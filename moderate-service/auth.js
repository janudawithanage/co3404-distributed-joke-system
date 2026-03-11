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
 *   AUTH0_BASE_URL        – public URL of this service
 *                           Local:  http://localhost:4300
 *                           Kong:   https://<KONG_IP>/moderate
 *   AUTH0_CLIENT_ID       – Auth0 Application Client ID
 *   AUTH0_CLIENT_SECRET   – Auth0 Application Client Secret
 *   AUTH0_ISSUER_BASE_URL – Auth0 Domain URL
 *                           e.g.  https://YOUR_TENANT.auth0.com
 *
 * Auth0 Dashboard Setup:
 *   1. Create a "Regular Web Application" in Auth0
 *   2. Add Allowed Callback URLs:
 *        http://localhost:4300/callback
 *        https://<KONG_IP>/moderate/callback
 *   3. Add Allowed Logout URLs:
 *        http://localhost:4300
 *        https://<KONG_IP>/moderate
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

const { auth, requiresAuth } = require('express-openid-connect');

/**
 * Build the OIDC middleware configuration from environment variables.
 * Falls back to safe defaults that will produce clear error messages.
 */
function buildAuthConfig(port) {
  return {
    // session secret — must be at least 32 characters in production
    secret: process.env.AUTH0_SECRET || 'CHANGE_ME_GENERATE_WITH_CRYPTO_RANDOMBYTES_32',

    // Public URL of this service — Auth0 redirects back here after login
    // When behind Kong: https://<KONG_IP>/moderate
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
      postLogoutRedirect: '/'
    }
  };
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

module.exports = { auth, buildAuthConfig, requiresAuth, requiresAuthJson };
