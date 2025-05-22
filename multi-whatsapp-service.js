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
                .from('integration_whatsapp_web')
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
                    table: 'integration_whatsapp_web'
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
                
                // Capturar información del usuario al iniciar sesión
                sock.ev.on('auth.update', async (authInfo) => {
                    try {
                        logger.info({
                            integrationId: id,
                            event: 'auth.update',
                            hasAuthInfo: !!authInfo,
                            authProps: authInfo ? Object.keys(authInfo) : []
                        }, 'Actualización de autenticación recibida');
                        
                        // Si la conexión está activa, actualizar información en BD
                        if (this.connections.has(id) && authInfo) {
                            // Si hay un cambio en la autenticación y ya tenemos información del usuario
                            // actualizar la información en la base de datos
                            if (sock.user) {
                                logger.info({
                                    integrationId: id,
                                    userInfo: {
                                        name: sock.user.name,
                                        id: sock.user.id,
                                        phone: sock.user.id?.split(':')[0]
                                    }
                                }, 'Información de usuario obtenida, actualizando BD');
                                
                                // Actualizar la información en la conexión
                                const connectionData = this.connections.get(id);
                                connectionData.userInfo = sock.user;
                                
                                // Actualizar estado en la base de datos si la conexión está abierta
                                if (connectionData.status === 'connected') {
                                    await this.updateIntegrationStatus(id, 'connected');
                                }
                            }
                        }
                    } catch (error) {
                        logger.error({
                            integrationId: id,
                            err: error
                        }, 'Error procesando evento auth.update');
                    }
                });
                
                // Handle connection updates
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
                            setTimeout(() => this.createConnection(integration), 5000);
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
                        // Obtener información del usuario conectado
                        const userInfo = sock.user || {};
                        
                        logWithContext('info', 'Conectado a WhatsApp', {
                            integrationId: id,
                            phoneNumberId: phone_number_id,
                            userInfo: {
                                name: userInfo.name,
                                id: userInfo.id,
                                verifiedName: userInfo.verifiedName
                            }
                        });
                        
                        // Almacenar la información del usuario en la conexión
                        if (this.connections.has(id)) {
                            const connectionData = this.connections.get(id);
                            connectionData.userInfo = userInfo;
                        }
                        
                        // Actualizar estado en la base de datos
                        await this.updateIntegrationStatus(id, 'connected');
                    }
                });
                
                // Handle incoming messages
                sock.ev.on('messages.upsert', async (m) => {
                    if (m.type === 'notify') {
                        logger.info({
                            integrationId: id,
                            messageCount: m.messages.length,
                            messageType: m.type
                        }, "Received messages.upsert event");
                        
                        for (const msg of m.messages) {
                            try {
                                // Log message structure for debugging
                                logger.info({
                                    integrationId: id,
                                    messageStructure: {
                                        hasMessage: !!msg.message,
                                        fromMe: msg.key?.fromMe,
                                        remoteJid: msg.key?.remoteJid,
                                        messageTypes: msg.message ? Object.keys(msg.message) : []
                                    }
                                }, "Message structure debug");
                                
                                // Skip processing if this is a receipt, status update, or if the message is from ourselves
                                if (msg.key.remoteJid === 'status@broadcast' ||
                                    !msg.message) {
                                    logger.debug({
                                        reason: msg.key.fromMe ? 'fromMe (ignorado temporalmente)' : (msg.key.remoteJid === 'status@broadcast' ? 'broadcast' : 'no message'),
                                        integrationId: id
                                    }, 'Skipping message processing');
                                    continue;
                                }
                                
                                // Añadir verificación adicional para evitar bucles si el mensaje es nuestro
                                if (msg.key.fromMe) {
                                    logger.info({
                                        integrationId: id,
                                        fromMe: true,
                                        remoteJid: msg.key.remoteJid
                                    }, 'Procesando mensaje marcado como fromMe (diagnóstico)');
                                    
                                    // Verificar si es realmente una respuesta automática analizando el contenido del mensaje
                                    const messageText = msg.message?.conversation || 
                                                      msg.message?.extendedTextMessage?.text || 
                                                      (msg.message?.imageMessage?.caption || '');
                                    
                                    // Si el mensaje contiene un patrón que indica que es una respuesta automática, ignorarlo
                                    if (messageText.startsWith('Lo siento, hubo un error') || 
                                        messageText.includes('procesando tu mensaje')) {
                                        logger.info({
                                            integrationId: id,
                                            messagePreview: messageText.substring(0, 30)
                                        }, 'Ignorando respuesta automática para evitar bucles');
                                        continue;
                                    }
                                }
                                
                                // En caso de que sea un mensaje marcado como fromMe, registrarlo para diagnóstico
                                if (msg.key?.fromMe) {
                                    logger.info({ 
                                        integrationId: id, 
                                        senderJid: msg.key.remoteJid,
                                        isFromMe: true
                                    }, 'Procesando mensaje marcado como fromMe para diagnóstico');
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
                
                // Escuchar actualizaciones de contactos para obtener información de perfil
                sock.ev.on('contacts.update', async (updates) => {
                    try {
                        logger.info({
                            integrationId: id,
                            updatesCount: updates.length,
                            updates: updates.map(u => ({id: u.id, name: u.name, notify: u.notify}))
                        }, 'Actualización de contactos recibida');
                        
                        // Buscar si hay actualizaciones para nuestro propio perfil
                        if (sock.user) {
                            const selfId = sock.user.id?.split('@')[0];
                            const selfUpdates = updates.filter(u => u.id?.split('@')[0] === selfId);
                            
                            if (selfUpdates.length > 0) {
                                logger.info({
                                    integrationId: id,
                                    selfUpdates: selfUpdates.map(u => ({
                                        id: u.id,
                                        name: u.name || u.notify,
                                        notify: u.notify
                                    }))
                                }, 'Actualización de perfil propio recibida');
                                
                                // Actualizar información en la conexión
                                if (this.connections.has(id)) {
                                    const connectionData = this.connections.get(id);
                                    if (!connectionData.userInfo) {
                                        connectionData.userInfo = {};
                                    }
                                    
                                    // Actualizar información de perfil
                                    const selfUpdate = selfUpdates[0];
                                    if (selfUpdate.name) connectionData.userInfo.name = selfUpdate.name;
                                    if (selfUpdate.notify) connectionData.userInfo.notify = selfUpdate.notify;
                                    
                                    // Actualizar en BD si la conexión está activa
                                    if (connectionData.status === 'connected') {
                                        await this.updateIntegrationStatus(id, 'connected');
                                    }
                                }
                            }
                        }
                    } catch (error) {
                        logger.error({
                            integrationId: id,
                            err: error
                        }, 'Error procesando actualización de contactos');
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
                
                // Preparar datos para actualizar en Supabase
                const updateData = {
                    status: status,
                    updated_at: new Date().toISOString()
                };
                
                // Si el estado es 'connected', agregar información adicional
                if (status === 'connected') {
                    updateData.connected_at = new Date().toISOString();
                    updateData.last_connected_at = new Date().toISOString();
                    
                    // Si hay información de perfil disponible, guardarla
                    if (connection.sock && connection.sock.user) {
                        updateData.profile_name = connection.sock.user.name || null;
                        updateData.profile_id = connection.sock.user.id || null;
                    }
                    
                    logger.info({
                        integrationId,
                        status,
                        updatedFields: Object.keys(updateData)
                    }, 'Actualizando información completa de conexión en BD');
                }
                
                // Update in Supabase
                const { error } = await supabase
                    .from('integration_whatsapp_web')
                    .update(updateData)
                    .eq('id', integrationId);
                
                if (error) {
                    logger.error({
                        err: error,
                        integrationId,
                        status
                    }, 'Error updating integration status in database');
                } else {
                    logger.info({
                        integrationId,
                        status,
                        success: true
                    }, 'BD actualizada correctamente');
                }
            }
        } catch (error) {
            logger.error({
                err: error,
                integrationId,
                status
            }, 'Error updating integration status');
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
        
        // Inicial debug log
        logger.info({
            integrationId,
            senderJid,
            hasMessageObj: !!message.message,
            messageKeyId: message.key?.id
        }, 'Iniciando procesamiento de mensaje');
        
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


        logger.info('************* Mensaje recibido *************');
        
        // Verificar el estado del bot para este usuario
        try {
            logger.info('Verificando estado de conversación');
            const { data: conversationState, error } = await supabase
                .from('whatsapp_web_conversation_states')
                .select('*')
                .eq('project_id', integration.project_id)
                .eq('business_account_id', integration.id)
                .eq('phone_number_id', integration.phone_number_id)
                .eq('user_id', senderJid)
                .single();

            logger.info('Estado de conversación verificado');
            logger.info(conversationState);

            if (error && error.code !== 'PGRST116') { // PGRST116 es el código para "no se encontró"
                logger.error({
                    err: error,
                    integrationId,
                    senderJid
                }, 'Error al verificar estado de conversación');
                return;
            }

            if (!conversationState) {
                // Si no existe el registro, crear uno nuevo con el bot activado
                const { error: insertError } = await supabase
                    .from('whatsapp_web_conversation_states')
                    .insert({
                        project_id: integration.project_id,
                        business_account_id: integration.id,
                        phone_number_id: integration.phone_number_id,
                        user_id: senderJid,
                        bot_active: true
                    });

                if (insertError) {
                    logger.error({
                        err: insertError,
                        integrationId,
                        senderJid
                    }, 'Error al crear nuevo estado de conversación');
                    return;
                }

                logger.info({
                    integrationId,
                    senderJid,
                    business_account_id: integration.id,
                    phone_number_id: integration.phone_number_id
                }, 'Nuevo estado de conversación creado con bot activado');
            } else if (!conversationState.bot_active) {
                logger.info({
                    integrationId,
                    senderJid,
                    business_account_id: integration.id,
                    phone_number_id: integration.phone_number_id
                }, 'Bot desactivado para este usuario - omitiendo procesamiento');
                return;
            }
        } catch (error) {
            logger.error({
                err: error,
                integrationId,
                senderJid
            }, 'Error al verificar estado del bot');
            return;
        }
        
        // Si es fromMe, agregar log especial para diagnóstico
        if (message.key?.fromMe) {
            logger.info({ 
                integrationId, 
                senderJid,
                isFromMe: true
            }, 'Procesando mensaje marcado como fromMe para diagnóstico');

            // Verificar si el mensaje es del dueño del número
            const connection = this.connections.get(integrationId);
            logger.info('Connection *************');
            logger.info(connection);

            if (connection && connection.userInfo && connection.userInfo.id === message.key.remoteJid) {
                logger.info({
                    integrationId,
                    senderJid,
                    messageContent
                }, 'Mensaje detectado del dueño del número - Desactivando bot');

                // Actualizar el estado del bot en la base de datos
                const { error: updateError } = await supabase
                    .from('whatsapp_web_conversation_states')
                    .update({ bot_active: false })
                    .eq('project_id', integration.project_id)
                    .eq('business_account_id', integration.id)
                    .eq('phone_number_id', integration.phone_number_id)
                    .eq('user_id', senderJid);

                if (updateError) {
                    logger.error({
                        err: updateError,
                        integrationId,
                        senderJid
                    }, 'Error al desactivar el bot');
                    return;
                }

                logger.info({
                    integrationId,
                    senderJid
                }, 'Bot desactivado exitosamente');
                return;
            }
        }
        
        // Debug log de tipos de mensaje disponibles
        logger.info({
            integrationId,
            messageTypes: Object.keys(message.message),
            hasConversation: !!message.message?.conversation,
            hasExtendedText: !!message.message?.extendedTextMessage,
            hasImage: !!message.message?.imageMessage
        }, 'Tipos de mensaje disponibles');
        
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
        
        // Si el mensaje es nuestro y contiene textos de respuesta automática, ignorarlo para evitar bucles
        if (message.key?.fromMe && (
            messageContent.startsWith('Lo siento, hubo un error') || 
            messageContent.includes('procesando tu mensaje')
        )) {
            logger.info({
                integrationId,
                messagePreview: messageContent.substring(0, 50)
            }, 'Ignorando respuesta automática para evitar bucles');
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
            // Log before API call
            logger.info({
                integrationId,
                senderJid,
                message: messageContent,
                projectId: integration.project_id
            }, 'Realizando llamada a API de Ublix');
            
            // Call the Ublix Chat API
            const response = await fetch(CHAT_API_URL + '/api/chat/message', {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json'
                },
                body: JSON.stringify({
                    message: messageContent,
                    project_id: integration.project_id,
                    user_id: senderJid,
                    source: integration.id,
                    number_phone_agent: integration.phone_number_id,
                    source_name: 'whatsapp_web',
                    name: 'whatsapp_web'
                })
            });

            // Log API response status
            logger.info({
                integrationId,
                apiStatus: response.status,
                apiStatusText: response.statusText
            }, 'Respuesta recibida de API de Ublix');

            if (!response.ok) {
                throw new Error(`Chat API error: ${response.statusText}`);
            }

            const data = await response.json();
            
            // Log response data
            logger.info({
                integrationId,
                hasResponse: !!data.response,
                responseLength: data.response ? data.response.length : 0,
                messageId: data.message_id
            }, 'Procesando respuesta de API');
            
            // Send the response back to WhatsApp
            logger.info({
                integrationId,
                senderJid,
                responsePreview: data.response ? data.response.substring(0, 50) + '...' : 'Sin respuesta',
            }, 'Enviando respuesta a WhatsApp');
            
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
                message: messageContent,
                errorName: error.name,
                errorMessage: error.message,
                errorStack: error.stack
            }, 'Error processing message');
            
            // Intentar enviar un mensaje de error al usuario
            try {
                logger.info({ integrationId, senderJid }, 'Intentando enviar mensaje de error al usuario');
                await this.sendMessage(
                    integrationId, 
                    senderJid, 
                    'Lo siento, hubo un error procesando tu mensaje. Por favor, intenta de nuevo más tarde.'
                );
                logger.info({ integrationId, senderJid }, 'Mensaje de error enviado correctamente');
            } catch (sendError) {
                logger.error({
                    err: sendError,
                    integrationId,
                    senderJid
                }, 'Error al enviar mensaje de error al usuario');
            }
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
                    .from('integration_whatsapp_web')
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