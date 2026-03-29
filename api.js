const express = require('express');
const bodyParser = require('body-parser');
const cors = require('cors');
const fs = require('fs');
const path = require('path');
const dotenv = require('dotenv');
const swaggerJsDoc = require('swagger-jsdoc');
const swaggerUi = require('swagger-ui-express');
const pino = require('pino');
const db = require('./db');

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

// Load environment variables
dotenv.config();

// Import the WhatsApp service
const whatsappService = require('./multi-whatsapp-service');

// Create Express app
const app = express();
const PORT = process.env.PORT || 3002;

// Middleware
app.use(bodyParser.json());
app.use(cors());
app.use('/uploads', express.static(path.join(__dirname, process.env.FILE_STORAGE_DIR || 'uploads')));

// Configuración de Swagger
const swaggerOptions = {
  definition: {
    openapi: '3.0.0',
    info: {
      title: 'WhatsApp API',
      version: '1.0.0',
      description: 'API para interactuar con WhatsApp usando Baileys',
      contact: {
        name: 'API Support',
      },
    },
    servers: [
      {
        url: `http://localhost:${PORT}`,
        description: 'Servidor de desarrollo',
      },
    ],
  },
  apis: ['./api.js'], // Archivos que contienen anotaciones JSDoc
};

// Check if WhatsApp service is initialized
const checkService = (req, res, next) => {
    if (!whatsappService) {
        logger.error('WhatsApp service not initialized');
        return res.status(503).json({
            success: false,
            message: 'WhatsApp service not initialized'
        });
    }
    next();
};

// Routes

/**
 * @swagger
 * /api/status:
 *   get:
 *     summary: Obtener el estado del servidor
 *     description: Retorna el estado del servidor y la información de las conexiones de WhatsApp activas
 *     responses:
 *       200:
 *         description: Estado del servidor
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 success:
 *                   type: boolean
 *                 status:
 *                   type: string
 *                 whatsapp_service_initialized:
 *                   type: boolean
 *                 active_connections:
 *                   type: integer
 *                 connections:
 *                   type: array
 */
app.get('/api/status', (req, res) => {
    const connections = whatsappService ? whatsappService.getActiveConnections() : [];
    res.json({
        success: true,
        status: 'online',
        whatsapp_service_initialized: !!whatsappService,
        active_connections: connections.length,
        connections
    });
});

/**
 * @swagger
 * /api/connections:
 *   get:
 *     summary: Obtener todas las conexiones activas
 *     description: Retorna información sobre todas las conexiones de WhatsApp activas
 *     responses:
 *       200:
 *         description: Lista de conexiones activas
 *       503:
 *         description: Servicio de WhatsApp no inicializado
 */
app.get('/api/connections', checkService, (req, res) => {
    try {
        const connections = whatsappService.getActiveConnections();
        res.json({
            success: true,
            connections
        });
    } catch (error) {
        console.error('Error getting connections:', error);
        res.status(500).json({
            success: false,
            message: 'Error getting connections',
            error: error.message
        });
    }
});

/**
 * @swagger
 * /api/send-message:
 *   post:
 *     summary: Enviar un mensaje de texto
 *     description: Envía un mensaje de texto a través de una conexión específica de WhatsApp
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required:
 *               - phone
 *               - message
 *               - integrationId
 *             properties:
 *               phone:
 *                 type: string
 *                 description: Número de teléfono con o sin formato @s.whatsapp.net
 *               message:
 *                 type: string
 *                 description: Texto del mensaje a enviar
 *               integrationId:
 *                 type: string
 *                 description: ID de la conexión de WhatsApp a utilizar
 *     responses:
 *       200:
 *         description: Mensaje enviado correctamente
 *       400:
 *         description: Faltan parámetros requeridos
 *       500:
 *         description: Error al enviar mensaje
 *       503:
 *         description: Servicio de WhatsApp no inicializado
 */
