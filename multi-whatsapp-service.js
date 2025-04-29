const { default: makeWASocket, DisconnectReason, useMultiFileAuthState } = require('@whiskeysockets/baileys');
const { Boom } = require('@hapi/boom');
const qrcode = require('qrcode-terminal');
const fs = require('fs');
const path = require('path');
const pino = require('pino');
const { createClient } = require('@supabase/supabase-js');
const dotenv = require('dotenv');
const crypto = require('crypto');

// Load environment variables
dotenv.config();

// Supabase configuration - Replace with your actual values
const SUPABASE_URL = process.env.SUPABASE_URL || '';
const SUPABASE_KEY = process.env.SUPABASE_KEY || '';
const supabase = createClient(SUPABASE_URL, SUPABASE_KEY);

const CHAT_API_URL = process.env.CHAT_API_URL || '';

// Configuración del logger mejorada para Azure
const logger = pino({
    level: process.env.NODE_ENV === 'production' ? 'info' : 'debug',
    base: {
        service: 'whatsapp-service',
        environment: process.env.NODE_ENV || 'development',
        version: process.env.npm_package_version || '1.0.0'
    },
    formatters: {
        level: (label) => {
            return { level: label.toUpperCase() };
        },
        bindings: (bindings) => {
            return {
                pid: bindings.pid,
                hostname: bindings.hostname,
                service: bindings.service,
                environment: bindings.environment,
                version: bindings.version
            };
        }
    },
    timestamp: () => `,"timestamp":"${new Date().toISOString()}"`,
    messageKey: 'message',
    errorKey: 'error',
    transport: {
        target: 'pino-pretty',
        options: {
            colorize: true,
            translateTime: 'SYS:standard',
            ignore: 'pid,hostname',
            messageFormat: '{msg}',
            errorLikeObjectKeys: ['err', 'error'],
            errorProps: 'stack'
        }
    }
});

// Función de utilidad para logging estructurado
const logWithContext = (level, message, context = {}) => {
    const logContext = {
        ...context,
        timestamp: new Date().toISOString(),
        service: 'whatsapp-service'
    };
    
    switch (level.toLowerCase()) {
        case 'error':
            logger.error(logContext, message);
            break;
        case 'warn':
            logger.warn(logContext, message);
            break;
        case 'info':
            logger.info(logContext, message);
            break;
        case 'debug':
            logger.debug(logContext, message);
            break;
        default:
            logger.info(logContext, message);
    }
};

// Configuración de directorio de sesiones
const DEFAULT_SESSION_DIR = './whatsapp_sessions';
const AZURE_SESSION_DIR = '/home/site/wwwroot/whatsapp_sessions';
const BASE_SESSION_DIR = process.env.BASE_SESSION_DIR || 
    (process.env.WEBSITE_SITE_NAME ? AZURE_SESSION_DIR : DEFAULT_SESSION_DIR);

// Create base session directory if it doesn't exist
if (!fs.existsSync(BASE_SESSION_DIR)) {
    logWithContext('info', 'Creando directorio de sesiones', {
        path: BASE_SESSION_DIR,
        isAzure: process.env.WEBSITE_SITE_NAME ? true : false
    });
    fs.mkdirSync(BASE_SESSION_DIR, { recursive: true });
}

