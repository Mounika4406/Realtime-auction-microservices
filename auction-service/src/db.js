const { Pool } = require('pg');

const pool = new Pool({
  connectionString: process.env.AUCTION_DATABASE_URL || 'postgresql://postgres:postgres@postgres-auction:5432/db_auction',
  connectionTimeoutMillis: 5000,
});

pool.on('error', (err) => {
  console.error('[auction-db] Unexpected database error on idle client:', err.message);
});

async function initDb() {
  const query = `
    CREATE TABLE IF NOT EXISTS auctions (
      id SERIAL PRIMARY KEY,
      title VARCHAR(255) NOT NULL,
      description TEXT,
      starting_price NUMERIC(12, 2) NOT NULL,
      current_price NUMERIC(12, 2) NOT NULL,
      end_time TIMESTAMPTZ NOT NULL,
      seller_id INTEGER NOT NULL,
      created_at TIMESTAMPTZ DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS bids (
      id SERIAL PRIMARY KEY,
      auction_id INTEGER NOT NULL REFERENCES auctions(id) ON DELETE CASCADE,
      user_id INTEGER NOT NULL,
      amount NUMERIC(12, 2) NOT NULL,
      created_at TIMESTAMPTZ DEFAULT NOW()
    );
  `;
  try {
    await pool.query(query);
    console.log('[auction-db] Database initialized successfully.');
  } catch (err) {
    console.error('[auction-db] Error initializing database schema:', err.message);
  }
}

module.exports = {
  query: (text, params) => pool.query(text, params),
  getClient: () => pool.connect(),
  pool,
  initDb,
};
