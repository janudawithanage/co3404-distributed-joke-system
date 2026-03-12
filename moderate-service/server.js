/**
 * moderate-service/server.js
 *
 * Joke Moderation Microservice
 * ─────────────────────────────
 * Responsibilities:
 *   - Human moderator reviews submitted jokes before they enter the database
 *   - GET  /moderate        – fetch next joke from "submit" queue for review
 *   - POST /moderated       – approve joke (ack + publish to "moderated" queue)
 *   - POST /reject          – reject joke (nack + discard permanently)
 *   - GET  /types           – return types from local ECST cache file
 *   - GET  /health          – health check
 *   - Serves static moderation UI from /public
 *
 * Architecture:
 *   submit-service → RabbitMQ "submit" queue → moderate-service (THIS)
 *   moderate-service → RabbitMQ "moderated" queue → etl-service → DB
 *
 * Event-Carried State Transfer:
 *   Types cache is kept up to date via the "mod_type_update" RabbitMQ queue.
 *   The ETL service publishes a type_update event (via fanout exchange) when
 *   a new joke type is written to the database. No synchronous HTTP calls.
 *
 * Authentication:
 *   OpenID Connect via Auth0 (express-openid-connect).
 *   The moderation UI and API endpoints require authentication.
 *   GET /health and GET /types are intentionally public.
 */

'use strict';

const express = require('express');
const path    = require('path');
const fs      = require('fs').promises;

const { connect, getNextJoke, approveJoke, rejectJoke, isReady } = require('./rabbitmq');
const { auth, buildAuthConfig, requiresAuth, requiresAuthJson, AUTH_ENABLED }  = require('./auth');

const app  = express();
const PORT = process.env.PORT || 4300;

// Cache directory mounted as Docker named volume
const CACHE_DIR  = '/app/cache';
const CACHE_FILE = path.join(CACHE_DIR, 'types.json');

// ─────────────────────────────────────────────────────────────────────────────
// CORS — allow browser requests from Kong's public origin
// ─────────────────────────────────────────────────────────────────────────────
app.use((req, res, next) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  if (req.method === 'OPTIONS') return res.sendStatus(204);
  next();
});

app.use(express.json());

// ─────────────────────────────────────────────────────────────────────────────
// OIDC Middleware (Auth0 express-openid-connect)
// Only active when AUTH0_CLIENT_ID + AUTH0_ISSUER_BASE_URL + AUTH0_SECRET are set.
// Without them the service runs in "no-auth" mode: all requests are treated as
// authenticated with a placeholder user so the core moderate flow still works.
// ─────────────────────────────────────────────────────────────────────────────
if (AUTH_ENABLED) {
  console.log('[Auth] Auth0 OIDC enabled — baseURL:', process.env.AUTH0_BASE_URL);
  app.use(auth(buildAuthConfig(PORT)));
} else {
  console.warn('[Auth] Auth0 NOT configured — running in unauthenticated mode. Set AUTH0_* env vars to enable.');
  // Inject mock oidc so requiresAuth/requiresAuthJson middleware still pass
  app.use((req, _res, next) => {
    req.oidc = {
      isAuthenticated: () => true,
      user: { name: 'Moderator (Auth Disabled)', email: 'moderator@local', picture: null }
    };
    next();
  });
  // Stub OIDC routes so Kong's moderate-auth-route returns 302 instead of 404
  app.get('/login',    (_req, res) => res.redirect('/moderate-ui'));
  app.get('/logout',   (_req, res) => res.redirect('/moderate-ui'));
  app.get('/callback', (_req, res) => res.redirect('/moderate-ui'));
}

// Serve static files from /public
// Kong routes /moderate-ui with strip_path:true, so the service always receives /
// Do NOT mount at /moderate — that conflicts with the GET /moderate API endpoint
app.use(express.static(path.join(__dirname, 'public')));

