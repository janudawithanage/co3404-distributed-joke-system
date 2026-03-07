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

CMD ["node", "server.js"]
