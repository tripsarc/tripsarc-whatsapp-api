const express = require('express');
const { default: makeWASocket, DisconnectReason, fetchLatestBaileysVersion, Browsers } = require('@whiskeysockets/baileys');
const qrcode = require('qrcode-terminal');
const pino = require('pino');

// 1. Import the new MongoDB Auth Package (Removed fs and path entirely)
const useBaileysAuthState = require('baileysauth').default || require('baileysauth');

const app = express();
app.use(express.json());

// ---------------------------------------------------------
// PRODUCTION ENVIRONMENT VARIABLES
// ---------------------------------------------------------
const port = process.env.SERVER_PORT || 3000;
const API_KEY = process.env.AUTHENTICATION_API_KEY || 'development-key';

// 2. Fetch the MongoDB URI from Render
const MONGODB_URI = process.env.MONGODB_URI;

let sock;
let isConnected = false;

async function connectToWhatsApp() {
    // 3. Replaced useMultiFileAuthState with MongoDB Auth
    // This pulls 'state', 'saveCreds', and a 'wipeCreds' function to safely delete corrupted sessions
    const { state, saveCreds, wipeCreds } = await useBaileysAuthState(MONGODB_URI);
    
    const { version, isLatest } = await fetchLatestBaileysVersion();
    console.log(`Using WA v${version.join('.')}, isLatest: ${isLatest}`);

    sock = makeWASocket({
        logger: pino({ level: 'silent' }),
        auth: state, // Now pulling directly from your MongoDB cluster
        printQRInTerminal: false,
        version: version,
        browser: Browsers.macOS('Desktop')
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
            
            // 4. Update the clearing logic to wipe MongoDB instead of local files
            if (statusCode === 405) {
                console.log('Received Status 405. Wiping corrupted MongoDB session...');
                if (wipeCreds) await wipeCreds(); 
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
                if (wipeCreds) await wipeCreds();
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
// ROUTE: The API Endpoint your WordPress site will talk to
// ---------------------------------------------------------
app.post('/send-message', async (req, res) => {
    const requestKey = req.headers['x-api-key'];
    
    // 1. Verify the secret key matches what is in Render
    if (requestKey !== API_KEY) {
        return res.status(401).json({ error: 'Unauthorized request. Invalid API Key.' });
    }

    // Block requests if WhatsApp isn't fully connected yet
    if (!isConnected) {
        return res.status(503).json({ error: 'WhatsApp Production is not connected yet. Check Render logs for QR code.' });
    }

    const { phone, message } = req.body;
    
    // 2. Ensure data was sent
    if (!phone || !message) {
        return res.status(400).json({ error: 'Phone number and message are required.' });
    }

    try {
        // Baileys requires the phone number to end with @s.whatsapp.net for individuals
        const jid = `${phone}@s.whatsapp.net`; 
        
        // 3. Send the message
        await sock.sendMessage(jid, { text: message });
        res.json({ success: true, message: 'Message successfully sent to Production WhatsApp!' });
    } catch (error) {
        console.error('Error sending message:', error);
        res.status(500).json({ error: 'Failed to send message.', details: error.message });
    }
});

app.listen(port, () => {
    console.log(`TripsArc Production Server running on port ${port}`);
    connectToWhatsApp();
});
