/*
 * (c) 2026 Heady Systems LLC.
 * Production server for headysystems -- Static files + API proxy + health check
 */
const http = require('http');
const https = require('https');
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

const PORT = process.env.PORT || 8080;
const API_TARGET = process.env.API_TARGET || 'https://manager.headysystems.com';
const DIST = path.join(__dirname, 'dist');
const SERVICE_NAME = 'headysystems';

// ─── CORS Whitelist (replaces wildcard '*') ──────────────────────────────────
const ALLOWED_ORIGINS = new Set([
  'https://headyme.com',
  'https://www.headyme.com',
  'https://headysystems.com',
  'https://www.headysystems.com',
  'https://headyconnection.org',
  'https://www.headyconnection.org',
  'https://headybuddy.org',
  'https://www.headybuddy.org',
  'https://headymcp.com',
  'https://www.headymcp.com',
  'https://headyio.com',
  'https://www.headyio.com',
  'https://headybot.com',
  'https://www.headybot.com',
  'https://headyapi.com',
  'https://www.headyapi.com',
  'https://heady-ai.com',
  'https://www.heady-ai.com',
  'https://auth.headysystems.com',
  'https://admin.headysystems.com',
  'https://api.headysystems.com',
  'https://headyme-site-667608982461.us-central1.run.app',
  'https://heady-edge-gateway-609590223909.us-central1.run.app',
]);

function isOriginAllowed(origin) {
  if (!origin) return false;
  if (ALLOWED_ORIGINS.has(origin)) return true;
  // Allow Cloud Run preview URLs
  if (/\.us-central1\.run\.app$/.test(origin)) return true;
  return false;
}

function getCorsHeaders(reqOrigin) {
  const headers = {
    'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, PATCH, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization, X-Heady-API-Key',
    'Access-Control-Max-Age': '86400',
  };
  if (isOriginAllowed(reqOrigin)) {
    headers['Access-Control-Allow-Origin'] = reqOrigin;
    headers['Access-Control-Allow-Credentials'] = 'true';
  }
  return headers;
}
// ─── End CORS ────────────────────────────────────────────────────────────────

const MIME = {
  '.html': 'text/html',
  '.css': 'text/css',
  '.js': 'application/javascript',
  '.mjs': 'application/javascript',
  '.json': 'application/json',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.webp': 'image/webp',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.ttf': 'font/ttf',
  '.eot': 'application/vnd.ms-fontobject',
  '.map': 'application/json',
  '.txt': 'text/plain',
  '.xml': 'application/xml',
  '.webmanifest': 'application/manifest+json',
};

const COMPRESSIBLE = new Set([
  'text/html', 'text/css', 'application/javascript', 'application/json',
  'image/svg+xml', 'text/plain', 'application/xml', 'application/manifest+json',
]);

const SECURITY_HEADERS = {
  'X-Content-Type-Options': 'nosniff',
  'X-Frame-Options': 'SAMEORIGIN',
  'X-XSS-Protection': '1; mode=block',
  'Referrer-Policy': 'strict-origin-when-cross-origin',
  'Strict-Transport-Security': 'max-age=31536000; includeSubDomains',
};

function getCacheControl(ext) {
  if (ext === '.html' || ext === '') return 'no-cache, must-revalidate';
  if (['.js', '.css', '.mjs'].includes(ext)) return 'public, max-age=31536000, immutable';
  if (['.woff', '.woff2', '.ttf', '.eot'].includes(ext)) return 'public, max-age=31536000, immutable';
  if (['.png', '.jpg', '.jpeg', '.gif', '.svg', '.ico', '.webp'].includes(ext)) return 'public, max-age=86400';
  return 'public, max-age=3600';
}

function compressAndSend(req, res, statusCode, headers, data) {
  const contentType = headers['Content-Type'] || '';
  const baseType = contentType.split(';')[0].trim();

  if (COMPRESSIBLE.has(baseType) && data.length > 1024) {
    const acceptEncoding = (req.headers['accept-encoding'] || '');
    if (acceptEncoding.includes('gzip')) {
      zlib.gzip(data, (err, compressed) => {
        if (err) {
          res.writeHead(statusCode, headers);
          res.end(data);
          return;
        }
        headers['Content-Encoding'] = 'gzip';
        headers['Vary'] = 'Accept-Encoding';
        res.writeHead(statusCode, headers);
        res.end(compressed);
      });
      return;
    }
  }
  res.writeHead(statusCode, headers);
  res.end(data);
}

