/**
 * moderate-service/auth.js
 *
 * OpenID Connect Authentication Middleware (Auth0)
 * ─────────────────────────────────────────────────
 * Uses the official Auth0 express-openid-connect library.
 *
 * Environment Variables Required:
 *   AUTH0_SECRET          – long random string for session cookie encryption
 *                           Generate: node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
 *   AUTH0_BASE_URL        – public URL of this service (Kong's public URL, NO path suffix)
 *                           Local:  http://localhost:8000   (Kong proxy port)
 *                           Kong:   https://<KONG_IP>       (no /moderate suffix!)
 *                           ⚠ Do NOT add a path suffix — OIDC builds the callback as
 *                             baseURL + '/callback', so Kong needs a route for '/callback'.
 *   AUTH0_CLIENT_ID       – Auth0 Application Client ID
 *   AUTH0_CLIENT_SECRET   – Auth0 Application Client Secret
 *   AUTH0_ISSUER_BASE_URL – Auth0 Domain URL
 *                           e.g.  https://YOUR_TENANT.auth0.com
 *
 * Auth0 Dashboard Setup:
 *   1. Create a "Regular Web Application" in Auth0
 *   2. Add Allowed Callback URLs:
 *        http://localhost:8000/callback
 *        https://<KONG_IP>/callback
 *   3. Add Allowed Logout URLs:
 *        http://localhost:8000/moderate-ui
 *        https://<KONG_IP>/moderate-ui
 *   4. Copy the Client ID, Client Secret, and Domain to your .env
 *
 * Flow:
 *   Unauthenticated request → Auth0 login page → callback → session cookie set
 *   requiresAuth() middleware blocks unauthenticated access and redirects
 *
 * Token Validation:
 *   express-openid-connect validates the ID token (RS256) from Auth0's
 *   JWKS endpoint automatically. The user profile is attached to req.oidc.user.
 */

'use strict';

const { auth, requiresAuth: oidcRequiresAuth } = require('express-openid-connect');

/**
 * Whether Auth0 is configured.
 *
 * Rules (in order):
 *   1. If AUTH_ENABLED=false is set explicitly, always disable OIDC.
 *   2. All three credentials must be present AND must not be the
 *      placeholder strings written into .env.example / local .env.
 *      This prevents the dev .env placeholders from accidentally
 *      enabling OIDC (which would error or block all requests).
 */
function _isRealCredential(v) {
  return !!v && !v.startsWith('REPLACE_') && !v.includes('YOUR_TENANT') && v !== 'CHANGE_ME';
}

// True when all three Auth0 credentials are present and non-placeholder.
const AUTH_CREDENTIALS_PRESENT = (
  _isRealCredential(process.env.AUTH0_CLIENT_ID) &&
  _isRealCredential(process.env.AUTH0_ISSUER_BASE_URL) &&
  _isRealCredential(process.env.AUTH0_SECRET)
);

// True when AUTH_ENABLED=false is explicitly set — the correct opt-out for local dev.
// Never set this in production; use real credentials instead.
const AUTH_EXPLICITLY_DISABLED = process.env.AUTH_ENABLED === 'false';

/**
 * AUTH_ENABLED — the runtime auth gate.
 *
 * Three operating modes (check getAuthMode() for granular status):
 *   'oidc'         → real credentials present  → Auth0 login required
 *   'dev'          → AUTH_ENABLED=false set     → passthrough, local dev only
 *   'unconfigured' → placeholder credentials, no explicit disable
 *                    → passthrough WITH a loud startup warning
 *                    → do NOT leave like this in production
 */
const AUTH_ENABLED = !AUTH_EXPLICITLY_DISABLED && AUTH_CREDENTIALS_PRESENT;

/**
 * Returns the current auth operating mode as a string.
 *   'oidc'         — credentials present → Auth0 login enforced
 *   'dev'          — explicitly disabled (AUTH_ENABLED=false) → passthrough
 *   'unconfigured' — placeholder credentials → passthrough with warning
 */
function getAuthMode() {
  if (AUTH_ENABLED)             return 'oidc';
  if (AUTH_EXPLICITLY_DISABLED) return 'dev';
  return 'unconfigured';
}

