# ─── Build Stage ──────────────────────────────────────────
# node:18-alpine is minimal (~50 MB vs ~350 MB for full node).
# Alpine Linux is ideal for production microservice containers.
FROM node:18-alpine

WORKDIR /app

# Copy dependency manifests first.
# Docker caches this layer separately — npm install only
# re-runs when package.json changes, not on source changes.
COPY package*.json ./

RUN npm install --production

# Copy application source after dependencies are installed
COPY . .

EXPOSE 4000

# Health check — Docker/Compose uses this to verify the container is healthy.
# wget is available on Alpine; curl is not.
HEALTHCHECK --interval=15s --timeout=5s --start-period=20s --retries=3 \
  CMD wget --no-verbose --tries=1 --spider http://localhost:4000/health || exit 1

CMD ["node", "server.js"]