app.post('/api/send-message', checkService, async (req, res) => {
    try {
        const { phone, message, integrationId } = req.body;
        
        if (!phone || !message || !integrationId) {
            logger.warn('Missing required parameters for send-message');
            return res.status(400).json({
                success: false,
                message: 'Phone number, message, and integrationId are required'
            });
        }
        
        // Format phone number (add @s.whatsapp.net if not present)
        const formattedPhone = phone.includes('@') 
            ? phone 
            : `${phone.replace(/[^0-9]/g, '')}@s.whatsapp.net`;
        
        // Send message
        await whatsappService.sendMessage(integrationId, formattedPhone, message);
        
        logger.info({ integrationId, phone: formattedPhone }, 'Message sent successfully');
        
        res.json({
            success: true,
            message: 'Message sent successfully'
        });
    } catch (error) {
        logger.error({ err: error, integrationId: req.body.integrationId }, 'Error sending message');
        res.status(500).json({
            success: false,
            message: 'Error sending message',
            error: error.message
        });
    }
});

/**
 * @swagger
 * /api/send-image:
 *   post:
 *     summary: Enviar una imagen
 *     description: Envía una imagen a través de una conexión específica de WhatsApp
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required:
 *               - phone
 *               - image
 *               - integrationId
 *             properties:
 *               phone:
 *                 type: string
 *                 description: Número de teléfono con o sin formato @s.whatsapp.net
 *               image:
 *                 type: string
 *                 description: Ruta de la imagen a enviar
 *               caption:
 *                 type: string
 *                 description: Texto opcional para la imagen
 *               integrationId:
 *                 type: string
 *                 description: ID de la conexión de WhatsApp a utilizar
 *     responses:
 *       200:
 *         description: Imagen enviada correctamente
 *       400:
 *         description: Faltan parámetros requeridos
 *       404:
 *         description: Archivo de imagen no encontrado
 *       500:
 *         description: Error al enviar imagen
 *       503:
 *         description: Servicio de WhatsApp no inicializado
 */
app.post('/api/send-image', checkService, async (req, res) => {
    try {
        const { phone, image, caption, integrationId } = req.body;
        
        if (!phone || !image || !integrationId) {
            return res.status(400).json({
                success: false,
                message: 'Phone number, image path, and integrationId are required'
            });
        }
        
        // Format phone number
        const formattedPhone = phone.includes('@') 
            ? phone 
            : `${phone.replace(/[^0-9]/g, '')}@s.whatsapp.net`;
        
        // Check if image exists
        if (!fs.existsSync(image)) {
            return res.status(404).json({
                success: false,
                message: 'Image file not found'
            });
        }
        
        // Send image
        await whatsappService.sendImage(integrationId, formattedPhone, image, caption || '');
        
        res.json({
            success: true,
            message: 'Image sent successfully'
        });
    } catch (error) {
        console.error('Error sending image:', error);
        res.status(500).json({
            success: false,
            message: 'Error sending image',
            error: error.message
        });
    }
});

/**
 * @swagger
 * /api/connections/{integrationId}:
 *   get:
 *     summary: Obtener estado de una conexión
 *     description: Obtiene el estado de una conexión específica de WhatsApp
 *     parameters:
 *       - in: path
 *         name: integrationId
 *         required: true
 *         schema:
 *           type: string
 *         description: ID de la conexión
 *     responses:
 *       200:
 *         description: Estado de la conexión
 *       404:
 *         description: Conexión no encontrada
 *       500:
 *         description: Error al obtener estado
 *       503:
 *         description: Servicio de WhatsApp no inicializado
 */
app.get('/api/connections/:integrationId', checkService, async (req, res) => {
    try {
        const { integrationId } = req.params;
        const status = whatsappService.getConnectionStatus(integrationId);
        
        if (!status.exists) {
            return res.status(404).json({
                success: false,
                message: 'Connection not found'
            });
        }
        
        res.json({
            success: true,
            connection: status
        });
    } catch (error) {
        console.error('Error getting connection status:', error);
        res.status(500).json({
            success: false,
            message: 'Error getting connection status',
            error: error.message
        });
    }
});

