# Architecture

## System Topology

### Local (Docker Compose)

All services run as Docker containers on `joke-net`. Kong is the only exposed entry point.

```
Browser / curl
     │  HTTP :8000
     ▼
+---------------------------+
| Kong  (DB-less, :8000→80) |  ← infra/kong/kong.local.yml
+---------------------------+
     │           │           │
     ▼           ▼           ▼
joke-svc    submit-svc   moderate-svc       etl-svc (internal only)
:3000→4000  :3200→4200   :3300→4300         :3001→4001
     │                        │
     └──────── MySQL ──────────┘
               :3306
            RabbitMQ
          :5672 / :15672
```

### Azure Production (4 VMs)

```
Internet
     │  HTTPS :443 / HTTP :80
     ▼
+────────────────────────────────+
│  Kong  (VM4 — public IP)       │  ← infra/kong/kong.yml
│  TLS termination, rate-limit   │
+────────────────────────────────+
     │  Azure VNet 10.0.1.x/24 — private, no direct public routing
     ├──────────────────────────────────────────────────────┐
     ▼                           ▼                          ▼
VM1 — 10.0.1.4             VM2 — 10.0.1.5           VM3 — 10.0.1.7
joke-service  :3000         submit-service :3200      moderate-service :3300
etl-service   :3001         RabbitMQ  :5672/:15672    (Auth0 OIDC)
MySQL         :3306
```

Kong is the **single public entry point**. VM1–VM3 have no public HTTP ports open in the NSG.

---

## Message / Event Flow

```
User
 │  POST /submit
 ▼
submit-service
 │  publish
 ▼
[submit queue]
 │  consume  (prefetch 1)
 ▼
moderate-service ──── human review (Auth0 OIDC UI) ────
 │  approve → publish to [moderated queue]
 │  reject  → nack (requeue=false), message discarded
 ▼
[moderated queue]
 │  consume  (prefetch 1)
 ▼
etl-service
 │  INSERT IGNORE into MySQL  (idempotent)
 │  if new type created → publish to [type_update fanout exchange]
 ▼
[sub_type_update]              [mod_type_update]
 │  consume                     │  consume
 ▼                              ▼
submit-service              moderate-service
 (refresh ECST type cache)   (refresh ECST type cache)
```

### Queues and Exchanges

| Name | Type | Producer | Consumer | Purpose |
|---|---|---|---|---|
| `submit` | Queue | submit-service | moderate-service | Pending jokes awaiting human review |
| `moderated` | Queue | moderate-service | etl-service | Approved jokes ready to persist |
| `type_update` | Fanout exchange | etl-service | — | ECST broadcast after a new type is created |
| `sub_type_update` | Queue (bound) | (via exchange) | submit-service | Refresh submit-service type cache |
| `mod_type_update` | Queue (bound) | (via exchange) | moderate-service | Refresh moderate-service type cache |

---

## Project Structure

```
.
├── docker-compose.yml            # Local dev — all 8 services + health checks
├── .env.example                  # Safe environment template
├── test-flows.js                 # 59 end-to-end tests
├── db/
│   └── init.sql                  # MySQL schema + seed data (runs on fresh volume)
├── joke-service/
│   ├── server.js                 # GET /joke/:type, GET /types, serves UI
│   ├── db.js                     # MySQL / MongoDB adapter (DB_TYPE env var)
│   └── public/                   # Browse-jokes frontend (HTML + JS)
├── submit-service/
│   ├── server.js                 # POST /submit, Swagger docs, GET /types (ECST)
│   ├── rabbitmq.js               # Publisher + sub_type_update ECST subscriber
│   └── public/                   # Submit-a-joke frontend
├── moderate-service/
│   ├── server.js                 # GET /moderate, POST /moderated, POST /reject
│   ├── rabbitmq.js               # 3 channels: consumer, producer, ECST subscriber
│   ├── auth.js                   # Auth0 OIDC config + requiresAuth* middleware
│   └── public/                   # Moderation UI
├── etl-service/
│   ├── server.js                 # Approved-joke persister + ECST type publisher
│   └── db.js                     # MySQL / MongoDB adapter
└── infra/
    ├── kong/
    │   ├── kong.local.yml        # Local Docker Compose Kong config
    │   ├── kong.yml              # Production Azure Kong config (private IPs)
    │   ├── docker-compose.yml    # Standalone Kong container with TLS (VM4)
    │   └── certs/                # Self-signed TLS certificate + key
    ├── vm1-compose.yml           # VM1: MySQL + joke-service + etl-service
    ├── vm2-compose.yml           # VM2: RabbitMQ + submit-service
    ├── vm3-compose.yml           # VM3: moderate-service
    ├── vm1-setup.sh              # One-time Docker bootstrap for VM1
    ├── vm2-setup.sh              # One-time Docker bootstrap for VM2
    ├── vm3-setup.sh              # One-time Docker bootstrap for VM3
    ├── deploy.sh                 # Full scp + docker compose deploy (VM1 + VM2)
    ├── scripts/
    │   ├── smoke-test.sh         # Post-deploy smoke test (18 checks)
    │   ├── redeploy-kong.sh      # Zero-downtime Kong config reload
    │   ├── fix-auth0-vm3.sh      # Patch Auth0 env vars on a running VM3
    │   ├── fix-db-cleanup.sh     # Remove test artifacts from the database
    │   └── fix-db-index.sh       # Idempotent DB index migration
    └── terraform/
        ├── main.tf               # 4 Azure VMs, VNet, NSG, Kong TLS provisioner
        ├── variables.tf          # Inputs: subscription, SSH key, Auth0
        ├── outputs.tf            # VM public IPs, SSH connection commands
        └── terraform.tfvars.example
```

