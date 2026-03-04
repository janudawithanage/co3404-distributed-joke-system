/**
 * etl-service/db.js – MySQL Connection Pool
 *
 * Identical pool pattern to joke-service/db.js.
 * Each microservice owns its own DB module — this keeps
 * services self-contained inside their Docker containers.
 */

'use strict';

const mysql = require('mysql2/promise');

const pool = mysql.createPool({
  host:               process.env.DB_HOST     || 'localhost',
  user:               process.env.DB_USER     || 'jokeuser',
  password:           process.env.DB_PASSWORD || 'jokepassword',
  database:           process.env.DB_NAME     || 'jokesdb',
  waitForConnections: true,
  connectionLimit:    10,
  queueLimit:         0
});

/**
 * Retry the initial DB connection.
 * MySQL may not be ready immediately even after Docker healthcheck passes.
 */
async function connectWithRetry(maxRetries = 10, delayMs = 3000) {
  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      const conn = await pool.getConnection();
      console.log(`[DB] Connected to MySQL (attempt ${attempt}/${maxRetries})`);
      conn.release();
      return;
    } catch (err) {
      console.warn(`[DB] Attempt ${attempt}/${maxRetries} failed: ${err.message}`);
      if (attempt < maxRetries) {
        await new Promise(res => setTimeout(res, delayMs));
      } else {
        throw new Error('[DB] Could not connect to MySQL after max retries');
      }
    }
  }
}

module.exports = { pool, connectWithRetry };
