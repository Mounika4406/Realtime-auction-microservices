const { Pool } = require('pg');

const pool = new Pool({
  connectionString: process.env.AUTH_DATABASE_URL || 'postgresql://postgres:postgres@postgres-auth:5432/db_auth',
  connectionTimeoutMillis: 5000,
});

pool.on('error', (err) => {
  console.error('[auth-db] Unexpected database error on idle client:', err.message);
});

async function initDb() {
  const query = `
    CREATE TABLE IF NOT EXISTS users (
      id SERIAL PRIMARY KEY,
      email VARCHAR(255) UNIQUE NOT NULL,
      password VARCHAR(255) NOT NULL,
      name VARCHAR(255) NOT NULL,
      created_at TIMESTAMPTZ DEFAULT NOW()
    );
  `;
  try {
    await pool.query(query);
    console.log('[auth-db] Database initialized successfully.');
  } catch (err) {
    console.error('[auth-db] Error initializing database schema:', err.message);
  }
}

module.exports = {
  query: (text, params) => pool.query(text, params),
  pool,
  initDb,
};
