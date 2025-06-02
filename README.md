# WhatsApp Multi-Connection API

API basada en Baileys para manejar múltiples conexiones de WhatsApp, integrada con Supabase para la gestión de conexiones.

## Características

- Soporte para múltiples conexiones de WhatsApp simultáneas
- Integración con Supabase para almacenar y gestionar las conexiones
- API RESTful para enviar mensajes y gestionar conexiones
- Sincronización automática de estado con Supabase
- Gestión de sesiones persistentes
- Generación de códigos QR para autenticación
- **🆕 Manejo inteligente de errores 403 y sesiones corruptas**
- **🆕 Sistema de reconexión con backoff exponencial**
- **🆕 Limpieza automática de archivos de sesión corruptos**
- **🆕 Endpoints de debug para monitoreo web**

## Requisitos

- Node.js 14+
- Una cuenta en Supabase con la tabla `integration_whatsapp_web` configurada
- Variables de entorno configuradas
- Azure Web App (para producción)

## Instalación

1. Clona este repositorio
2. Instala las dependencias:

```bash
npm install
```

3. Copia `.env.example` a `.env` y configura las variables de entorno:

```bash
cp .env.example .env
```

4. Edita el archivo `.env` con tus credenciales de Supabase

## Mejoras en el Manejo de Errores

### Problema Anterior
Los errores 403 "Connection Failure" causaban bucles infinitos de reconexión, consumiendo recursos y logs.

### Solución Implementada
- **Límite de reintentos**: Máximo 5 intentos de reconexión por integración
- **Backoff exponencial**: Delays que aumentan progresivamente (5s, 10s, 20s, 40s, 80s)
- **Limpieza automática**: Después de 2 errores 403, se eliminan archivos de sesión corruptos
- **Detección inteligente**: Diferenciación entre errores temporales y permanentes

## Estructura de la base de datos

La aplicación espera una tabla en Supabase con la siguiente estructura:

```sql
create table public.integration_whatsapp_web (
  id uuid not null default gen_random_uuid (),
  project_id uuid not null,
  phone_number_id character varying(255) not null,
  access_token text not null,
  business_account_id character varying(255) null,
  active boolean null default true,
  status character varying(50) null default 'disconnected',
  created_at timestamp with time zone not null default now(),
  updated_at timestamp with time zone not null default now(),
  connected_at timestamp with time zone null,
  last_connected_at timestamp with time zone null,
  profile_name character varying(255) null,
  profile_id character varying(255) null,
  constraint integration_whatsapp_web_pkey primary key (id)
);
```

## Despliegue en Azure Web App

### Variables de Entorno en Azure
```env
# Supabase
SUPABASE_URL=tu-url-de-supabase
SUPABASE_KEY=tu-clave-de-supabase

# API Chat (para procesamiento de mensajes)
CHAT_API_URL=tu-api-de-chat

# Configuración del servidor
PORT=3002
NODE_ENV=production

# Directorio de sesiones (Azure)
BASE_SESSION_DIR=/home/site/wwwroot/whatsapp_sessions

# URL del sitio en Azure
WEBSITE_SITE_NAME=tu-app-name
```

### Configuración de Azure
El servicio está optimizado para Azure Web App:
- Detección automática del entorno Azure
- Directorio de sesiones configurado para el sistema de archivos persistente
- Timeouts optimizados para el entorno de Azure
- Logs estructurados compatibles con Azure Application Insights

## Uso

### Iniciar el servidor

```bash
npm start
```

Esto iniciará el servicio de WhatsApp y el servidor API en el puerto especificado (por defecto 3002).

### Endpoints de la API

#### Endpoints Principales

##### Obtener estado del servidor
```
GET /api/status
```

##### Obtener todas las conexiones activas
```
GET /api/connections
```

##### Obtener detalles de una conexión específica
```
GET /api/connections/:integrationId
```

##### Obtener código QR para una conexión (datos)
```
GET /api/connections/:integrationId/qr
```

##### Obtener código QR como imagen
```
GET /api/connections/:integrationId/qr-image
```

##### Refrescar una conexión
```
POST /api/connections/:integrationId/refresh
```

##### Generar nuevo código QR
```
POST /api/connections/:integrationId/generate-qr
```

##### Cerrar sesión y eliminar archivos
```
POST /api/connections/:integrationId/logout
```

#### Endpoints de Debug y Monitoreo

##### Obtener estadísticas de reconexión
```
GET /api/debug/reconnection-stats
```
Retorna información sobre intentos de reconexión activos, timers programados y estadísticas de fallos.

**Respuesta ejemplo:**
```json
{
  "success": true,
  "stats": {
    "activeTimers": 2,
    "connectionsWithAttempts": 3,
    "totalAttempts": 8,
    "connectionAttempts": [
      {
        "integrationId": "uuid-1",
        "attempts": 3,
        "maxAttempts": 5,
        "hasTimer": true
      }
    ]
  }
}
```

