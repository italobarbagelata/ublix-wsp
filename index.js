const { default: makeWASocket, DisconnectReason, useMultiFileAuthState } = require('@whiskeysockets/baileys');
const { Boom } = require('@hapi/boom');
const qrcode = require('qrcode-terminal');
const fs = require('fs');
const path = require('path');
const pino = require('pino');

// Configuración del logger
const logger = pino({
    level: process.env.NODE_ENV === 'production' ? 'info' : 'debug',
    transport: {
        target: 'pino-pretty',
        options: {
            colorize: true,
            translateTime: 'SYS:standard',
            ignore: 'pid,hostname'
        }
    }
});

// Session directory
const SESSION_DIR = './auth_session';

// Create session directory if it doesn't exist
if (!fs.existsSync(SESSION_DIR)) {
    fs.mkdirSync(SESSION_DIR, { recursive: true });
}

// Function to connect to WhatsApp
async function connectToWhatsApp() {
    try {
        // Use the file system to store authentication data
        const { state, saveCreds } = await useMultiFileAuthState(SESSION_DIR);
        
        // Create a WhatsApp connection
        const sock = makeWASocket({
            auth: state,
            printQRInTerminal: true,
            markOnlineOnConnect: false,
            defaultQueryTimeoutMs: 60000,
            logger: pino({ level: 'silent' })
        });
        
        // Save credentials when updated
        sock.ev.on('creds.update', saveCreds);
        
        // Handle connection updates
        sock.ev.on('connection.update', (update) => {
            const { connection, lastDisconnect, qr } = update;
            
            // If QR code is available, display it in terminal
            if (qr) {
                logger.info('QR Code received, scan using WhatsApp app');
                qrcode.generate(qr, { small: true });
            }
            
            // If connection is closed, check if we should reconnect
            if (connection === 'close') {
                const shouldReconnect = (lastDisconnect.error instanceof Boom && 
                    lastDisconnect.error.output?.statusCode !== DisconnectReason.loggedOut);
                
                logger.warn(
                    { error: lastDisconnect.error?.output?.payload?.message || 'Unknown error' },
                    'Connection closed'
                );
                
                if (shouldReconnect) {
                    logger.info('Reconnecting...');
                    connectToWhatsApp();
                } else {
                    logger.info('Connection closed. Not reconnecting.');
                    // If logged out, delete auth session
                    if (lastDisconnect.error?.output?.statusCode === DisconnectReason.loggedOut) {
                        logger.info('Logged out. Deleting session files...');
                        try {
                            fs.rmSync(SESSION_DIR, { recursive: true, force: true });
                            logger.info('Session files deleted. Please restart the application.');
                        } catch (error) {
                            logger.error({ err: error }, 'Error deleting session files');
                        }
                    }
                }
            }
            
            // If connected, log success
            if (connection === 'open') {
                logger.info('Connected to WhatsApp!');
            }
        });
        
        // Handle incoming messages
        sock.ev.on('messages.upsert', async (m) => {
            if (m.type === 'notify') {
                for (const msg of m.messages) {
                    // Skip broadcast messages
                    if (msg.key.remoteJid === 'status@broadcast') continue;
                    
                    // Get message content
                    const messageContent = msg.message?.conversation || 
                                      msg.message?.extendedTextMessage?.text || 
                                      msg.message?.imageMessage?.caption || 
                                      'Media message';
                    
                    // Skip empty messages
                    if (!messageContent) continue;
                    
                    // Get sender information
                    const senderJid = msg.key.remoteJid;
                    
                    logger.info({ sender: senderJid, message: messageContent }, 'New message received');
                    
                    // Example: Reply to message
                    await sock.sendMessage(senderJid, { text: `Received your message: ${messageContent}` });
                }
            }
        });
        
        // Add utility functions to the socket
        sock.sendSimpleText = async (jid, text) => {
            return await sock.sendMessage(jid, { text });
        };
        
        sock.sendImage = async (jid, imagePath, caption = '') => {
            const image = fs.readFileSync(imagePath);
            return await sock.sendMessage(jid, {
                image,
                caption
            });
        };
        
        return sock;
    } catch (error) {
        logger.error({ err: error }, 'Error in WhatsApp connection');
    }
}

// Start WhatsApp connection
connectToWhatsApp()
    .then(sock => {
        logger.info('WhatsApp client initialized');
        // You can use sock to send messages programmatically
        global.waSocket = sock; // Make it accessible globally
    })
    .catch(err => logger.error({ err }, 'Error initializing WhatsApp client'));

logger.info('WhatsApp client starting...'); 