CI/CD pipelines (`.github/workflows/`):

| Workflow | Trigger | Action |
|---|---|---|
| `validate.yml` | Every push to main | Lint JS, validate `docker compose config` |
| `deploy-joke.yml` | Manual (`workflow_dispatch`) | Build image → push to Docker Hub → deploy VM1 → health check |
| `deploy-submit.yml` | Manual (`workflow_dispatch`) | Build image → push to Docker Hub → deploy VM2 → health check |
| `deploy-moderate.yml` | Manual (`workflow_dispatch`) | Build image → push to Docker Hub → deploy VM3 → health check |
| `deploy-etl.yml` | Manual (`workflow_dispatch`) | Build image → push to Docker Hub → deploy VM1 → health check |
| `deploy-kong.yml` | Manual (`workflow_dispatch`) | SCP config to VM4 → reload Kong → health check |

---

## Key Design Decisions

### Moderation before persistence
Submitted jokes are never written to the database directly. They sit in the `submit` queue until a human moderator approves them. Only then does `etl-service` write to MySQL. Rejected jokes are discarded (`nack`, `requeue=false`).

### ECST (Event-Carried State Transfer)
`submit-service` and `moderate-service` each maintain an in-memory cache of the current joke-type list. This cache is refreshed whenever `etl-service` creates a new type and broadcasts to the `type_update` fanout exchange. This removes a synchronous HTTP dependency on `joke-service` at runtime.

### At-least-once delivery + idempotency
- `etl-service` acks `moderated` messages **only** after a confirmed DB write.
- `moderate-service` acks `submit` messages **only** after forwarding to `moderated` queue.
- MySQL uses `INSERT IGNORE` for idempotent type and joke inserts.
- MongoDB uses `findOneAndUpdate` with `upsert: true`.

### Auth fallback modes
`moderate-service` has three startup modes:
- **`oidc`** — Auth0 credentials present and valid. Full OIDC login enforced.
- **`dev`** — `AUTH_ENABLED=false` or credentials missing. Mock user injected; no login required. Intended for local workflow testing.
- **`unconfigured`** — Credentials partially set. Service starts with a prominent warning.

A startup guard in `server.js` also emits a `CRITICAL` warning if `AUTH_ENABLED=false` is detected on a non-localhost base URL, preventing accidental public deployment without auth.

### Kong as single origin
All services are on a private network. Only Kong has a public IP. Kong enforces:
- Rate-limiting on `/joke/:type` (5 req/min per IP)
- Correlation IDs (`Kong-Request-ID` header on every response)
- TLS termination (self-signed cert in `infra/kong/certs/`)
- IP restriction on `/mq-admin/*` (localhost / Docker bridge CIDR only)

### MySQL / MongoDB switching
Both `joke-service` and `etl-service` support `DB_TYPE=mysql` (default) or `DB_TYPE=mongo`. The adapter module branches at startup; the rest of the service is DB-agnostic. The automated test suite runs against MySQL only.

### prefetch(1)
Both consumers (`moderate-service` on `submit`, `etl-service` on `moderated`) set `channel.prefetch(1)` to prevent a single consumer from receiving more messages than it can process, giving fair distribution if multiple instances run.
