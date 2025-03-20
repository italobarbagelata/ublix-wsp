# WhatsApp Multi-Connection API

API basada en Baileys para manejar múltiples conexiones de WhatsApp, integrada con Supabase para la gestión de conexiones.

## Características

- Soporte para múltiples conexiones de WhatsApp simultáneas
- Integración con Supabase para almacenar y gestionar las conexiones
- API RESTful para enviar mensajes y gestionar conexiones
- Sincronización automática de estado con Supabase
- Gestión de sesiones persistentes
- Generación de códigos QR para autenticación

## Requisitos

- Node.js 14+
- Una cuenta en Supabase con la tabla `integration_whatsapp_business` configurada
- Variables de entorno configuradas

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

## Estructura de la base de datos

La aplicación espera una tabla en Supabase con la siguiente estructura:

```sql
create table public.integration_whatsapp_business (
  id uuid not null default gen_random_uuid (),
  project_id uuid not null,
  phone_number_id character varying(255) not null,
  access_token text not null,
  business_account_id character varying(255) null,
  active boolean null default true,
  created_at timestamp with time zone not null default now(),
  updated_at timestamp with time zone not null default now(),
  constraint integration_whatsapp_business_pkey primary key (id)
);
```

## Uso

### Iniciar el servidor

```bash
npm start
```

Esto iniciará el servicio de WhatsApp y el servidor API en el puerto especificado (por defecto 3002).

### Endpoints de la API

#### Obtener estado del servidor
```
GET /api/status
```

#### Obtener todas las conexiones activas
```
GET /api/connections
```

#### Obtener detalles de una conexión específica
```
GET /api/connections/:integrationId
```

#### Obtener código QR para una conexión (datos)
```
GET /api/connections/:integrationId/qr
```
Respuesta:
```json
{
  "success": true,
  "qrCode": "string-del-codigo-qr"
}
```

#### Obtener código QR como imagen
```
GET /api/connections/:integrationId/qr-image
```
Respuesta: Imagen PNG del código QR

#### Enviar mensaje de texto
```
POST /api/send-message
```
Cuerpo de la solicitud:
```json
{
  "integrationId": "00000000-0000-0000-0000-000000000000",
  "phone": "123456789",
  "message": "Hola, este es un mensaje de prueba"
}
```

#### Enviar imagen
```
POST /api/send-image
```
Cuerpo de la solicitud:
```json
{
  "integrationId": "00000000-0000-0000-0000-000000000000",
  "phone": "123456789",
  "image": "/ruta/a/imagen.jpg",
  "caption": "Descripción opcional de la imagen"
}
```

#### Actualizar/Reiniciar una conexión
```
POST /api/connections/:integrationId/refresh
```

#### Cerrar sesión y eliminar datos de una conexión
```
POST /api/connections/:integrationId/logout
```

## Integración con chatbot

Para integrar con un chatbot basado en Python o LangChain, puedes modificar el método `processIncomingMessage` en el archivo `multi-whatsapp-service.js`. Este método se llama cada vez que se recibe un mensaje en cualquiera de las conexiones activas.

## Licencia

ISC 