/**
 * @swagger
 * /api/connections/{integrationId}/qr:
 *   get:
 *     summary: Obtener código QR
 *     description: Obtiene el código QR para una conexión específica
 *     parameters:
 *       - in: path
 *         name: integrationId
 *         required: true
 *         schema:
 *           type: string
 *         description: ID de la conexión
 *     responses:
 *       200:
 *         description: Código QR
 *       404:
 *         description: Código QR no disponible
 *       500:
 *         description: Error al obtener código QR
 *       503:
 *         description: Servicio de WhatsApp no inicializado
 */
app.get('/api/connections/:integrationId/qr', checkService, async (req, res) => {
    try {
        const { integrationId } = req.params;
        const qrCode = whatsappService.getQRCode(integrationId);
        
        if (!qrCode) {
            return res.status(404).json({
                success: false,
                message: 'QR code not available for this connection'
            });
        }
        
        res.json({
            success: true,
            qrCode
        });
    } catch (error) {
        console.error('Error getting QR code:', error);
        res.status(500).json({
            success: false,
            message: 'Error getting QR code',
            error: error.message
        });
    }
});

/**
 * @swagger
 * /api/connections/{integrationId}/qr-image:
 *   get:
 *     summary: Obtener imagen de código QR
 *     description: Obtiene el código QR como imagen para una conexión específica
 *     parameters:
 *       - in: path
 *         name: integrationId
 *         required: true
 *         schema:
 *           type: string
 *         description: ID de la conexión
 *     responses:
 *       200:
 *         description: Imagen del código QR (PNG)
 *         content:
 *           image/png:
 *             schema:
 *               type: string
 *               format: binary
 *       404:
 *         description: Código QR no disponible
 *       500:
 *         description: Error al generar imagen
 *       503:
 *         description: Servicio de WhatsApp no inicializado
 */
app.get('/api/connections/:integrationId/qr-image', checkService, async (req, res) => {
    try {
        const { integrationId } = req.params;
        const qrCode = whatsappService.getQRCode(integrationId);
        
        if (!qrCode) {
            return res.status(404).json({
                success: false,
                message: 'QR code not available for this connection'
            });
        }
        
        // Create QR code as SVG string
        const QRCode = require('qrcode');
        const qrImage = await QRCode.toDataURL(qrCode);
        
        // Set headers for image
        res.set('Content-Type', 'image/png');
        
        // Send QR code image
        const dataUrl = qrImage.split(',')[1];
        const img = Buffer.from(dataUrl, 'base64');
        res.send(img);
    } catch (error) {
        console.error('Error generating QR image:', error);
        res.status(500).json({
            success: false,
            message: 'Error generating QR image',
            error: error.message
        });
    }
});

/**
 * @swagger
 * /api/connections/{integrationId}/refresh:
 *   post:
 *     summary: Refrescar conexión
 *     description: Fuerza el reinicio de una conexión específica
 *     parameters:
 *       - in: path
 *         name: integrationId
 *         required: true
 *         schema:
 *           type: string
 *         description: ID de la conexión
 *     responses:
 *       200:
 *         description: Proceso de refresco iniciado
 *       404:
 *         description: Conexión no encontrada
 *       500:
 *         description: Error al refrescar conexión
 *       503:
 *         description: Servicio de WhatsApp no inicializado
 */
