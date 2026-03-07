# CO3404 Distributed Systems — Run and Test Guide
## Option 3: Local Development + Azure Deployment

---

## Table of Contents

1. [Prerequisites](#1-prerequisites)
2. [Phase 1 — Local Docker Setup](#2-phase-1--local-docker-setup)
3. [Verify Each Service (Local)](#3-verify-each-service-local)
4. [Verify RabbitMQ Queue Flow](#4-verify-rabbitmq-queue-flow)
5. [Verify Type Cache Fallback](#5-verify-type-cache-fallback)
6. [Verify Resilience by Stopping Services](#6-verify-resilience-by-stopping-services)
7. [Phase 2 — Azure Deployment (VM1 + VM2)](#7-phase-2--azure-deployment-vm1--vm2)
8. [Phase 3 — Kong Gateway (Terraform)](#8-phase-3--kong-gateway-terraform)
9. [Verify Kong Single-Origin Routing](#9-verify-kong-single-origin-routing)
10. [Verify HTTPS / TLS](#10-verify-https--tls)
11. [Verify Rate Limiting](#11-verify-rate-limiting)
12. [Verify Kong Swagger Docs](#12-verify-kong-swagger-docs)
13. [Final Submission Checklist](#13-final-submission-checklist)

---

## 1. Prerequisites

| Tool | Install | Verify |
|------|---------|--------|
| Docker Desktop | https://www.docker.com/products/docker-desktop/ | `docker --version` |
| Docker Compose v2 | Included with Docker Desktop | `docker compose version` |
| Azure CLI | `brew install azure-cli` | `az version` |
| Terraform ≥ 1.5 | `brew install terraform` | `terraform version` |
| jq | `brew install jq` | `jq --version` |
| curl | Pre-installed on macOS | `curl --version` |

> **No local Node.js required** — all services run inside Docker containers.

---

## 2. Phase 1 — Local Docker Setup

### Step 1: Set up environment variables

```bash
cd /path/to/co3404-distributed-joke-system

# The .env file is already present with correct defaults
cat .env
```

Expected contents:
```
DB_HOST=mysql
DB_USER=jokeuser
DB_PASSWORD=jokepassword
DB_NAME=jokesdb
DB_ROOT_PASSWORD=rootpassword
RABBITMQ_HOST=rabbitmq
RABBITMQ_USER=guest
RABBITMQ_PASSWORD=guest
JOKE_SERVICE_URL=http://joke-service:3001
```

### Step 2: Build and start all services

```bash
docker compose up --build
```

Wait for all services to show **healthy** or **started**. MySQL takes ~30 s on first run to initialise.

### Step 3: Verify all containers are running

```bash
docker compose ps
```

Expected:
```
NAME                    STATUS          PORTS
jokes_mysql             healthy         0.0.0.0:3306->3306/tcp
jokes_rabbitmq          healthy         0.0.0.0:5672->5672/tcp, 0.0.0.0:15672->15672/tcp
jokes_joke_service      healthy         0.0.0.0:3001->3001/tcp
jokes_submit_service    running         0.0.0.0:3002->3002/tcp
jokes_etl_service       healthy         0.0.0.0:3003->3003/tcp
```

---

## 3. Verify Each Service (Local)

### Joke Service
```bash
# Health check
curl http://localhost:3001/health | jq .
# Expected: {"status":"ok","service":"joke-service","timestamp":"..."}

# Get all joke types
curl http://localhost:3001/types | jq .
# Expected: array of {id, name} objects

# Get a random programming joke
curl http://localhost:3001/joke/programming | jq .
# Expected: {id, setup, punchline, type}

# Get 3 dad jokes
curl "http://localhost:3001/joke/dad?count=3" | jq .
# Expected: array of 3 jokes

# Get a random joke of any type
curl http://localhost:3001/joke/any | jq .

# Request more jokes than exist (count=100 with only ~2 dad jokes → returns all available)
curl "http://localhost:3001/joke/dad?count=100" | jq length
# Expected: 2 (or however many exist — not 100)

# Frontend UI
open http://localhost:3001
# Expected: "Joke Machine" page loads with type dropdown populated dynamically
# Select a type, click "Get Joke(s)", wait 3 seconds → punchline appears
```

### Submit Service
```bash
# Health check
curl http://localhost:3002/health | jq .
# Expected: {"status":"ok","service":"submit-service","timestamp":"..."}

# Get types (via proxy to joke-service)
curl http://localhost:3002/types | jq .
# Expected: same array as joke-service /types

# Submit a new joke
curl -X POST http://localhost:3002/submit \
  -H "Content-Type: application/json" \
  -d '{"setup":"Why did the sysadmin go to therapy?","punchline":"Too many unresolved issues.","type":"programming"}' | jq .
# Expected: {"message":"Joke queued for processing by the ETL service","queued":{...}}

# Missing fields — should return 400
curl -X POST http://localhost:3002/submit \
  -H "Content-Type: application/json" \
  -d '{"setup":"incomplete"}' | jq .
# Expected: {"error":"Missing required fields: setup, punchline, type"}

# Swagger UI
open http://localhost:3002/docs
# Expected: Swagger UI page with POST /submit, GET /types, GET /health

# Frontend UI
open http://localhost:3002
# Expected: "Submit a Joke" form with type dropdown
```

### ETL Service
```bash
# Health check
curl http://localhost:3003/health | jq .
# Expected: {"status":"ok","service":"etl-service","timestamp":"..."}

# Check ETL logs for message processing
docker compose logs --tail=20 etl-service
# Expected to see: "[ETL] ✅ Inserted joke..." after submitting via Submit service
```

### RabbitMQ Management UI
```bash
open http://localhost:15672
# Login: guest / guest
# Navigate to Queues tab → jokes_queue should be visible
# After submit, message count briefly shows 1 then drops to 0 (consumed by ETL)
```

### MySQL (direct query)
```bash
docker exec jokes_mysql mysql -ujokeuser -pjokepassword jokesdb \
  -e "SELECT j.id, j.setup, t.name AS type FROM jokes j JOIN types t ON j.type_id=t.id ORDER BY j.id DESC LIMIT 5;"
# Expected: table of recently inserted jokes
```

---

## 4. Verify RabbitMQ Queue Flow

This demonstrates the asynchronous Submit → Queue → ETL → MySQL pipeline.

### Step 1: Stop the ETL service (so messages queue up)
```bash
docker compose stop etl-service
```

### Step 2: Submit several jokes (they will queue in RabbitMQ)
```bash
for i in 1 2 3; do
  curl -s -X POST http://localhost:3002/submit \
    -H "Content-Type: application/json" \
    -d "{\"setup\":\"Queue test $i\",\"punchline\":\"Response $i\",\"type\":\"general\"}" | jq .message
done
```

### Step 3: Verify messages are in the queue
```bash
# RabbitMQ Management API (count messages)
curl -s -u guest:guest http://localhost:15672/api/queues/%2F/jokes_queue | \
  jq '{messages: .messages, consumers: .consumers}'
# Expected: {"messages": 3, "consumers": 0}
```

### Step 4: Restart the ETL service — messages are processed immediately
```bash
docker compose start etl-service
sleep 5

# Check ETL logs
docker compose logs --tail=20 etl-service
# Expected: 3 "✅ Inserted joke" lines

# Verify queue is now empty
curl -s -u guest:guest http://localhost:15672/api/queues/%2F/jokes_queue | \
  jq .messages
# Expected: 0

# Verify jokes are in MySQL
docker exec jokes_mysql mysql -ujokeuser -pjokepassword jokesdb \
  -e "SELECT id, setup FROM jokes ORDER BY id DESC LIMIT 5;"
```

---

## 5. Verify Type Cache Fallback

This demonstrates Submit resilience when the Joke service is unavailable.

### Step 1: Prime the cache (call /types while Joke service is up)
```bash
curl http://localhost:3002/types | jq length
# Expected: 5 (or however many types exist)
```

### Step 2: Stop the Joke service
```bash
docker compose stop joke-service
```

### Step 3: Submit still returns types from cache
```bash
curl http://localhost:3002/types | jq .
# Expected: SAME array as before — served from /app/cache/types.json
# Check Submit logs for: "Joke Service unavailable – reading from cache"
docker compose logs --tail=10 submit-service
```

### Step 4: Submission still works while Joke is down
```bash
curl -X POST http://localhost:3002/submit \
  -H "Content-Type: application/json" \
  -d '{"setup":"Cache test","punchline":"Works without Joke service!","type":"general"}' | jq .
# Expected: 202 Accepted — RabbitMQ is independent of Joke service
```

### Step 5: Restart Joke service
```bash
docker compose start joke-service
```

---

## 6. Verify Resilience by Stopping Services

| Scenario | Command to stop | Expected behaviour |
|----------|----------------|--------------------|
| ETL down | `docker compose stop etl-service` | Submit still accepts jokes; messages queue in RabbitMQ |
| Joke down | `docker compose stop joke-service` | Submit returns cached types; RabbitMQ unaffected |
| RabbitMQ down | `docker compose stop rabbitmq` | Submit returns 503 on POST /submit; Joke service unaffected |
| MySQL down | `docker compose stop mysql` | Joke returns 500 on queries; ETL nacks messages (requeues) |

To restart any stopped service:
```bash
docker compose start <service-name>
```

---

## 7. Phase 2 — Azure Deployment (VM1 + VM2)

> Refer to `PHASE2.md` for the full step-by-step Azure portal setup.

### Quick deployment reference

```bash
# Deploy source files to both VMs
./infra/deploy.sh   # Fill in VM1_IP and VM2_IP at the top first

# SSH into VM1 and start services
ssh -i ~/.ssh/co3404_key azureuser@<VM1_PUBLIC_IP>
cd ~/co3404
docker compose up -d --build

# SSH into VM2 and start services
ssh -i ~/.ssh/co3404_key azureuser@<VM2_PUBLIC_IP>
cd ~/co3404
docker compose up -d --build
```

### Verify cross-VM connectivity (from VM1)
```bash
# Test that ETL can reach RabbitMQ on VM2
nc -zv 10.0.1.5 5672
# Expected: Connection succeeded

# Test that Submit can reach Joke service on VM1
# (from VM2)
curl http://10.0.1.4:3001/types | jq length
```

---

## 8. Phase 3 — Kong Gateway (Terraform)

> Refer to `PHASE3.md` for the full step-by-step guide.

### Prerequisites
- Phase 2 VMs running (VM1 at 10.0.1.4, VM2 at 10.0.1.5)
- Azure CLI logged in: `az login`
- SSH key at `~/.ssh/co3404_key`

### Deploy Kong VM
```bash
cd infra/terraform

# Configure values
cp terraform.tfvars.example terraform.tfvars
# Edit terraform.tfvars: set subscription_id and my_ip

# Deploy (creates VM3, installs Docker, uploads config, starts Kong)
terraform init
terraform plan     # preview changes
terraform apply    # ~8–12 minutes

# Note the output values
KONG_IP=$(terraform output -raw kong_public_ip)
echo "Kong IP: $KONG_IP"
```

### Trust the self-signed certificate (macOS)
```bash
# Add to System Keychain (removes browser/curl warnings)
sudo security add-trusted-cert \
  -d -r trustRoot \
  -k /Library/Keychains/System.keychain \
  infra/kong/certs/server.crt

# Restart your browser after adding.
# For curl without Keychain: use -k or --cacert infra/kong/certs/server.crt
```

---

## 9. Verify Kong Single-Origin Routing

All commands below use the Kong public HTTPS endpoint as the single entry point.

```bash
KONG_IP=$(cd infra/terraform && terraform output -raw kong_public_ip)
# Or set manually: KONG_IP=85.211.240.162

# Verify Kong is alive (response headers confirm traffic goes through Kong)
curl -sk -I https://$KONG_IP/joke/any | grep -E "kong|Kong|HTTP"
# Expected headers: Kong-Request-ID (correlation-id plugin), X-Kong-Upstream-Latency

# Joke API through Kong
curl -sk https://$KONG_IP/joke/programming | jq .
curl -sk https://$KONG_IP/joke/any | jq .
curl -sk "https://$KONG_IP/joke/dad?count=2" | jq .

# Types through Kong (submit-service proxy)
curl -sk https://$KONG_IP/types | jq .

# Submit joke through Kong → RabbitMQ → ETL → MySQL
curl -sk -X POST https://$KONG_IP/submit \
  -H "Content-Type: application/json" \
  -d '{"setup":"Why did the network engineer go crazy?","punchline":"Too many packets lost.","type":"programming"}' | jq .
# Expected: {"message":"Joke queued for processing by the ETL service",...}

# Swagger docs through Kong
open https://$KONG_IP/docs
# Expected: Swagger UI page (note: add -k to curl if cert not trusted)

# Joke frontend through Kong (access with trailing slash for static assets to load)
open https://$KONG_IP/joke-ui/

# Submit frontend through Kong (access with trailing slash)
open https://$KONG_IP/submit/
```

> **Note on frontend URLs**: Static assets (app.js) are served correctly when the page
> is accessed with a **trailing slash** (e.g., `/joke-ui/` not `/joke-ui`). This is
> standard behaviour with path-stripping reverse proxies. API endpoints (`/joke/*`,
> `/submit`, `/types`) work regardless of trailing slash.

---

## 10. Verify HTTPS / TLS

```bash
KONG_IP=$(cd infra/terraform && terraform output -raw kong_public_ip)

# Certificate details
openssl s_client -connect $KONG_IP:443 -showcerts </dev/null 2>/dev/null | \
  openssl x509 -text -noout | grep -E "Subject:|Subject Alternative Name|IP Address|Not After"
# Expected:
#   Not After: Mar  4 10:58:04 2027 GMT
#   Subject: CN=kong-gateway
#   IP Address: 85.211.240.162, IP Address: 127.0.0.1

# HTTPS works (with cert in Keychain, no -k needed)
curl --cacert infra/kong/certs/server.crt https://$KONG_IP/joke/any | jq .

# HTTP (port 80) also works for testing
curl http://$KONG_IP/joke/any | jq .
```

---

## 11. Verify Rate Limiting

The Joke API allows **5 requests per minute per IP**. After the 5th request, Kong returns **HTTP 429**.

```bash
KONG_IP=$(cd infra/terraform && terraform output -raw kong_public_ip)

echo "=== Testing Joke API rate limit (max 5/min) ==="
for i in $(seq 1 8); do
  STATUS=$(curl -sk -o /dev/null -w "%{http_code}" https://$KONG_IP/joke/any)
  echo "  Request $i → HTTP $STATUS"
  sleep 0.3
done
```

**Expected output:**
```
  Request 1 → HTTP 200
  Request 2 → HTTP 200
  Request 3 → HTTP 200
  Request 4 → HTTP 200
  Request 5 → HTTP 200
  Request 6 → HTTP 429   ← rate limit
  Request 7 → HTTP 429
  Request 8 → HTTP 429
```

```bash
# See rate limit headers
curl -sk -i https://$KONG_IP/joke/any | head -15
# When limited, response includes:
# X-RateLimit-Limit-Minute: 5
# X-RateLimit-Remaining-Minute: 0
# Retry-After: 60

# Confirm Submit has NO rate limit (8 rapid requests → all 200)
echo "=== Testing Submit API has no rate limit ==="
for i in $(seq 1 8); do
  STATUS=$(curl -sk -o /dev/null -w "%{http_code}" \
    -X POST https://$KONG_IP/submit \
    -H "Content-Type: application/json" \
    -d "{\"setup\":\"RL test $i\",\"punchline\":\"no limit\",\"type\":\"general\"}")
  echo "  Submit $i → HTTP $STATUS"
  sleep 0.1
done
# Expected: all 8 return 202
```

---

## 12. Verify Kong Swagger Docs

The Swagger UI for the Submit API is accessible through Kong:

```bash
KONG_IP=$(cd infra/terraform && terraform output -raw kong_public_ip)

# Check that /docs returns HTML (Swagger UI)
curl -sk https://$KONG_IP/docs | grep -i "swagger"
# Expected: contains "swagger" in the HTML body

# Open in browser
open https://$KONG_IP/docs
# Expected: Interactive Swagger UI with POST /submit, GET /types, GET /health
```

---

## 13. Final Submission Checklist

### What TO include in your submission zip

```
co3404-distributed-joke-system/
├── .env.example                    ✅
├── .gitignore                      ✅
├── docker-compose.yml              ✅
├── README.md                       ✅
├── PHASE2.md                       ✅
├── PHASE3.md                       ✅
├── OPTION3_VERIFICATION_GUIDE.md   ✅
├── AUDIT_REPORT.md                 ✅
├── RUN_AND_TEST.md                 ✅
├── FIX_SUMMARY.md                  ✅
├── db/
│   └── init.sql                    ✅
├── joke-service/                   ✅ (all .js, Dockerfile, package.json, public/)
├── submit-service/                 ✅ (all .js, Dockerfile, package.json, public/)
├── etl-service/                    ✅ (all .js, Dockerfile, package.json)
└── infra/
    ├── deploy.sh                   ✅
    ├── vm1-compose.yml             ✅
    ├── vm1-setup.sh                ✅
    ├── vm2-compose.yml             ✅
    ├── vm2-setup.sh                ✅
    ├── vm3-setup.sh                ✅
    ├── .env.vm1.example            ✅
    ├── .env.vm2.example            ✅
    ├── kong/
    │   ├── docker-compose.yml      ✅
    │   └── certs/.gitkeep          ✅
    └── terraform/
        ├── main.tf                 ✅
        ├── variables.tf            ✅
        ├── outputs.tf              ✅
        ├── kong.yml.tpl            ✅
        └── terraform.tfvars.example ✅
```

### What NOT to include

```
node_modules/                      ❌  (rebuild via npm install inside Docker)
.env                               ❌  (contains credentials)
infra/.env.vm1                     ❌  (contains real Azure private IPs)
infra/.env.vm2                     ❌  (contains real Azure private IPs)
infra/terraform/terraform.tfvars   ❌  (contains your subscription ID + IP)
infra/terraform/terraform.tfstate  ❌  (contains real Azure resource IDs)
infra/terraform/terraform.tfstate.backup  ❌
infra/terraform/.terraform/        ❌  (downloaded provider binaries ~100 MB)
infra/terraform/.terraform.lock.hcl  ❌
infra/kong/kong.yml                ❌  (generated by Terraform from kong.yml.tpl)
infra/kong/certs/server.crt        ❌  (generated on VM; re-generated by terraform apply)
infra/kong/certs/server.key        ❌  (TLS private key — NEVER commit)
```

### Create the submission zip
```bash
cd ..
zip -r co3404-submission.zip co3404-distributed-joke-system \
  --exclude "*/node_modules/*" \
  --exclude "*/.env" \
  --exclude "*/infra/.env.vm1" \
  --exclude "*/infra/.env.vm2" \
  --exclude "*/terraform/terraform.tfvars" \
  --exclude "*/terraform/terraform.tfstate" \
  --exclude "*/terraform/terraform.tfstate.backup" \
  --exclude "*/terraform/.terraform/*" \
  --exclude "*/terraform/.terraform.lock.hcl" \
  --exclude "*/kong/kong.yml" \
  --exclude "*/kong/certs/server.crt" \
  --exclude "*/kong/certs/server.key" \
  --exclude "*/kong/certs/server.pem" \
  --exclude "*/.DS_Store"

echo "Submission zip: $(du -sh ../co3404-submission.zip)"
```

---

*Guide generated: 7 March 2026*