function serveStatic(req, res) {
  const urlPath = req.url.split('?')[0];
  let filePath = path.join(DIST, urlPath === '/' ? 'index.html' : urlPath);

  // Prevent directory traversal
  if (!filePath.startsWith(DIST)) {
    res.writeHead(403, { 'Content-Type': 'text/plain' });
    res.end('Forbidden');
    return;
  }

  fs.stat(filePath, (statErr, stats) => {
    // SPA fallback: if file doesn't exist or is directory, serve index.html
    if (statErr || !stats.isFile()) {
      filePath = path.join(DIST, 'index.html');
    }

    const ext = path.extname(filePath);
    const contentType = MIME[ext] || 'application/octet-stream';

    fs.readFile(filePath, (err, data) => {
      if (err) {
        res.writeHead(404, { 'Content-Type': 'text/plain', ...SECURITY_HEADERS });
        res.end('Not Found');
        return;
      }
      const headers = {
        'Content-Type': contentType,
        'Cache-Control': getCacheControl(ext),
        ...SECURITY_HEADERS,
      };
      compressAndSend(req, res, 200, headers, data);
    });
  });
}

function proxyToApi(req, res) {
  const origin = req.headers.origin || '';
  const targetUrl = new URL(req.url, API_TARGET);
  const client = targetUrl.protocol === 'https:' ? https : http;

  const proxyOpts = {
    hostname: targetUrl.hostname,
    port: targetUrl.port || (targetUrl.protocol === 'https:' ? 443 : 80),
    path: targetUrl.pathname + (targetUrl.search || ''),
    method: req.method,
    headers: { ...req.headers, host: targetUrl.host },
    timeout: 30000,
  };

  const proxyReq = client.request(proxyOpts, (proxyRes) => {
    const corsHeaders = getCorsHeaders(origin);
    const headers = {
      ...proxyRes.headers,
      ...corsHeaders,
    };
    res.writeHead(proxyRes.statusCode, headers);
    proxyRes.pipe(res);
  });

  proxyReq.on('error', (err) => {
    console.error('[Proxy] Error: ' + err.message);
    res.writeHead(502, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: false, error: 'API proxy failed: ' + err.message }));
  });

  proxyReq.on('timeout', () => {
    proxyReq.destroy();
    res.writeHead(504, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: false, error: 'API proxy timeout' }));
  });

  req.pipe(proxyReq);
}

const server = http.createServer((req, res) => {
  const origin = req.headers.origin || '';

  // CORS preflight
  if (req.method === 'OPTIONS') {
    const corsHeaders = getCorsHeaders(origin);
    res.writeHead(204, corsHeaders);
    res.end();
    return;
  }

  // Health check
  if (req.url === '/health') {
    const body = JSON.stringify({ ok: true, service: SERVICE_NAME, uptime: process.uptime() });
    res.writeHead(200, { 'Content-Type': 'application/json', ...SECURITY_HEADERS });
    res.end(body);
    return;
  }

  // Proxy /api/* to HeadyManager
  if (req.url.startsWith('/api/') || req.url.startsWith('/api-docs')) {
    proxyToApi(req, res);
    return;
  }

  // Static files
  serveStatic(req, res);
});

server.listen(PORT, '0.0.0.0', () => {
  process.stdout.write(JSON.stringify({ level: 'info', service: SERVICE_NAME, message: 'Production server on http://0.0.0.0:' + PORT, ts: new Date().toISOString() }) + '\n');
  process.stdout.write(JSON.stringify({ level: 'info', service: SERVICE_NAME, message: 'API proxy -> ' + API_TARGET, ts: new Date().toISOString() }) + '\n');
});

// Graceful shutdown
function shutdown(signal) {
  process.stdout.write(JSON.stringify({ level: 'info', service: SERVICE_NAME, message: 'Received ' + signal + ', shutting down gracefully...', ts: new Date().toISOString() }) + '\n');
  server.close(() => {
    process.stdout.write(JSON.stringify({ level: 'info', service: SERVICE_NAME, message: 'Server closed.', ts: new Date().toISOString() }) + '\n');
    process.exit(0);
  });
  setTimeout(() => {
    console.error('[' + SERVICE_NAME + '] Forced shutdown after timeout.');
    process.exit(1);
  }, 10000).unref();
}

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