// ─────────────────────────────────────────────────────────────────────────────
// GET /health — public, no auth required
// ─────────────────────────────────────────────────────────────────────────────
app.get('/health', (_req, res) => {
  res.json({
    status:    'ok',
    service:   'moderate-service',
    rabbitmq:  isReady() ? 'connected' : 'disconnected',
    timestamp: new Date().toISOString()
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// GET /types
// Returns the cached types array (updated via ECST events from ETL).
// Public: the types dropdown needs to load even before full OIDC flow completes.
// ─────────────────────────────────────────────────────────────────────────────
app.get('/types', async (_req, res) => {
  try {
    const raw   = await fs.readFile(CACHE_FILE, 'utf8');
    const types = JSON.parse(raw);
    res.json(types);
  } catch (_err) {
    // Cache not yet populated (service just started); return empty array
    res.json([]);
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// GET /moderate — PROTECTED (requires authentication)
//
// Returns the next joke from the "submit" RabbitMQ queue for human review.
// The AMQP message is held unacknowledged until the moderator approves or
// rejects it. Allows page-refresh resilience: returns the same joke if one
// is already pending review.
//
// Polling: frontend calls this every 1 second when no joke is pending.
//
// Responses:
//   200 { setup, punchline, type }    — joke ready for moderation
//   204 (empty body)                  — queue is empty, poll again
//   503 { error }                     — RabbitMQ unavailable
// ─────────────────────────────────────────────────────────────────────────────
app.get('/moderate', requiresAuthJson, async (req, res) => {
  if (!isReady()) {
    return res.status(503).json({
      error: 'Message broker unavailable — please try again shortly'
    });
  }

  try {
    const joke = await getNextJoke();

    if (!joke) {
      // No messages in queue — return 204 so frontend knows to keep polling
      return res.status(204).end();
    }

    res.json({
      setup:     joke.setup,
      punchline: joke.punchline,
      type:      joke.type,
      submittedAt: joke.submittedAt || null
    });
  } catch (err) {
    console.error('[Moderate] Error fetching joke:', err.message);
    res.status(500).json({ error: 'Failed to fetch joke from queue' });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// POST /moderated — PROTECTED (requires authentication)
//
// Moderator approves the current pending joke (possibly after editing).
// Sends the joke to the "moderated" queue for ETL processing.
//
// Body: { setup, punchline, type }
//
// ECST note: The moderator may edit the joke type. If the new type doesn't
// exist yet, ETL will create it and emit a type_update event back.
// ─────────────────────────────────────────────────────────────────────────────
app.post('/moderated', requiresAuthJson, async (req, res) => {
  const { setup, punchline, type } = req.body;

  if (!setup || !punchline || !type) {
    return res.status(400).json({
      error: 'Missing required fields: setup, punchline, type'
    });
  }

  const approvedJoke = {
    setup:       setup.trim(),
    punchline:   punchline.trim(),
    type:        type.trim().toLowerCase(),
    moderatedAt: new Date().toISOString(),
    moderatedBy: req.oidc?.user?.email || req.oidc?.user?.name || 'unknown'
  };

  try {
    await approveJoke(approvedJoke);
    console.log(
      `[Moderate] ✅ Joke approved by ${approvedJoke.moderatedBy}: "${approvedJoke.setup.substring(0, 50)}"`
    );
    res.status(202).json({
      message: 'Joke approved and queued for database insertion',
      joke:    approvedJoke
    });
  } catch (err) {
    console.error('[Moderate] Error approving joke:', err.message);
    res.status(503).json({ error: err.message });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// POST /reject — PROTECTED (requires authentication)
//
// Moderator rejects the current pending joke.
// The joke is nacked with requeue=false → permanently discarded.
// ─────────────────────────────────────────────────────────────────────────────
app.post('/reject', requiresAuthJson, async (req, res) => {
  try {
    await rejectJoke();
    console.log('[Moderate] ❌ Joke rejected and discarded');
    res.status(200).json({ message: 'Joke rejected and discarded' });
  } catch (err) {
    console.error('[Moderate] Error rejecting joke:', err.message);
    res.status(503).json({ error: err.message });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// GET /me — PROTECTED (requires authentication)
// Returns the authenticated user's profile (for the UI header).
// ─────────────────────────────────────────────────────────────────────────────
app.get('/me', requiresAuth(), (req, res) => {
  const user = req.oidc.user;
  res.json({
    name:    user.name  || user.nickname || user.email,
    email:   user.email || '',
    picture: user.picture || null
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Startup — initialise cache dir, connect RabbitMQ, start HTTP server
// ─────────────────────────────────────────────────────────────────────────────
async function start() {
  // Ensure the cache directory exists (Docker volume may not pre-create it)
  await fs.mkdir(CACHE_DIR, { recursive: true });

  // Start RabbitMQ connection (auto-reconnects in background)
  connect();

  app.listen(PORT, () => {
    console.log(`[Moderate Service] Listening on http://localhost:${PORT}`);
    console.log(`[Moderate Service] Auth0 base URL: ${process.env.AUTH0_BASE_URL || `http://localhost:${PORT}`}`);
  });
}

start().catch(err => {
  console.error('[Moderate Service] Fatal startup error:', err.message);
  process.exit(1);
});
