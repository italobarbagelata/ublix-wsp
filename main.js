/**
 * WhatsApp API using Baileys
 * This file starts both the WhatsApp service and the API server
 */

const dotenv = require('dotenv');
const { app } = require('./api');
const whatsappService = require('./multi-whatsapp-service');
const pino = require('pino');

// Configuración del logger
const logger = pino({
    level: process.env.NODE_ENV === 'production' ? 'info' : 'debug',
    ...(process.env.NODE_ENV !== 'production' ? {
        transport: {
            target: 'pino-pretty',
            options: {
                colorize: true,
                translateTime: 'SYS:standard',
                ignore: 'pid,hostname'
            }
        }
    } : {})
});

// Load environment variables
dotenv.config();

async function main() {
    try {
        logger.info('Starting WhatsApp Multi-Connection Service...');

        // Initialize WhatsApp service
        const success = await whatsappService.initialize();

        if (success) {
            logger.info('WhatsApp service initialized successfully');
        } else {
            logger.error('WhatsApp service initialization failed');
            process.exit(1);
        }

        // Start API server
        const PORT = process.env.PORT || 3002;
        const server = app.listen(PORT, () => {
            logger.info(`API server running on port ${PORT}`);
            logger.info('Available endpoints:');
            logger.info(`- Check status: GET http://localhost:${PORT}/api/status`);
            logger.info(`- Get connections: GET http://localhost:${PORT}/api/connections`);
            logger.info(`- Send message: POST http://localhost:${PORT}/api/send-message`);
            logger.info(`- Send image: POST http://localhost:${PORT}/api/send-image`);
            logger.info(`Documentación de Swagger disponible en http://localhost:${PORT}/api-docs`);
        });

        // Configuración de timeouts para Azure
        server.setTimeout(120000); // 2 minutos de timeout
        server.keepAliveTimeout = 65000; // 65 segundos de keep-alive

        // Handle server shutdown
        process.on('SIGINT', () => {
            logger.info('Shutting down server...');
            server.close(() => {
                logger.info('Server shut down.');
                process.exit(0);
            });
        });

        // Manejo específico para Azure
        process.on('SIGTERM', () => {
            logger.info('Received SIGTERM signal from Azure...');
            server.close(() => {
                logger.info('Server shut down gracefully.');
                process.exit(0);
            });
        });

    } catch (error) {
        logger.error({ err: error }, 'Failed to initialize WhatsApp service');
        process.exit(1);
    }
}

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

main(); 