# Local Development Guide

## Prerequisites

- [Docker Desktop](https://www.docker.com/products/docker-desktop/) 4.x or later
- Node.js 18+ — only needed to run `test-flows.js`

No local databases or message brokers are required. Everything runs in Docker.

---

## Step 1 — Clone and configure

```bash
git clone <repo-url>
cd co3404-distributed-joke-system
cp .env.example .env
```

For basic local development you don't need to change anything in `.env`. Auth0 is optional — see [Auth0 Setup](#auth0-setup) below.

> **Security note:** `.env.example` ships with `AUTH_ENABLED=false`. This is intentional for local demo use. Never deploy with this setting to a public URL.

---

## Step 2 — Start all services

```bash
# Default: MySQL + all services
docker compose up -d
```

First startup takes ~30 s for MySQL and RabbitMQ health checks to pass.

```bash
# Verify all containers are healthy
docker compose ps

# Quick API check
curl http://localhost:8000/types
curl http://localhost:8000/joke/programming
```

### MongoDB mode (optional)

```bash
DB_TYPE=mongo docker compose --profile mongo up -d
```

Starts MongoDB instead of MySQL. `joke-service` and `etl-service` automatically switch to the Mongo adapter when `DB_TYPE=mongo`.

---

## Step 3 — Open the app

### Via Kong Gateway `:8000` (recommended)

| URL | Description |
|---|---|
| http://localhost:8000/joke-ui | Joke browser |
| http://localhost:8000/submit | Submit a joke |
| http://localhost:8000/moderate-ui | Moderation UI (no login required locally) |
| http://localhost:8000/docs | Swagger / OpenAPI docs |
| http://localhost:8000/mq-admin/ | RabbitMQ management (localhost-only via Kong) |

### Direct service ports (dev / debug only — bypass Kong)

| URL | Service | Port mapping |
|---|---|---|
| http://localhost:3000 | joke-service | host 3000 → container 4000 |
| http://localhost:3200 | submit-service | host 3200 → container 4200 |
| http://localhost:3300 | moderate-service | host 3300 → container 4300 |
| http://localhost:3001/health | etl-service | host 3001 → container 4001 |
| http://localhost:15672 | RabbitMQ management | `guest` / `guest` |
| localhost:3306 | MySQL | `jokeuser` / `jokepassword` |

---

## Auth0 Setup

Auth0 is **optional** for local development. Without it `moderate-service` runs in **dev mode** — a mock moderator is injected automatically and the full submit → queue → approve → persist pipeline works without any login.

To enable real Auth0 OIDC login:

1. Create a free [Auth0](https://auth0.com) account
2. Create a **Regular Web Application**
3. Set **Allowed Callback URLs:** `http://localhost:8000/callback`
4. Set **Allowed Logout URLs:** `http://localhost:8000/moderate-ui`
5. Add to `.env`:

```env
AUTH_ENABLED=true
AUTH0_CLIENT_ID=your-client-id
AUTH0_CLIENT_SECRET=your-client-secret
AUTH0_ISSUER_BASE_URL=https://your-domain.auth0.com
AUTH0_BASE_URL=http://localhost:8000
AUTH0_SECRET=any-random-string-at-least-32-characters
```

---

## Environment Variables

| Variable | Default | Description |
|---|---|---|
| `DB_TYPE` | `mysql` | Database adapter: `mysql` or `mongo` |
| `DB_HOST` | `mysql` | MySQL hostname |
| `DB_USER` | `jokeuser` | MySQL username |
| `DB_PASSWORD` | `jokepassword` | MySQL password |
| `DB_NAME` | `jokesdb` | MySQL database name |
| `DB_ROOT_PASSWORD` | `rootpassword` | MySQL root password (init only) |
| `MONGO_URI` | — | MongoDB connection URI (required when `DB_TYPE=mongo`) |
| `RABBITMQ_HOST` | `rabbitmq` | RabbitMQ hostname |
| `RABBITMQ_USER` | `guest` | RabbitMQ username |
| `RABBITMQ_PASSWORD` | `guest` | RabbitMQ password |
| `PUBLIC_GATEWAY_BASE` | `http://localhost:8000` | Public Kong URL used in Swagger and UI status bar |
| `AUTH_ENABLED` | `false` | Set `true` to require Auth0 OIDC login |
| `AUTH0_SECRET` | — | Session encryption secret (32+ chars) |
| `AUTH0_BASE_URL` | `http://localhost:8000` | Public callback base URL |
| `AUTH0_CLIENT_ID` | — | Auth0 application client ID |
| `AUTH0_CLIENT_SECRET` | — | Auth0 application client secret |
| `AUTH0_ISSUER_BASE_URL` | — | `https://your-domain.auth0.com` |

All defaults work for local Docker Compose. Auth0 variables are the only ones that require real values for OIDC login.

---

## Database Schema

```sql
CREATE TABLE types (
  id   INT AUTO_INCREMENT PRIMARY KEY,
  name VARCHAR(100) UNIQUE NOT NULL
) DEFAULT CHARSET=utf8mb4;

-- Only approved (moderated) jokes ever reach this table
CREATE TABLE jokes (
  id        INT AUTO_INCREMENT PRIMARY KEY,
  setup     TEXT NOT NULL,
  punchline TEXT NOT NULL,
  type_id   INT  NOT NULL,
  FOREIGN KEY (type_id) REFERENCES types(id) ON DELETE RESTRICT
) DEFAULT CHARSET=utf8mb4;
```

Seed categories: `general`, `programming`, `knock-knock`, `dad`, `science`

`db/init.sql` runs automatically on the first `docker compose up` (MySQL volume init). It is idempotent — safe to re-run.

With MongoDB (`DB_TYPE=mongo`), the same data is represented as Mongoose `Type` and `Joke` models.

---

## Running the Test Suite

```bash
node test-flows.js
```

- 59 end-to-end tests against the local Docker stack
- Covers: health checks, joke fetch, rate-limiting, submit → queue, moderate → approve/reject, ETL → DB write, ECST cache sync, auth modes, and UI HTML serving
- Automatically drains queues and removes test data before and after the run

Expected result: **58 pass · 0 fail · 1 benign warning**

> The warning (FLOW 9) reports that auth mode is `dev` — this is the correct value for a local stack with `AUTH_ENABLED=false`.

### Manual cleanup (if tests are interrupted mid-run)

```bash
docker exec jokes_mysql mysql -ujokeuser -pjokepassword jokesdb \
  -e "DELETE j FROM jokes j JOIN types t ON j.type_id=t.id \
      WHERE t.name REGEXP '^(ecst|etl)[0-9]+\$' OR t.name='testing'; \
      DELETE FROM types \
      WHERE name REGEXP '^(ecst|etl)[0-9]+\$' OR name='testing';"
```

---

## Stopping and Resetting

```bash
# Stop containers, keep data volumes (fast restart)
docker compose down

# Stop and delete all volumes — full clean reset
docker compose down -v
```
