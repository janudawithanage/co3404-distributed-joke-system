# CO3404 Distributed Joke System

Distributed microservices project for the **CO3404 Distributed Systems** module at Ulster University.

The platform supports:
- browsing jokes,
- submitting jokes,
- human moderation,
- asynchronous persistence through RabbitMQ.

> Last updated: **28 March 2026**

---

## Table of Contents

- [Architecture](#architecture)
- [Hosted Links (Azure)](#hosted-links-azure)
- [Local Development Links](#local-development-links)
- [Quick Start (Local)](#quick-start-local)
- [How to Run on Azure](#how-to-run-on-azure)
- [API Reference](#api-reference)
- [Project Structure](#project-structure)
- [Database Schema](#database-schema)
- [Environment Variables](#environment-variables)
- [Secrets / API Keys](#secrets--api-keys)
- [Queues & Exchanges](#queues--exchanges)
- [Key Design Decisions](#key-design-decisions)

---

## Architecture

```
Browser / curl
  |
  v  HTTPS (443) / HTTP (80)
+-----------------------------------+
| Kong API Gateway (VM4)            |
| TLS termination, routing, plugins |
+----------------+------------------+
         | private Azure VNet (10.0.1.x)
   +-------------+--------------+----------------+
   v                            v                v
VM1 (10.0.1.4)            VM2 (10.0.1.5)   VM3 (10.0.1.7)
+------------------+      +---------------+ +----------------+
| Joke Service     |      | Submit Service| | Moderate Service|
| ETL Service      |      | RabbitMQ      | | (Auth0 OIDC)    |
| MySQL            |      +---------------+ +----------------+
+------------------+
```

### Message / Event Flow

```
Browser --> POST /submit --> submit-service --> "submit" queue --> moderate-service
                                                                        |
                                                     Approve/Reject (Auth0 OIDC UI)
                                                                        |
                                               "moderated" queue --> etl-service --> DB
                                                                        |
                                                      type_update fanout exchange
                                                      /                     \
                                           sub_type_update         mod_type_update
                                        (submit ECST cache)    (moderate ECST cache)
```

| Service | VM | Role |
|---|---|---|
| **Joke Service** | VM1 :3001 | Serves jokes from MySQL/MongoDB; provides a browsing frontend |
| **ETL Service** | VM1 (internal) | Consumes `moderated` queue; writes to DB; publishes ECST type_update |
| **MySQL** | VM1 :3306 | Relational store for joke types and jokes |
| **Submit Service** | VM2 :3002 | Accepts new jokes; publishes to `submit` queue; Swagger docs |
| **RabbitMQ** | VM2 :5672 | Message broker: `submit`, `moderated`, `type_update` fanout exchange |
| **Moderate Service** | VM3 :3300 | Auth0 OIDC-protected UI; reviewer approves/rejects queued jokes |
| **Kong** | VM4 :443/80 | DB-less API gateway: TLS, rate-limiting, correlation IDs |

### Service Overview (local ports)

| Service | Host port(s) | Key endpoints | Notes |
|---|---|---|---|
| Joke Service | 3000 -> 4000 | `/joke/:type`, `/types`, `/health`, `/joke-ui` | Reads from MySQL (default) or MongoDB |
| Submit Service | 3200 -> 4200 | `POST /submit`, `GET /types`, `/docs`, `/health`, `/submit` | Publishes to `submit` queue; uses ECST cache |
| Moderate Service | 3300 -> 4300 | `GET /moderate`, `POST /moderated`, `POST /reject`, `/types`, `/me`, `/health`, `/moderate-ui` | Auth0 OIDC (optional fallback) |
| ETL Service | 3001 -> 4001 | `/health` | Consumes `moderated`; writes to DB; emits `type_update` |
| RabbitMQ | 5672, 15672 | AMQP; `http://localhost:15672` | Default creds `guest/guest` |
| Kong Gateway | 8000 -> 80 | Proxy all APIs and UIs | DB-less; uses `infra/kong/kong.local.yml` |
| MySQL | 3306 | MySQL protocol | Enabled when `DB_TYPE=mysql` |
| MongoDB | 27017 | Mongo protocol | Enabled when `DB_TYPE=mongo` |

---

## Hosted Links (Azure)

> All public traffic should go through **Kong** (VM4).
>
> Get the current Kong public IP from Terraform outputs:
>
> ```bash
> cd infra/terraform
> terraform output
> ```
>
> If TLS is self-signed, use `curl -k`.

**Kong Base URL:** `https://<KONG_PUBLIC_IP>`

### Web UIs

| URL | Description |
|---|---|
| `https://<KONG_PUBLIC_IP>/joke-ui` | Joke Machine — browse jokes |
| `https://<KONG_PUBLIC_IP>/submit` | Submit a joke |
| `https://<KONG_PUBLIC_IP>/moderate-ui` | Moderate jokes (Auth0 login required) |
| `https://<KONG_PUBLIC_IP>/docs` | Swagger / OpenAPI interactive docs |

### API Endpoints (via Kong)

| Method | URL | Description |
|---|---|---|
| `GET` | `/joke/programming` | Get a random programming joke |
| `GET` | `/joke/any` | Get a random joke of any type |
| `GET` | `/joke/any?count=3` | Get 3 random jokes |
| `GET` | `/types` | List all joke categories |
| `POST` | `/submit` | Submit a new joke (queues for moderation) |
| `GET` | `/moderate` | Moderation API (Auth0 protected) |
| `POST` | `/moderated` | Approve a joke (Auth0 session required) |
| `POST` | `/reject` | Reject a joke (Auth0 session required) |
| `GET` | `/me` | Returns authenticated moderator profile |

### Quick Test Commands (Azure)

```bash
export KONG_IP=<KONG_PUBLIC_IP>

curl -sk https://$KONG_IP/types
curl -sk https://$KONG_IP/joke/programming
curl -sk "https://$KONG_IP/joke/any?count=3"

# Submit a new joke (will queue for human moderation)
curl -sk -X POST https://$KONG_IP/submit \
  -H "Content-Type: application/json" \
  -d '{"setup":"Why did the DevOps engineer quit?","punchline":"Because they kept getting deployed to production.","type":"programming"}'

# Trigger rate limit (5 req/min on /joke)
for i in $(seq 1 8); do
  echo -n "Request $i: "
  curl -sk -o /dev/null -w "%{http_code}\n" https://$KONG_IP/joke/any
  sleep 0.3
done
```

> Rate limit: `/joke/:type` is limited to **5 requests/minute per IP**. Requests 6–8 return `429 Too Many Requests`.

---

## Local Development Links

After running `docker compose up -d`:

### Via Kong Gateway (port 8000) -- recommended

| URL | Description |
|---|---|
| http://localhost:8000/joke-ui | Joke Machine frontend |
| http://localhost:8000/submit | Submit a joke frontend |
| http://localhost:8000/moderate-ui | Moderation UI (Auth0 login required) |
| http://localhost:8000/docs | Swagger UI |
| http://localhost:8000/joke/programming | API -- get a joke |
| http://localhost:8000/types | API -- list categories |

### Direct Service Ports (bypass Kong — dev/debug only)

| URL | Service | Notes |
|---|---|---|
| http://localhost:3000 | Joke Service | host 3000 -> container 4000 |
| http://localhost:3000/health | Joke Service | Health check |
| http://localhost:3200 | Submit Service | host 3200 -> container 4200 |
| http://localhost:3200/docs | Submit Service | Swagger UI |
| http://localhost:3200/health | Submit Service | Health check |
| http://localhost:3300 | Moderate Service | host 3300 -> container 4300 |
| http://localhost:3300/health | Moderate Service | Health check |
| http://localhost:3001/health | ETL Service | Health check |
| http://localhost:15672 | RabbitMQ | Management UI (guest / guest) |
| http://localhost:8000/mq-admin/ | RabbitMQ | Management UI via Kong |
| localhost:3306 | MySQL | jokeuser / jokepassword |

> **Azure direct access** (bypassing Kong):
> - VM1 public IP — joke-service and ETL
> - VM2 public IP — submit-service and RabbitMQ
> - VM3 public IP — moderate-service
>
> Use `terraform output` from `infra/terraform` to get current IPs.

---

## Quick Start (Local)

### Prerequisites

- [Docker Desktop](https://www.docker.com/products/docker-desktop/)
- Auth0 account (free tier works -- see Auth0 Setup below)

### Step 1 -- Clone the repo

```bash
git clone <repo-url>
cd co3404-distributed-joke-system
```

### Step 2 -- Configure environment

```bash
cp .env.example .env
# Edit .env and fill in AUTH0_* values
```

### Step 3 -- Start all services

```bash
# Default MySQL mode (uses 'default' profile, no flag needed)
docker compose up -d

# Or MongoDB mode (starts MongoDB instead of MySQL)
DB_TYPE=mongo docker compose --profile mongo up -d
```

Startup takes ~30s for MySQL and RabbitMQ health checks to pass.

### Step 4 -- Verify

```bash
docker compose ps
curl http://localhost:8000/types
curl http://localhost:8000/joke/programming
```

### Step 5 -- Open the app

| URL | Description |
|---|---|
| http://localhost:8000/joke-ui | Joke browser |
| http://localhost:8000/submit | Submit jokes |
| http://localhost:8000/moderate-ui | Moderation UI (Auth0 login) |
| http://localhost:8000/docs | Swagger docs |
| http://localhost:15672 | RabbitMQ dashboard (guest/guest) |

### Auth0 Setup

1. Create a free Auth0 account and a Regular Web Application
2. Set Allowed Callback URLs: `http://localhost:8000/callback`
3. Set Allowed Logout URLs: `http://localhost:8000/moderate-ui`
4. Add to `.env`:

```
AUTH0_CLIENT_ID=your-client-id
AUTH0_CLIENT_SECRET=your-client-secret
AUTH0_ISSUER_BASE_URL=https://your-domain.auth0.com
AUTH0_BASE_URL=http://localhost:8000
AUTH0_SECRET=any-long-random-string-32-chars-minimum
```

---

## How to Run on Azure

### Step 1 -- Provision infrastructure

```bash
cd infra/terraform
cp terraform.tfvars.example terraform.tfvars
# Fill in subscription_id, ssh_public_key, Auth0 vars
terraform init && terraform apply
```

Creates 4 VMs: VM1 (joke-vm), VM2 (submit-vm), VM3 (moderate-vm), VM4 (kong-vm).

### Step 2 -- Deploy VM1 + VM2

```bash
cd ../..
# Edit infra/deploy.sh: set VM1_IP, VM2_IP
./infra/deploy.sh

# SSH and start
ssh -i ~/.ssh/co3404_key azureuser@<VM1_IP>
cd ~/co3404 && docker compose up -d

ssh -i ~/.ssh/co3404_key azureuser@<VM2_IP>
cd ~/co3404 && docker compose up -d
```

### Step 3 -- Deploy VM3 (moderate-service)

**Automated (recommended):** GitHub Actions deploys VM3 automatically on every push to `main` that touches `moderate-service/**`.

**Manual (first-time setup):**

```bash
# Bootstrap Docker on VM3
scp -i ~/.ssh/co3404_key infra/vm3-setup.sh azureuser@<VM3_IP>:/tmp/
ssh -i ~/.ssh/co3404_key azureuser@<VM3_IP> "chmod +x /tmp/vm3-setup.sh && sudo /tmp/vm3-setup.sh"

# Deploy compose file + env
scp -i ~/.ssh/co3404_key infra/vm3-compose.yml azureuser@<VM3_IP>:~/moderate/docker-compose.yml
scp -i ~/.ssh/co3404_key infra/.env.vm3 azureuser@<VM3_IP>:~/moderate/.env
ssh -i ~/.ssh/co3404_key azureuser@<VM3_IP> "cd ~/moderate && docker compose pull && docker compose up -d"
```

GitHub Actions secrets required for CI/CD:
`DOCKER_USERNAME`, `DOCKER_PASSWORD`, `VM3_HOST`, `VM3_USER`, `VM3_SSH_KEY`,
`AUTH0_SECRET`, `AUTH0_BASE_URL`, `AUTH0_CLIENT_ID`, `AUTH0_CLIENT_SECRET`, `AUTH0_ISSUER_BASE_URL`,
`RABBITMQ_HOST`, `RABBITMQ_USER`, `RABBITMQ_PASSWORD`

### Step 4 -- Kong (VM4)

Kong is fully managed by Terraform provisioners and starts automatically after `terraform apply`.

---

## API Reference

### GET /types

```bash
curl http://localhost:8000/types
# [{"id":1,"name":"dad"},{"id":2,"name":"general"},...]
```

### GET /joke/:type

```bash
curl http://localhost:8000/joke/programming
curl http://localhost:8000/joke/any
# {"id":3,"setup":"...","punchline":"...","type":"programming"}
```

> Rate limited: 5 requests/minute per IP via Kong. Returns `429` after limit.

### GET /joke/:type?count=N

```bash
curl "http://localhost:8000/joke/any?count=5"
```

### POST /submit

```bash
curl -X POST http://localhost:8000/submit \
  -H "Content-Type: application/json" \
  -d '{"setup":"...","punchline":"...","type":"programming"}'
# 202: {"message":"Joke queued for moderation","queued":{...}}
```

### GET /moderate (Auth0 protected)

Opens the moderation UI. Requires Auth0 login. Moderators can edit, approve, or reject jokes.

### GET /docs

Swagger / OpenAPI interactive documentation for the Submit Service.

---

## Project Structure

```
.
+-- docker-compose.yml            # Local dev: all 8 services
+-- .env.example                  # Environment template
+-- db/
|   +-- init.sql                  # MySQL schema + seed data
+-- joke-service/                 # GET /joke/:type, GET /types, GET /health
|   +-- server.js
|   +-- db.js                     # MySQL + MongoDB adapter (DB_TYPE)
|   +-- public/                   # Frontend HTML + JS
+-- submit-service/               # POST /submit, GET /types (ECST), Swagger
|   +-- server.js
|   +-- rabbitmq.js               # Producer + ECST sub_type_update subscriber
|   +-- public/                   # Frontend HTML + JS
+-- moderate-service/             # Auth0 OIDC moderation UI
|   +-- server.js                 # GET /moderate, POST /moderated, POST /reject
|   +-- rabbitmq.js               # 3 channels: consumer, producer, ECST
|   +-- auth.js                   # Auth0 config + requiresAuthJson middleware
|   +-- public/                   # Moderation UI
+-- etl-service/                  # Consumes moderated queue -> DB + ECST publisher
|   +-- server.js
|   +-- db.js                     # MySQL + MongoDB adapter
+-- infra/
|   +-- kong/
|   |   +-- kong.local.yml        # Local Kong config (service hostnames)
|   |   +-- kong.yml              # Production Kong config (private IPs)
|   |   +-- docker-compose.yml    # Kong with TLS
|   +-- vm1-compose.yml           # VM1: MySQL + Joke Service + ETL
|   +-- vm2-compose.yml           # VM2: RabbitMQ + Submit Service
|   +-- vm3-compose.yml           # VM3: Moderate Service
|   +-- vm3-setup.sh              # Bootstrap Docker on VM3 (moderate-vm)
|   +-- deploy.sh                 # scp deploy to VM1 + VM2 (VM3 via CI/CD)
|   +-- terraform/
|       +-- main.tf               # 4 Azure VMs, VNet, NSG, Kong TLS provisioner
|       +-- variables.tf          # Inputs: subscription, SSH key, Auth0, VM3
|       +-- outputs.tf            # IPs, SSH commands
|       +-- terraform.tfvars.example
+-- .github/
    +-- workflows/
        +-- deploy-moderate.yml   # CI/CD: Docker build+push, SSH deploy to VM3
```

---

## Database Schema

```sql
CREATE TABLE types (
  id   INT AUTO_INCREMENT PRIMARY KEY,
  name VARCHAR(100) UNIQUE NOT NULL
);

-- Only approved (moderated) jokes reach this table
CREATE TABLE jokes (
  id        INT AUTO_INCREMENT PRIMARY KEY,
  setup     TEXT NOT NULL,
  punchline TEXT NOT NULL,
  type_id   INT  NOT NULL,
  FOREIGN KEY (type_id) REFERENCES types(id) ON DELETE RESTRICT
);
```

Seed categories: `general`, `programming`, `knock-knock`, `dad`, `science`

With MongoDB (`DB_TYPE=mongo`), the same schema is represented as Mongoose `Type` and `Joke` models.

---

## Environment Variables

| Variable | Default | Description |
|---|---|---|
| `DB_HOST` | `mysql` | MySQL hostname |
| `DB_USER` | `jokeuser` | MySQL user |
| `DB_PASSWORD` | `jokepassword` | MySQL password |
| `DB_NAME` | `jokesdb` | MySQL database name |
| `DB_ROOT_PASSWORD` | `rootpassword` | MySQL root password |
| `DB_TYPE` | `mysql` | Database adapter: `mysql` or `mongo` |
| `MONGO_URI` | -- | MongoDB URI (when DB_TYPE=mongo) |
| `RABBITMQ_HOST` | `rabbitmq` | RabbitMQ hostname |
| `RABBITMQ_USER` | `guest` | RabbitMQ username |
| `RABBITMQ_PASSWORD` | `guest` | RabbitMQ password |
| `AUTH0_SECRET` | -- | Session encryption secret (32+ chars) |
| `AUTH0_BASE_URL` | `http://localhost:8000` | Public URL through Kong |
| `AUTH0_CLIENT_ID` | -- | Auth0 application client ID |
| `AUTH0_CLIENT_SECRET` | -- | Auth0 application client secret |
| `AUTH0_ISSUER_BASE_URL` | -- | `https://your-domain.auth0.com` |

Copy `.env.example` to `.env`. Defaults work for local development except Auth0 variables.

---

## Secrets / API Keys

- Keep real keys in `.env` (or env vars in your shell/CI). `.env` is already ignored by git.
- Share **only** placeholders in `.env.example`; never commit real values.
- For production, set secrets as environment variables or CI/CD secrets (see GitHub Actions variables listed in [How to Run on Azure](#how-to-run-on-azure)).
- If a secret was committed, rotate it immediately and force-push without the secret in history if policy allows.

---

## Queues & Exchanges

| Name | Type | Producer(s) | Consumer(s) | Purpose |
|---|---|---|---|---|
| `submit` | Queue | submit-service | moderate-service | Pending jokes awaiting human review |
| `moderated` | Queue | moderate-service | etl-service | Approved jokes ready for persistence |
| `type_update` | Fanout exchange | etl-service | `sub_type_update`, `mod_type_update` queues | ECST broadcast carrying the full type list |
| `sub_type_update` | Queue (bound to `type_update`) | etl-service | submit-service | Refresh submit-service cache after new type creation |
| `mod_type_update` | Queue (bound to `type_update`) | etl-service | moderate-service | Refresh moderate-service cache after new type creation |

---

## Key Design Decisions

- **Moderation before persistence.** Submitted jokes enter `submit` queue -> moderate-service. Only approved jokes reach `moderated` queue -> ETL -> DB. Rejected jokes are nack'd (requeue=false).
- **Auth0 OIDC.** `express-openid-connect` with `authRequired: false`. API routes use `requiresAuthJson()` returning 401 JSON. Browser routes use `requiresAuth()` for redirect flow.
- **Auth fallback mode.** If `AUTH0_*` variables are missing, moderate-service runs in unauthenticated local mode with a mock user so queue workflow can still be tested.
- **ECST (Event-Carried State Transfer).** ETL publishes to `type_update` fanout exchange after each new type insertion. Submit (`sub_type_update`) and Moderate (`mod_type_update`) services cache the type list locally, removing HTTP polling dependency on joke-service.
- **At-least-once delivery.** ETL acks `moderated` messages only after confirmed DB write. Moderate acks `submit` messages only after forwarding to `moderated` queue.
- **Idempotent type inserts.** MySQL uses `INSERT IGNORE`; MongoDB uses `findOneAndUpdate` with `upsert:true` and `$setOnInsert`.
- **MySQL / MongoDB switching.** `DB_TYPE` env var selects the adapter at startup in both `joke-service/db.js` and `etl-service/db.js`.
- **prefetch(1).** Both consumers (moderate-service on `submit`, etl-service on `moderated`) use prefetch(1) to prevent consumer flooding.
- **Kong as the single origin.** VM1, VM2, VM3 are not publicly reachable. All routing, TLS, and rate limiting is enforced at Kong (VM4).
- **CI/CD for moderate-service.** GitHub Actions builds Docker image, pushes to Docker Hub, and SSH-deploys to VM3 via `docker compose pull && up --force-recreate` on every push to main.

