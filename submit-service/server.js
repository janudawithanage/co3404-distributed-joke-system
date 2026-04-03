/**
 * submit-service/server.js
 *
 * Submit Microservice — Option 4
 * ───────────────────────────────
 * Responsibilities:
 *   - POST /submit   – validate and publish joke to "submit" RabbitMQ queue
 *   - GET  /types    – return types from ECST cache (no HTTP call to joke-service)
 *   - GET  /docs     – Swagger UI
 *   - GET  /health   – health check
 *   - Serve static frontend (public/)
 *
 * Distributed Systems Design:
 *   Submit → RabbitMQ "submit" queue → moderate-service → "moderated" queue → ETL → DB
 *
 *   Submit never writes to the database directly.
 *   If RabbitMQ is down, messages cannot be sent (503).
 *   If the moderator service is down, messages queue up (at-least-once delivery).
 *
 * ECST Types Cache:
 *   Types are kept up to date via the "sub_type_update" RabbitMQ queue.
 *   ETL publishes to the "type_update" fanout exchange after creating a new type.
 *   This service updates its local types.json instead of calling joke-service HTTP.
 *   This means GET /types works even when joke-service and ETL are both offline.
 */

'use strict';

const express      = require('express');
const path         = require('path');
const fs           = require('fs').promises;
const helmet       = require('helmet');
const swaggerJsdoc = require('swagger-jsdoc');
const swaggerUi    = require('swagger-ui-express');

const { connect, publishJoke } = require('./rabbitmq');

const app  = express();
const PORT = process.env.PORT || 4200;

const CACHE_DIR  = '/app/cache';
const CACHE_FILE = path.join(CACHE_DIR, 'types.json');

// ─────────────────────────────────────────────────────────────────────────────
// Security Headers (helmet)
// ─────────────────────────────────────────────────────────────────────────────
app.use(helmet({
  contentSecurityPolicy: false,
  crossOriginEmbedderPolicy: false
}));

// ─────────────────────────────────────────────────────────────────────────────
// Request Logging — structured per-request log line with duration
// ─────────────────────────────────────────────────────────────────────────────
app.use((req, res, next) => {
  const start = Date.now();
  res.on('finish', () => {
    const ms = Date.now() - start;
    console.log(`[Submit Service] ${req.method} ${req.originalUrl} → ${res.statusCode} (${ms}ms)`);
  });
  next();
});

// ─────────────────────────────────────────────────────────────────────────────
// CORS
// ─────────────────────────────────────────────────────────────────────────────
app.use((req, res, next) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.sendStatus(204);
  next();
});
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));
app.use('/submit', express.static(path.join(__dirname, 'public')));

// ─────────────────────────────────────────────────────────────────────────────
// GET /config.js — Runtime configuration injected into the frontend
//
// Exposes the gateway base URL (and optionally Azure base URL) as a
// global window.APP_CONFIG object — identical pattern to joke-service.
// The frontend app.js reads window.APP_CONFIG.gatewayBase to route all
// API calls through Kong instead of hard-coding a base URL.
// ─────────────────────────────────────────────────────────────────────────────
app.get('/config.js', (_req, res) => {
  const config = {
    gatewayBase:  process.env.PUBLIC_GATEWAY_BASE  || '',
    azureBase:    process.env.PUBLIC_AZURE_BASE     || '',
    localBase:    process.env.PUBLIC_LOCAL_BASE     || '',
  };
  res.type('application/javascript').send(
    `window.APP_CONFIG = ${JSON.stringify(config)};`
  );
});

// ─────────────────────────────────────────────────────────────────────────────
// Swagger / OpenAPI
// ─────────────────────────────────────────────────────────────────────────────
const swaggerOptions = {
  definition: {
    openapi: '3.0.0',
    info: {
      title:       'Submit Service API',
      version:     '2.0.0',
      description: 'CO3404 Distributed Systems Option 4 – Submit jokes to moderation queue'
    },
    // When PUBLIC_GATEWAY_BASE is set (production/Azure) that server appears FIRST
    // so Swagger UI selects it as the default for "Try it out" requests.
    // Locally (no env var set) the local direct server appears first.
    servers: (() => {
      const azureBase = process.env.PUBLIC_AZURE_BASE || process.env.PUBLIC_GATEWAY_BASE;
      const list = [
        { url: 'http://localhost:8000', description: 'Local – Kong (recommended)' },
        { url: 'http://localhost:3200', description: 'Local – direct (bypass Kong)' },
      ];
      if (azureBase && azureBase !== 'http://localhost:3200' && azureBase !== 'http://localhost:8000') {
        // Put Azure server at the top so Swagger UI picks it as default
        list.unshift({ url: azureBase, description: 'Hosted – Azure Kong' });
      }
      return list;
    })()
  },
  apis: ['./server.js']
};
const swaggerSpec = swaggerJsdoc(swaggerOptions);
app.use('/docs', swaggerUi.serve, swaggerUi.setup(swaggerSpec));

