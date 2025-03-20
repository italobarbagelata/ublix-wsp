const express = require('express');
const bodyParser = require('body-parser');
const cors = require('cors');
const fs = require('fs');
const path = require('path');
const dotenv = require('dotenv');

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

// Check if WhatsApp service is initialized
const checkService = (req, res, next) => {
    if (!whatsappService) {
        return res.status(503).json({
            success: false,
            message: 'WhatsApp service not initialized'
        });
    }
    next();
};

// Routes

// Server status
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

// Get all connections
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

// Send message through a specific connection
app.post('/api/send-message', checkService, async (req, res) => {
    try {
        const { phone, message, integrationId } = req.body;
        
        if (!phone || !message || !integrationId) {
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
        
        res.json({
            success: true,
            message: 'Message sent successfully'
        });
    } catch (error) {
        console.error('Error sending message:', error);
        res.status(500).json({
            success: false,
            message: 'Error sending message',
            error: error.message
        });
    }
});

// Send image through a specific connection
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

// Get connection status
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

// Get QR code for a specific connection
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

// Get QR code as an image for a specific connection
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

// Force refresh connection
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
        
        // Fetch the integration data from Supabase
        const { data, error } = await whatsappService.supabase
            .from('integration_whatsapp_business')
            .select('*')
            .eq('id', integrationId)
            .single();
            
        if (error || !data) {
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

// Force QR code generation for a specific connection
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

// Logout and delete session for a specific connection
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

// Start server
const server = app.listen(PORT, () => {
    console.log(`API server running on port ${PORT}`);
    console.log(`- Check status: GET http://localhost:${PORT}/api/status`);
    console.log(`- Get connections: GET http://localhost:${PORT}/api/connections`);
    console.log(`- Send message: POST http://localhost:${PORT}/api/send-message`);
    console.log(`- Send image: POST http://localhost:${PORT}/api/send-image`);
});

// Handle server shutdown
process.on('SIGINT', () => {
    console.log('Shutting down server...');
    server.close(() => {
        console.log('Server shut down.');
        process.exit(0);
    });
});

module.exports = { app, whatsappService }; 