##### Limpiar sesiones corruptas
```
POST /api/debug/clean-corrupted
```
Identifica y limpia automáticamente conexiones que han fallado múltiples veces.

**Respuesta ejemplo:**
```json
{
  "success": true,
  "message": "Corrupted sessions cleanup initiated",
  "corruptedConnections": [
    {
      "integrationId": "uuid-1",
      "attempts": 4,
      "status": "error",
      "phoneNumberId": "+123456789"
    }
  ]
}
```

#### Enviar mensaje
```
POST /api/send-message
Content-Type: application/json

{
  "integrationId": "uuid-de-la-integracion",
  "to": "numero-telefono",
  "message": "Hola mundo"
}
```

#### Enviar imagen
```
POST /api/send-image
Content-Type: multipart/form-data

integrationId: uuid-de-la-integracion
to: numero-telefono
caption: texto-opcional
image: archivo-imagen
```

## Solución de Problemas en Azure

### Error 403 "Connection Failure"

Este error suele indicar que:
1. La sesión de WhatsApp Web ha expirado
2. El usuario cerró sesión desde el teléfono
3. Los archivos de sesión están corruptos

**Solución automática**: El sistema maneja estos errores automáticamente:
- Después de 2 intentos fallidos, limpia los archivos de sesión
- Usa backoff exponencial para evitar spam de reconexiones
- Limita a 5 intentos máximos por integración

**Solución manual usando API**:
```bash
# Verificar estado de reconexiones
curl https://tu-app.azurewebsites.net/api/debug/reconnection-stats

# Limpiar sesiones corruptas
curl -X POST https://tu-app.azurewebsites.net/api/debug/clean-corrupted

# Refrescar conexión específica
curl -X POST https://tu-app.azurewebsites.net/api/connections/{integrationId}/refresh
```

### Bucles de Reconexión

**Síntomas**: Logs repetitivos de "Intentando reconexión" en Azure Application Insights

**Solución**: El nuevo sistema previene bucles infinitos con:
- Límites de reintentos
- Delays progresivos
- Limpieza automática de sesiones problemáticas

**Monitoreo en Azure**:
- Usa Azure Application Insights para ver logs estructurados
- Configura alertas en métricas de error
- Revisa el endpoint `/api/debug/reconnection-stats` regularmente

### Verificar Estado del Servicio

```bash
# Estado del servicio
curl https://tu-app.azurewebsites.net/api/status

# Estadísticas de reconexión
curl https://tu-app.azurewebsites.net/api/debug/reconnection-stats

# Lista de conexiones
curl https://tu-app.azurewebsites.net/api/connections
```

## Monitoreo en Producción

### Azure Application Insights
El servicio genera logs estructurados compatibles con Application Insights:

```json
{
  "level": "INFO",
  "service": "whatsapp-service",
  "integrationId": "uuid",
  "phoneNumberId": "+123456789",
  "message": "Conectado a WhatsApp exitosamente"
}
```

### Alertas Recomendadas
Configura alertas en Azure para:
- Errores de conexión frecuentes
- Número de intentos de reconexión alto
- Fallos en procesamiento de mensajes

### Dashboard de Monitoreo
Puedes crear consultas KQL en Application Insights:

```kql
// Errores de conexión por hora
traces
| where message contains "Connection Failure"
| summarize count() by bin(timestamp, 1h)

// Estado de conexiones
traces
| where message contains "Conectado a WhatsApp"
| summarize count() by tostring(customDimensions.phoneNumberId)
```

## Variables de Entorno

```env
# Supabase
SUPABASE_URL=tu-url-de-supabase
SUPABASE_KEY=tu-clave-de-supabase

# API Chat (para procesamiento de mensajes)
CHAT_API_URL=tu-api-de-chat

# Configuración del servidor
PORT=3002
NODE_ENV=production

# Azure Web App (se configura automáticamente)
WEBSITE_SITE_NAME=tu-app-name
BASE_SESSION_DIR=/home/site/wwwroot/whatsapp_sessions
```

## Desarrollo

### Ejecutar en modo desarrollo
```bash
npm run dev
```

### Estructura del Proyecto
```
├── main.js                 # Punto de entrada principal
├── multi-whatsapp-service.js # Lógica principal del servicio
├── api.js                  # Endpoints de la API REST
├── index.js                # Cliente simple (legacy)
├── whatsapp_sessions/      # Archivos de sesión de WhatsApp
└── README.md              # Documentación
```

## Contribuir

1. Fork el proyecto
2. Crea una rama para tu feature (`git checkout -b feature/AmazingFeature`)
3. Commit tus cambios (`git commit -m 'Add some AmazingFeature'`)
4. Push a la rama (`git push origin feature/AmazingFeature`)
5. Abre un Pull Request

## Licencia

Este proyecto está bajo la Licencia ISC. 