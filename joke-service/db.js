/**
 * joke-service/db.js
 *
 * Unified Database Adapter — MySQL or MongoDB
 * ───────────────────────────────────────────
 * Controlled by the DB_TYPE environment variable:
 *   DB_TYPE=mysql  (default) — uses MySQL via mysql2/promise
 *   DB_TYPE=mongo            — uses MongoDB via mongoose
 *
 * Exports:
 *   connectWithRetry()         — establishes DB connection with retries
 *   getJokes(type, count)      — returns array of { id, setup, punchline, type }
 *   getTypes()                 — returns array of { id, name }
 *
 * Distributed Systems Note:
 *   A connection pool (MySQL) or connection singleton (MongoDB) is used
 *   so that concurrent HTTP requests share existing DB connections.
 */

'use strict';

const DB_TYPE = (process.env.DB_TYPE || 'mysql').toLowerCase();

// =============================================================================
// MONGODB ADAPTER
// =============================================================================
if (DB_TYPE === 'mongo') {
  const mongoose = require('mongoose');

  const MONGO_URI = process.env.MONGO_URI || 'mongodb://localhost:27017/jokesdb';

  // Mirror the same Type schema as etl-service so both services
  // read/write from the same 'types' collection.
  const typeSchema = new mongoose.Schema(
    { name: { type: String, unique: true, lowercase: true, trim: true, maxlength: 50 } },
    { timestamps: false }
  );

  const jokeSchema = new mongoose.Schema({
    setup:     { type: String, required: true, maxlength: 500 },
    punchline: { type: String, required: true, maxlength: 500 },
    type:      { type: String, required: true, lowercase: true, trim: true, maxlength: 50 }
  }, { timestamps: true });

  // Use mongoose.models to avoid "Cannot overwrite model once compiled" errors
  // when this module is re-evaluated (e.g. in tests or hot-reload scenarios).
  const Type = mongoose.models.Type || mongoose.model('Type', typeSchema);
  const Joke = mongoose.models.Joke || mongoose.model('Joke', jokeSchema);

  async function connectWithRetry(maxRetries = 10, delayMs = 3000) {
    for (let attempt = 1; attempt <= maxRetries; attempt++) {
      try {
        await mongoose.connect(MONGO_URI, { serverSelectionTimeoutMS: 5000 });
        console.log(`[DB/Mongo] Connected to MongoDB (attempt ${attempt}/${maxRetries})`);
        return;
      } catch (err) {
        console.warn(`[DB/Mongo] Attempt ${attempt}/${maxRetries} failed: ${err.message}`);
        if (attempt < maxRetries) {
          await new Promise(r => setTimeout(r, delayMs));
        } else {
          throw new Error('[DB/Mongo] Could not connect to MongoDB after max retries');
        }
      }
    }
  }

  async function getJokes(type, count) {
    const matchStage = type === 'any' ? {} : { type };
    const results = await Joke.aggregate([
      { $match: matchStage },
      { $sample: { size: count } }
    ]);
    return results.map(j => ({
      id:        j._id.toString(),
      setup:     j.setup,
      punchline: j.punchline,
      type:      j.type
    }));
  }

  async function getTypes() {
    // Query the dedicated 'types' collection (written by etl-service).
    // This ensures type consistency: a newly created type (with no jokes yet)
    // is still visible immediately after ETL's type_update ECST event fires.
    // Using Joke.distinct('type') was wrong — it would miss types with 0 jokes.
    const types = await Type.find({}).sort({ name: 1 });
    return types.map((t, i) => ({ id: i + 1, name: t.name }));
  }

  module.exports = { connectWithRetry, getJokes, getTypes };

// =============================================================================
// MYSQL ADAPTER (default)
// =============================================================================
} else {
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

  async function connectWithRetry(maxRetries = 10, delayMs = 3000) {
    for (let attempt = 1; attempt <= maxRetries; attempt++) {
      try {
        const conn = await pool.getConnection();
        console.log(`[DB/MySQL] Connected to MySQL (attempt ${attempt}/${maxRetries})`);
        conn.release();
        return;
      } catch (err) {
        console.warn(`[DB/MySQL] Attempt ${attempt}/${maxRetries} failed: ${err.message}`);
        if (attempt < maxRetries) {
          await new Promise(r => setTimeout(r, delayMs));
        } else {
          throw new Error('[DB/MySQL] Could not connect to MySQL after max retries');
        }
      }
    }
  }

  async function getJokes(type, count) {
    let rows;
    if (type === 'any') {
      [rows] = await pool.query(
        `SELECT j.id, j.setup, j.punchline, t.name AS type
         FROM   jokes j JOIN types t ON j.type_id = t.id
         ORDER  BY RAND() LIMIT ?`,
        [count]
      );
    } else {
      [rows] = await pool.query(
        `SELECT j.id, j.setup, j.punchline, t.name AS type
         FROM   jokes j JOIN types t ON j.type_id = t.id
         WHERE  t.name = ?
         ORDER  BY RAND() LIMIT ?`,
        [type, count]
      );
    }
    return rows;
  }

  async function getTypes() {
    const [rows] = await pool.query('SELECT id, name FROM types ORDER BY name');
    return rows;
  }

  module.exports = { pool, connectWithRetry, getJokes, getTypes };
}