app.post('/api/connections/:integrationId/refresh', checkService, async (req, res) => {
    try {
        const { integrationId } = req.params;
        
        // Get the current connection
        const connections = whatsappService.getActiveConnections();
        const connection = connections.find(conn => conn.id === integrationId);
        
        if (!connection) {
            return res.status(404).json({
                success: false,
                message: 'Connection not found'
            });
        }
        
        // Remove and recreate the connection
        await whatsappService.removeConnection(integrationId);
        
        // Fetch the integration data from PostgreSQL
        const { rows } = await db.query(
            'SELECT * FROM integration_whatsapp_web WHERE id = $1 LIMIT 1',
            [integrationId]
        );
        const data = rows[0];

        if (!data) {
            return res.status(404).json({
                success: false,
                message: 'Integration not found in database'
            });
        }
        
        // Recreate the connection
        await whatsappService.createConnection(data);
        
        res.json({
            success: true,
            message: 'Connection refresh initiated'
        });
    } catch (error) {
        console.error('Error refreshing connection:', error);
        res.status(500).json({
            success: false,
            message: 'Error refreshing connection',
            error: error.message
        });
    }
});

/**
 * @swagger
 * /api/connections/{integrationId}/generate-qr:
 *   post:
 *     summary: Generar código QR
 *     description: Fuerza la generación de un nuevo código QR para una conexión
 *     parameters:
 *       - in: path
 *         name: integrationId
 *         required: true
 *         schema:
 *           type: string
 *         description: ID de la conexión
 *     responses:
 *       200:
 *         description: Generación de código QR iniciada
 *       404:
 *         description: Conexión no encontrada
 *       500:
 *         description: Error al generar código QR
 *       503:
 *         description: Servicio de WhatsApp no inicializado
 */
app.post('/api/connections/:integrationId/generate-qr', checkService, async (req, res) => {
    try {
        const { integrationId } = req.params;
        
        // Force generate QR code
        const success = await whatsappService.forceGenerateQR(integrationId);
        
        if (!success) {
            return res.status(404).json({
                success: false,
                message: 'Connection not found or QR code could not be generated'
            });
        }
        
        res.json({
            success: true,
            message: 'QR code generation initiated'
        });
    } catch (error) {
        console.error('Error generating QR code:', error);
        res.status(500).json({
            success: false,
            message: 'Error generating QR code',
            error: error.message
        });
    }
});

/**
 * @swagger
 * /api/connections/{integrationId}/logout:
 *   post:
 *     summary: Cerrar sesión
 *     description: Cierra sesión y elimina los archivos de sesión para una conexión
 *     parameters:
 *       - in: path
 *         name: integrationId
 *         required: true
 *         schema:
 *           type: string
 *         description: ID de la conexión
 *     responses:
 *       200:
 *         description: Sesión cerrada y eliminada correctamente
 *       404:
 *         description: Conexión no encontrada
 *       500:
 *         description: Error al cerrar sesión
 *       503:
 *         description: Servicio de WhatsApp no inicializado
 */
app.post('/api/connections/:integrationId/logout', checkService, async (req, res) => {
    try {
        const { integrationId } = req.params;
        
        // Remove the connection
        const success = await whatsappService.removeConnection(integrationId);
        
        if (!success) {
            return res.status(404).json({
                success: false,
                message: 'Connection not found or could not be removed'
            });
        }
        
        // Delete session files
        const sessionDir = path.join(process.env.BASE_SESSION_DIR || './whatsapp_sessions', integrationId.toString());
        if (fs.existsSync(sessionDir)) {
            fs.rmSync(sessionDir, { recursive: true, force: true });
        }
        
        res.json({
            success: true,
            message: 'Logged out successfully. Session deleted.'
        });
    } catch (error) {
        console.error('Error logging out:', error);
        res.status(500).json({
            success: false,
            message: 'Error logging out',
            error: error.message
        });
    }
});

/**
 * @swagger
 * /api/debug/reconnection-stats:
 *   get:
 *     summary: Obtener estadísticas de reconexión
 *     description: Retorna información sobre intentos de reconexión activos
 *     responses:
 *       200:
 *         description: Estadísticas de reconexión
 *       503:
 *         description: Servicio de WhatsApp no inicializado
 */
