const { Pool } = require('pg');

const pool = new Pool({
  connectionString: process.env.NOTIFICATION_DATABASE_URL || 'postgresql://postgres:postgres@postgres-notification:5432/db_notification',
  connectionTimeoutMillis: 5000,
});

pool.on('error', (err) => {
  console.error('[notification-db] Unexpected database error on idle client:', err.message);
});

async function initDb() {
  const query = `
    CREATE TABLE IF NOT EXISTS notifications (
      id SERIAL PRIMARY KEY,
      user_id INTEGER NOT NULL,
      message TEXT NOT NULL,
      is_read BOOLEAN NOT NULL DEFAULT FALSE,
      created_at TIMESTAMPTZ DEFAULT NOW()
    );
  `;
  try {
    await pool.query(query);
    console.log('[notification-db] Database initialized successfully.');
  } catch (err) {
    console.error('[notification-db] Error initializing database schema:', err.message);
  }
}

module.exports = {
  query: (text, params) => pool.query(text, params),
  pool,
  initDb,
};