/**
 * Build the OIDC middleware configuration from environment variables.
 * Falls back to safe defaults that will produce clear error messages.
 */
function buildAuthConfig(port) {
  return {
    // session secret — must be at least 32 characters in production
    secret: process.env.AUTH0_SECRET || 'CHANGE_ME_GENERATE_WITH_CRYPTO_RANDOMBYTES_32',

    // Public URL of this service — Auth0 redirects back here after login
    // When behind Kong: https://<KONG_IP>
    // Local development: http://localhost:<PORT>
    baseURL: process.env.AUTH0_BASE_URL || `http://localhost:${port}`,

    // Auth0 Application credentials
    clientID:       process.env.AUTH0_CLIENT_ID       || '',
    issuerBaseURL:  process.env.AUTH0_ISSUER_BASE_URL || '',
    clientSecret:   process.env.AUTH0_CLIENT_SECRET   || '',

    // authRequired: false — allows public health/types endpoints to be unprotected.
    // Individual routes use requiresAuth() to protect sensitive endpoints.
    authRequired: false,

    // Use Auth0's RP-Initiated Logout endpoint for the /logout route
    auth0Logout: true,

    // Request an authorization code (PKCE flow) with profile/email scopes
    authorizationParams: {
      response_type: 'code',
      scope:         'openid profile email'
    },

    // Route overrides — keep defaults but make them explicit for documentation
    routes: {
      callback:          '/callback',
      postLogoutRedirect: '/moderate-ui'  // redirect here after Auth0 logout
    }
  };
}

/**
 * Passthrough used when Auth0 is not configured.
 * Injects a mock req.oidc so requiresAuth/requiresAuthJson still work.
 */
function noAuthMiddleware(req, _res, next) {
  req.oidc = {
    isAuthenticated: () => true,
    user: {
      name:         'Moderator (Auth Disabled)',
      email:        'moderator@local',
      picture:      null,
      _authEnabled: false  // consumed by GET /me → sent to UI as authEnabled:false
    }
  };
  next();
}

/**
 * Returns a requiresAuth middleware.
 * When AUTH_ENABLED: uses express-openid-connect's requiresAuth().
 * When not:         returns the passthrough noAuthMiddleware.
 */
function requiresAuth() {
  return AUTH_ENABLED ? oidcRequiresAuth() : noAuthMiddleware;
}

/**
 * Middleware that blocks unauthenticated API requests with JSON 401
 * instead of redirecting to login (used for API endpoints).
 */
function requiresAuthJson(req, res, next) {
  if (!req.oidc || !req.oidc.isAuthenticated()) {
    return res.status(401).json({
      error:   'Authentication required',
      hint:    'Access the moderation UI via your browser to log in first',
      loginUrl: '/login'
    });
  }
  next();
}

/**
 * Optional moderator-role enforcement.
 *
 * Configure with:
 *   MODERATOR_ROLE=moderator
 *   AUTH0_ROLES_CLAIM=https://your-namespace.example.com/roles   (optional)
 *
 * If MODERATOR_ROLE is unset, role checks are skipped.
 */
function requiresModeratorRoleJson(req, res, next) {
  if (!AUTH_ENABLED) return next();

  const requiredRole = (process.env.MODERATOR_ROLE || '').trim();
  if (!requiredRole) return next();

  const user = req.oidc?.user || {};
  const rolesClaimKey = (process.env.AUTH0_ROLES_CLAIM || '').trim();
  const roleBag = rolesClaimKey ? user[rolesClaimKey] : (user.roles || []);
  const roles = Array.isArray(roleBag)
    ? roleBag
    : (typeof roleBag === 'string' && roleBag ? [roleBag] : []);

  if (!roles.includes(requiredRole)) {
    return res.status(403).json({
      error: 'Forbidden',
      hint: `Moderator role "${requiredRole}" is required`
    });
  }

  next();
}

module.exports = {
  auth,
  buildAuthConfig,
  requiresAuth,
  requiresAuthJson,
  requiresModeratorRoleJson,
  noAuthMiddleware,
  AUTH_ENABLED,
  getAuthMode
};
