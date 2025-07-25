# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Información del Proyecto

Este es un servicio de API REST para manejar múltiples conexiones de WhatsApp Web usando la librería Baileys. Está integrado con Supabase para persistencia de datos y optimizado para despliegue en Azure Web App.

## Comandos Principales

```bash
# Desarrollo
npm run dev          # Inicia el servidor con logs formateados (pino-pretty)

# Producción
npm start           # Inicia el servidor en modo producción

# Cliente legacy
npm run client      # Ejecuta cliente simple (index.js)

# Tests
npm test            # No hay tests implementados (retorna 0)
```

## Arquitectura del Sistema

### Componentes Principales

1. **main.js**: Punto de entrada que inicia el servicio WhatsApp y servidor Express
2. **multi-whatsapp-service.js**: Núcleo del servicio que maneja:
   - Múltiples conexiones WhatsApp simultáneas
   - Reconexión automática con backoff exponencial
   - Limpieza de sesiones corruptas
   - Sincronización con Supabase
   - Gestión de imágenes en Supabase Storage
   
3. **api.js**: Define todos los endpoints REST:
   - Gestión de conexiones (`/api/connections/*`)
   - Envío de mensajes (`/api/send-message`, `/api/send-image`)
   - Endpoints de debug (`/api/debug/*`)
   - Documentación Swagger en `/api-docs`

### Base de Datos (Supabase)

Tabla principal: `integration_whatsapp_web`
- Almacena configuración y estado de cada conexión WhatsApp
- Se sincroniza automáticamente con el estado de las conexiones
- Listener en tiempo real para cambios en la base de datos

### Gestión de Sesiones

- Directorio: `whatsapp_sessions/` (local) o `/home/site/wwwroot/whatsapp_sessions` (Azure)
- Cada conexión tiene su propio subdirectorio UUID
- Limpieza automática tras errores 403 repetidos

## Variables de Entorno Requeridas

```env
SUPABASE_URL=<url de tu proyecto Supabase>
SUPABASE_KEY=<clave anon/service de Supabase>
CHAT_API_URL=<URL de API para procesar mensajes entrantes>
PORT=3002
NODE_ENV=development|production
```

## Despliegue en Azure

El proyecto incluye configuración específica para Azure:
- `web.config`: Configuración IIS para Node.js
- `iisnode.yml`: Parámetros de IISNode
- Detección automática del entorno Azure
- Logs estructurados compatibles con Application Insights

## Funcionalidades Clave

### Sistema de Reconexión Inteligente
- Límite de 5 intentos con backoff exponencial
- Delays progresivos: 5s, 10s, 20s, 40s, 80s
- Limpieza automática de sesiones tras múltiples fallos

### Procesamiento de Mensajes
- Deduplicación usando Map con limpieza cada 10 minutos
- Integración con API externa para procesamiento
- Manejo de mensajes de texto e imágenes

### Endpoints de Debug
- `/api/debug/reconnection-stats`: Estadísticas de reconexión
- `/api/debug/clean-corrupted`: Limpieza manual de sesiones

## Estructura de Clases Principales

### MultiWhatsAppService
- `connections`: Map de conexiones activas
- `qrCodes`: Map de códigos QR
- `reconnectionAttempts`: Tracking de intentos de reconexión
- Métodos principales:
  - `initialize()`: Inicializa el servicio
  - `createConnection()`: Crea nueva conexión WhatsApp
  - `sendMessage()`: Envía mensajes de texto
  - `sendImage()`: Envía imágenes
  - `getActiveConnections()`: Lista conexiones activas

### SupabaseImageService
- Gestión de imágenes en Supabase Storage
- Buckets por proyecto
- Métodos: `saveImage()`, `deleteImage()`, `getImageUrl()`

## Notas Importantes

- No hay linter configurado (ESLint/Prettier)
- No hay tests unitarios o de integración
- Usa Baileys (librería no oficial de WhatsApp Web)
- Sistema de reconexión inteligente para evitar bucles infinitos
- Endpoints de debug disponibles para monitoreo en producción