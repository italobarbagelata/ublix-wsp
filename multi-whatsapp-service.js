const { default: makeWASocket, DisconnectReason, useMultiFileAuthState } = require('@whiskeysockets/baileys');
const { Boom } = require('@hapi/boom');
const qrcode = require('qrcode-terminal');
const fs = require('fs');
const path = require('path');
const pino = require('pino');
const { createClient } = require('@supabase/supabase-js');
const dotenv = require('dotenv');

// Load environment variables
dotenv.config();

// Supabase configuration - Replace with your actual values
const SUPABASE_URL = process.env.SUPABASE_URL || '';
const SUPABASE_KEY = process.env.SUPABASE_KEY || '';
const supabase = createClient(SUPABASE_URL, SUPABASE_KEY);

// Base directory for all sessions
const BASE_SESSION_DIR = process.env.BASE_SESSION_DIR || './whatsapp_sessions';

// Create base session directory if it doesn't exist
if (!fs.existsSync(BASE_SESSION_DIR)) {
    fs.mkdirSync(BASE_SESSION_DIR, { recursive: true });
}

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

logger.info(`BASE_SESSION_DIR: ${BASE_SESSION_DIR}`);
logger.info(`Directory exists: ${fs.existsSync(BASE_SESSION_DIR)}`);

// Class to manage multiple WhatsApp connections
class MultiWhatsAppService {
    constructor() {
        this.connections = new Map(); // Map to store active connections
        this.qrCodes = new Map(); // Map to store QR codes
        this.supabase = supabase; // Expose supabase instance
    }

    // Initialize connections from Supabase
    async initialize() {
        try {
            logger.info('Initializing WhatsApp connections from database...');
            
            // Fetch all active integrations from Supabase
            const { data, error } = await supabase
                .from('integration_whatsapp_business')
                .select('*')
                .eq('active', true);
                
            if (error) {
                throw new Error(`Failed to fetch WhatsApp integrations: ${error.message}`);
            }
            
            logger.info(`Found ${data.length} active WhatsApp integrations`);
            
            // Initialize each connection
            for (const integration of data) {
                await this.createConnection(integration);
            }
            
            // Setup listener for database changes to automatically update connections
            this.setupDatabaseListener();
            
            return true;
        } catch (error) {
            logger.error({ err: error }, 'Error initializing WhatsApp service');
            return false;
        }
    }
    
    // Setup realtime subscription to the integrations table
    setupDatabaseListener() {
        const channel = supabase
            .channel('integration_changes')
            .on(
                'postgres_changes',
                {
                    event: '*',
                    schema: 'public',
                    table: 'integration_whatsapp_business'
                },
                async (payload) => {
                    const integration = payload.new;
                    
                    // Handle record updates
                    if (payload.eventType === 'UPDATE') {
                        if (integration.active && !this.connections.has(integration.id)) {
                            // New active connection
                            await this.createConnection(integration);
                        } else if (!integration.active && this.connections.has(integration.id)) {
                            // Connection deactivated
                            await this.removeConnection(integration.id);
                        }
                    }
                    
                    // Handle new records
                    if (payload.eventType === 'INSERT' && integration.active) {
                        await this.createConnection(integration);
                    }
                    
                    // Handle deleted records
                    if (payload.eventType === 'DELETE' && this.connections.has(payload.old.id)) {
                        await this.removeConnection(payload.old.id);
                    }
                }
            )
            .subscribe();
    }
    
