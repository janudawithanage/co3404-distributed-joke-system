/**
 * moderator-service/server.js
 *
 * Moderator Microservice
 * ──────────────────────
 * Responsibilities:
 *   - Pull jokes from the "submit" RabbitMQ queue for human review
 *   - Allow a moderator to edit, approve, or reject each joke
 *   - Forward approved jokes to the "moderated" queue → ETL → MySQL
 *   - Maintain a local types cache, updated via type_update events
 *   - Serve the Moderator HTML/JS frontend
 *
 * ── New architecture flow (Option 4) ────────────────────────
 *
 *   Submit Service → [submit queue]
 *                           ↓
 *                   Moderator Service   ← GET  /moderate  (UI polls)
 *                           ↓             POST /moderated (approve)
 *                           ↓             POST /reject    (discard)
 *                   [moderated queue]
 *                           ↓
 *                     ETL Service → MySQL
 *
 * ── Pending joke state ──────────────────────────────────────
 *   One joke is held "in-flight" (unacked) at a time.
 *   GET /moderate returns the same joke until the moderator acts.
 *   On service restart, RabbitMQ redelivers the unacked message.
 *
 * ── Event-Carried State Transfer ────────────────────────────
 *   Moderator subscribes to "mod_type_update" queue.
 *   When ETL creates a new type it publishes a type_update event
 *   to the "type_updates" fanout exchange, which fans out to both
 *   "mod_type_update" and "sub_type_update" queues.
 *   The moderator updates its local cache file — no polling needed.
 */

'use strict';

const express = require('express');
const path    = require('path');
const fs      = require('fs').promises;
const axios   = require('axios');

const rabbitMQ = require('./rabbitmq');

const app  = express();
const PORT = process.env.PORT || 3004;

const JOKE_SERVICE_URL = process.env.JOKE_SERVICE_URL || 'http://joke-service:3001';

// Cache — mounted as a Docker named volume (mod_type_cache).
// Persists across container restarts so types survive a service reboot.
const CACHE_DIR  = '/app/cache';
const CACHE_FILE = path.join(CACHE_DIR, 'types.json');

// ── In-flight pending joke ────────────────────────────────────
// One message is held unacked in RabbitMQ while under review.
// null means no joke is currently being reviewed.
// Cleared on RabbitMQ reconnect (RabbitMQ redelivers the message).
let pendingJoke = null; // { content: { setup, punchline, type }, rawMsg }

