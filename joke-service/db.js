/**
 * db.js – MySQL Connection Pool
 *
 * Distributed Systems Note:
 * A connection POOL is used rather than a single connection because:
 *   - Multiple concurrent HTTP requests each need DB access
 *   - Pool reuses existing connections (lower latency per request)
 *   - Pool automatically manages connection lifecycle and limits
 *   - connectionLimit prevents overwhelming the MySQL server
 *
 * mysql2/promise provides native async/await support.
 */

'use strict';

const mysql = require('mysql2/promise');

const pool = mysql.createPool({
  host:               process.env.DB_HOST     || 'localhost',
  user:               process.env.DB_USER     || 'jokeuser',
  password:           process.env.DB_PASSWORD || 'jokepassword',
  database:           process.env.DB_NAME     || 'jokesdb',
  waitForConnections: true,
  connectionLimit:    10,   // max concurrent connections in pool
  queueLimit:         0     // unlimited queued requests
});

/**
 * Retry the initial DB connection.
 *
 * MySQL may not be accepting connections immediately when the
 * container starts, even after the healthcheck passes. Retrying
 * with a delay handles this startup race condition gracefully.
 *
 * @param {number} maxRetries - number of connection attempts
 * @param {number} delayMs    - milliseconds between attempts
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
