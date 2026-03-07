# CO3404 Distributed Joke System

A distributed microservices application built for the CO3404 Distributed Systems module. Users can browse and submit jokes through a web interface backed by a fully decoupled, message-driven architecture.

---

## Architecture

```
Browser
  │
  ▼
Kong API Gateway (port 8000)
  ├──▶ Joke Service   (port 4000) ──▶ MySQL
  └──▶ Submit Service (port 4200) ──▶ RabbitMQ ──▶ ETL Service ──▶ MySQL
```

| Service | Role |
|---|---|
| **Joke Service** | Serves jokes from MySQL; provides a browsing frontend |
| **Submit Service** | Accepts new jokes, publishes them to RabbitMQ; provides a submission frontend and Swagger docs |
| **ETL Service** | Consumes the RabbitMQ queue and persists jokes to MySQL |
| **MySQL** | Persistent relational store for joke types and jokes |
| **RabbitMQ** | Message broker decoupling Submit from ETL |
| **Kong** | DB-less API gateway — single public entry point, routing, rate-limiting, and request correlation |

### Key Design Decisions

- **Submit never writes to the DB directly.** Messages queue up in RabbitMQ, so submissions succeed even if MySQL is temporarily down.
- **At-least-once delivery.** ETL only ACKs a message after a successful DB write. If it crashes, RabbitMQ re-delivers.
- **Idempotent type inserts.** `INSERT IGNORE` on `types` prevents duplicates when the same message is processed more than once.
- **Cache-aside on `/types`.** Submit Service caches joke types to a Docker volume — it can return types even when Joke Service is offline.

---

## Quick Start (Local)

### Prerequisites

- [Docker Desktop](https://www.docker.com/products/docker-desktop/) (Docker Engine + Compose)

### 1. Configure environment

```bash
cp .env.example .env
```

The defaults in `.env.example` work out of the box for local development — no changes needed unless you want custom credentials.

### 2. Start all services

```bash
docker compose up -d
```

### 3. Open the app

| URL | Description |
|---|---|
| http://localhost:8000/joke-ui | Browse jokes (via Kong) |
| http://localhost:8000/submit | Submit a joke (via Kong) |
| http://localhost:8000/docs | Swagger / OpenAPI docs |
| http://localhost:8000/mq-admin | RabbitMQ Management UI (guest / guest) |

> Direct service ports are also available: Joke Service on `:3000`, Submit Service on `:3200`, ETL health on `:3001`.

### 4. Stop and clean up

```bash
# Stop containers, keep volumes (data preserved)
docker compose down

# Stop containers AND remove all volumes (full reset)
docker compose down -v
```

---

## Project Structure

```
.
├── docker-compose.yml          # Local development — all services
├── .env.example                # Environment variable template
├── db/
│   └── init.sql                # MySQL schema + seed data
├── joke-service/               # Node.js — serves jokes from MySQL
│   ├── server.js
│   ├── db.js
│   └── public/                 # Frontend (HTML + JS)
├── submit-service/             # Node.js — accepts submissions via RabbitMQ
│   ├── server.js
│   ├── rabbitmq.js
│   └── public/                 # Frontend (HTML + JS)
├── etl-service/                # Node.js — RabbitMQ consumer → MySQL
│   ├── server.js
│   └── db.js
└── infra/                      # Infrastructure configs
    ├── kong/
    │   ├── kong.local.yml      # Kong declarative config (local)
    │   └── kong.yml            # Kong declarative config (Azure)
    ├── vm1-compose.yml         # Azure VM1: MySQL + Joke Service + ETL
    ├── vm2-compose.yml         # Azure VM2: RabbitMQ + Submit Service
    ├── deploy.sh               # Deployment helper script
    └── terraform/              # Azure infrastructure as code
```

---

## API Reference

All routes are accessible through Kong at `http://localhost:8000`.

### Joke Service

| Method | Path | Description |
|---|---|---|
| `GET` | `/joke/:type` | Fetch a random joke by type. Use `any` for all types. |
| `GET` | `/joke/:type?count=N` | Fetch N random jokes by type |
| `GET` | `/types` | List all joke categories |
| `GET` | `/health` | Health check |

**Example**

```bash
curl http://localhost:8000/joke/programming
curl http://localhost:8000/joke/any?count=3
curl http://localhost:8000/types
```

### Submit Service

| Method | Path | Description |
|---|---|---|
| `POST` | `/submit` | Submit a new joke (published to RabbitMQ) |
| `GET` | `/types` | List joke categories (cached proxy to Joke Service) |
| `GET` | `/docs` | Swagger UI |
| `GET` | `/health` | Health check |

**Example**

```bash
curl -X POST http://localhost:8000/submit \
  -H "Content-Type: application/json" \
  -d '{"setup":"Why do Java developers wear glasses?","punchline":"Because they don'\''t C#!","type":"programming"}'
```

---

## Database Schema

```sql
types (id, name UNIQUE)   -- joke categories
jokes (id, setup, punchline, type_id FK → types.id)
```

Seed categories: `general`, `programming`, `knock-knock`, `dad`, `science`

---

## Environment Variables

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
| `JOKE_SERVICE_URL` | `http://joke-service:4000` | Internal URL used by Submit Service |

---

## Infrastructure (Azure — Phase 2)

The `infra/` directory contains everything needed to deploy to Azure:

- **VM1** (`vm1-compose.yml`) — runs MySQL, Joke Service, and ETL Service
- **VM2** (`vm2-compose.yml`) — runs RabbitMQ and Submit Service
- **Kong** (`kong/kong.yml`) — API gateway with TLS, rate limiting, and correlation IDs
- **Terraform** (`terraform/`) — provisions Azure VMs, networking, and NSG rules

See `infra/deploy.sh` for the deployment workflow.

---

## Module

**CO3404 Distributed Systems** — Ulster University
