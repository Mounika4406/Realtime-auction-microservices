require('dotenv').config();
const express = require('express');
const cors = require('cors');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const db = require('./db');

const app = express();
const PORT = process.env.AUTH_SERVICE_PORT || 8001;
const JWT_SECRET = process.env.JWT_SECRET || 'super_secret_auction_jwt_token_key_2026!';

app.use(cors());
app.use(express.json());

// Health check endpoint
app.get(['/health', '/api/auth/health'], async (req, res) => {
  try {
    await db.query('SELECT 1');
    res.status(200).json({ status: 'ok', service: 'auth-service', db: 'connected' });
  } catch (err) {
    res.status(503).json({ status: 'degraded', service: 'auth-service', db: err.message });
  }
});

// Registration handler
async function handleRegister(req, res) {
  try {
    const { email, password, name } = req.body;

    if (!email || !password || !name) {
      return res.status(400).json({ error: 'Email, password, and name are required.' });
    }

    if (typeof email !== 'string' || !email.includes('@')) {
      return res.status(400).json({ error: 'Invalid email format.' });
    }

    if (typeof password !== 'string' || password.length < 6) {
      return res.status(400).json({ error: 'Password must be at least 6 characters long.' });
    }

    // Check if user already exists
    const existing = await db.query('SELECT id FROM users WHERE email = $1', [email.toLowerCase().trim()]);
    if (existing.rows.length > 0) {
      return res.status(409).json({ error: 'User with this email already exists.' });
    }

    // Hash password with bcrypt
    const saltRounds = 10;
    const hashedPassword = await bcrypt.hash(password, saltRounds);

    const result = await db.query(
      'INSERT INTO users (email, password, name) VALUES ($1, $2, $3) RETURNING id, email, name',
      [email.toLowerCase().trim(), hashedPassword, name.trim()]
    );

    const newUser = result.rows[0];
    return res.status(201).json({
      id: newUser.id,
      email: newUser.email,
      name: newUser.name,
    });
  } catch (err) {
    console.error('[auth-service] Registration error:', err);
    return res.status(500).json({ error: 'Internal server error during registration.' });
  }
}

// Login handler
async function handleLogin(req, res) {
  try {
    const { email, password } = req.body;

    if (!email || !password) {
      return res.status(400).json({ error: 'Email and password are required.' });
    }

    const result = await db.query('SELECT id, email, name, password FROM users WHERE email = $1', [
      email.toLowerCase().trim(),
    ]);

    if (result.rows.length === 0) {
      return res.status(401).json({ error: 'Invalid email or password.' });
    }

    const user = result.rows[0];
    const isPasswordValid = await bcrypt.compare(password, user.password);

    if (!isPasswordValid) {
      return res.status(401).json({ error: 'Invalid email or password.' });
    }

    // Generate JWT (claims include user ID, email, name)
    const token = jwt.sign(
      {
        id: user.id,
        email: user.email,
        name: user.name,
      },
      JWT_SECRET,
      { expiresIn: '24h' }
    );

    return res.status(200).json({
      accessToken: token,
    });
  } catch (err) {
    console.error('[auth-service] Login error:', err);
    return res.status(500).json({ error: 'Internal server error during login.' });
  }
}

// Routes supporting both direct paths and /api/auth prefixed paths
app.post('/register', handleRegister);
app.post('/api/auth/register', handleRegister);
app.post('/login', handleLogin);
app.post('/api/auth/login', handleLogin);

// Start server
async function startServer() {
  await db.initDb();
  app.listen(PORT, '0.0.0.0', () => {
    console.log(`[auth-service] Server running on port ${PORT}`);
  });
}

if (require.main === module) {
  startServer();
}

module.exports = { app, startServer };
