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
const path = require('path');
const helmet = require('helmet');
const { connectWithRetry, getJokes, getTypes } = require('./db');

const app = express();
const PORT = process.env.PORT || 4000;

// Shared config for the unified luxury homepage. Values can be overridden
// via environment variables; otherwise sensible defaults are derived.
function buildPublicConfig() {
  const gatewayBase = process.env.PUBLIC_GATEWAY_BASE || '';
  const localBase = process.env.PUBLIC_LOCAL_BASE || '';
  const azureBase = process.env.PUBLIC_AZURE_BASE || '';
  const jokeBase = process.env.PUBLIC_JOKE_BASE || '';
  const submitBase = process.env.PUBLIC_SUBMIT_BASE || '';
  const moderateBase = process.env.PUBLIC_MODERATE_BASE || '';

  return {
    gatewayBase,
    localBase,
    azureBase,
    jokeServiceBase: jokeBase,
    submitServiceBase: submitBase,
    moderateServiceBase: moderateBase
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Security Headers (helmet)
// ─────────────────────────────────────────────────────────────────────────────
app.use(helmet({
  contentSecurityPolicy: false,   // allow inline styles / Google Fonts in the frontend
  crossOriginEmbedderPolicy: false
}));

// ─────────────────────────────────────────────────────────────────────────────
// Request Logging — structured per-request log line with duration
// ─────────────────────────────────────────────────────────────────────────────
app.use((req, res, next) => {
  const start = Date.now();
  res.on('finish', () => {
    const ms = Date.now() - start;
    console.log(`[Joke Service] ${req.method} ${req.originalUrl} → ${res.statusCode} (${ms}ms)`);
  });
  next();
});

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

// ─────────────────────────────────────────────────────────────────────────────
// Cross-service Redirects
//
// When a user visits /submit/, /moderate-ui/, or /docs directly on the
// joke-service (port 3000), they get a 404 because those routes live on
// other services.  These redirects forward them to the correct endpoint:
//   /submit/      → submit-service  (via Kong or direct)
//   /moderate-ui/ → moderate-service (via Kong or direct)
//   /docs         → submit-service Swagger UI (via Kong or direct)
//
// Kong gateway (8000) is preferred when PUBLIC_GATEWAY_BASE is set.
// Fall back to direct service ports for pure-local use without Kong.
// ─────────────────────────────────────────────────────────────────────────────
app.use('/submit', (req, res, next) => {
  // Only redirect GET browser requests (not API POST /submit calls if any)
  if (req.method !== 'GET' && req.method !== 'HEAD') return next();
  const gw = process.env.PUBLIC_GATEWAY_BASE || 'http://localhost:8000';
  return res.redirect(302, `${gw}/submit${req.url === '/' ? '/' : req.url}`);
});

app.use('/moderate-ui', (req, res) => {
  const gw = process.env.PUBLIC_GATEWAY_BASE || 'http://localhost:8000';
  return res.redirect(302, `${gw}/moderate-ui${req.url === '/' ? '/' : req.url}`);
});

app.use('/docs', (req, res) => {
  const gw = process.env.PUBLIC_GATEWAY_BASE || 'http://localhost:8000';
  return res.redirect(302, `${gw}/docs${req.url === '/' ? '' : req.url}`);
});

// ─────────────────────────────────────────────────────────────────────────────
// Runtime Config — window.APP_CONFIG
//
// Served at both /config.js (root) AND /joke-ui/config.js so that the
// frontend works whether accessed via / or /joke-ui/.
//
// The HTML has <base href="/joke-ui/">, which means a relative <script src="config.js">
// resolves to /joke-ui/config.js — without this alias it returns 404, and
// window.APP_CONFIG is never set.  Without APP_CONFIG the type dropdown stays
// empty (bases.gateway falls back to window.location.origin = the joke-service
// itself, and submitting POSTs to the wrong service).
// ─────────────────────────────────────────────────────────────────────────────
function serveConfig(_req, res) {
  res.type('application/javascript').send(
    `window.APP_CONFIG = ${JSON.stringify(buildPublicConfig())};`
  );
}
app.get('/config.js', serveConfig);
app.get('/joke-ui/config.js', serveConfig);

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
  const count = Math.max(1, parseInt(req.query.count) || 1);

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
    status: 'ok',
    service: 'joke-service',
    dbType: process.env.DB_TYPE || 'mysql',
    timestamp: new Date().toISOString()
  });
});

// ─────────────────────────────────────────────────────────────
// Startup
// ─────────────────────────────────────────────────────────────
let server;
async function start() {
  try {
    await connectWithRetry();
    server = app.listen(PORT, () => {
      console.log(`[Joke Service] Listening on http://localhost:${PORT}`);
      console.log(`[Joke Service] DB type: ${process.env.DB_TYPE || 'mysql'}`);
    });
  } catch (err) {
    console.error('[Joke Service] Fatal startup error:', err.message);
    process.exit(1);
  }
}

// ─────────────────────────────────────────────────────────────
// Graceful Shutdown — close HTTP server on SIGTERM/SIGINT
// Docker sends SIGTERM on `docker stop`. This ensures in-flight
// requests complete before the container exits.
// ─────────────────────────────────────────────────────────────
function shutdown(signal) {
  console.log(`[Joke Service] ${signal} received — shutting down gracefully…`);
  if (server) {
    server.close(() => {
      console.log('[Joke Service] HTTP server closed');
      process.exit(0);
    });
    // Force exit after 10 s if connections linger
    setTimeout(() => process.exit(1), 10000).unref();
  } else {
    process.exit(0);
  }
}
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));

start();
