/**
 * joke-service/server.js
 *
 * Joke Microservice
 * ─────────────────
 * Responsibilities:
 *   - Serve jokes from the MySQL database
 *   - GET /joke/:type?count=N  — fetch N jokes by type
 *   - GET /types               — list all unique joke categories
 *   - GET /health              — health check
 *   - Serve static frontend (public/)
 *
 * Distributed Systems Note:
 *   This service is stateless — no session or local state.
 *   All data lives in MySQL. This means multiple instances
 *   could be run behind a load balancer for horizontal scaling
 *   (relevant for Phase 2 / Kong gateway).
 */

'use strict';

const express = require('express');
const path    = require('path');
const { pool, connectWithRetry } = require('./db');

const app  = express();
const PORT = process.env.PORT || 3001;

// ─────────────────────────────────────────────────────────────────────────────
// CORS — Allow browser requests from any origin (Kong acts as the single
// public entry point; individual service CORS headers are a defence-in-depth
// measure for direct VM access during development/testing).
// ─────────────────────────────────────────────────────────────────────────────
app.use((req, res, next) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.sendStatus(204);
  next();
});

app.use(express.json());

// Serve static files from /public (frontend HTML + JS)
app.use(express.static(path.join(__dirname, 'public')));

// ─────────────────────────────────────────────────────────────
// GET /types
// Returns all unique joke categories ordered alphabetically.
//
// This endpoint is also consumed by the Submit Service via HTTP
// to populate its type cache — a service-to-service call within
// the Docker network (http://joke-service:3001/types).
// ─────────────────────────────────────────────────────────────
app.get('/types', async (req, res) => {
  try {
    const [rows] = await pool.query(
      'SELECT id, name FROM types ORDER BY name'
    );
    res.json(rows);
  } catch (err) {
    console.error('[Joke Service] /types error:', err.message);
    res.status(500).json({ error: 'Failed to fetch types' });
  }
});

// ─────────────────────────────────────────────────────────────
// GET /joke/:type?count=N
//
// Returns jokes of a given type. Optional ?count query param
// controls how many to return (defaults to 1).
//
// - type = "any"  → random selection from ALL types
// - count > DB rows → returns all available (LIMIT handles this)
// - ORDER BY RAND() → random selection each request (stateless)
// ─────────────────────────────────────────────────────────────
app.get('/joke/:type', async (req, res) => {
  const { type } = req.params;
  const count    = Math.max(1, parseInt(req.query.count) || 1);

  try {
    let rows;

    if (type === 'any') {
      // Random jokes across all types
      [rows] = await pool.query(
        `SELECT j.id, j.setup, j.punchline, t.name AS type
         FROM   jokes j
         JOIN   types t ON j.type_id = t.id
         ORDER  BY RAND()
         LIMIT  ?`,
        [count]
      );
    } else {
      // Jokes filtered by specific type name
      [rows] = await pool.query(
        `SELECT j.id, j.setup, j.punchline, t.name AS type
         FROM   jokes j
         JOIN   types t ON j.type_id = t.id
         WHERE  t.name = ?
         ORDER  BY RAND()
         LIMIT  ?`,
        [type, count]
      );
    }

    if (rows.length === 0) {
      return res.status(404).json({
        error: `No jokes found for type: "${type}"`
      });
    }

    // Return a single object when count=1, array otherwise.
    // The frontend normalises both with Array.isArray().
    res.json(count === 1 ? rows[0] : rows);

  } catch (err) {
    console.error('[Joke Service] /joke error:', err.message);
    res.status(500).json({ error: 'Failed to fetch joke' });
  }
});

// ─────────────────────────────────────────────────────────────
// GET /health
// ─────────────────────────────────────────────────────────────
app.get('/health', (_req, res) => {
  res.json({
    status:    'ok',
    service:   'joke-service',
    timestamp: new Date().toISOString()
  });
});

// ─────────────────────────────────────────────────────────────
// Startup — connect to DB first, then open HTTP server
// ─────────────────────────────────────────────────────────────
async function start() {
  try {
    await connectWithRetry();
    app.listen(PORT, () => {
      console.log(`[Joke Service] Listening on http://localhost:${PORT}`);
    });
  } catch (err) {
    console.error('[Joke Service] Fatal startup error:', err.message);
    process.exit(1);
  }
}

start();
