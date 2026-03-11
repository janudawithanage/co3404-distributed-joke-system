/**
 * joke-service/server.js
 *
 * Joke Microservice — Option 4
 * ─────────────────────────────
 * Responsibilities:
 *   - Serve jokes from MySQL (default) or MongoDB (DB_TYPE=mongo)
 *   - GET /joke/:type?count=N  — fetch N jokes by type
 *   - GET /types               — list all unique joke categories
 *   - GET /health              — health check
 *   - Serve static frontend (public/)
 *
 * Distributed Systems Note:
 *   This service is stateless — no session or local state.
 *   All data lives in the database. Multiple instances could run
 *   behind a load balancer for horizontal scaling.
 *
 *   DB_TYPE=mysql (default) → MySQL 8 via mysql2/promise
 *   DB_TYPE=mongo           → MongoDB via mongoose
 */

'use strict';

const express = require('express');
const path    = require('path');
const { connectWithRetry, getJokes, getTypes } = require('./db');

const app  = express();
const PORT = process.env.PORT || 4000;

// ─────────────────────────────────────────────────────────────────────────────
// CORS
// ─────────────────────────────────────────────────────────────────────────────
app.use((req, res, next) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.sendStatus(204);
  next();
});

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));
app.use('/joke-ui', express.static(path.join(__dirname, 'public')));

// ─────────────────────────────────────────────────────────────
// GET /types
// Returns all unique joke categories.
// ─────────────────────────────────────────────────────────────
app.get('/types', async (_req, res) => {
  try {
    const types = await getTypes();
    res.json(types);
  } catch (err) {
    console.error('[Joke Service] /types error:', err.message);
    res.status(500).json({ error: 'Failed to fetch types' });
  }
});

// ─────────────────────────────────────────────────────────────
// GET /joke/:type?count=N
//
// Returns jokes of a given type. Optional ?count param controls
// how many to return (defaults to 1).
//
// - type = "any"  → random selection from ALL types
// - count > DB rows → returns all available
// - ORDER BY RAND() / $sample → random selection each request
// ─────────────────────────────────────────────────────────────
app.get('/joke/:type', async (req, res) => {
  const { type } = req.params;
  const count    = Math.max(1, parseInt(req.query.count) || 1);

  try {
    const rows = await getJokes(type, count);

    if (rows.length === 0) {
      return res.status(404).json({
        error: `No jokes found for type: "${type}"`
      });
    }

    // Return a single object when count=1, array otherwise.
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
    dbType:    process.env.DB_TYPE || 'mysql',
    timestamp: new Date().toISOString()
  });
});

// ─────────────────────────────────────────────────────────────
// Startup
// ─────────────────────────────────────────────────────────────
async function start() {
  try {
    await connectWithRetry();
    app.listen(PORT, () => {
      console.log(`[Joke Service] Listening on http://localhost:${PORT}`);
      console.log(`[Joke Service] DB type: ${process.env.DB_TYPE || 'mysql'}`);
    });
  } catch (err) {
    console.error('[Joke Service] Fatal startup error:', err.message);
    process.exit(1);
  }
}

start();
