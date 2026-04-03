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
const helmet  = require('helmet');

const { connect, getNextJoke, approveJoke, rejectJoke, isReady } = require('./rabbitmq');
const {
  auth,
  buildAuthConfig,
  requiresAuthJson,
  requiresModeratorRoleJson,
  noAuthMiddleware,
  AUTH_ENABLED,
  getAuthMode
} = require('./auth');

const app  = express();
const PORT = process.env.PORT || 4300;

// Cache directory mounted as Docker named volume
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
    console.log(`[Moderate Service] ${req.method} ${req.originalUrl} → ${res.statusCode} (${ms}ms)`);
  });
  next();
});

// ─────────────────────────────────────────────────────────────────────────────
// CORS — allow browser requests from Kong's public origin
// ─────────────────────────────────────────────────────────────────────────────
app.use((req, res, next) => {
  const allowedOrigin = process.env.AUTH0_BASE_URL || process.env.PUBLIC_GATEWAY_BASE || '*';
  res.setHeader('Access-Control-Allow-Origin', allowedOrigin);
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
  const mode = getAuthMode();
  if (mode === 'dev') {
    console.info(
      '[Auth] Auth0 disabled via AUTH_ENABLED=false — running in dev/demo mode.\n' +
      '       Do NOT use this mode on a public server.'
    );
  } else {
    // 'unconfigured' mode: credentials are still placeholder strings.
    // This is the Azure state when .env.vm3 has not been filled in.
    console.warn(
      '[Auth] \u26a0\ufe0f  SECURITY WARNING: Auth0 credentials not configured.\n' +
      '       Moderation endpoints (GET /moderate, POST /moderated, POST /reject) are\n' +
      '       accessible to ANY network peer without a login.\n' +
      '       Set AUTH0_SECRET, AUTH0_CLIENT_ID, AUTH0_CLIENT_SECRET,\n' +
      '       AUTH0_ISSUER_BASE_URL and AUTH0_BASE_URL in infra/.env.vm3\n' +
      '       then redeploy to enforce Auth0 login (BUG-H6 fix).'
    );
  }

  // BUG-L5: Extra guard — warn loudly if the public base URL looks non-local
  // (i.e. this process is deployed publicly but auth is still off).
  const _baseUrl = (process.env.AUTH0_BASE_URL || process.env.PUBLIC_GATEWAY_BASE || '').toLowerCase();
  if (_baseUrl && !_baseUrl.includes('localhost') && !_baseUrl.includes('127.0.0.1')) {
    console.error(
      '\n\u2554\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2557\n' +
      '\u2551  \ud83d\udd34 CRITICAL: AUTH DISABLED ON A PUBLIC-FACING DEPLOYMENT           \u2551\n' +
      '\u2551  AUTH0_BASE_URL / PUBLIC_GATEWAY_BASE is a non-localhost URL.       \u2551\n' +
      '\u2551  URL: ' + _baseUrl + '\n' +
      '\u2551  The moderation API is reachable by any internet peer, NO login.   \u2551\n' +
      '\u2551  Remove AUTH_ENABLED=false and set real AUTH0_* credentials.       \u2551\n' +
      '\u255a\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u255d\n'
    );
  }

  // Inject a mock req.oidc so requiresAuthJson / requiresModeratorRoleJson still
  // compile a response — they check isAuthenticated() which returns true here.
  app.use(noAuthMiddleware);
  // Stub OIDC routes so Kong's moderate-auth-route returns 302 instead of 404
  app.get('/login',    (_req, res) => res.redirect('/moderate-ui'));
  app.get('/logout',   (_req, res) => res.redirect('/moderate-ui'));
  app.get('/callback', (_req, res) => res.redirect('/moderate-ui'));
}

// Attach X-Auth-Mode header to every response so operators can verify the mode
// without reading logs:  curl -sI https://<KONG_IP>/health | grep X-Auth-Mode
app.use((_req, res, next) => { res.setHeader('X-Auth-Mode', getAuthMode()); next(); });

// ─────────────────────────────────────────────────────────────────────────────
// GET /auth-status — PUBLIC
//
// Returns the current authentication mode. Consumed by:
//   - The moderation UI (shows warning banner when auth is not configured).
//   - Operators: curl https://<KONG_IP>/auth-status
//
// Responses:
//   { authEnabled: true,  mode: 'oidc' }
//   { authEnabled: false, mode: 'dev',          warning: '...' }
//   { authEnabled: false, mode: 'unconfigured',  warning: '...' }
// ─────────────────────────────────────────────────────────────────────────────
app.get('/auth-status', (_req, res) => {
  const mode    = getAuthMode();
  const payload = { authEnabled: AUTH_ENABLED, mode };
  if (mode !== 'oidc') {
    payload.warning = mode === 'dev'
      ? 'Authentication explicitly disabled (AUTH_ENABLED=false). Dev/demo mode — not for production.'
      : 'Auth0 credentials not configured. Moderation endpoints are accessible to any network peer. ' +
        'Set AUTH0_SECRET, AUTH0_CLIENT_ID, AUTH0_CLIENT_SECRET, AUTH0_ISSUER_BASE_URL ' +
        'and AUTH0_BASE_URL in infra/.env.vm3 then redeploy to enforce login (BUG-H6 fix).';
  }
  res.json(payload);
});

// Serve static files from /public
// Kong routes /moderate-ui with strip_path:true, so the service always receives /
// Do NOT mount at /moderate — that conflicts with the GET /moderate API endpoint
app.use(express.static(path.join(__dirname, 'public')));
// Also serve at /moderate-ui for direct access (e.g. bypassing Kong in dev)
app.use('/moderate-ui', express.static(path.join(__dirname, 'public')));

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
// GET /types  and  GET /moderate-types
// Returns the cached types array (updated via ECST events from ETL).
// Public: the types dropdown needs to load even before full OIDC flow completes.
// /moderate-types is exposed via a dedicated Kong route so the moderation UI
// fetches from this service's own ECST cache, independent of submit-service.
// ───────────────────────────────────────────────────────────────────────────────
async function serveTypesCache(_req, res) {
  try {
    const raw   = await fs.readFile(CACHE_FILE, 'utf8');
    const types = JSON.parse(raw);
    res.json(types);
  } catch (_err) {
    // Cache not yet populated (service just started); return empty array
    res.json([]);
  }
}
app.get('/types', serveTypesCache);
app.get('/moderate-types', serveTypesCache);

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
app.get('/moderate', requiresAuthJson, requiresModeratorRoleJson, async (req, res) => {
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
app.post('/moderated', requiresAuthJson, requiresModeratorRoleJson, async (req, res) => {
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
app.post('/reject', requiresAuthJson, requiresModeratorRoleJson, async (req, res) => {
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
app.get('/me', requiresAuthJson, (req, res) => {
  const user = req.oidc.user;
  res.json({
    name:        user.name    || user.nickname || user.email,
    email:       user.email   || '',
    picture:     user.picture || null,
    authEnabled: AUTH_ENABLED  // consumed by the UI to show the auth-warning banner
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Startup — initialise cache dir, connect RabbitMQ, start HTTP server
// ─────────────────────────────────────────────────────────────────────────────
let server;
async function start() {
  // Ensure the cache directory exists (Docker volume may not pre-create it)
  await fs.mkdir(CACHE_DIR, { recursive: true });

  // Start RabbitMQ connection (auto-reconnects in background)
  connect();

  server = app.listen(PORT, () => {
    console.log(`[Moderate Service] Listening on http://localhost:${PORT}`);
    console.log(`[Moderate Service] Auth0 base URL: ${process.env.AUTH0_BASE_URL || `http://localhost:${PORT}`}`);
  });
}

// ─────────────────────────────────────────────────────────────
// Graceful Shutdown — close HTTP server on SIGTERM/SIGINT
// Docker sends SIGTERM on `docker stop`. This ensures in-flight
// requests complete before the container exits.
// ─────────────────────────────────────────────────────────────
function shutdown(signal) {
  console.log(`[Moderate Service] ${signal} received — shutting down gracefully…`);
  if (server) {
    server.close(() => {
      console.log('[Moderate Service] HTTP server closed');
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
  console.error('[Moderate Service] Fatal startup error:', err.message);
  process.exit(1);
});
