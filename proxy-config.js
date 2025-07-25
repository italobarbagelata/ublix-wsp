// Configuración de proxy para WhatsApp Web
// NOTA: Requiere instalar: npm install https-proxy-agent

const { HttpsProxyAgent } = require('https-proxy-agent');

// Configuración de proxies rotativos
const PROXY_LIST = [
    // Añade tus proxies aquí
    // 'http://user:pass@proxy1.com:8080',
    // 'http://user:pass@proxy2.com:8080',
];

let currentProxyIndex = 0;

function getNextProxy() {
    if (PROXY_LIST.length === 0) return null;
    const proxy = PROXY_LIST[currentProxyIndex];
    currentProxyIndex = (currentProxyIndex + 1) % PROXY_LIST.length;
    return proxy;
}

function getProxyAgent() {
    const proxyUrl = getNextProxy();
    if (!proxyUrl) return null;
    
    console.log(`Usando proxy: ${proxyUrl}`);
    return new HttpsProxyAgent(proxyUrl);
}

module.exports = { getProxyAgent };