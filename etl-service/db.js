/**
 * etl-service/db.js
 *
 * Unified Database Adapter — MySQL or MongoDB
 * ───────────────────────────────────────────
 * Controlled by the DB_TYPE environment variable:
 *   DB_TYPE=mysql  (default) — uses MySQL via mysql2/promise
 *   DB_TYPE=mongo            — uses MongoDB via mongoose
 *
 * Exports:
 *   connectWithRetry()             — establishes DB connection with retries
 *   insertJoke({ setup, punchline, type })
 *                                  — inserts joke, returns { isNewType: bool }
 *   getAllTypes()                   — returns all types as [{ id, name }]
 *
 * The isNewType flag is used by the ETL to know when to emit a
 * type_update ECST event so downstream services can refresh their caches.
 */

'use strict';

const DB_TYPE = (process.env.DB_TYPE || 'mysql').toLowerCase();

// =============================================================================
// MONGODB ADAPTER
// =============================================================================
if (DB_TYPE === 'mongo') {
  const mongoose = require('mongoose');

  const MONGO_URI = process.env.MONGO_URI || 'mongodb://localhost:27017/jokesdb';

  const typeSchema = new mongoose.Schema(
    { name: { type: String, unique: true, lowercase: true, trim: true, maxlength: 50 } },
    { timestamps: false }
  );

  const jokeSchema = new mongoose.Schema(
    {
      setup:     { type: String, required: true, maxlength: 500 },
      punchline: { type: String, required: true, maxlength: 500 },
      type:      { type: String, required: true, lowercase: true, trim: true, maxlength: 50 }
    },
    { timestamps: true }
  );

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

  // findOneAndUpdate with upsert: new:false → returns null when doc is created new
  async function insertJoke({ setup, punchline, type }) {
    const typeName   = type.trim().toLowerCase();
    const existing   = await Type.findOneAndUpdate(
      { name: typeName },
      { $setOnInsert: { name: typeName } },
      { upsert: true, new: false }
    );
    const isNewType  = existing === null;
    await Joke.create({ setup, punchline, type: typeName });
    console.log(`[DB/Mongo] ✅ Inserted joke (type: ${typeName}): "${String(setup).substring(0, 50)}…"`);
    return { isNewType };
  }

  async function getAllTypes() {
    const types = await Type.find({}).sort({ name: 1 });
    return types.map((t, i) => ({ id: i + 1, name: t.name }));
  }

  module.exports = { connectWithRetry, insertJoke, getAllTypes };

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
    charset:            'utf8mb4',
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

  // INSERT IGNORE is atomic+idempotent. affectedRows===1 → type was newly inserted.
  async function getOrCreateType(typeName) {
    const name = typeName.trim().toLowerCase();
    const [insertResult] = await pool.query(
      'INSERT IGNORE INTO types (name) VALUES (?)',
      [name]
    );
    const isNewType = insertResult.affectedRows > 0;
    const [rows] = await pool.query('SELECT id FROM types WHERE name = ?', [name]);
    if (!rows.length) throw new Error(`Type not found after INSERT IGNORE: "${name}"`);
    return { id: rows[0].id, isNewType };
  }

  async function insertJoke({ setup, punchline, type }) {
    if (!setup || !punchline || !type) {
      throw new Error('Message missing required fields: setup, punchline, type');
    }
    const { id: typeId, isNewType } = await getOrCreateType(type);
    // INSERT IGNORE: silently skips if the same (setup, punchline) already exists.
    // This handles edge cases where a message is re-delivered (at-least-once).
    const [result] = await pool.query(
      'INSERT IGNORE INTO jokes (setup, punchline, type_id) VALUES (?, ?, ?)',
      [setup, punchline, typeId]
    );
    if (result.affectedRows > 0) {
      console.log(`[DB/MySQL] ✅ Inserted joke (type: ${type}): "${String(setup).substring(0, 50)}…"`);
    } else {
      console.warn(`[DB/MySQL] ⚠️  Duplicate joke skipped (already in DB): "${String(setup).substring(0, 50)}…"`);
    }
    return { isNewType };
  }

  async function getAllTypes() {
    const [rows] = await pool.query('SELECT id, name FROM types ORDER BY name');
    return rows;
  }

  module.exports = { connectWithRetry, insertJoke, getAllTypes };
}
