require('dotenv').config();
const express = require('express');
const cors = require('cors');
const jwt = require('jsonwebtoken');
const db = require('./db');
const { startRabbitMQConsumer } = require('./rabbitmq');

const app = express();
const PORT = process.env.NOTIFICATION_SERVICE_PORT || 8004;
const JWT_SECRET = process.env.JWT_SECRET || 'super_secret_auction_jwt_token_key_2026!';

app.use(cors());
app.use(express.json());

// Auth extraction helper
function getUserFromRequest(req) {
  if (req.headers['x-user-id']) {
    return {
      id: parseInt(req.headers['x-user-id'], 10),
      email: req.headers['x-user-email'] || '',
    };
  }

  const authHeader = req.headers.authorization;
  if (authHeader && authHeader.startsWith('Bearer ')) {
    const token = authHeader.substring(7);
    try {
      const decoded = jwt.verify(token, JWT_SECRET);
      return { id: decoded.id, email: decoded.email };
    } catch {
      return null;
    }
  }

  return null;
}

// Health check endpoint
app.get(['/health', '/api/notifications/health'], async (req, res) => {
  try {
    await db.query('SELECT 1');
    res.status(200).json({ status: 'ok', service: 'notification-service', db: 'connected' });
  } catch (err) {
    res.status(503).json({ status: 'degraded', service: 'notification-service', db: err.message });
  }
});

// GET /notifications - Retrieve chronological notifications for authenticated user
async function handleGetNotifications(req, res) {
  try {
    const user = getUserFromRequest(req);
    if (!user) {
      return res.status(401).json({ error: 'Unauthorized: Authentication required to view notifications.' });
    }

    const result = await db.query(
      `SELECT id, message, is_read, created_at 
       FROM notifications 
       WHERE user_id = $1 
       ORDER BY created_at DESC`,
      [user.id]
    );

    const formatted = result.rows.map((row) => ({
      id: row.id,
      message: row.message,
      is_read: row.is_read,
      created_at: new Date(row.created_at).toISOString(),
    }));

    return res.status(200).json(formatted);
  } catch (err) {
    console.error('[notification-service] Error fetching notifications:', err);
    return res.status(500).json({ error: 'Failed to retrieve notifications.' });
  }
}

// Handle root, resource name, and /api/ prefixed routes
app.get(['/', '/notifications', '/api/notifications'], handleGetNotifications);

// RabbitMQ Event Handler: Alert outbid user
async function handleBidPlacedEvent(payload) {
  // payload schema: { auction_id, user_id, new_price, previous_price, previous_bidder_id }
  const { auction_id, new_price, previous_bidder_id } = payload;

  if (previous_bidder_id !== null && previous_bidder_id !== undefined) {
    const outbidUserId = parseInt(previous_bidder_id, 10);
    const formattedPrice = Number(new_price).toFixed(2);
    const alertMessage = `You have been outbid on auction #${auction_id}! The new highest bid is $${formattedPrice}.`;

    try {
      const res = await db.query(
        `INSERT INTO notifications (user_id, message, is_read, created_at) 
         VALUES ($1, $2, FALSE, NOW()) 
         RETURNING id, user_id, message, created_at`,
        [outbidUserId, alertMessage]
      );
      console.log(`[notification-service] Created outbid notification for user ${outbidUserId}:`, res.rows[0]);
    } catch (err) {
      console.error('[notification-service] Failed to persist outbid notification:', err);
    }
  } else {
    console.log(`[notification-service] No previous bidder on auction #${auction_id}. No outbid notification required.`);
  }
}

// Start Server & RabbitMQ Consumer
async function startServer() {
  await db.initDb();
  await startRabbitMQConsumer(handleBidPlacedEvent);
  app.listen(PORT, '0.0.0.0', () => {
    console.log(`[notification-service] Server running on port ${PORT}`);
  });
}

if (require.main === module) {
  startServer();
}

module.exports = { app, startServer, handleBidPlacedEvent };