// Verificar permisos del directorio
try {
    fs.accessSync(BASE_SESSION_DIR, fs.constants.R_OK | fs.constants.W_OK);
    logWithContext('info', 'Directorio de sesiones accesible', {
        path: BASE_SESSION_DIR
    });
} catch (error) {
    logWithContext('error', 'Error de permisos en directorio de sesiones', {
        path: BASE_SESSION_DIR,
        error: error.message
    });
    throw error;
}

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
            
            // Initialize each connection
            if (data && data.length > 0) {
                for (const integration of data) {
                    await this.createConnection(integration);
                }
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
                }
            });
            
        // Store channel reference to prevent garbage collection
        this.realtimeChannel = channel;
    }
    
    // Create a single WhatsApp connection
    async createConnection(integration) {
        const { id, phone_number_id } = integration;
        logWithContext('info', 'Iniciando creación de conexión WhatsApp', {
            integrationId: id,
            phoneNumberId: phone_number_id
        });
        
        let retryCount = 0;
        const maxRetries = 3;
        let lastError = null;
        
        const attemptConnection = async () => {
            try {
                // Create session directory for this specific connection
                const sessionDir = path.join(BASE_SESSION_DIR, id.toString());
                logWithContext('debug', 'Creando directorio de sesión', {
                    integrationId: id,
                    sessionDir
                });
                
                if (!fs.existsSync(sessionDir)) {
                    fs.mkdirSync(sessionDir, { recursive: true });
                }
                
                // Initialize auth state from the session directory
                const { state, saveCreds } = await useMultiFileAuthState(sessionDir);
                
                logWithContext('info', 'Estado de autenticación inicializado', {
                    integrationId: id
                });
                
                // Create WhatsApp connection with improved error handling
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
                    emitOwnEvents: true,
                    maxRetries: 5,
                    retryDelayMs: 10000,
                    syncFullHistory: false
                });
                
                // Save credentials when updated
                sock.ev.on('creds.update', saveCreds);
                
                // Handle connection updates with improved error handling
                sock.ev.on('connection.update', async (update) => {
                    const { connection, lastDisconnect, qr } = update;
                    
                    logWithContext('info', 'Actualización de conexión recibida', {
                        integrationId: id,
                        connection,
                        hasQR: !!qr,
                        disconnectReason: lastDisconnect?.error?.output?.payload?.message,
                        statusCode: lastDisconnect?.error?.output?.statusCode
                    });
                    
                    if (qr) {
                        logWithContext('info', 'Código QR recibido', {
                            integrationId: id
                        });
                        await this.updateIntegrationStatus(id, 'awaiting_qr_scan', qr);
                    }
                    
                    if (connection === 'close') {
                        const statusCode = lastDisconnect?.error?.output?.statusCode;
                        const shouldReconnect = (
                            lastDisconnect?.error instanceof Boom && 
                            statusCode !== DisconnectReason.loggedOut
                        );
                        
                        logWithContext('warn', 'Conexión cerrada', {
                            integrationId: id,
                            statusCode,
                            shouldReconnect,
                            error: lastDisconnect?.error?.message || 'Error desconocido'
                        });
                        
                        if (shouldReconnect) {
                            logWithContext('info', 'Intentando reconexión', {
                                integrationId: id
                            });
                            // Esperar antes de reconectar
                            await new Promise(resolve => setTimeout(resolve, 5000));
                            await this.createConnection(integration);
                        } else {
                            logWithContext('error', 'Conexión cerrada permanentemente', {
                                integrationId: id,
                                phoneNumberId: phone_number_id
                            });
                            await this.updateIntegrationStatus(id, 'disconnected');
                            
                            if (lastDisconnect.error?.output?.statusCode === DisconnectReason.loggedOut) {
                                logWithContext('info', 'Eliminando archivos de sesión', {
                                    integrationId: id,
                                    phoneNumberId: phone_number_id
                                });
                                try {
                                    fs.rmSync(sessionDir, { recursive: true, force: true });
                                } catch (error) {
                                    logWithContext('error', 'Error al eliminar archivos de sesión', {
                                        err: error,
                                        integrationId: id,
                                        phoneNumberId: phone_number_id
                                    });
                                }
                            }
                            
                            this.connections.delete(id);
                        }
                    }
                    
                    if (connection === 'open') {
                        logWithContext('info', 'Conectado a WhatsApp', {
                            integrationId: id,
                            phoneNumberId: phone_number_id
                        });
                        await this.updateIntegrationStatus(id, 'connected');
                    }
                });
                
                // Handle incoming messages with improved error handling
                sock.ev.on('messages.upsert', async (m) => {
                    if (m.type === 'notify') {
                        for (const msg of m.messages) {
                            try {
                                await this.processIncomingMessage(id, integration, msg);
                            } catch (error) {
                                logWithContext('error', 'Error procesando mensaje', {
                                    err: error,
                                    integrationId: id,
                                    messageId: msg.key?.id
                                });
                            }
                        }
                    }
                });
                
                // Add utility functions to the socket
                sock.sendSimpleText = async (jid, text) => {
                    try {
                        return await sock.sendMessage(jid, { text });
                    } catch (error) {
                        logWithContext('error', 'Error enviando mensaje de texto', {
                            err: error,
                            integrationId: id,
                            jid
                        });
                        throw error;
                    }
                };
                
                sock.sendImage = async (jid, imagePath, caption = '') => {
                    try {
                        const image = fs.readFileSync(imagePath);
                        return await sock.sendMessage(jid, {
                            image,
                            caption
                        });
                    } catch (error) {
                        logWithContext('error', 'Error enviando imagen', {
                            err: error,
                            integrationId: id,
                            jid
                        });
                        throw error;
                    }
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
                lastError = error;
                logWithContext('error', 'Error en la conexión WhatsApp', {
                    err: error,
                    integrationId: id,
                    phoneNumberId: phone_number_id
                });
                await this.updateIntegrationStatus(id, 'error', error.message);
                return null;
            }
        }
        
        while (retryCount < maxRetries) {
            retryCount++;
            logWithContext('info', `Intento de conexión ${retryCount} de ${maxRetries}`, {
                integrationId: id
            });
            
            const sock = await attemptConnection();
            if (sock) {
                return sock;
            }
            
            // Esperar antes de reintentar
            await new Promise(resolve => setTimeout(resolve, 5000));
        }
        
        logWithContext('error', 'Máximo número de intentos de conexión alcanzado', {
            integrationId: id,
            lastError: lastError?.message
        });
        
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
        try {
            // Verificar si el mensaje ya fue procesado
            const messageId = message.key?.id;
            if (this.processedMessageIds.has(messageId)) {
                logWithContext('debug', 'Mensaje ya procesado', {
                    integrationId,
                    messageId
                });
                return;
            }

            // Marcar mensaje como procesado
            this.processedMessageIds.set(messageId, Date.now());

            // Procesar el mensaje
            const response = await this.handleMessage(integrationId, integration, message);
            
            if (response) {
                await this.sendMessage(integrationId, message.key.remoteJid, response);
            }
        } catch (error) {
            logWithContext('error', 'Error procesando mensaje', {
                err: error,
                integrationId,
                messageId: message.key?.id
            });
            
            // Intentar enviar mensaje de error al usuario
            try {
                await this.sendMessage(
                    integrationId,
                    message.key.remoteJid,
                    'Lo siento, hubo un error procesando tu mensaje. Por favor, intenta de nuevo más tarde.'
                );
            } catch (sendError) {
                logWithContext('error', 'Error enviando mensaje de error', {
                    err: sendError,
                    integrationId
                });
            }
        }
    }
    
    async handleMessage(integrationId, integration, message) {
        // Implementar la lógica de procesamiento de mensajes aquí
        // Por ejemplo, llamar a una API externa o procesar el mensaje localmente
        return 'Mensaje recibido correctamente';
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
        logger.info({
            integrationId,
            jid,
            hasText: !!text,
            textLength: text ? text.length : 0
        }, 'Iniciando envío de mensaje');
        
        if (!this.connections.has(integrationId)) {
            logger.error({
                integrationId,
                availableConnections: Array.from(this.connections.keys())
            }, 'No se encontró la conexión para el integrationId proporcionado');
            throw new Error(`No active connection found for integration ID: ${integrationId}`);
        }
        
        const connection = this.connections.get(integrationId);
        logger.info({
            integrationId,
            connectionStatus: connection.status,
            hasSocket: !!connection.sock,
            hasSimpleText: !!(connection.sock && connection.sock.sendSimpleText)
        }, 'Estado de la conexión para envío');
        
        if (!connection.sock) {
            logger.error({ integrationId }, 'Socket no disponible para enviar mensaje');
            throw new Error(`Socket no disponible para integration ID: ${integrationId}`);
        }
        
        if (!connection.sock.sendSimpleText) {
            logger.error({ integrationId }, 'Método sendSimpleText no disponible en el socket');
            throw new Error(`El método sendSimpleText no está disponible en el socket para integration ID: ${integrationId}`);
        }
        
        try {
            logger.info({ integrationId, jid }, 'Enviando mensaje a WhatsApp');
            const result = await connection.sock.sendSimpleText(jid, text);
            logger.info({ 
                integrationId, 
                jid,
                result: result ? JSON.stringify(result).substring(0, 100) : 'Sin resultado'
            }, 'Mensaje enviado exitosamente');
            return result;
        } catch (error) {
            logger.error({
                err: error,
                integrationId,
                jid,
                errorName: error.name,
                errorMessage: error.message
            }, 'Error enviando mensaje');
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
        logWithContext('info', 'Iniciando apagado del servicio');
        
        // Limpiar intervalos
        if (this.messageCleanupInterval) {
            clearInterval(this.messageCleanupInterval);
        }
        
        if (this.periodicCheckInterval) {
            clearInterval(this.periodicCheckInterval);
        }
        
        // Cerrar todas las conexiones
        for (const [id, connection] of this.connections.entries()) {
            try {
                if (connection.sock) {
                    await connection.sock.logout();
                }
                this.connections.delete(id);
            } catch (error) {
                logWithContext('error', 'Error cerrando conexión', {
                    err: error,
                    integrationId: id
                });
            }
        }
        
        // Limpiar mensajes procesados
        this.processedMessageIds.clear();
        
        logWithContext('info', 'Servicio apagado correctamente');
    }
}

// Export a singleton instance
const whatsappService = new MultiWhatsAppService();
module.exports = whatsappService;