// ─────────────────────────────────────────────────────────────────────────────
// Middleware
// ─────────────────────────────────────────────────────────────────────────────
app.use((req, res, next) => {
  res.setHeader('Access-Control-Allow-Origin',  '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.sendStatus(204);
  next();
});

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// ─────────────────────────────────────────────────────────────
// GET /moderate
//
// Polls the "submit" queue for the next joke awaiting review.
//
// Behaviour:
//   • If a joke is already in review (pendingJoke set), return it
//     unchanged — the moderator is still reviewing it.
//   • Otherwise, call channel.get() to pull one message.
//   • If the queue is empty, return { waiting: true } so the
//     frontend can display "No jokes available. Waiting…"
//
// Distributed Systems Note:
//   channel.get() uses basicGet (synchronous pull) rather than
//   basicConsume (push). This gives the moderator full control over
//   when the next message is fetched, matching the one-at-a-time
//   human review workflow.
// ─────────────────────────────────────────────────────────────
app.get('/moderate', async (req, res) => {
  try {
    // A joke is already in review — keep returning it until acted on
    if (pendingJoke) {
      return res.json({ joke: pendingJoke.content });
    }

    if (!rabbitMQ.isReady()) {
      return res.json({ waiting: true, message: 'Connecting to message broker…' });
    }

    // Pull the next joke from the submit queue (manual ack mode)
    const result = await rabbitMQ.getNextJoke();
    if (!result) {
      return res.json({ waiting: true, message: 'No jokes available. Waiting…' });
    }

    pendingJoke = result;
    console.log('[Moderator] New joke pulled for review:', result.content);

    res.json({ joke: pendingJoke.content });

  } catch (err) {
    console.error('[Moderator] GET /moderate error:', err.message);
    res.status(500).json({ error: 'Failed to fetch joke from queue' });
  }
});

// ─────────────────────────────────────────────────────────────
// POST /moderated
//
// Moderator approves the current joke (potentially with edits).
//
// Steps:
//   1. Validate the edited joke fields from the request body
//   2. ACK the in-flight message  → removes it from "submit" queue
//   3. Publish the approved joke  → "moderated" queue → ETL → MySQL
//   4. Clear pendingJoke state
//
// The body fields (setup, punchline, type) are the moderator's
// final version — may differ from what was originally submitted.
// ─────────────────────────────────────────────────────────────
app.post('/moderated', async (req, res) => {
  if (!pendingJoke) {
    return res.status(400).json({ error: 'No joke is currently pending moderation' });
  }

  const { setup, punchline, type } = req.body;
  if (!setup || !punchline || !type) {
    return res.status(400).json({ error: 'Missing required fields: setup, punchline, type' });
  }

  const approvedJoke = {
    setup:     setup.trim(),
    punchline: punchline.trim(),
    type:      type.trim().toLowerCase()
  };

  try {
    // Ack the original message — permanently removes from "submit" queue
    rabbitMQ.ackJoke(pendingJoke.rawMsg);

    // Publish approved (possibly edited) joke to the "moderated" queue
    rabbitMQ.publishModerated(approvedJoke);

    console.log('[Moderator] ✅ Joke approved and forwarded to "moderated" queue');
    pendingJoke = null;

    res.json({
      message: 'Joke approved and queued for database insertion',
      joke:    approvedJoke
    });
  } catch (err) {
    console.error('[Moderator] POST /moderated error:', err.message);
    res.status(503).json({ error: 'Message broker unavailable — please try again' });
  }
});

// ─────────────────────────────────────────────────────────────
// POST /reject
//
// Moderator rejects the current joke. It is permanently discarded.
//
// channel.nack(msg, allUpTo=false, requeue=false) sends a negative
// acknowledgement without requeuing. The message is dropped.
// In production, a dead-letter exchange could capture rejected jokes.
// ─────────────────────────────────────────────────────────────
app.post('/reject', (req, res) => {
  if (!pendingJoke) {
    return res.status(400).json({ error: 'No joke is currently pending moderation' });
  }

  try {
    rabbitMQ.rejectJoke(pendingJoke.rawMsg);
    const rejected = pendingJoke.content;
    pendingJoke = null;
    console.log('[Moderator] ❌ Joke rejected and discarded:', rejected);
    res.json({ message: 'Joke rejected and discarded', joke: rejected });
  } catch (err) {
    console.error('[Moderator] POST /reject error:', err.message);
    res.status(503).json({ error: 'Message broker unavailable — please try again' });
  }
});

// ─────────────────────────────────────────────────────────────
// GET /types
//
// Returns all joke types from the local file cache.
//
// Cache is:
//   1. Seeded at startup from the Joke Service HTTP endpoint
//   2. Updated in real-time via type_update events (ECST)
//
// The frontend uses this to populate the type field and
// show a dropdown of existing categories for consistency.
// ─────────────────────────────────────────────────────────────
app.get('/types', async (_req, res) => {
  try {
    const raw   = await fs.readFile(CACHE_FILE, 'utf8');
    const types = JSON.parse(raw);
    res.json(types);
  } catch {
    // Cache missing — return empty array; UI falls back to free-text input
    res.json([]);
  }
});

// ─────────────────────────────────────────────────────────────
// GET /health
// ─────────────────────────────────────────────────────────────
app.get('/health', (_req, res) => {
  res.json({
    status:     'ok',
    service:    'moderator-service',
    connected:  rabbitMQ.isReady(),
    hasPending: !!pendingJoke,
    timestamp:  new Date().toISOString()
  });
});

// ─────────────────────────────────────────────────────────────
// Types cache helpers
// ─────────────────────────────────────────────────────────────

/**
 * Seed the types cache from the Joke Service at startup.
 * Gracefully falls back to an empty cache if the service
 * is unreachable (e.g. during parallel container startup).
 */
async function seedTypesCache() {
  try {
    const response = await axios.get(`${JOKE_SERVICE_URL}/types`, { timeout: 3000 });
    await fs.mkdir(CACHE_DIR, { recursive: true });
    await fs.writeFile(CACHE_FILE, JSON.stringify(response.data));
    console.log('[Moderator] Types cache seeded from Joke Service');
  } catch {
    console.warn('[Moderator] Joke Service unreachable — using existing or empty types cache');
    await fs.mkdir(CACHE_DIR, { recursive: true });
    try {
      await fs.access(CACHE_FILE); // exists, keep it
    } catch {
      await fs.writeFile(CACHE_FILE, JSON.stringify([])); // create empty cache
    }
  }
}

/**
 * Handle a type_update event (Event-Carried State Transfer).
 *
 * When ETL inserts a brand-new joke type into MySQL, it publishes:
 *   { event: "type_update", type: { id, name }, timestamp }
 * to the "type_updates" fanout exchange.
 *
 * This handler adds the new type to the local cache file.
 * Idempotent: duplicate events (at-least-once delivery) are
 * safely ignored via the find() check.
 *
 * @param {{ event: string, type: { id: number, name: string }, timestamp: string }} event
 */
async function handleTypeUpdate(event) {
  if (event.event !== 'type_update') return;
  const { id, name } = event.type;

  try {
    await fs.mkdir(CACHE_DIR, { recursive: true });

    let types = [];
    try {
      const raw = await fs.readFile(CACHE_FILE, 'utf8');
      types = JSON.parse(raw);
    } catch { /* cache missing — start fresh */ }

    // Idempotency check: only add if not already present
    if (!types.find(t => t.name === name)) {
      types.push({ id, name });
      types.sort((a, b) => a.name.localeCompare(b.name));
      await fs.writeFile(CACHE_FILE, JSON.stringify(types));
      console.log(`[Moderator] 📦 Types cache updated via event: added "${name}"`);
    } else {
      console.log(`[Moderator] type_update event ignored — type "${name}" already cached`);
    }
  } catch (err) {
    console.error('[Moderator] Failed to apply type_update event to cache:', err.message);
  }
}

// ─────────────────────────────────────────────────────────────
// Startup
// ─────────────────────────────────────────────────────────────
async function start() {
  // Ensure cache directory exists before any file I/O
  await fs.mkdir(CACHE_DIR, { recursive: true });

  // Attempt to seed types cache from Joke Service
  await seedTypesCache();

  // ── Register Event-Carried State Transfer handler ──────────
  rabbitMQ.onTypeUpdate(handleTypeUpdate);

  // ── Clear pending joke state on reconnect ──────────────────
  // When the RabbitMQ connection drops, the in-flight message
  // is automatically redelivered by RabbitMQ on reconnection.
  // We clear pendingJoke so GET /moderate fetches it fresh.
  rabbitMQ.onReconnect(() => {
    if (pendingJoke) {
      console.warn('[Moderator] Connection dropped — clearing pending joke (will be redelivered)');
      pendingJoke = null;
    }
  });

  // ── Connect to RabbitMQ (non-blocking, retries automatically) ──
  rabbitMQ.connect();

  app.listen(PORT, () => {
    console.log(`[Moderator Service] Listening on  http://localhost:${PORT}`);
    console.log(`[Moderator Service] UI at          http://localhost:${PORT}/`);
    console.log(`[Moderator Service] Health at      http://localhost:${PORT}/health`);
  });
}

start().catch(err => {
  console.error('[Moderator Service] Fatal startup error:', err.message);
  process.exit(1);
});
