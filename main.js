/**
 * WhatsApp API using Baileys
 * This file starts both the WhatsApp service and the API server
 */

const dotenv = require('dotenv');

// Load environment variables
dotenv.config();

console.log('Starting WhatsApp Multi-Connection Service...');

// Import the WhatsApp service
const whatsappService = require('./multi-whatsapp-service');

// Initialize the WhatsApp service
whatsappService.initialize()
    .then(success => {
        if (success) {
            console.log('WhatsApp service initialized successfully');
        } else {
            console.error('WhatsApp service initialization failed');
        }
        
        // Start the API server
        const { app } = require('./api');
        
        console.log('WhatsApp service and API server are running...');
    })
    .catch(error => {
        console.error('Failed to initialize WhatsApp service:', error);
        process.exit(1);
    }); 