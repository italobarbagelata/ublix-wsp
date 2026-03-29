const { default: makeWASocket, DisconnectReason, useMultiFileAuthState, downloadMediaMessage } = require('@whiskeysockets/baileys');
const { Boom } = require('@hapi/boom');
const qrcode = require('qrcode-terminal');
const fs = require('fs');
const path = require('path');
const pino = require('pino');
const dotenv = require('dotenv');
const crypto = require('crypto');
const FormData = require('form-data');
const axios = require('axios');
const { v4: uuidv4 } = require('uuid');

dotenv.config();

const db = require('./db');

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

// Clase para manejar el almacenamiento de archivos en disco local
class FileStorage {
    constructor() {
        this.baseDir = process.env.FILE_STORAGE_DIR || './uploads';
        if (!fs.existsSync(this.baseDir)) {
            fs.mkdirSync(this.baseDir, { recursive: true });
        }
    }

    _generateFilename(originalFilename) {
        const fileExtension = originalFilename ? originalFilename.split('.').pop() : 'jpg';
        const timestamp = new Date().toISOString().replace(/[:.]/g, '-').split('T')[0];
        const uniqueId = uuidv4();
        return `${timestamp}_${uniqueId}.${fileExtension}`;
    }

    async saveImage(projectId, imageBuffer, contentType = 'image/jpeg', originalFilename = 'image.jpg') {
        try {
            const filename = this._generateFilename(originalFilename);
            const currentDate = new Date();
            const relPath = `${projectId}/${currentDate.getFullYear()}/${String(currentDate.getMonth() + 1).padStart(2, '0')}/${String(currentDate.getDate()).padStart(2, '0')}`;
            const dirPath = path.join(this.baseDir, relPath);

            if (!fs.existsSync(dirPath)) {
                fs.mkdirSync(dirPath, { recursive: true });
            }

            const filePath = path.join(dirPath, filename);
            fs.writeFileSync(filePath, imageBuffer);

            // Construir URL pública usando SERVER_URL
            const serverUrl = process.env.SERVER_URL || `http://localhost:${process.env.PORT || 3002}`;
            const publicUrl = `${serverUrl}/uploads/${relPath}/${filename}`;

            logger.info(`Imagen guardada localmente: ${publicUrl}`);
            return publicUrl;
        } catch (error) {
            logger.error(`Error al guardar imagen: ${error.message}`);
            throw error;
        }
    }

    async deleteImage(projectId, filename) {
        try {
            const filePath = path.join(this.baseDir, projectId, filename);
            if (fs.existsSync(filePath)) {
                fs.unlinkSync(filePath);
            }
            return true;
        } catch (error) {
            logger.error(`Error al eliminar imagen: ${error.message}`);
            return false;
        }
    }

    async getImageUrl(projectId, filename) {
        const serverUrl = process.env.SERVER_URL || `http://localhost:${process.env.PORT || 3002}`;
        return `${serverUrl}/uploads/${projectId}/${filename}`;
    }
}

