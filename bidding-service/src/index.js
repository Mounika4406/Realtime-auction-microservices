require('dotenv').config();
const http = require('http');
const url = require('url');
const express = require('express');
const cors = require('cors');
const { WebSocketServer, WebSocket } = require('ws');
const jwt = require('jsonwebtoken');
const { startRabbitMQConsumer } = require('./rabbitmq');

const app = express();
const PORT = process.env.BIDDING_SERVICE_PORT || 8003;
const JWT_SECRET = process.env.JWT_SECRET || 'super_secret_auction_jwt_token_key_2026!';

app.use(cors());
app.use(express.json());

// In-memory room management: Map<auctionIdString, Set<WebSocket>>
const rooms = new Map();

// Helper to add client to room
function joinRoom(auctionId, ws) {
  const key = String(auctionId);
  if (!rooms.has(key)) {
    rooms.set(key, new Set());
  }
  rooms.get(key).add(ws);
  console.log(`[bidding-service] Client joined room for auction ${key}. Total in room: ${rooms.get(key).size}`);
}

// Helper to remove client from room
function leaveRoom(auctionId, ws) {
  const key = String(auctionId);
  if (rooms.has(key)) {
    const set = rooms.get(key);
    set.delete(ws);
    if (set.size === 0) {
      rooms.delete(key);
      console.log(`[bidding-service] Room for auction ${key} deleted (empty).`);
    } else {
      console.log(`[bidding-service] Client left room for auction ${key}. Remaining: ${set.size}`);
    }
  }
}

// Broadcast message exclusively to clients in specific auction room
function broadcastToAuctionRoom(auctionId, data) {
  const key = String(auctionId);
  const clients = rooms.get(key);
  if (!clients || clients.size === 0) {
    console.log(`[bidding-service] No active clients in room for auction ${key}. Skipping broadcast.`);
    return;
  }

  const messageStr = JSON.stringify(data);
  let count = 0;
  for (const client of clients) {
    if (client.readyState === WebSocket.OPEN) {
      client.send(messageStr);
      count++;
    }
  }
  console.log(`[bidding-service] Broadcasted NEW_BID to ${count} clients in auction room ${key}`);
}

// Health check endpoint
app.get(['/health', '/api/bidding/health'], (req, res) => {
  let totalConnections = 0;
  for (const set of rooms.values()) {
    totalConnections += set.size;
  }
  res.status(200).json({
    status: 'ok',
    service: 'bidding-service',
    activeRooms: rooms.size,
    totalConnections,
  });
});

const server = http.createServer(app);

// Create standalone WebSocketServer with noServer: true
const wss = new WebSocketServer({ noServer: true });

// HTTP Upgrade handler with JWT authentication and URL parsing
server.on('upgrade', (req, socket, head) => {
  const parsedUrl = url.parse(req.url, true);
  const pathname = parsedUrl.pathname || '';
  const match = pathname.match(/^\/ws\/auctions\/([^/?#]+)/);

  if (!match) {
    socket.write('HTTP/1.1 404 Not Found\r\n\r\n');
    socket.destroy();
    return;
  }

  const auctionId = match[1];
  const token = parsedUrl.query.token;

  if (!token) {
    console.warn(`[bidding-service] Connection rejected for auction ${auctionId}: Missing token.`);
    socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n');
    socket.destroy();
    return;
  }

  // Cryptographically validate JWT signature and expiration
  try {
    const decoded = jwt.verify(token, JWT_SECRET);
    wss.handleUpgrade(req, socket, head, (ws) => {
      ws.user = decoded;
      ws.auctionId = auctionId;
      wss.emit('connection', ws, req);
    });
  } catch (err) {
    console.warn(`[bidding-service] Connection rejected for auction ${auctionId}: Invalid token (${err.message}).`);
    socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n');
    socket.destroy();
  }
});

// WebSocket connection lifecycle
wss.on('connection', (ws) => {
  const auctionId = ws.auctionId;
  const user = ws.user;

  console.log(`[bidding-service] User ${user.id} (${user.email}) connected to auction ${auctionId}`);
  joinRoom(auctionId, ws);

  // Send initial welcome/acknowledgement
  ws.send(
    JSON.stringify({
      type: 'CONNECTED',
      payload: {
        message: `Successfully connected to auction #${auctionId}`,
        auctionId,
        userId: user.id,
      },
    })
  );

  // Handle incoming messages (e.g. heartbeat ping/pong)
  ws.on('message', (message) => {
    try {
      const parsed = JSON.parse(message.toString());
      if (parsed.type === 'PING') {
        ws.send(JSON.stringify({ type: 'PONG' }));
      }
    } catch {
      // Ignore non-JSON messages
    }
  });

  ws.on('close', () => {
    console.log(`[bidding-service] User ${user.id} disconnected from auction ${auctionId}`);
    leaveRoom(auctionId, ws);
  });

  ws.on('error', (err) => {
    console.error(`[bidding-service] WebSocket error for auction ${auctionId}:`, err.message);
    leaveRoom(auctionId, ws);
  });
});

// RabbitMQ Event Handler
async function handleRabbitMQMessage(payload) {
  // payload schema: { auction_id, user_id, new_price, previous_price, previous_bidder_id }
  const { auction_id, user_id, new_price } = payload;
  if (!auction_id || !user_id || new_price === undefined) {
    console.warn('[bidding-service] Invalid bid event payload:', payload);
    return;
  }

  const broadcastMessage = {
    type: 'NEW_BID',
    payload: {
      auctionId: Number(auction_id),
      userId: Number(user_id),
      newPrice: Number(new_price),
    },
  };

  broadcastToAuctionRoom(auction_id, broadcastMessage);
}

// Start Server & RabbitMQ Consumer
async function startServer() {
  await startRabbitMQConsumer(handleRabbitMQMessage);
  server.listen(PORT, '0.0.0.0', () => {
    console.log(`[bidding-service] Server running on port ${PORT}`);
  });
}

if (require.main === module) {
  startServer();
}

module.exports = { app, server, wss, startServer, rooms, broadcastToAuctionRoom };
