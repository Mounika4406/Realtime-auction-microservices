require('dotenv').config();
const express = require('express');
const cors = require('cors');
const jwt = require('jsonwebtoken');
const db = require('./db');
const { connectRabbitMQ, publishBidPlaced } = require('./rabbitmq');

const app = express();
const PORT = process.env.AUCTION_SERVICE_PORT || 8002;
const JWT_SECRET = process.env.JWT_SECRET || 'super_secret_auction_jwt_token_key_2026!';

app.use(cors());
app.use(express.json());

// Auth extraction helper: reads X-User-Id header (from API Gateway) or decodes Bearer token
function getUserFromRequest(req) {
  // If API Gateway passed validated user ID in header
  if (req.headers['x-user-id']) {
    return {
      id: parseInt(req.headers['x-user-id'], 10),
      email: req.headers['x-user-email'] || '',
    };
  }

  // Fallback: direct Bearer token validation
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
app.get(['/health', '/api/auctions/health'], async (req, res) => {
  try {
    await db.query('SELECT 1');
    res.status(200).json({ status: 'ok', service: 'auction-service', db: 'connected' });
  } catch (err) {
    res.status(503).json({ status: 'degraded', service: 'auction-service', db: err.message });
  }
});

// GET /auctions - List active auctions
async function handleGetAuctions(req, res) {
  try {
    const result = await db.query(
      `SELECT id, title, description, starting_price, current_price, end_time, seller_id, created_at 
       FROM auctions 
       ORDER BY created_at DESC`
    );
    return res.status(200).json(result.rows);
  } catch (err) {
    console.error('[auction-service] Error fetching auctions:', err);
    return res.status(500).json({ error: 'Failed to retrieve auctions.' });
  }
}

// GET /auctions/:id - Get auction details & bids
async function handleGetAuctionById(req, res) {
  try {
    const auctionId = parseInt(req.params.id, 10);
    if (isNaN(auctionId)) {
      return res.status(400).json({ error: 'Invalid auction ID.' });
    }

    const auctionRes = await db.query(
      `SELECT id, title, description, starting_price, current_price, end_time, seller_id, created_at 
       FROM auctions WHERE id = $1`,
      [auctionId]
    );

    if (auctionRes.rows.length === 0) {
      return res.status(404).json({ error: 'Auction not found.' });
    }

    const bidsRes = await db.query(
      `SELECT id, auction_id, user_id, amount, created_at 
       FROM bids 
       WHERE auction_id = $1 
       ORDER BY created_at DESC`,
      [auctionId]
    );

    const auction = auctionRes.rows[0];
    auction.bids = bidsRes.rows;

    return res.status(200).json(auction);
  } catch (err) {
    console.error('[auction-service] Error fetching auction details:', err);
    return res.status(500).json({ error: 'Failed to retrieve auction details.' });
  }
}

// POST /auctions - Create a new auction
async function handleCreateAuction(req, res) {
  try {
    const user = getUserFromRequest(req);
    if (!user) {
      return res.status(401).json({ error: 'Unauthorized: Authentication required to create an auction.' });
    }

    const { title, description, starting_price, end_time } = req.body;

    if (!title || starting_price === undefined || !end_time) {
      return res.status(400).json({ error: 'Title, starting_price, and end_time are required.' });
    }

    const startPriceNum = parseFloat(starting_price);
    if (isNaN(startPriceNum) || startPriceNum <= 0) {
      return res.status(400).json({ error: 'starting_price must be a positive number.' });
    }

    const endDate = new Date(end_time);
    if (isNaN(endDate.getTime()) || endDate <= new Date()) {
      return res.status(400).json({ error: 'end_time must be a valid future ISO 8601 date string.' });
    }

    const sellerId = user.id;

    const result = await db.query(
      `INSERT INTO auctions (title, description, starting_price, current_price, end_time, seller_id) 
       VALUES ($1, $2, $3, $4, $5, $6) 
       RETURNING id, title, description, starting_price, current_price, end_time, seller_id, created_at`,
      [title.trim(), description ? description.trim() : '', startPriceNum, startPriceNum, endDate.toISOString(), sellerId]
    );

    return res.status(201).json(result.rows[0]);
  } catch (err) {
    console.error('[auction-service] Error creating auction:', err);
    return res.status(500).json({ error: 'Failed to create auction.' });
  }
}

// POST /auctions/:id/bids - Place a new bid with atomic transaction & RabbitMQ publication
async function handlePlaceBid(req, res) {
  const user = getUserFromRequest(req);
  if (!user) {
    return res.status(401).json({ error: 'Unauthorized: Authentication required to place a bid.' });
  }

  const auctionId = parseInt(req.params.id, 10);
  if (isNaN(auctionId)) {
    return res.status(400).json({ error: 'Invalid auction ID.' });
  }

  const { amount } = req.body;
  if (amount === undefined || amount === null) {
    return res.status(400).json({ error: 'Bid amount is required.' });
  }

  const bidAmount = parseFloat(amount);
  if (isNaN(bidAmount) || bidAmount <= 0) {
    return res.status(400).json({ error: 'Bid amount must be a positive number.' });
  }

  const client = await db.getClient();
  try {
    // 1. Begin atomic SQL transaction
    await client.query('BEGIN');

    // 2. Row-level lock on auction record
    const lockRes = await client.query(
      `SELECT id, current_price, end_time, seller_id 
       FROM auctions 
       WHERE id = $1 FOR UPDATE`,
      [auctionId]
    );

    if (lockRes.rows.length === 0) {
      await client.query('ROLLBACK');
      return res.status(404).json({ error: 'Auction not found.' });
    }

    const auction = lockRes.rows[0];

    // Check if auction has expired
    if (new Date(auction.end_time) <= new Date()) {
      await client.query('ROLLBACK');
      return res.status(400).json({ error: 'Auction has already ended.' });
    }

    const currentPrice = parseFloat(auction.current_price);

    // 3. Validate bid amount is strictly greater than current price
    if (bidAmount <= currentPrice) {
      await client.query('ROLLBACK');
      return res.status(400).json({
        error: `Bid amount must be strictly greater than current price of $${currentPrice.toFixed(2)}.`,
      });
    }

    // 4. Retrieve previous highest bidder
    const prevBidRes = await client.query(
      `SELECT user_id, amount FROM bids 
       WHERE auction_id = $1 
       ORDER BY amount DESC, created_at DESC LIMIT 1`,
      [auctionId]
    );

    const previousBidderId = prevBidRes.rows.length > 0 ? prevBidRes.rows[0].user_id : null;
    const previousPrice = currentPrice;

    // 5. Insert bid record
    const insertBidRes = await client.query(
      `INSERT INTO bids (auction_id, user_id, amount) 
       VALUES ($1, $2, $3) 
       RETURNING id, auction_id, user_id, amount, created_at`,
      [auctionId, user.id, bidAmount]
    );
    const newBid = insertBidRes.rows[0];

    // 6. Update current_price on auctions table
    await client.query(
      `UPDATE auctions SET current_price = $1 WHERE id = $2`,
      [bidAmount, auctionId]
    );

    // 7. Commit atomic transaction
    await client.query('COMMIT');

    // 8. Publish AMQP event payload to RabbitMQ topic exchange
    const eventPayload = {
      auction_id: auctionId,
      user_id: user.id,
      new_price: bidAmount,
      previous_price: previousPrice,
      previous_bidder_id: previousBidderId,
    };

    try {
      await publishBidPlaced(eventPayload);
    } catch (mqErr) {
      console.error('[auction-service] Warning: Failed to publish event to RabbitMQ:', mqErr.message);
    }

    return res.status(201).json({
      message: 'Bid successfully placed.',
      bid: newBid,
      auction: {
        id: auctionId,
        current_price: bidAmount,
      },
    });
  } catch (err) {
    await client.query('ROLLBACK');
    console.error('[auction-service] Error processing bid transaction:', err);
    return res.status(500).json({ error: 'Internal server error while processing bid.' });
  } finally {
    client.release();
  }
}

// Bind endpoints to root, resource name, and /api/ prefixed paths
app.get(['/', '/auctions', '/api/auctions'], handleGetAuctions);
app.get(['/:id', '/auctions/:id', '/api/auctions/:id'], handleGetAuctionById);
app.post(['/', '/auctions', '/api/auctions'], handleCreateAuction);
app.post(['/:id/bids', '/auctions/:id/bids', '/api/auctions/:id/bids'], handlePlaceBid);

// Start server
async function startServer() {
  await db.initDb();
  await connectRabbitMQ();
  app.listen(PORT, '0.0.0.0', () => {
    console.log(`[auction-service] Server running on port ${PORT}`);
  });
}

if (require.main === module) {
  startServer();
}

module.exports = { app, startServer };