// Class to manage multiple WhatsApp connections
class MultiWhatsAppService {
    constructor() {
        this.connections = new Map(); // Map to store active connections
        this.qrCodes = new Map(); // Map to store QR codes
        this.processedMessageIds = new Map(); // Map to store processed message IDs
        this.reconnectionAttempts = new Map(); // Track reconnection attempts per integration
        this.reconnectionTimers = new Map(); // Track active reconnection timers
        this.maxReconnectionAttempts = 5; // Maximum reconnection attempts
        this.baseReconnectionDelay = 5000; // Base delay: 5 seconds
        this.maxReconnectionDelay = 300000; // Max delay: 5 minutes
        
        // Circuit breaker para evitar loops infinitos
        this.lastFailureTime = new Map(); // Track last failure time per integration
        this.circuitBreakerDelay = 5 * 60 * 1000; // 5 minutos de cooldown mínimo
        this.globalErrorCount = 0; // Contador global de errores
        this.lastGlobalReset = Date.now(); // Último reset global
        
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

    // Initialize connections from database
    async initialize() {
        try {
            logger.info('Initializing WhatsApp connections from database...');
            
            // Fetch all active integrations from PostgreSQL
            const { rows: data } = await db.query(
                'SELECT * FROM integration_whatsapp_web WHERE active = $1',
                [true]
            );

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
    
    // Setup PostgreSQL LISTEN/NOTIFY for integration changes
    async setupDatabaseListener() {
        logger.info('Setting up database listener for integration changes via LISTEN/NOTIFY');

        try {
            // Acquire a dedicated client for LISTEN
            this.listenerClient = await db.pool.connect();

            this.listenerClient.on('notification', async (msg) => {
                try {
                    const payload = JSON.parse(msg.payload);
                    const eventType = payload.event;
                    const record = payload.record || {};
                    const oldRecord = payload.old_record || {};

                    logger.info({ eventType, integrationId: record.id || oldRecord.id }, 'Integration change detected');

                    if (eventType === 'UPDATE') {
                        if (record.active && !this.connections.has(record.id)) {
                            logger.info({ integrationId: record.id }, 'Activating new connection');
                            await this.createConnection(record);
                        } else if (!record.active && this.connections.has(record.id)) {
                            logger.info({ integrationId: record.id }, 'Deactivating connection');
                            await this.removeConnection(record.id);
                        }
                    }

                    if (eventType === 'INSERT' && record.active) {
                        logger.info({ integrationId: record.id }, 'New integration created, setting up connection');
                        await this.createConnection(record);
                    }

                    if (eventType === 'DELETE' && this.connections.has(oldRecord.id)) {
                        logger.info({ integrationId: oldRecord.id }, 'Integration deleted, removing connection');
                        await this.removeConnection(oldRecord.id);
                    }
                } catch (parseError) {
                    logger.error({ err: parseError, rawPayload: msg.payload }, 'Error parsing NOTIFY payload');
                }
            });

            await this.listenerClient.query('LISTEN integration_whatsapp_web_changes');
            logger.info('Successfully subscribed to integration_whatsapp_web_changes channel');
        } catch (error) {
            logger.error({ err: error }, 'Error setting up database listener. Falling back to periodic checks only.');
        }
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
                        // Reset reconnection attempts when QR is received (indicates fresh session)
                        this.reconnectionAttempts.delete(id);
                        logWithContext('info', 'Código QR recibido', {
                            integrationId: id
                        });
                        await this.updateIntegrationStatus(id, 'awaiting_qr_scan', qr);
                    }
                    
                    if (connection === 'close') {
                        const statusCode = lastDisconnect?.error?.output?.statusCode;
                        const errorMessage = lastDisconnect?.error?.message || 'Error desconocido';
                        
                        // Get current reconnection attempts for this integration
                        const currentAttempts = this.reconnectionAttempts.get(id) || 0;
                        
                        logWithContext('warn', 'Conexión cerrada', {
                            integrationId: id,
                            statusCode,
                            errorMessage,
                            currentAttempts,
                            maxAttempts: this.maxReconnectionAttempts
                        });
                        
                        // Handle specific error codes
                        if (statusCode === DisconnectReason.loggedOut) {
                            logWithContext('info', 'Usuario cerró sesión desde el teléfono - eliminando archivos de sesión', {
                                integrationId: id,
                                phoneNumberId: phone_number_id
                            });
                            
                            await this.cleanupConnection(id, sessionDir, 'logged_out');
                            return;
                        }
                        
                        // Handle 403 and 405 errors with special logic
                        if (statusCode === 403 || statusCode === 405) {
                            logWithContext('warn', `Error ${statusCode} detectado - posible sesión corrupta o problema de conexión`, {
                                integrationId: id,
                                phoneNumberId: phone_number_id,
                                currentAttempts,
                                errorMessage: lastDisconnect?.error?.message
                            });
                            
                            // If we've had multiple 403/405 errors, clean session files
                            if (currentAttempts >= 2) {
                                logWithContext('info', `Múltiples errores ${statusCode} - limpiando archivos de sesión corruptos`, {
                                    integrationId: id,
                                    phoneNumberId: phone_number_id,
                                    attempts: currentAttempts
                                });
                                
                                try {
                                    if (fs.existsSync(sessionDir)) {
                                        fs.rmSync(sessionDir, { recursive: true, force: true });
                                        logWithContext('info', 'Archivos de sesión eliminados exitosamente', {
                                            integrationId: id,
                                            sessionDir
                                        });
                                    }
                                    
                                    // Reset reconnection attempts after cleaning
                                    this.reconnectionAttempts.delete(id);
                                } catch (cleanupError) {
                                    logWithContext('error', 'Error al eliminar archivos de sesión', {
                                        err: cleanupError,
                                        integrationId: id,
                                        sessionDir
                                    });
                                }
                            }
                        }
                        
                        // Circuit breaker: verificar si hay demasiados errores recientes
                        const now = Date.now();
                        const lastFailure = this.lastFailureTime.get(id) || 0;
                        const timeSinceLastFailure = now - lastFailure;
                        
                        // Actualizar estadísticas globales de errores
                        this.globalErrorCount++;
                        this.lastFailureTime.set(id, now);
                        
                        // Reset global counter cada 10 minutos
                        if (now - this.lastGlobalReset > 10 * 60 * 1000) {
                            this.globalErrorCount = 0;
                            this.lastGlobalReset = now;
                        }
                        
                        // Circuit breaker: si hay demasiados errores globales, parar todo
                        const isGlobalCircuitOpen = this.globalErrorCount > 20; // Más de 20 errores en 10 min
                        const isLocalCircuitOpen = timeSinceLastFailure < this.circuitBreakerDelay; // Menos de 5 min desde último fallo
                        
                        if (isGlobalCircuitOpen) {
                            logWithContext('error', 'Circuit breaker global activado - demasiados errores', {
                                integrationId: id,
                                globalErrorCount: this.globalErrorCount,
                                timeWindowMinutes: 10
                            });
                        }
                        
                        if (isLocalCircuitOpen) {
                            logWithContext('warn', 'Circuit breaker local activado - cooldown activo', {
                                integrationId: id,
                                timeSinceLastFailureMs: timeSinceLastFailure,
                                circuitBreakerDelayMs: this.circuitBreakerDelay
                            });
                        }
                        
                        // Check if we should attempt reconnection
                        const shouldReconnect = (
                            lastDisconnect?.error instanceof Boom && 
                            statusCode !== DisconnectReason.loggedOut &&
                            currentAttempts < this.maxReconnectionAttempts &&
                            !isGlobalCircuitOpen &&
                            !isLocalCircuitOpen
                        );
                        
                        if (shouldReconnect) {
                            // Increment reconnection attempts
                            this.reconnectionAttempts.set(id, currentAttempts + 1);
                            
                            // Calculate exponential backoff delay
                            const delay = Math.min(
                                this.baseReconnectionDelay * Math.pow(2, currentAttempts),
                                this.maxReconnectionDelay
                            );
                            
                            logWithContext('info', 'Programando reconexión con backoff exponencial', {
                                integrationId: id,
                                attempt: currentAttempts + 1,
                                maxAttempts: this.maxReconnectionAttempts,
                                delayMs: delay,
                                delaySeconds: Math.round(delay / 1000)
                            });
                            
                            // Clear any existing timer for this integration
                            const existingTimer = this.reconnectionTimers.get(id);
                            if (existingTimer) {
                                clearTimeout(existingTimer);
                            }
                            
                            // Set new reconnection timer
                            const timer = setTimeout(async () => {
                                this.reconnectionTimers.delete(id);
                                
                                logWithContext('info', 'Ejecutando reconexión programada', {
                                    integrationId: id,
                                    attempt: currentAttempts + 1
                                });
                                
                                await this.createConnection(integration);
                            }, delay);
                            
                            this.reconnectionTimers.set(id, timer);
                            
                            // Update status to indicate reconnection is scheduled
                            await this.updateIntegrationStatus(id, 'reconnecting');
                        } else {
                            // Max attempts reached, permanent error, or circuit breaker activated
                            if (currentAttempts >= this.maxReconnectionAttempts) {
                                logWithContext('error', 'Máximo de intentos de reconexión alcanzado', {
                                    integrationId: id,
                                    phoneNumberId: phone_number_id,
                                    attempts: currentAttempts
                                });
                            } else if (isGlobalCircuitOpen) {
                                logWithContext('error', 'Reconexión bloqueada por circuit breaker global', {
                                    integrationId: id,
                                    phoneNumberId: phone_number_id,
                                    globalErrorCount: this.globalErrorCount
                                });
                            } else if (isLocalCircuitOpen) {
                                logWithContext('warn', 'Reconexión bloqueada por circuit breaker local', {
                                    integrationId: id,
                                    phoneNumberId: phone_number_id,
                                    cooldownRemainingMs: this.circuitBreakerDelay - timeSinceLastFailure
                                });
                                // No cleanup for local circuit breaker - just wait
                                await this.updateIntegrationStatus(id, 'error');
                                return;
                            }
                            
                            await this.cleanupConnection(id, sessionDir, 'connection_failed');
                        }
                    }
                    
                    if (connection === 'open') {
                        // Reset reconnection attempts on successful connection
                        this.reconnectionAttempts.delete(id);
                        
                        // Clear any pending reconnection timer
                        const existingTimer = this.reconnectionTimers.get(id);
                        if (existingTimer) {
                            clearTimeout(existingTimer);
                            this.reconnectionTimers.delete(id);
                        }
                        
                        // Obtener información del usuario conectado
                        const userInfo = sock.user || {};
                        
                        logWithContext('info', 'Conectado a WhatsApp exitosamente', {
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
    
    // Update integration status in database
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
                
                // Preparar datos para actualizar en PostgreSQL
                const setClauses = ['status = $1', 'updated_at = $2'];
                const values = [status, new Date().toISOString()];
                let paramIndex = 3;

                if (status === 'connected') {
                    setClauses.push(`connected_at = $${paramIndex}`);
                    values.push(new Date().toISOString());
                    paramIndex++;
                    setClauses.push(`last_connected_at = $${paramIndex}`);
                    values.push(new Date().toISOString());
                    paramIndex++;

                    if (connection.sock && connection.sock.user) {
                        setClauses.push(`profile_name = $${paramIndex}`);
                        values.push(connection.sock.user.name || null);
                        paramIndex++;
                        setClauses.push(`profile_id = $${paramIndex}`);
                        values.push(connection.sock.user.id || null);
                        paramIndex++;
                    }

                    logger.info({
                        integrationId,
                        status,
                        updatedFields: setClauses
                    }, 'Actualizando información completa de conexión en BD');
                }

                values.push(integrationId);
                const queryText = `UPDATE integration_whatsapp_web SET ${setClauses.join(', ')} WHERE id = $${paramIndex}`;

                try {
                    await db.query(queryText, values);
                    logger.info({
                        integrationId,
                        status,
                        success: true
                    }, 'BD actualizada correctamente');
                } catch (dbError) {
                    logger.error({
                        err: dbError,
                        integrationId,
                        status
                    }, 'Error updating integration status in database');
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
            const { rows } = await db.query(
                `SELECT * FROM whatsapp_web_conversation_states
                 WHERE project_id = $1 AND business_account_id = $2
                   AND phone_number_id = $3 AND user_id = $4
                 LIMIT 1`,
                [integration.project_id, integration.id, integration.phone_number_id, senderJid]
            );
            const conversationState = rows[0] || null;

            logger.info('Estado de conversación verificado');
            logger.info(conversationState);

            if (!conversationState) {
                // Si no existe el registro, crear uno nuevo con el bot activado
                try {
                    await db.query(
                        `INSERT INTO whatsapp_web_conversation_states
                         (project_id, business_account_id, phone_number_id, user_id, bot_active)
                         VALUES ($1, $2, $3, $4, $5)`,
                        [integration.project_id, integration.id, integration.phone_number_id, senderJid, true]
                    );
                } catch (insertError) {
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
        
        // Verificar si el mensaje es del dueño del número
        const connection = this.connections.get(integrationId);
        logger.info('Connection *************');
        logger.info(connection);

        if (!connection) {
            logger.error({
                integrationId,
                senderJid
            }, 'No se encontró la conexión');
            return;
        }

        if (!connection.integration) {
            logger.error({
                integrationId,
                senderJid
            }, 'La conexión no tiene información de integración');
            return;
        }

        // Extraer solo el número del phone_number_id (remover el +)
        const ownerNumber = connection.integration.phone_number_id.replace('+', '');
        
        // Para mensajes enviados (fromMe=true), el remoteJid es el destinatario
        // Para mensajes recibidos (fromMe=false), el remoteJid es el remitente
        const actualSenderNumber = message.key.fromMe 
            ? connection.userInfo.id.split(/[:@]/)[0]  // Si es nuestro mensaje, usar nuestro número
            : message.key.remoteJid.split('@')[0];     // Si es mensaje recibido, usar el número del remitente

        // Un mensaje es del dueño solo si fromMe es true
        const isFromOwner = message.key.fromMe;

        logger.info({
            fromMe: message.key.fromMe,
            actualSenderNumber,
            ownerNumber,
            isFromOwner,
            phone_number_id: connection.integration.phone_number_id,
            userInfoId: connection.userInfo.id,
            remoteJid: message.key.remoteJid
        }, 'Verificando si el mensaje es del dueño');

        if (isFromOwner) {
            // Log de los datos que se van a actualizar
            logger.info({
                project_id: connection.integration.project_id,
                business_account_id: connection.integration.id,
                phone_number_id: connection.integration.phone_number_id,
                user_id: senderJid
            }, 'Datos para actualización en BD');


            try {
                await db.query(
                    `UPDATE whatsapp_web_conversation_states SET bot_active = $1
                     WHERE project_id = $2 AND business_account_id = $3
                       AND phone_number_id = $4 AND user_id = $5`,
                    [false, connection.integration.project_id, connection.integration.id,
                     connection.integration.phone_number_id, senderJid]
                );
            } catch (updateError) {
                logger.error({
                    err: updateError,
                    integrationId,
                    senderJid,
                    errorMessage: updateError.message
                }, 'Error al desactivar el bot');
                return;
            }

            logger.info({
                integrationId,
                senderJid,
                success: true
            }, 'Bot desactivado exitosamente');
            return;
        }
        
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
            let finalMessage = messageContent;
            let imageUrl = null;
            
            // Procesar imagen si existe
            if (message.message?.imageMessage) {
                try {
                    logger.info({
                        integrationId,
                        senderJid,
                        hasImage: true
                    }, 'Procesando imagen recibida');
                    
                    // Obtener la imagen del mensaje
                    const imageMessage = message.message.imageMessage;
                    const imageBuffer = await downloadMediaMessage(message, 'buffer', {}, {
                        logger: logger,
                        reuploadRequest: connection.sock.updateMediaMessage
                    });
                    
                    if (imageBuffer) {
                        // Crear instancia de FileStorage
                        const fileStorage = new FileStorage();
                        
                        // Guardar imagen localmente
                        imageUrl = await fileStorage.saveImage(
                            integration.project_id,
                            imageBuffer,
                            'image/jpeg',
                            `whatsapp_image_${messageId}.jpg`
                        );
                        
                        logger.info({
                            integrationId,
                            senderJid,
                            imageUrl
                        }, 'Imagen guardada exitosamente');
                        
                        // Construir mensaje markdown para el bot
                        finalMessage = `![Imagen](${imageUrl})`;
                        
                        // Si hay caption, agregarlo al mensaje
                        if (imageMessage.caption) {
                            finalMessage += `\n\n${imageMessage.caption}`;
                        }
                    } else {
                        logger.warn({
                            integrationId,
                            senderJid
                        }, 'No se pudo descargar la imagen del mensaje');
                    }
                } catch (imageError) {
                    logger.error({
                        integrationId,
                        senderJid,
                        err: imageError
                    }, 'Error procesando imagen');
                    // Continuar con el mensaje original si falla el procesamiento de imagen
                }
            }
            
            // Crear el FormData primero
            const formData = new FormData();
            formData.append('message', finalMessage);
            formData.append('project_id', integration.project_id);
            formData.append('user_id', senderJid);
            formData.append('source_id', integration.id);
            formData.append('number_phone_agent', integration.phone_number_id);
            formData.append('source', 'whatsapp_web');
            formData.append('name', 'whatsapp_web');
            
            // Si hay imagen, agregar la URL al FormData
            if (imageUrl) {
                formData.append('image_url', imageUrl);
            }

            // Log de los valores de FormData antes de enviar
            logger.info({
                integrationId,
                formData: {
                    message: finalMessage,
                    project_id: integration.project_id,
                    user_id: senderJid,
                    source_id: integration.id,
                    number_phone_agent: integration.phone_number_id,
                    source: 'whatsapp_web',
                    name: 'whatsapp_web',
                    image_url: imageUrl
                }
            }, 'Valores de FormData a enviar a la API de Ublix');
            
            // Llamada a la API usando axios
            const response = await axios.post(
                CHAT_API_URL + '/api/chat/message',
                formData,
                { headers: formData.getHeaders() }
            );

            // Log API response status
            logger.info({
                integrationId,
                apiStatus: response.status,
                apiStatusText: response.statusText || response.statusText
            }, 'Respuesta recibida de API de Ublix');

            if (response.status < 200 || response.status >= 300) {
                throw new Error(`Chat API error: ${response.statusText}`);
            }

            const data = response.data;
            
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
            // Agregar más detalles del error para debug
            const errorDetails = {
                err: error,
                integrationId,
                sender: senderJid,
                message: messageContent,
                errorName: error.name,
                errorMessage: error.message,
                errorStack: error.stack,
                // Detalles adicionales si es error de axios
                ...(error.response && {
                    responseStatus: error.response.status,
                    responseStatusText: error.response.statusText,
                    responseData: error.response.data,
                    responseHeaders: error.response.headers
                }),
                ...(error.config && {
                    requestUrl: error.config.url,
                    requestMethod: error.config.method,
                    requestHeaders: error.config.headers
                })
            };
            
            logger.error(errorDetails, 'Error processing message');
            
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
            // Use the centralized cleanup method
            const success = await this.cleanupConnection(integrationId, connection.sessionDir, 'manual');
            return success;
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
                const { rows: data } = await db.query(
                    'SELECT * FROM integration_whatsapp_web WHERE active = $1',
                    [true]
                );
                
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
        
        // Clear all reconnection timers
        for (const [integrationId, timer] of this.reconnectionTimers.entries()) {
            clearTimeout(timer);
            logger.info(`Cleared reconnection timer for integration ${integrationId}`);
        }
        this.reconnectionTimers.clear();
        this.reconnectionAttempts.clear();
        
        // Release the LISTEN client back to the pool
        if (this.listenerClient) {
            try {
                await this.listenerClient.query('UNLISTEN integration_whatsapp_web_changes');
                this.listenerClient.release();
                logger.info('Released database listener client');
            } catch (err) {
                logger.error({ err }, 'Error releasing listener client');
            }
            this.listenerClient = null;
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

    // Cleanup connection and related resources
    async cleanupConnection(integrationId, sessionDir, reason = 'unknown') {
        try {
            logWithContext('info', 'Iniciando limpieza de conexión', {
                integrationId,
                reason,
                sessionDir
            });
            
            // Clear any pending reconnection timer
            const existingTimer = this.reconnectionTimers.get(integrationId);
            if (existingTimer) {
                clearTimeout(existingTimer);
                this.reconnectionTimers.delete(integrationId);
                logWithContext('info', 'Timer de reconexión cancelado', { integrationId });
            }
            
            // Clear reconnection attempts
            this.reconnectionAttempts.delete(integrationId);
            
            // Update status in database
            const statusMap = {
                'logged_out': 'disconnected',
                'connection_failed': 'error',
                'manual': 'disconnected'
            };
            
            const status = statusMap[reason] || 'disconnected';
            await this.updateIntegrationStatus(integrationId, status);
            
            // Remove from connections map
            if (this.connections.has(integrationId)) {
                const connection = this.connections.get(integrationId);
                
                // Properly close socket if exists
                if (connection.sock) {
                    try {
                        connection.sock.ev.removeAllListeners();
                    } catch (error) {
                        logWithContext('warn', 'Error al cerrar socket', {
                            integrationId,
                            err: error.message
                        });
                    }
                }
                
                this.connections.delete(integrationId);
            }
            
            // Remove session files if reason is logged_out or after multiple 403 errors
            if (reason === 'logged_out' || reason === 'session_cleanup') {
                try {
                    if (sessionDir && fs.existsSync(sessionDir)) {
                        fs.rmSync(sessionDir, { recursive: true, force: true });
                        logWithContext('info', 'Archivos de sesión eliminados', {
                            integrationId,
                            sessionDir,
                            reason
                        });
                    }
                } catch (error) {
                    logWithContext('error', 'Error al eliminar archivos de sesión', {
                        integrationId,
                        sessionDir,
                        err: error.message
                    });
                }
            }
            
            logWithContext('info', 'Limpieza de conexión completada', {
                integrationId,
                reason
            });
            
            return true;
        } catch (error) {
            logWithContext('error', 'Error durante limpieza de conexión', {
                integrationId,
                reason,
                err: error.message
            });
            return false;
        }
    }

    // Manual method to clean corrupted sessions
    async cleanCorruptedSessions() {
        logger.info('Iniciando limpieza manual de sesiones corruptas...');
        
        const corruptedConnections = [];
        
        for (const [integrationId, connection] of this.connections.entries()) {
            const attempts = this.reconnectionAttempts.get(integrationId) || 0;
            
            // Consider a connection corrupted if it has failed multiple times
            if (attempts >= 3 || connection.status === 'error') {
                corruptedConnections.push({
                    integrationId,
                    attempts,
                    status: connection.status,
                    phoneNumberId: connection.integration.phone_number_id
                });
            }
        }
        
        logger.info(`Encontradas ${corruptedConnections.length} conexiones potencialmente corruptas`);
        
        for (const corrupt of corruptedConnections) {
            logger.info(`Limpiando sesión corrupta: ${corrupt.phoneNumberId} (${corrupt.integrationId})`);
            
            const connection = this.connections.get(corrupt.integrationId);
            if (connection) {
                await this.cleanupConnection(corrupt.integrationId, connection.sessionDir, 'session_cleanup');
                
                // Attempt to recreate the connection after cleanup
                setTimeout(async () => {
                    logger.info(`Reintentando conexión limpia para ${corrupt.phoneNumberId}`);
                    await this.createConnection(connection.integration);
                }, 5000);
            }
        }
        
        return corruptedConnections;
    }
    
    // Get reconnection statistics
    getReconnectionStats() {
        const stats = {
            activeTimers: this.reconnectionTimers.size,
            connectionsWithAttempts: this.reconnectionAttempts.size,
            totalAttempts: 0,
            connectionAttempts: []
        };
        
        for (const [integrationId, attempts] of this.reconnectionAttempts.entries()) {
            stats.totalAttempts += attempts;
            stats.connectionAttempts.push({
                integrationId,
                attempts,
                maxAttempts: this.maxReconnectionAttempts,
                hasTimer: this.reconnectionTimers.has(integrationId)
            });
        }
        
        return stats;
    }
}

// Export a singleton instance
const whatsappService = new MultiWhatsAppService();
module.exports = whatsappService;