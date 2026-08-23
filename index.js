const express = require('express');
const { 
    default: makeWASocket, 
    DisconnectReason, 
    fetchLatestBaileysVersion, 
    Browsers
    // Notice we completely removed makeInMemoryStore from here
} = require('@whiskeysockets/baileys');
const qrcode = require('qrcode-terminal');
const pino = require('pino');
const { MongoClient } = require('mongodb');
const useMongoDBAuthState = require('./mongoAuth');
const NodeCache = require('node-cache');

const app = express();
app.use(express.json());

// ---------------------------------------------------------
// PRODUCTION ENVIRONMENT VARIABLES
// ---------------------------------------------------------
const port = process.env.SERVER_PORT || 3000;
const API_KEY = process.env.AUTHENTICATION_API_KEY || 'development-key';
const MONGODB_URI = process.env.MONGODB_URI;

// ---------------------------------------------------------
// CUSTOM LIGHTWEIGHT MESSAGE CACHE 
// ---------------------------------------------------------
const msgRetryCounterCache = new NodeCache();
// Cache messages for exactly 5 minutes (300 seconds) to handle delivery retries without wasting RAM
const messageCache = new NodeCache({ stdTTL: 300, checkperiod: 60 }); 

let sock;
let isConnected = false;

async function connectToWhatsApp() {
    console.log('Connecting to MongoDB database...');
    const mongoClient = new MongoClient(MONGODB_URI);
    await mongoClient.connect();
    
    const collection = mongoClient.db().collection('auth_session');
    console.log('Successfully connected to MongoDB!');

    const { state, saveCreds, wipeCreds } = await useMongoDBAuthState(collection);
    
    const { version, isLatest } = await fetchLatestBaileysVersion();
    console.log(`Using WA v${version.join('.')}, isLatest: ${isLatest}`);

    sock = makeWASocket({
        logger: pino({ level: 'silent' }),
        auth: state, 
        printQRInTerminal: false,
        version: version,
        browser: Browsers.macOS('Desktop'),
        msgRetryCounterCache,
        getMessage: async (key) => {
            // If your phone requests a retry, find the original message from our NodeCache
            const cachedMsg = messageCache.get(key.id);
            if (cachedMsg) {
                return cachedMsg;
            }
            return { conversation: 'Message missing from cache' };
        }
    });

    // Automatically capture all sent/received messages and temporarily save them to the cache
    sock.ev.on('messages.upsert', ({ messages }) => {
        for (const m of messages) {
            if (m.key && m.key.id && m.message) {
                messageCache.set(m.key.id, m.message);
            }
        }
    });

    sock.ev.on('creds.update', saveCreds);

    sock.ev.on('connection.update', async (update) => {
        const { connection, lastDisconnect, qr } = update;

        if (qr) {
            console.log('\n============================================================');
            console.log('       SCAN THIS QR CODE WITH PRODUCTION WHATSAPP           ');
            console.log('============================================================\n');
            qrcode.generate(qr, { small: true });
        }

        if (connection === 'close') {
            const statusCode = lastDisconnect?.error?.output?.statusCode;
            
            if (statusCode === 405) {
                console.log('Received Status 405. Wiping corrupted MongoDB session...');
                await wipeCreds(); 
                setTimeout(connectToWhatsApp, 3000);
                return;
            }

            const shouldReconnect = statusCode !== DisconnectReason.loggedOut;
            console.log(`Connection closed (Status: ${statusCode}). Reconnecting: ${shouldReconnect}`);
            isConnected = false;
            
            if (shouldReconnect) {
                setTimeout(connectToWhatsApp, 3000);
            } else {
                console.log('Logged out. Wiping MongoDB auth...');
                await wipeCreds();
                setTimeout(connectToWhatsApp, 3000);
            }
        } else if (connection === 'open') {
            console.log('------------------------------------------------------------');
            console.log('  ✅ PRODUCTION WHATSAPP CLIENT SUCCESSFULLY CONNECTED!     ');
            console.log('------------------------------------------------------------');
            isConnected = true;
        }
    });
}

// ---------------------------------------------------------
// ROUTE: Health Check
// ---------------------------------------------------------
app.get('/', (req, res) => {
    res.json({
        status: 'online',
        environment: 'production',
        whatsapp_connected: isConnected
    });
});

// ---------------------------------------------------------
// ROUTE: The API Endpoint your website will talk to
// ---------------------------------------------------------
app.post('/send-message', async (req, res) => {
    const requestKey = req.headers['x-api-key'];
    
    if (requestKey !== API_KEY) {
        return res.status(401).json({ error: 'Unauthorized request. Invalid API Key.' });
    }

    if (!isConnected) {
        return res.status(503).json({ error: 'WhatsApp Production is not connected yet. Check Render logs for QR code.' });
    }

    const { phone, message } = req.body;
    
    if (!phone || !message) {
        return res.status(400).json({ error: 'Phone number and message are required.' });
    }

    try {
        const jid = `${phone}@s.whatsapp.net`; 
        
        // 1. Capture the return object when sending the message
        const sentMsg = await sock.sendMessage(jid, { text: message });
        
        // 2. Instantly cache it so your sender phone can sync the encryption key
        if (sentMsg && sentMsg.key && sentMsg.key.id && sentMsg.message) {
            messageCache.set(sentMsg.key.id, sentMsg.message);
        }

        res.json({ success: true, message: 'Message successfully sent to Production WhatsApp!' });
    } catch (error) {
        console.error('Error sending message:', error);
        res.status(500).json({ error: 'Failed to send message.', details: error.message });
    }
});

// ---------------------------------------------------------
// ROUTE: Emergency Session Reset
// ---------------------------------------------------------
app.get('/reset-session', async (req, res) => {
    try {
        const mongoClient = new MongoClient(MONGODB_URI);
        await mongoClient.connect();
        
        // This instantly deletes all corrupted keys from the database
        await mongoClient.db().collection('auth_session').deleteMany({});
        res.send('MongoDB session wiped successfully! Check your Render Logs for a new QR code.');
        
        // Kills the server to force Render to restart and generate a new QR
        setTimeout(() => process.exit(1), 2000); 
    } catch (error) {
        res.status(500).send('Error wiping session: ' + error.message);
    }
});

app.listen(port, () => {
    console.log(`Production Server running on port ${port}`);
    connectToWhatsApp();
});
