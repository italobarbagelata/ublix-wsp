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
        this.processedMessageIds = new Map(); // Map to store processed message IDs
        
        // Configurar limpieza periódica de mensajes procesados
        this.setupMessageCleanupInterval();
    }
    
    // Configura un intervalo para limpiar periódicamente los mensajes procesados
    setupMessageCleanupInterval() {
        // Limpiar cada 10 minutos
        const CLEANUP_INTERVAL = 10 * 60 * 1000;
        
        this.messageCleanupInterval = setInterval(() => {
            try {
                if (!this.processedMessageIds || this.processedMessageIds.size === 0) {
                    return;
                }
                
                const countBefore = this.processedMessageIds.size;
                const fiveMinutesAgo = Date.now() - 5 * 60 * 1000;
                
                // Eliminar mensajes antiguos
                for (const [id, timestamp] of this.processedMessageIds.entries()) {
                    if (timestamp < fiveMinutesAgo) {
                        this.processedMessageIds.delete(id);
                    }
                }
                
                const countAfter = this.processedMessageIds.size;
                if (countBefore !== countAfter) {
                    logger.debug(`Limpieza de mensajes procesados: ${countBefore} -> ${countAfter}`);
                }
            } catch (error) {
                logger.error({ err: error }, 'Error durante la limpieza de mensajes procesados');
            }
        }, CLEANUP_INTERVAL);
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
            
            logger.info(`Found ${data?.length || 0} active WhatsApp integrations`);
            
            // Mostrar información detallada sobre las integraciones encontradas
            if (data && data.length > 0) {
                data.forEach(integration => {
                    logger.info({
                        integrationId: integration.id,
                        phoneNumberId: integration.phone_number_id,
                        status: integration.status,
                        projectId: integration.project_id
                    }, 'Integration details from database');
                });
            
                // Initialize each connection
                for (const integration of data) {
                    logger.info({ integrationId: integration.id }, 'Starting connection setup');
                    await this.createConnection(integration);
                }
            } else {
                logger.info('No active WhatsApp integrations found in database');
            }
            
            // Setup listener for database changes to automatically update connections
            this.setupDatabaseListener();
            
            // Set up periodic check for new integrations - as a backup in case realtime fails
            this.startPeriodicIntegrationCheck();
            
            return true;
        } catch (error) {
            logger.error({ err: error }, 'Error initializing WhatsApp service');
            return false;
        }
    }
    
    // Setup realtime subscription to the integrations table
    setupDatabaseListener() {
        logger.info('Setting up database listener for integration changes');
        
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
                    logger.info({ eventType: payload.eventType, integrationId: payload.new?.id || payload.old?.id }, 'Integration change detected');
                    
                    // Handle record updates
                    if (payload.eventType === 'UPDATE') {
                        const integration = payload.new;
                        if (integration.active && !this.connections.has(integration.id)) {
                            // New active connection
                            logger.info({ integrationId: integration.id }, 'Activating new connection');
                            await this.createConnection(integration);
                        } else if (!integration.active && this.connections.has(integration.id)) {
                            // Connection deactivated
                            logger.info({ integrationId: integration.id }, 'Deactivating connection');
                            await this.removeConnection(integration.id);
                        }
                    }
                    
                    // Handle new records
                    if (payload.eventType === 'INSERT' && payload.new.active) {
                        logger.info({ integrationId: payload.new.id }, 'New integration created, setting up connection');
                        await this.createConnection(payload.new);
                    }
                    
                    // Handle deleted records
                    if (payload.eventType === 'DELETE' && this.connections.has(payload.old.id)) {
                        logger.info({ integrationId: payload.old.id }, 'Integration deleted, removing connection');
                        await this.removeConnection(payload.old.id);
                    }
                }
            )
            .subscribe((status) => {
                logger.info({ status }, 'Realtime subscription status');
                if (status === 'SUBSCRIBED') {
                    logger.info('Successfully subscribed to integration changes');
                    
                    // Log current connections status
                    const activeConnections = this.getActiveConnections();
                    logger.info({
                        connectionCount: activeConnections.length,
                        connections: activeConnections
                    }, 'Current active connections after subscription');
                }
            });
            
        // Store channel reference to prevent garbage collection
        this.realtimeChannel = channel;
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
                logger.info(`Initializing auth state from directory: ${sessionDir}`);
                const { state, saveCreds } = await useMultiFileAuthState(sessionDir);
                
                logger.info({ integrationId: id }, 'Auth state initialized');
                
                // Ensure crypto module is available
                logger.info('Setting up crypto module for WhatsApp connection');
                global.crypto = require('crypto');
                
                // Create WhatsApp connection
                logger.info({ integrationId: id }, 'Creating WhatsApp socket connection');
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
                logger.info({ integrationId: id }, 'WhatsApp socket created, setting up event handlers');
                
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
                        
                        // Mostrar mensaje más evidente para el código QR
                        logger.info({
                            integrationId: id,
                            phoneNumberId: phone_number_id,
                            hasQR: true
                        }, '===> QR CODE AVAILABLE FOR SCANNING! <===');
                        
                        // Generar código QR en terminal para facilitar el escaneo
                        qrcode.generate(qr, { small: true });
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
                            try {
                                // Skip processing if this is a receipt, status update, or if the message is from ourselves
                                if (msg.key.fromMe || 
                                    msg.key.remoteJid === 'status@broadcast' ||
                                    !msg.message) {
                                    continue;
                                }
                                
                                // Este logging es opcional y puede ser removido en producción
                                logger.debug({
                                    integrationId: id,
                                    messageType: Object.keys(msg.message || {})[0] || 'unknown',
                                    fromMe: msg.key.fromMe,
                                    remoteJid: msg.key.remoteJid,
                                    messageId: msg.key.id
                                }, 'Message debug info');
                                
                                // Process message with our enhanced handler
                                this.processIncomingMessage(id, integration, msg);
                            } catch (err) {
                                logger.error({
                                    err,
                                    integrationId: id,
                                    messageId: msg.key?.id,
                                    remoteJid: msg.key?.remoteJid
                                }, 'Error handling incoming message event');
                            }
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
        
        // Verificar si es un mensaje válido
        if (!message || !message.message) {
            logger.debug({ integrationId, senderJid }, 'Mensaje vacío recibido, ignorando');
            return;
        }
        
        // Verificar si es un mensaje de estado/broadcast
        if (senderJid === 'status@broadcast') {
            logger.debug('Mensaje broadcast recibido, ignorando');
            return;
        }
        
        // Verificar si es un mensaje del sistema o notificación
        if (message.key?.fromMe || message.key?.participant === 'status@broadcast') {
            logger.debug({ integrationId, senderJid }, 'Mensaje del sistema recibido, ignorando');
            return;
        }
        
        // Extraer el contenido del mensaje de diferentes tipos posibles
        const messageContent = message.message?.conversation || 
                             message.message?.extendedTextMessage?.text || 
                             message.message?.imageMessage?.caption || 
                             (message.message?.imageMessage ? 'Imagen recibida' : null) ||
                             (message.message?.documentMessage ? 'Documento recibido' : null) ||
                             (message.message?.audioMessage ? 'Audio recibido' : null) ||
                             (message.message?.videoMessage ? 'Video recibido' : null) ||
                             null;
        
        // Verificar si hay contenido de mensaje
        if (!messageContent || messageContent.trim() === '') {
            logger.debug({ integrationId, senderJid }, 'Mensaje sin contenido recibido, ignorando');
            return;
        }
        
        // Guardar el ID del mensaje para evitar procesarlo varias veces
        const messageId = message.key?.id;
        
        // Verificar si ya procesamos este mensaje (usando un Map para almacenar IDs recientes)
        if (!this.processedMessageIds) {
            this.processedMessageIds = new Map();
        }
        
        if (this.processedMessageIds.has(messageId)) {
            logger.debug({ integrationId, senderJid, messageId }, 'Mensaje duplicado recibido, ignorando');
            return;
        }
        
        // Almacenar este ID de mensaje como procesado (con expiración después de 5 minutos)
        this.processedMessageIds.set(messageId, Date.now());
        
        // Limpiar IDs de mensajes antiguos (más de 5 minutos)
        const fiveMinutesAgo = Date.now() - 5 * 60 * 1000;
        for (const [id, timestamp] of this.processedMessageIds.entries()) {
            if (timestamp < fiveMinutesAgo) {
                this.processedMessageIds.delete(id);
            }
        }
        
        logger.info({
            integrationId,
            sender: senderJid,
            messageId,
            message: messageContent
        }, 'Nuevo mensaje válido recibido');
        
        try {
            // Call the Ublix Chat API
            const response = await fetch('https://ublix-api-bagfa9hdh8hqhxcb.eastus-01.azurewebsites.net/api/chat/message', {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json'
                },
                body: JSON.stringify({
                    message: messageContent,
                    project_id: integration.project_id,
                    user_id: senderJid // Using WhatsApp JID as user_id
                })
            });

            if (!response.ok) {
                throw new Error(`Chat API error: ${response.statusText}`);
            }

            const data = await response.json();
            
            // Send the response back to WhatsApp
            await this.sendMessage(integrationId, senderJid, data.response);
            
            // Log the interaction
            logger.info({
                integrationId,
                sender: senderJid,
                message: messageContent,
                response: data.response,
                messageId: data.message_id
            }, 'Message processed successfully');
        } catch (error) {
            logger.error({
                err: error,
                integrationId,
                sender: senderJid,
                message: messageContent
            }, 'Error processing message');
            
            // Send an error message to the user
            await this.sendMessage(
                integrationId, 
                senderJid, 
                'Lo siento, hubo un error procesando tu mensaje. Por favor, intenta de nuevo más tarde.'
            );
        }
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
    
    // Periodic check for new integrations as a backup mechanism
    startPeriodicIntegrationCheck() {
        // Check every 5 minutes for changes
        const CHECK_INTERVAL = 5 * 60 * 1000;
        
        this.periodicCheckInterval = setInterval(async () => {
            try {
                logger.info('Performing periodic integration check');
                
                // Get all active integrations from database
                const { data, error } = await supabase
                    .from('integration_whatsapp_business')
                    .select('*')
                    .eq('active', true);
                    
                if (error) {
                    throw new Error(`Failed to fetch WhatsApp integrations: ${error.message}`);
                }
                
                // Get current active integrations
                const activeIntegrationIds = Array.from(this.connections.keys());
                
                // Identify new integrations to add
                const newIntegrations = data.filter(integration => 
                    !activeIntegrationIds.includes(integration.id));
                
                // Identify integrations to remove (no longer in the database or not active)
                const dataIntegrationIds = data.map(integration => integration.id);
                const integrationsToRemove = activeIntegrationIds.filter(id => 
                    !dataIntegrationIds.includes(id));
                
                // Add new integrations
                if (newIntegrations.length > 0) {
                    logger.info(`Found ${newIntegrations.length} new integrations to add`);
                    for (const integration of newIntegrations) {
                        await this.createConnection(integration);
                    }
                }
                
                // Remove deleted/deactivated integrations
                if (integrationsToRemove.length > 0) {
                    logger.info(`Found ${integrationsToRemove.length} integrations to remove`);
                    for (const id of integrationsToRemove) {
                        await this.removeConnection(id);
                    }
                }
            } catch (error) {
                logger.error({ err: error }, 'Error in periodic integration check');
            }
        }, CHECK_INTERVAL);
    }

    // Stop the service and clean up resources
    async shutdown() {
        logger.info('Shutting down WhatsApp service...');
        
        // Clear periodic check interval
        if (this.periodicCheckInterval) {
            clearInterval(this.periodicCheckInterval);
            this.periodicCheckInterval = null;
        }
        
        // Clear message cleanup interval
        if (this.messageCleanupInterval) {
            clearInterval(this.messageCleanupInterval);
            this.messageCleanupInterval = null;
        }
        
        // Unsubscribe from realtime channel
        if (this.realtimeChannel) {
            await this.realtimeChannel.unsubscribe();
            logger.info('Unsubscribed from realtime channel');
            this.realtimeChannel = null;
        }
        
        // Close all active connections
        const connectionIds = Array.from(this.connections.keys());
        logger.info(`Closing ${connectionIds.length} active connections`);
        
        for (const id of connectionIds) {
            await this.removeConnection(id);
        }
        
        // Clear processed message IDs
        if (this.processedMessageIds) {
            this.processedMessageIds.clear();
        }
        
        logger.info('WhatsApp service shutdown complete');
    }
}

// Export a singleton instance
const whatsappService = new MultiWhatsAppService();
module.exports = whatsappService;