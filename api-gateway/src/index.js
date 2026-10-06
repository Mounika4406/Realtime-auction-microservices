require('dotenv').config();
const http = require('http');
const express = require('express');
const cors = require('cors');
const jwt = require('jsonwebtoken');
const httpProxy = require('http-proxy');

const app = express();
const PORT = process.env.API_GATEWAY_PORT || 8000;
const JWT_SECRET = process.env.JWT_SECRET || 'super_secret_auction_jwt_token_key_2026!';

const AUTH_SERVICE_URL = process.env.AUTH_SERVICE_URL || 'http://auth-service:8001';
const AUCTION_SERVICE_URL = process.env.AUCTION_SERVICE_URL || 'http://auction-service:8002';
const BIDDING_SERVICE_URL = process.env.BIDDING_SERVICE_URL || 'http://bidding-service:8003';
const NOTIFICATION_SERVICE_URL = process.env.NOTIFICATION_SERVICE_URL || 'http://notification-service:8004';

// Create HTTP proxy instance
const proxy = httpProxy.createProxyServer({
  ws: true,
  changeOrigin: true,
});

proxy.on('error', (err, req, res) => {
  console.error('[gateway-proxy] Proxy error:', err.message);
  if (res && res.writeHead && !res.headersSent) {
    res.writeHead(502, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'Bad Gateway: Downstream service is currently unreachable.' }));
  }
});

// Enable CORS
app.use(cors());

// Gateway health check
app.get('/health', (req, res) => {
  res.status(200).json({
    status: 'ok',
    gateway: 'active',
    targets: {
      auth: AUTH_SERVICE_URL,
      auction: AUCTION_SERVICE_URL,
      bidding: BIDDING_SERVICE_URL,
      notification: NOTIFICATION_SERVICE_URL,
    },
  });
});

// Helper: Determine if route requires JWT authentication
function isProtectedRoute(method, path) {
  const cleanPath = path.replace(/\/+$/, '');
  const m = method.toUpperCase();

  // POST /api/auctions
  if (m === 'POST' && (cleanPath === '/api/auctions' || cleanPath === '/auctions')) {
    return true;
  }

  // POST /api/auctions/:id/bids
  if (m === 'POST' && (/^\/api\/auctions\/[^/]+\/bids$/.test(cleanPath) || /^\/auctions\/[^/]+\/bids$/.test(cleanPath))) {
    return true;
  }

  // GET /api/notifications
  if (m === 'GET' && (cleanPath === '/api/notifications' || cleanPath === '/notifications')) {
    return true;
  }

  return false;
}

// Centralized JWT Authentication Middleware
app.use((req, res, next) => {
  if (isProtectedRoute(req.method, req.path)) {
    const authHeader = req.headers.authorization;
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
      return res.status(401).json({
        error: 'Unauthorized: Missing or malformed Authorization header with Bearer token.',
      });
    }

    const token = authHeader.substring(7);
    try {
      const decoded = jwt.verify(token, JWT_SECRET);
      // Append decoded user claims to internal downstream headers
      req.headers['x-user-id'] = String(decoded.id);
      if (decoded.email) {
        req.headers['x-user-email'] = decoded.email;
      }
      return next();
    } catch (err) {
      return res.status(401).json({
        error: `Unauthorized: Invalid or expired token (${err.message}).`,
      });
    }
  }

  next();
});

// Reverse Proxy Routing Rules
// Route /api/auth/* to auth-service
app.use(['/api/auth', '/auth'], (req, res) => {
  proxy.web(req, res, { target: AUTH_SERVICE_URL });
});

// Route /api/auctions/* to auction-service
app.use(['/api/auctions', '/auctions'], (req, res) => {
  proxy.web(req, res, { target: AUCTION_SERVICE_URL });
});

// Route /api/notifications/* to notification-service
app.use(['/api/notifications', '/notifications'], (req, res) => {
  proxy.web(req, res, { target: NOTIFICATION_SERVICE_URL });
});

const server = http.createServer(app);

// WebSocket Proxy Handling for /ws/auctions/:auctionId
server.on('upgrade', (req, socket, head) => {
  const urlPath = req.url || '';
  if (urlPath.startsWith('/ws/auctions/')) {
    console.log(`[gateway] Proxying WebSocket upgrade to Bidding Service for: ${urlPath}`);
    proxy.ws(req, socket, head, { target: BIDDING_SERVICE_URL });
  } else {
    console.warn(`[gateway] Rejecting WebSocket upgrade for unknown path: ${urlPath}`);
    socket.write('HTTP/1.1 404 Not Found\r\n\r\n');
    socket.destroy();
  }
});

function startServer() {
  server.listen(PORT, '0.0.0.0', () => {
    console.log(`[api-gateway] API Gateway listening on port ${PORT}`);
  });
}

if (require.main === module) {
  startServer();
}

module.exports = { app, server, startServer };
