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
const swaggerJsdoc = require('swagger-jsdoc');
const swaggerUi    = require('swagger-ui-express');

const { connect, publishJoke } = require('./rabbitmq');

const app  = express();
const PORT = process.env.PORT || 4200;

const CACHE_DIR  = '/app/cache';
const CACHE_FILE = path.join(CACHE_DIR, 'types.json');

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
    servers: [
      { url: 'http://localhost:3200',  description: 'Local – direct' },
      { url: 'http://localhost:8000',  description: 'Local – Kong' },
      { url: 'https://KONG_PUBLIC_IP', description: 'Azure – Kong (replace IP)' }
    ]
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
async function start() {
  await fs.mkdir(CACHE_DIR, { recursive: true });
  connect();
  app.listen(PORT, () => {
    console.log(`[Submit Service] Listening on http://localhost:${PORT}`);
    console.log(`[Submit Service] Swagger UI at  http://localhost:${PORT}/docs`);
  });
}

start().catch(err => {
  console.error('[Submit Service] Fatal startup error:', err.message);
  process.exit(1);
});