    // Create a single WhatsApp connection
    async createConnection(integration) {
        const { id, phone_number_id } = integration;
        logger.info({ integrationId: id, phoneNumberId: phone_number_id }, 'Setting up WhatsApp connection');
        
        let retryCount = 0;
        const maxRetries = 3;
        
        const attemptConnection = async () => {
            try {
                // Create session directory for this specific connection
                const sessionDir = path.join(BASE_SESSION_DIR, id.toString());
                logger.info(`Creating session directory: ${sessionDir}`);
                if (!fs.existsSync(sessionDir)) {
                    fs.mkdirSync(sessionDir, { recursive: true });
                }
                logger.info(`Session directory created successfully: ${sessionDir}`);
                
                // Initialize auth state from the session directory
                const { state, saveCreds } = await useMultiFileAuthState(sessionDir);
                
                logger.info({ integrationId: id }, 'Auth state initialized');
                
                // Create WhatsApp connection
                const sock = makeWASocket({
                    auth: state,
                    printQRInTerminal: false,
                    markOnlineOnConnect: false,
                    defaultQueryTimeoutMs: 60000,
                    logger: pino({ level: 'debug' }),
                    browser: ['Ubuntu', 'Chrome', '10.0'],
                    connectTimeoutMs: 60000,
                    keepAliveIntervalMs: 30000,
                    retryRequestDelayMs: 5000,
                    emitOwnEvents: true
                });
                
                // Save credentials when updated
                sock.ev.on('creds.update', saveCreds);
                
                // Handle connection updates
                sock.ev.on('connection.update', async (update) => {
                    const { connection, lastDisconnect, qr } = update;
                    
                    // Agregar más logging
                    logger.info({
                        event: 'connection.update',
                        update: {
                            connection,
                            hasQR: !!qr,
                            disconnectReason: lastDisconnect?.error?.output?.payload?.message,
                            statusCode: lastDisconnect?.error?.output?.statusCode
                        }
                    });
                    
                    if (qr) {
                        logger.info('QR Code received, updating status...');
                        await this.updateIntegrationStatus(id, 'awaiting_qr_scan', qr);
                    }
                    
                    if (connection === 'close') {
                        const statusCode = lastDisconnect?.error?.output?.statusCode;
                        const shouldReconnect = (
                            lastDisconnect?.error instanceof Boom && 
                            statusCode !== DisconnectReason.loggedOut
                        );
                        
                        logger.info({
                            message: 'Connection closed',
                            statusCode,
                            shouldReconnect,
                            error: lastDisconnect?.error?.message || 'Unknown error'
                        });
                        
                        if (shouldReconnect) {
                            logger.info('Attempting to reconnect in 5 seconds...');
                            setTimeout(() => this.createConnection(integration), 5000);
                        } else {
                            logger.info({ integrationId: id, phoneNumberId: phone_number_id }, 'Connection closed permanently');
                            await this.updateIntegrationStatus(id, 'disconnected');
                            
                            // If logged out, delete auth session
                            if (lastDisconnect.error?.output?.statusCode === DisconnectReason.loggedOut) {
                                logger.info({ integrationId: id, phoneNumberId: phone_number_id }, 'Deleting session files');
                                try {
                                    fs.rmSync(sessionDir, { recursive: true, force: true });
                                    logger.info({ integrationId: id, phoneNumberId: phone_number_id }, 'Session files deleted');
                                } catch (error) {
                                    logger.error(
                                        { err: error, integrationId: id, phoneNumberId: phone_number_id },
                                        'Error deleting session files'
                                    );
                                }
                            }
                            
                            // Remove from active connections
                            this.connections.delete(id);
                        }
                    }
                    
                    // Handle successful connection
                    if (connection === 'open') {
                        logger.info({ integrationId: id, phoneNumberId: phone_number_id }, 'Connected to WhatsApp');
                        await this.updateIntegrationStatus(id, 'connected');
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
                            
                            logger.info(
                                { 
                                    integrationId: id, 
                                    phoneNumberId: phone_number_id,
                                    sender: senderJid,
                                    message: messageContent
                                },
                                'New message received'
                            );
                            
                            // Process message - You can add your chatbot logic here
                            this.processIncomingMessage(id, integration, msg);
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
                
                // Store connection in the map
                this.connections.set(id, {
                    sock: sock,
                    integration,
                    sessionDir,
                    status: 'connecting'
                });
                
                return sock;
            } catch (error) {
                logger.error(
                    { err: error, integrationId: id, phoneNumberId: phone_number_id },
                    'Error in WhatsApp connection'
                );
                await this.updateIntegrationStatus(id, 'error', error.message);
                return null;
            }
        }
        
        while (retryCount < maxRetries) {
            retryCount++;
            logger.info({ integrationId: id }, `Attempting connection, attempt ${retryCount} of ${maxRetries}`);
            const sock = await attemptConnection();
            if (sock) {
                return sock;
            }
        }
        
        return null;
    }
    
    // Update integration status in Supabase
    async updateIntegrationStatus(integrationId, status, additionalData = null) {
        try {
            // Update the connections map with the new status
            if (this.connections.has(integrationId)) {
                const connection = this.connections.get(integrationId);
                connection.status = status;
                
                // If additionalData is a QR code, store it in the connection
                if (additionalData && status === 'awaiting_qr_scan') {
                    connection.qrCode = additionalData;
                }
                
                // Update in Supabase (without the QR code data which is too large)
                const { error } = await supabase
                    .from('integration_whatsapp_business')
                    .update({
                        status: status,
                        updated_at: new Date().toISOString()
                    })
                    .eq('id', integrationId);
                
                if (error) {
                    logger.error(`Error updating integration status in database for ${integrationId}:`, error);
                }
                // else {
                //     console.log(`Updated integration status for ${integrationId} to ${status}`);
                // }
            }
        } catch (error) {
            logger.error(`Error updating integration status for ${integrationId}:`, error);
        }
    }
    
    // Get QR code for a specific integration
    getQRCode(integrationId) {
        if (!this.connections.has(integrationId)) {
            return null;
        }
        
        const connection = this.connections.get(integrationId);
        const qrCode = connection.qrCode || null;
        
        // If there is a QR code, display it in the console when specifically requested
        if (qrCode) {
            const integration = connection.integration;
            logger.info(`\nDisplaying QR Code for ${integration.phone_number_id} (${integrationId}):`);
            qrcode.generate(qrCode, { small: true });
        }
        
        return qrCode;
    }
    
    // Force generate QR code for a specific integration (for refreshing)
    async forceGenerateQR(integrationId) {
        if (!this.connections.has(integrationId)) {
            return false;
        }
        
        try {
            const connection = this.connections.get(integrationId);
            const sock = connection.sock;
            
            // Request new QR code by forcing a reconnection
            if (sock) {
                sock.ev.emit('connection.update', { qr: null });
                logger.info(`Requested new QR code for integration ${integrationId}`);
                return true;
            }
            
            return false;
        } catch (error) {
            logger.error(`Error generating QR for ${integrationId}:`, error);
            return false;
        }
    }
    
    // Get detailed status of a connection
    getConnectionStatus(integrationId) {
        if (!this.connections.has(integrationId)) {
            return {
                exists: false,
                status: 'not_found'
            };
        }
        
        const connection = this.connections.get(integrationId);
        return {
            exists: true,
            status: connection.status,
            phoneNumberId: connection.integration.phone_number_id,
            hasQR: !!connection.qrCode,
            projectId: connection.integration.project_id
        };
    }
    
    // Process incoming message (implement your chatbot logic here)
    async processIncomingMessage(integrationId, integration, message) {
        const senderJid = message.key.remoteJid;
        const messageContent = message.message?.conversation || 
                             message.message?.extendedTextMessage?.text || 
                             message.message?.imageMessage?.caption || 
                             'Media message';
        
        // TODO: Implement your chatbot logic here
        // This is where you would connect to your Python backend or LangChain chatbot
        
        // For now, just echo the message back
        await this.sendMessage(integrationId, senderJid, `Echo: ${messageContent}`);
    }
    
    // Remove a connection
    async removeConnection(integrationId) {
        if (!this.connections.has(integrationId)) {
            return false;
        }
        
        const connection = this.connections.get(integrationId);
        logger.info(`Removing WhatsApp connection for ${connection.integration.phone_number_id} (${integrationId})`);
        
        try {
            // Close the socket properly if possible
            if (connection.sock) {
                // Baileys doesn't have a formal way to close connections,
                // but we can remove listeners to allow garbage collection
                connection.sock.ev.removeAllListeners();
            }
            
            // Remove from our connections map
            this.connections.delete(integrationId);
            
            return true;
        } catch (error) {
            logger.error(`Error removing connection for ${integrationId}:`, error);
            return false;
        }
    }
    
    // Send a message using a specific connection
    async sendMessage(integrationId, jid, text) {
        if (!this.connections.has(integrationId)) {
            throw new Error(`No active connection found for integration ID: ${integrationId}`);
        }
        
        const connection = this.connections.get(integrationId);
        
        try {
            return await connection.sock.sendSimpleText(jid, text);
        } catch (error) {
            logger.error(`Error sending message for ${integrationId}:`, error);
            throw error;
        }
    }
    
    // Send an image using a specific connection
    async sendImage(integrationId, jid, imagePath, caption = '') {
        if (!this.connections.has(integrationId)) {
            throw new Error(`No active connection found for integration ID: ${integrationId}`);
        }
        
        const connection = this.connections.get(integrationId);
        
        try {
            return await connection.sock.sendImage(jid, imagePath, caption);
        } catch (error) {
            logger.error(`Error sending image for ${integrationId}:`, error);
            throw error;
        }
    }
    
    // Get all active connections
    getActiveConnections() {
        return Array.from(this.connections.entries()).map(([id, conn]) => ({
            id,
            phoneNumberId: conn.integration.phone_number_id,
            status: conn.status,
            projectId: conn.integration.project_id
        }));
    }
}

// Export a singleton instance
const whatsappService = new MultiWhatsAppService();
module.exports = whatsappService;