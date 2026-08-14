const express = require('express');
const { default: makeWASocket, useMultiFileAuthState, DisconnectReason, fetchLatestBaileysVersion, Browsers } = require('@whiskeysockets/baileys');
const qrcode = require('qrcode-terminal');
const pino = require('pino');
const fs = require('fs');
const path = require('path');

const app = express();
app.use(express.json());

// ---------------------------------------------------------
// PRODUCTION ENVIRONMENT VARIABLES
// ---------------------------------------------------------
const port = process.env.SERVER_PORT || 3000;
const API_KEY = process.env.AUTHENTICATION_API_KEY || 'development-key';

// Renamed folder to completely bypass old corrupted session loops in PROD
const AUTH_DIR = path.join(__dirname, 'auth_info_prod_v2'); 

let sock;
let isConnected = false;

async function connectToWhatsApp() {
    const { state, saveCreds } = await useMultiFileAuthState(AUTH_DIR);
    
    // Fetch the absolute latest version from WhatsApp servers dynamically
    const { version, isLatest } = await fetchLatestBaileysVersion();
    console.log(`Using WA v${version.join('.')}, isLatest: ${isLatest}`);

    sock = makeWASocket({
        logger: pino({ level: 'silent' }),
        auth: state,
        printQRInTerminal: false,
        version: version,
        browser: Browsers.macOS('Desktop') // Emulates a clean Desktop Mac Chrome browser
    });

    sock.ev.on('creds.update', saveCreds);

    sock.ev.on('connection.update', (update) => {
        const { connection, lastDisconnect, qr } = update;

        if (qr) {
            console.log('\n============================================================');
            console.log('       SCAN THIS QR CODE WITH PRODUCTION WHATSAPP           ');
            console.log('============================================================\n');
            qrcode.generate(qr, { small: true });
            console.log('\n============================================================\n');
        }

        if (connection === 'close') {
            const statusCode = lastDisconnect?.error?.output?.statusCode;
            
            // 405 Method Not Allowed means invalid session or version mismatch
            // This will automatically wipe the session and try again if it fails
            if (statusCode === 405) {
                console.log('Received Status 405. Clearing corrupted session to generate new QR...');
                if (fs.existsSync(AUTH_DIR)) fs.rmSync(AUTH_DIR, { recursive: true, force: true });
                setTimeout(connectToWhatsApp, 3000);
                return;
            }

            const shouldReconnect = statusCode !== DisconnectReason.loggedOut;
            console.log(`Connection closed (Status: ${statusCode}). Reconnecting: ${shouldReconnect}`);
            isConnected = false;
            
            if (shouldReconnect) {
                setTimeout(connectToWhatsApp, 3000);
            } else {
                console.log('Logged out. Clearing auth directory...');
                if (fs.existsSync(AUTH_DIR)) fs.rmSync(AUTH_DIR, { recursive: true, force: true });
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
