# API Overview

All routes are accessed through **Kong** at `http://localhost:8000` (local) or `https://<KONG_PUBLIC_IP>` (Azure). Kong adds a `Kong-Request-ID` correlation header to every response.

---

## Joke Service

### `GET /joke/:type`

Returns a random joke of the given type. Use `any` to draw from all categories.

```bash
curl http://localhost:8000/joke/programming
curl http://localhost:8000/joke/any
```

**200 OK:**
```json
{
  "id": 3,
  "setup": "Why do programmers prefer dark mode?",
  "punchline": "Because light attracts bugs.",
  "type": "programming"
}
```

> **Rate limit:** 5 requests per minute per IP via Kong.
> Returns `429 Too Many Requests` with `Retry-After` and `X-RateLimit-*` headers after the limit.

### `GET /joke/:type?count=N`

Returns up to N jokes as a JSON array.

```bash
curl "http://localhost:8000/joke/any?count=3"
```

### `GET /types`

Returns all joke categories from the database.

```bash
curl http://localhost:8000/types
```

**200 OK:**
```json
[
  {"id":1,"name":"dad"},
  {"id":2,"name":"general"},
  {"id":3,"name":"knock-knock"},
  {"id":4,"name":"programming"},
  {"id":5,"name":"science"}
]
```

---

## Submit Service

### `POST /submit`

Queues a new joke for human moderation. The joke is published to the `submit` RabbitMQ queue and not persisted until a moderator approves it.

```bash
curl -X POST http://localhost:8000/submit \
  -H "Content-Type: application/json" \
  -d '{"setup":"Why did the DevOps engineer quit?","punchline":"Too many deployments.","type":"programming"}'
```

**202 Accepted:**
```json
{
  "message": "Joke queued for moderation",
  "queued": {
    "setup": "Why did the DevOps engineer quit?",
    "punchline": "Too many deployments.",
    "type": "programming"
  }
}
```

**400 Bad Request** — missing `setup`, `punchline`, or `type`.

### `GET /types` (submit-service)

Returns the submit-service's locally cached type list (ECST cache). Same shape as the joke-service `/types` endpoint.

### `GET /docs`

Swagger / OpenAPI interactive documentation. Lists all submit-service routes with request/response schemas and a "Try it out" interface.

---

## Moderate Service

All moderation routes require an active Auth0 OIDC session when `AUTH_ENABLED=true`. With the default local `AUTH_ENABLED=false`, a mock moderator is injected automatically — no login required.

### `GET /moderate`

Peeks at the next pending joke from the `submit` queue (does not consume / ack yet).

```bash
curl http://localhost:8000/moderate
```

**200 OK** (joke pending):
```json
{
  "setup": "...",
  "punchline": "...",
  "type": "programming"
}
```

**204 No Content** — queue is empty.

### `POST /moderated`

Approves the pending joke. Publishes it to the `moderated` queue for ETL persistence and acks the original `submit` message.

```bash
curl -X POST http://localhost:8000/moderated \
  -H "Content-Type: application/json" \
  -d '{"setup":"...","punchline":"...","type":"programming"}'
```

**200 OK:**
```json
{ "message": "Joke approved and queued for persistence" }
```

### `POST /reject`

Rejects the pending joke. Nacks the `submit` message with `requeue: false` — the message is discarded permanently.

```bash
curl -X POST http://localhost:8000/reject \
  -H "Content-Type: application/json" \
  -d '{"setup":"...","punchline":"...","type":"programming"}'
```

**200 OK:**
```json
{ "message": "Joke rejected" }
```

### `GET /me`

Returns the currently authenticated moderator's profile (Auth0 user object in OIDC mode, or mock user in dev mode).

```bash
curl http://localhost:8000/me
```

### `GET /auth-status`

Returns the current authentication configuration.

```bash
curl http://localhost:8000/auth-status
```

**200 OK:**
```json
{ "mode": "dev", "user": null, "authEnabled": false }
```

Possible `mode` values: `"oidc"` | `"dev"` | `"unconfigured"`

### `GET /types` (moderate-service)

Returns the moderate-service's locally cached type list (ECST cache).

---

## ETL Service

ETL has no public write endpoints — it consumes the `moderated` queue internally and writes approved jokes to the database.

### `GET /health`

```bash
curl http://localhost:3001/health   # direct (not via Kong)
```

**200 OK:**
```json
{ "status": "ok", "db": "connected", "rabbitmq": "connected" }
```

---

## All Services — Health Check

Every service exposes `GET /health` returning HTTP 200 with `{ "status": "ok" }`.

| URL | Service |
|---|---|
| http://localhost:8000/joke-health | joke-service (via Kong) |
| http://localhost:3000/health | joke-service (direct) |
| http://localhost:3200/health | submit-service (direct) |
| http://localhost:3300/health | moderate-service (direct) |
| http://localhost:3001/health | etl-service (direct) |

---

## Rate Limiting

Enforced by Kong on the `/joke/:type` route only.

| Route | Limit |
|---|---|
| `GET /joke/:type` | 5 requests / minute / IP |
| All other routes | No Kong-level rate limit |

**429 Too Many Requests** response includes:
- `Retry-After: <seconds>`
- `X-RateLimit-Limit-Minute: 5`
- `X-RateLimit-Remaining-Minute: 0`

---

## Authentication Requirements

| Route | Auth required |
|---|---|
| `GET /joke/*`, `GET /types`, `POST /submit` | None |
| `GET /docs` | None |
| `GET /moderate`, `POST /moderated`, `POST /reject`, `GET /me` | Auth0 OIDC session (when `AUTH_ENABLED=true`) |
| `GET /mq-admin/*` | Localhost / Docker bridge CIDR only (Kong ip-restriction) |

When auth is required and the session is missing, API routes return:

```json
{ "error": "Authentication required", "status": 401 }
```

Browser routes redirect to the Auth0 login page.

---

## Kong-Injected Headers

Every response from Kong includes:

| Header | Description |
|---|---|
| `Kong-Request-ID` | Unique correlation ID for the request |
| `X-RateLimit-Limit-Minute` | Rate limit cap (joke routes only) |
| `X-RateLimit-Remaining-Minute` | Remaining requests this minute |
| `X-Auth-Mode` | Auth mode reported by moderate-service (`oidc` / `dev` / `unconfigured`) |