// ─────────────────────────────────────────────────────────────────────────────
// POST /submit
// ─────────────────────────────────────────────────────────────────────────────
/**
 * @swagger
 * /submit:
 *   post:
 *     summary: Submit a new joke for moderation
 *     description: >
 *       Publishes the joke to the RabbitMQ "submit" queue.
 *       The moderate-service picks it up for human review before ETL writes to DB.
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [setup, punchline, type]
 *             properties:
 *               setup:     { type: string }
 *               punchline: { type: string }
 *               type:      { type: string }
 *     responses:
 *       202: { description: Joke queued for moderation }
 *       400: { description: Missing required fields }
 *       503: { description: RabbitMQ unavailable }
 */
app.post('/submit', async (req, res) => {
  const { setup, punchline, type } = req.body;

  if (!setup || !punchline || !type) {
    return res.status(400).json({
      error: 'Missing required fields: setup, punchline, type'
    });
  }

  if (setup.length > 500 || punchline.length > 500) {
    return res.status(400).json({ error: 'setup and punchline must each be 500 characters or fewer' });
  }
  if (type.length > 50) {
    return res.status(400).json({ error: 'type must be 50 characters or fewer' });
  }

  const jokeData = {
    setup:       setup.trim(),
    punchline:   punchline.trim(),
    type:        type.trim().toLowerCase(),
    submittedAt: new Date().toISOString()
  };

  try {
    await publishJoke(jokeData);
    res.status(202).json({
      message: 'Joke queued for human moderation',
      queued:  jokeData
    });
  } catch (err) {
    console.error('[Submit Service] Failed to publish:', err.message);
    res.status(503).json({
      error: 'Message broker unavailable – please try again shortly'
    });
  }
});

// ─────────────────────────────────────────────────────────────
// GET /types  — ECST cache-only
//
// Returns types from the local cache file which is kept current
// by the ECST type_update events from the ETL service.
// No HTTP call to joke-service — fully decoupled.
// Returns [] if cache is not yet populated (service cold start).
// ─────────────────────────────────────────────────────────────
/**
 * @swagger
 * /types:
 *   get:
 *     summary: Get all joke types (from local ECST cache)
 *     responses:
 *       200:
 *         description: Array of joke type objects
 */
app.get('/types', async (_req, res) => {
  try {
    const raw   = await fs.readFile(CACHE_FILE, 'utf8');
    const types = JSON.parse(raw);
    res.json(types);
  } catch (_err) {
    // Cache not yet populated — return empty array; types will arrive via ECST
    res.json([]);
  }
});

// ─────────────────────────────────────────────────────────────
// GET /health
// ─────────────────────────────────────────────────────────────
/**
 * @swagger
 * /health:
 *   get:
 *     summary: Health check
 *     responses:
 *       200: { description: Service is healthy }
 */
app.get('/health', (_req, res) => {
  res.json({
    status:    'ok',
    service:   'submit-service',
    timestamp: new Date().toISOString()
  });
});

// ─────────────────────────────────────────────────────────────
// Startup
// ─────────────────────────────────────────────────────────────
let server;
async function start() {
  await fs.mkdir(CACHE_DIR, { recursive: true });
  connect();
  server = app.listen(PORT, () => {
    console.log(`[Submit Service] Listening on http://localhost:${PORT}`);
    console.log(`[Submit Service] Swagger UI at  http://localhost:${PORT}/docs`);
  });
}

// ─────────────────────────────────────────────────────────────
// Graceful Shutdown — close HTTP server on SIGTERM/SIGINT
// Docker sends SIGTERM on `docker stop`. This ensures in-flight
// requests complete before the container exits.
// ─────────────────────────────────────────────────────────────
function shutdown(signal) {
  console.log(`[Submit Service] ${signal} received — shutting down gracefully…`);
  if (server) {
    server.close(() => {
      console.log('[Submit Service] HTTP server closed');
      process.exit(0);
    });
    setTimeout(() => process.exit(1), 10000).unref();
  } else {
    process.exit(0);
  }
}
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT',  () => shutdown('SIGINT'));

start().catch(err => {
  console.error('[Submit Service] Fatal startup error:', err.message);
  process.exit(1);
});
