/**
 * submit-service/server.js
 *
 * Submit Microservice
 * ───────────────────
 * Responsibilities:
 *   - POST /submit   – validate and publish joke to RabbitMQ
 *   - GET  /types    – proxy Joke Service; cache result for resilience
 *   - GET  /docs     – Swagger UI for interactive API documentation
 *   - GET  /health   – health check
 *   - Serve static frontend (public/)
 *
 * Distributed Systems Design:
 *   Submit → RabbitMQ → ETL → MySQL
 *
 *   Submit never writes to MySQL directly.
 *   This decoupling means:
 *     • Submit works even if the DB is down
 *     • If ETL is down, messages queue up (at-least-once delivery)
 *     • If Joke service is down, /types falls back to a local cache
 */

'use strict';

const express      = require('express');
const path         = require('path');
const axios        = require('axios');
const fs           = require('fs').promises;
const swaggerJsdoc = require('swagger-jsdoc');
const swaggerUi    = require('swagger-ui-express');

const { connect, publishJoke } = require('./rabbitmq');

const app  = express();
const PORT = process.env.PORT || 4200;

// Cache location – mounted as a Docker named volume (type_cache)
const CACHE_DIR  = '/app/cache';
const CACHE_FILE = path.join(CACHE_DIR, 'types.json');

const JOKE_SERVICE_URL = process.env.JOKE_SERVICE_URL || 'http://joke-service:4000';
// ─────────────────────────────────────────────────────────────────────────────
// CORS — Allow browser requests from any origin.
// Required when the frontend is served through Kong HTTPS and makes API calls
// back through the same Kong origin (relative paths). Defence-in-depth for
// direct VM access during testing.
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
// Also serve at /submit/ prefix so that <base href="/submit/"> in index.html
// resolves assets correctly when the page is loaded via Kong's /submit route.
app.use('/submit', express.static(path.join(__dirname, 'public')));

// ─────────────────────────────────────────────────────────────
// Swagger / OpenAPI setup
// ─────────────────────────────────────────────────────────────
const swaggerOptions = {
  definition: {
    openapi: '3.0.0',
    info: {
      title:       'Submit Service API',
      version:     '1.0.0',
      description: 'CO3404 Distributed Systems – Submit new jokes to the RabbitMQ queue'
    },
    servers: [
      { url: 'http://localhost:3200',  description: 'Local – direct (host port 3200)' },
      { url: 'http://localhost:8000',  description: 'Local – via Kong gateway (port 8000)' },
      { url: 'https://KONG_PUBLIC_IP', description: 'Azure – Kong gateway (replace KONG_PUBLIC_IP)' }
    ]
  },
  apis: ['./server.js'] // source file containing @swagger annotations
};

const swaggerSpec = swaggerJsdoc(swaggerOptions);
app.use('/docs', swaggerUi.serve, swaggerUi.setup(swaggerSpec));

// ─────────────────────────────────────────────────────────────
// POST /submit
// ─────────────────────────────────────────────────────────────
/**
 * @swagger
 * /submit:
 *   post:
 *     summary: Submit a new joke
 *     description: >
 *       Publishes the joke as a JSON message to the RabbitMQ
 *       "jokes_queue". The ETL service consumes the queue and
 *       persists the joke to MySQL. This endpoint does NOT
 *       write to the database directly (decoupled architecture).
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [setup, punchline, type]
 *             properties:
 *               setup:
 *                 type: string
 *                 example: "Why do programmers wear glasses?"
 *               punchline:
 *                 type: string
 *                 example: "Because they can't C#!"
 *               type:
 *                 type: string
 *                 example: "programming"
 *     responses:
 *       202:
 *         description: Joke accepted and queued for processing
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 message: { type: string }
 *                 queued:  { type: object }
 *       400:
 *         description: Missing required fields
 *       503:
 *         description: RabbitMQ unavailable
 */
app.post('/submit', async (req, res) => {
  const { setup, punchline, type } = req.body;

  if (!setup || !punchline || !type) {
    return res.status(400).json({
      error: 'Missing required fields: setup, punchline, type'
    });
  }

  const jokeData = {
    setup:     setup.trim(),
    punchline: punchline.trim(),
    type:      type.trim().toLowerCase()
  };

  try {
    await publishJoke(jokeData);
    res.status(202).json({
      message: 'Joke queued for processing by the ETL service',
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
// GET /types  (resilient proxy + cache)
//
// Distributed Systems Note:
//   This implements a simplified cache-aside pattern:
//     1. Request fresh data from Joke Service
//     2. Write to local cache file (Docker volume)
//     3. On failure, read from cache file
//
//   The cache file lives on a named Docker volume so it
//   persists across container restarts. This means Submit
//   can return joke types even when Joke Service is stopped.
// ─────────────────────────────────────────────────────────────
/**
 * @swagger
 * /types:
 *   get:
 *     summary: Get all joke types
 *     description: >
 *       Fetches types from the Joke Service and caches them locally.
 *       Returns cached data if the Joke Service is unreachable.
 *     responses:
 *       200:
 *         description: Array of joke type objects
 *         content:
 *           application/json:
 *             schema:
 *               type: array
 *               items:
 *                 type: object
 *                 properties:
 *                   id:   { type: integer }
 *                   name: { type: string }
 *       503:
 *         description: Joke Service down and no cache available
 */
app.get('/types', async (req, res) => {
  try {
    // Try the Joke Service first (3 s timeout to fail fast)
    const response = await axios.get(`${JOKE_SERVICE_URL}/types`, {
      timeout: 3000
    });
    const types = response.data;

    // Update the cache file for future fallback use
    await fs.mkdir(CACHE_DIR, { recursive: true });
    await fs.writeFile(CACHE_FILE, JSON.stringify(types));
    console.log('[Submit Service] Types fetched live and cache updated');

    res.json(types);

  } catch (err) {
    // Joke Service unreachable – fall back to cache
    console.warn('[Submit Service] Joke Service unavailable – reading from cache');
    try {
      const raw   = await fs.readFile(CACHE_FILE, 'utf8');
      const types = JSON.parse(raw);
      res.json(types);
      console.log('[Submit Service] Returned types from cache');
    } catch (cacheErr) {
      res.status(503).json({
        error:  'Joke Service unavailable and no cache found',
        hint:   'Start the Joke Service and call GET /types once to prime the cache'
      });
    }
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
 *       200:
 *         description: Service is healthy
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
  // Ensure the cache directory exists before anything tries to use it
  await fs.mkdir(CACHE_DIR, { recursive: true });

  // Start RabbitMQ connection in the background (non-blocking).
  // The connect() function retries automatically on failure.
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