app.get('/api/debug/reconnection-stats', checkService, (req, res) => {
    try {
        const stats = whatsappService.getReconnectionStats();
        res.json({
            success: true,
            stats
        });
    } catch (error) {
        console.error('Error getting reconnection stats:', error);
        res.status(500).json({
            success: false,
            message: 'Error getting reconnection stats',
            error: error.message
        });
    }
});

/**
 * @swagger
 * /api/debug/clean-corrupted:
 *   post:
 *     summary: Limpiar sesiones corruptas
 *     description: Identifica y limpia conexiones que han fallado múltiples veces
 *     responses:
 *       200:
 *         description: Proceso de limpieza iniciado
 *       503:
 *         description: Servicio de WhatsApp no inicializado
 */
app.post('/api/debug/clean-corrupted', checkService, async (req, res) => {
    try {
        const corruptedConnections = await whatsappService.cleanCorruptedSessions();
        res.json({
            success: true,
            message: 'Corrupted sessions cleanup initiated',
            corruptedConnections
        });
    } catch (error) {
        console.error('Error cleaning corrupted sessions:', error);
        res.status(500).json({
            success: false,
            message: 'Error cleaning corrupted sessions',
            error: error.message
        });
    }
});

/**
 * @swagger
 * /api/debug/circuit-breaker:
 *   get:
 *     summary: Obtener estado del circuit breaker
 *     description: Retorna información sobre el estado del circuit breaker global y local
 *     responses:
 *       200:
 *         description: Estado del circuit breaker
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 success:
 *                   type: boolean
 *                 circuitBreakerStatus:
 *                   type: object
 *       503:
 *         description: Servicio de WhatsApp no inicializado
 */
app.get('/api/debug/circuit-breaker', checkService, (req, res) => {
    try {
        const now = Date.now();
        const circuitBreakerStatus = {
            globalErrorCount: whatsappService.globalErrorCount,
            lastGlobalReset: whatsappService.lastGlobalReset,
            timeSinceLastReset: now - whatsappService.lastGlobalReset,
            isGlobalCircuitOpen: whatsappService.globalErrorCount > 20,
            circuitBreakerDelayMs: whatsappService.circuitBreakerDelay,
            activeConnections: whatsappService.connections.size,
            connectionStates: []
        };

        // Add status for each connection
        for (const [integrationId, connection] of whatsappService.connections.entries()) {
            const lastFailure = whatsappService.lastFailureTime.get(integrationId) || 0;
            const timeSinceLastFailure = now - lastFailure;
            const isLocalCircuitOpen = timeSinceLastFailure < whatsappService.circuitBreakerDelay;
            
            circuitBreakerStatus.connectionStates.push({
                integrationId,
                lastFailureTime: lastFailure,
                timeSinceLastFailureMs: timeSinceLastFailure,
                isLocalCircuitOpen,
                reconnectionAttempts: whatsappService.reconnectionAttempts.get(integrationId) || 0,
                hasActiveTimer: whatsappService.reconnectionTimers.has(integrationId)
            });
        }

        res.json({
            success: true,
            circuitBreakerStatus
        });
    } catch (error) {
        console.error('Error getting circuit breaker status:', error);
        res.status(500).json({
            success: false,
            message: 'Error getting circuit breaker status',
            error: error.message
        });
    }
});

// Configuración de Swagger
const swaggerDocs = swaggerJsDoc(swaggerOptions);
app.use('/api-docs', swaggerUi.serve, swaggerUi.setup(swaggerDocs));

// Handle uncaught exceptions
process.on('uncaughtException', (error) => {
    logger.fatal(error, 'Uncaught Exception');
    process.exit(1);
});

// Handle unhandled promise rejections
process.on('unhandledRejection', (reason, promise) => {
    logger.fatal({ reason, promise }, 'Unhandled Promise Rejection');
    process.exit(1);
});

module.exports = { app, whatsappService }; 