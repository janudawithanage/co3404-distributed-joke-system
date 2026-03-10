# CO3404 Distributed Joke System

A distributed microservices application built for the **CO3404 Distributed Systems** module at Ulster University. Users can browse and submit jokes through a web interface backed by a fully decoupled, message-driven architecture deployed on Azure.

---

## Table of Contents

- [Architecture](#architecture)
- [Hosted Links (Azure — Live)](#hosted-links-azure--live)
- [Local Development Links](#local-development-links)
- [Quick Start (Local)](#quick-start-local)
- [How to Run on Azure](#how-to-run-on-azure)
- [API Reference](#api-reference)
- [Project Structure](#project-structure)
- [Database Schema](#database-schema)
- [Environment Variables](#environment-variables)
- [Key Design Decisions](#key-design-decisions)

---

## Architecture

```
Browser / curl
      │
      ▼  HTTPS (443) / HTTP (80)
┌─────────────────────────────────┐
│   Kong API Gateway  (VM3)       │  — TLS termination, routing,
│   85.211.240.162                │    rate limiting, request IDs
└──────────┬──────────────────────┘
           │ private Azure VNet (10.0.1.x)
     ┌─────┴──────────┐
     ▼                ▼
  VM1 (10.0.1.4)   VM2 (10.0.1.5)
  ┌────────────┐   ┌──────────────────┐
  │Joke Service│   │ Submit Service   │
  │  :3001     │   │  :3002           │
  │            │   │                  │
  │ETL Service │   │ RabbitMQ         │
  │  :3003     │   │  :5672 / :15672  │
  └──────┬─────┘   └────────┬─────────┘
         │                  │
         └──────┬───────────┘
                ▼
            MySQL :3306  (VM1)
```

| Service | VM | Role |
|---|---|---|
| **Joke Service** | VM1 :3001 | Serves jokes from MySQL; provides a browsing frontend |
| **ETL Service** | VM1 :3003 | Consumes RabbitMQ queue and persists jokes to MySQL |
| **MySQL** | VM1 :3306 | Persistent relational store for joke types and jokes |
| **Submit Service** | VM2 :3002 | Accepts new jokes, publishes to RabbitMQ; serves submission frontend + Swagger docs |
| **RabbitMQ** | VM2 :5672 | Message broker decoupling Submit from ETL |
| **Kong** | VM3 :443/80 | DB-less API gateway — single public entry point, TLS, rate-limiting, correlation IDs |

---

## Hosted Links (Azure — Live)

> All public traffic goes through the **Kong API Gateway** only.  
> Kong uses a self-signed certificate — add `-k` to any `curl` command.

**Kong Base URL:** `https://85.211.240.162`

### Web UIs

| URL | Description |
|---|---|
| [https://85.211.240.162/joke-ui](https://85.211.240.162/joke-ui) | 🎭 Joke Machine — browse jokes |
| [https://85.211.240.162/submit](https://85.211.240.162/submit) | 📝 Submit a joke |
| [https://85.211.240.162/docs](https://85.211.240.162/docs) | 📖 Swagger / OpenAPI interactive docs |

### API Endpoints (via Kong)

| Method | URL | Description |
|---|---|---|
| `GET` | `https://85.211.240.162/joke/programming` | Get a random programming joke |
| `GET` | `https://85.211.240.162/joke/any` | Get a random joke of any type |
| `GET` | `https://85.211.240.162/joke/any?count=3` | Get 3 random jokes |
| `GET` | `https://85.211.240.162/types` | List all joke categories |
| `POST` | `https://85.211.240.162/submit` | Submit a new joke |

### Quick Test Commands (Azure)

```bash
# Set the Kong IP once
export KONG_IP=85.211.240.162

# Get all joke types
curl -sk https://$KONG_IP/types

# Get a random programming joke
curl -sk https://$KONG_IP/joke/programming

# Get 3 random jokes of any type
curl -sk "https://$KONG_IP/joke/any?count=3"

# Submit a new joke
curl -sk -X POST https://$KONG_IP/submit \
  -H "Content-Type: application/json" \
  -d '{"setup":"Why did the DevOps engineer quit?","punchline":"Because they kept getting deployed to production.","type":"programming"}'

# Trigger rate limit (5 req/min on /joke — sends 8 requests)
for i in $(seq 1 8); do
  echo -n "Request $i: "
  curl -sk -o /dev/null -w "%{http_code}\n" https://$KONG_IP/joke/any
  sleep 0.3
done
```

> ⚠️ The `/joke/:type` route is **rate limited to 5 requests per minute** per IP. Requests 6–8 will return `429 Too Many Requests`.

> ℹ️ `/health` is **not** exposed through Kong — it is an internal Docker health check only.

---

## Local Development Links

After running `docker compose up -d` the following URLs become available:

### Via Kong Gateway (port 8000) — recommended

| URL | Description |
|---|---|
| http://localhost:8000/joke-ui | 🎭 Joke Machine frontend |
| http://localhost:8000/submit | 📝 Submit a joke frontend |
| http://localhost:8000/docs | 📖 Swagger UI |
| http://localhost:8000/joke/programming | API — get a joke |
| http://localhost:8000/joke/any?count=3 | API — get 3 jokes |
| http://localhost:8000/types | API — list categories |

### Direct Service Ports (bypass Kong — dev/debug only)

| URL | Service | Description |
|---|---|---|
| http://localhost:3000 | Joke Service | Frontend + API (host port `3000` → container `4000`) |
| http://localhost:3000/joke/programming | Joke Service | Direct API call |
| http://localhost:3000/types | Joke Service | Direct types endpoint |
| http://localhost:3000/health | Joke Service | Health check |
| http://localhost:3200 | Submit Service | Frontend + API (host port `3200` → container `4200`) |
| http://localhost:3200/docs | Submit Service | Swagger UI |
| http://localhost:3200/health | Submit Service | Health check |
| http://localhost:3001/health | ETL Service | Health check (host port `3001` → container `4001`) |
| http://localhost:15672 | RabbitMQ | Management UI — login: `guest` / `guest` |
| localhost:3306 | MySQL | Direct DB connection (user: `jokeuser`, password: `jokepassword`) |

---

## Quick Start (Local)

### Prerequisites

- [Docker Desktop](https://www.docker.com/products/docker-desktop/) (includes Docker Engine + Compose)

### Step 1 — Clone the repo

```bash
git clone <repo-url>
cd co3404-distributed-joke-system
```

### Step 2 — Configure environment

```bash
cp .env.example .env
```

The defaults in `.env.example` work out of the box — no changes needed for local development.

### Step 3 — Build and start all services

```bash
docker compose up -d
```

This starts 6 containers: `mysql`, `rabbitmq`, `joke-service`, `submit-service`, `etl-service`, and `kong`.  
Startup takes ~30 seconds for MySQL and RabbitMQ health checks to pass.

### Step 4 — Verify everything is running

```bash
docker compose ps
```

All containers should show `healthy` or `running`. Then test:

```bash
# Should return a list of joke types
curl http://localhost:8000/types

# Should return a joke
curl http://localhost:8000/joke/programming
```

### Step 5 — Open the app

| URL | What you'll see |
|---|---|
| http://localhost:8000/joke-ui | Joke browser frontend |
| http://localhost:8000/submit | Joke submission form |
| http://localhost:8000/docs | Swagger interactive API docs |
| http://localhost:15672 | RabbitMQ dashboard (guest / guest) |

### Step 6 — View logs

```bash
# All services
docker compose logs -f

# Individual service
docker compose logs -f joke-service
docker compose logs -f submit-service
docker compose logs -f etl-service
docker compose logs -f kong
```

### Step 7 — Stop and clean up

```bash
# Stop containers, keep volumes (data preserved on next start)
docker compose down

# Stop containers AND wipe all data (full reset)
docker compose down -v
```

---

## How to Run on Azure

### Prerequisites

- Azure CLI installed and logged in (`az login`)
- Terraform installed
- SSH key at `~/.ssh/co3404_key`

### Step 1 — Provision infrastructure

```bash
cd infra/terraform
cp terraform.tfvars.example terraform.tfvars
# Edit terraform.tfvars with your subscription ID and SSH public key
terraform init
terraform apply
```

### Step 2 — Get VM IPs

```bash
terraform output
# kong_public_ip  = "85.211.240.162"
# ssh_command     = "ssh -i ~/.ssh/co3404_key azureuser@85.211.240.162"
```

### Step 3 — Deploy services

```bash
cd ../..
# Edit infra/deploy.sh — set VM1_IP and VM2_IP from the Azure portal
# az vm list-ip-addresses -g rg-co3404-jokes -o table

chmod +x infra/deploy.sh
./infra/deploy.sh
```

### Step 4 — SSH into VMs and start services

```bash
# VM1 — Joke Service, ETL Service, MySQL
ssh -i ~/.ssh/co3404_key azureuser@<VM1_IP>
cd ~/co3404 && docker compose -f vm1-compose.yml up -d

# VM2 — Submit Service, RabbitMQ
ssh -i ~/.ssh/co3404_key azureuser@<VM2_IP>
cd ~/co3404 && docker compose -f vm2-compose.yml up -d
```

### Step 5 — Kong starts automatically on VM3

Kong is managed by the Terraform provisioner on VM3 and starts automatically after provisioning.

### Cost Management

```bash
# Deallocate Kong VM to stop billing (preserves disk/IP)
az vm deallocate -g rg-co3404-jokes -n vm-kong --no-wait

# Start it again
az vm start -g rg-co3404-jokes -n vm-kong
```

---

## API Reference

All routes below work on both local (`http://localhost:8000`) and Azure (`https://85.211.240.162`).

### GET /types

Returns all joke categories ordered alphabetically.

```bash
curl http://localhost:8000/types
# → [{"id":1,"name":"dad"},{"id":2,"name":"general"},...]
```

### GET /joke/:type

Returns one random joke. Use `any` for any category.

```bash
curl http://localhost:8000/joke/programming
curl http://localhost:8000/joke/dad
curl http://localhost:8000/joke/any
```

**Response (HTTP 200):**
```json
{
  "id": 3,
  "setup": "Why do programmers prefer dark mode?",
  "punchline": "Because light attracts bugs!",
  "type": "programming"
}
```

**Not found (HTTP 404):**
```json
{ "error": "No jokes found for type: \"unknown\"" }
```

> ⚠️ Rate limited: **5 requests/minute per IP** (returns `429` after limit exceeded).

### GET /joke/:type?count=N

Returns N random jokes as an array. If N exceeds available jokes, all are returned without error.

```bash
curl "http://localhost:8000/joke/programming?count=2"
curl "http://localhost:8000/joke/any?count=5"
```

### POST /submit

Submits a new joke to the RabbitMQ queue. The ETL service picks it up and writes it to MySQL.

```bash
curl -X POST http://localhost:8000/submit \
  -H "Content-Type: application/json" \
  -d '{"setup":"Why do Java developers wear glasses?","punchline":"Because they don'\''t C#!","type":"programming"}'
```

**Request body:**
| Field | Type | Required | Description |
|---|---|---|---|
| `setup` | string | ✅ | The joke setup / question |
| `punchline` | string | ✅ | The punchline / answer |
| `type` | string | ✅ | Category (e.g. `programming`, `dad`, `general`) |

**Response (HTTP 202):**
```json
{
  "message": "Joke queued for processing by the ETL service",
  "queued": { "setup": "...", "punchline": "...", "type": "programming" }
}
```

**Errors:**
- `400` — missing `setup`, `punchline`, or `type`
- `503` — RabbitMQ unavailable

### GET /docs

Swagger / OpenAPI interactive documentation for the Submit Service.

```
http://localhost:8000/docs        (local)
https://85.211.240.162/docs       (Azure)
```

### GET /joke-ui

Joke Machine web frontend.

### GET /submit (GET)

Joke submission web frontend.

---

## Project Structure

```
.
├── docker-compose.yml            # Local development — all 6 services
├── .env.example                  # Environment variable template (copy to .env)
├── db/
│   └── init.sql                  # MySQL schema + seed data (auto-runs on first start)
├── joke-service/                 # Node.js — serves jokes from MySQL
│   ├── server.js                 # Express app — GET /joke/:type, GET /types, GET /health
│   ├── db.js                     # MySQL connection pool with retry
│   └── public/                   # Frontend HTML + JS
├── submit-service/               # Node.js — accepts submissions via RabbitMQ
│   ├── server.js                 # Express app — POST /submit, GET /types (cache), GET /docs
│   ├── rabbitmq.js               # AMQP connection + publish helper
│   └── public/                   # Frontend HTML + JS
├── etl-service/                  # Node.js — RabbitMQ consumer → MySQL
│   ├── server.js                 # Consumes jokes_queue, writes to MySQL, GET /health
│   └── db.js                     # MySQL connection pool with retry
└── infra/
    ├── kong/
    │   ├── kong.local.yml        # Kong config for local Docker (HTTP only)
    │   └── kong.yml              # Kong config for Azure (HTTPS + rate limiting)
    ├── vm1-compose.yml           # Azure VM1: MySQL + Joke Service + ETL Service
    ├── vm2-compose.yml           # Azure VM2: RabbitMQ + Submit Service
    ├── deploy.sh                 # Copies source files to Azure VMs via scp
    └── terraform/
        ├── main.tf               # Azure VMs, VNet, NSG, public IPs
        ├── variables.tf          # Input variables
        ├── outputs.tf            # IPs, test commands, SSH commands
        └── terraform.tfvars.example
```

---

## Database Schema

```sql
-- Joke categories
CREATE TABLE types (
  id   INT AUTO_INCREMENT PRIMARY KEY,
  name VARCHAR(100) UNIQUE NOT NULL
);

-- Individual jokes
CREATE TABLE jokes (
  id        INT AUTO_INCREMENT PRIMARY KEY,
  setup     TEXT NOT NULL,
  punchline TEXT NOT NULL,
  type_id   INT  NOT NULL,
  FOREIGN KEY (type_id) REFERENCES types(id) ON DELETE RESTRICT
);
```

**Seed categories:** `general`, `programming`, `knock-knock`, `dad`, `science`

---

## Environment Variables

Copy `.env.example` to `.env` — defaults work for local development without any changes.

| Variable | Default | Description |
|---|---|---|
| `DB_HOST` | `mysql` | MySQL hostname (Docker service name) |
| `DB_USER` | `jokeuser` | MySQL application user |
| `DB_PASSWORD` | `jokepassword` | MySQL application password |
| `DB_NAME` | `jokesdb` | MySQL database name |
| `DB_ROOT_PASSWORD` | `rootpassword` | MySQL root password |
| `RABBITMQ_HOST` | `rabbitmq` | RabbitMQ hostname (Docker service name) |
| `RABBITMQ_USER` | `guest` | RabbitMQ username |
| `RABBITMQ_PASSWORD` | `guest` | RabbitMQ password |
| `JOKE_SERVICE_URL` | `http://joke-service:4000` | Internal URL used by Submit Service to proxy `/types` |

---

## Key Design Decisions

- **Submit never writes to the DB directly.** It publishes to RabbitMQ. Submissions succeed even if MySQL is temporarily down.
- **At-least-once delivery.** ETL only ACKs a RabbitMQ message after a successful DB write. If ETL crashes, RabbitMQ re-delivers.
- **Idempotent type inserts.** `INSERT IGNORE` on `types` prevents duplicates when the same message is re-delivered.
- **Cache-aside on `/types`.** Submit Service caches joke types to a Docker named volume — it can serve types even when Joke Service is offline.
- **prefetch(1) on ETL.** Prevents the ETL from being flooded when the DB is slow; ensures fair message dispatch when scaling horizontally.
- **Kong as the single origin.** No client ever contacts VM1 or VM2 directly. All routing, TLS, and rate limiting is enforced at Kong.

---

## Module

**CO3404 Distributed Systems** — Ulster University
