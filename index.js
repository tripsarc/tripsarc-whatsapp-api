const express = require('express');
const { default: makeWASocket, useMultiFileAuthState, DisconnectReason } = require('@whiskeysockets/baileys');
const pino = require('pino'); 

const app = express();
app.use(express.json());

// Pull port and API key from Render's Environment Variables
const port = process.env.SERVER_PORT || 3000;
const API_KEY = process.env.AUTHENTICATION_API_KEY || 'development-key';

let sock;

async function connectToWhatsApp() {
    // Saves session data locally so you don't have to scan the QR code every single time
    const { state, saveCreds } = await useMultiFileAuthState('auth_info_baileys');
    
    sock = makeWASocket({
        auth: state,
        printQRInTerminal: true, // This will print the QR code in your Render logs
        logger: pino({ level: 'silent' }) // Mutes excessive Baileys background logs
    });

    sock.ev.on('connection.update', (update) => {
        const { connection, lastDisconnect, qr } = update;
        
        if (qr) {
            console.log('>>> ACTION REQUIRED: Check Render Logs and scan this QR code with your WhatsApp! <<<');
        }
        
        if (connection === 'close') {
            const shouldReconnect = lastDisconnect.error?.output?.statusCode !== DisconnectReason.loggedOut;
            console.log('Connection closed. Reconnecting:', shouldReconnect);
            if (shouldReconnect) {
                connectToWhatsApp();
            }
        } else if (connection === 'open') {
            console.log('WhatsApp connection is officially OPEN and ready!');
        }
    });

    sock.ev.on('creds.update', saveCreds);
}

// Start the WhatsApp connection
connectToWhatsApp();

// ---------------------------------------------------------
// The API Endpoint your WordPress site will talk to
// ---------------------------------------------------------
app.post('/send-message', async (req, res) => {
    const requestKey = req.headers['x-api-key'];
    
    // 1. Verify the secret key matches what is in Render
    if (requestKey !== API_KEY) {
        return res.status(401).json({ error: 'Unauthorized request. Invalid API Key.' });
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
        res.json({ success: true, message: 'Message successfully sent to WhatsApp!' });
    } catch (error) {
        console.error('Error sending message:', error);
        res.status(500).json({ error: 'Failed to send message.' });
    }
});

// A simple health check route (used to keep Render awake)
app.get('/', (req, res) => {
    res.send('TripsArc WhatsApp API is Active');
});

app.listen(port, () => {
    console.log(`Server is listening on port ${port}`);
});