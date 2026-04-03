#!/usr/bin/env bash
# =============================================================================
# infra/deploy.sh
# Manual deployment script for VM1 (joke-vm), VM2 (submit-vm),
# VM3 (moderate-vm, fallback only), and VM4 (kong-vm).
#
# NORMAL WORKFLOW — CI/CD handles this automatically:
#   joke-service   → .github/workflows/deploy-joke.yml   (pushes to Docker Hub,
#                    SSHs to VM1, force-recreates the container)
#   submit-service → .github/workflows/deploy-submit.yml (same for VM2)
#   moderate-service → .github/workflows/deploy-moderate.yml (same for VM3)
#
# USE THIS SCRIPT for:
#   - First-time VM setup (CI/CD secrets not yet configured)
#   - Deploying etl-service updates (no CI/CD for ETL)
#   - Pushing a new infra/kong/kong.yml to VM4
#   - Emergency re-deploy without waiting for GitHub Actions
#
# Usage:
#   1. Fill in VM1_IP, VM2_IP (and optionally VM3_IP, KONG4_IP) below.
#   2. chmod +x infra/deploy.sh
#   3. ./infra/deploy.sh
#
# Run from the project root directory:
#   cd /path/to/co3404-distributed-joke-system
#   ./infra/deploy.sh
#
# What this script does on each VM:
#   1. Copies source files via scp (needed for etl-service which builds locally)
#   2. Pulls latest Docker Hub images for joke-service / submit-service
#   3. Runs: docker compose down --remove-orphans
#   4. Runs: docker compose up -d --build   (--build rebuilds ETL; image:
#      services use the freshly-pulled Docker Hub image)
# =============================================================================

set -euo pipefail

# ─── CONFIGURE THESE ────────────────────────────────────────────────────────
# Replace these with your actual VM public IPs from the Azure portal.
# To find them: az vm list-ip-addresses -g rg-co3404-jokes -o table
VM1_IP="REPLACE_WITH_VM1_PUBLIC_IP"
VM2_IP="REPLACE_WITH_VM2_PUBLIC_IP"
VM3_IP="REPLACE_WITH_VM3_PUBLIC_IP"   # moderate-vm (optional — CI/CD handles main branch)
KONG4_IP="REPLACE_WITH_KONG4_PUBLIC_IP"  # Kong VM — set to reload Kong config (fixes BUG-H7)
SSH_KEY="$HOME/.ssh/co3404_key"
REMOTE_USER="azureuser"
REMOTE_DIR="~/co3404"

# Resolve absolute project root (works regardless of where the script is called from)
# MUST come before the guards below, which use ${PROJECT_ROOT} to check for .env files.
PROJECT_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

# ─────────────────────────────────────────────────────────────────────────────

# Guard: fail fast if IPs are still placeholders
if [[ "$VM1_IP" == "REPLACE_WITH_VM1_PUBLIC_IP" || "$VM2_IP" == "REPLACE_WITH_VM2_PUBLIC_IP" ]]; then
  echo "❌ ERROR: Please set VM1_IP and VM2_IP at the top of this script before running."
  exit 1
fi

# Guard: .env files must exist before we attempt to scp them to the VMs.
# Without these files the scp command would fail with a cryptic 'No such file'
# error that set -euo pipefail turns into a silent abort mid-deploy.
if [[ ! -f "${PROJECT_ROOT}/infra/.env.vm1" ]]; then
  echo "❌ ERROR: infra/.env.vm1 not found."
  echo "   Copy infra/.env.vm1.example → infra/.env.vm1 and fill in all REPLACE_WITH_* values."
  exit 1
fi
if [[ ! -f "${PROJECT_ROOT}/infra/.env.vm2" ]]; then
  echo "❌ ERROR: infra/.env.vm2 not found."
  echo "   Copy infra/.env.vm2.example → infra/.env.vm2 and fill in all REPLACE_WITH_* values."
  exit 1
fi

echo "========================================"
echo " Distributed Joke System — Deploy Script"
echo " Project root: $PROJECT_ROOT"
echo " VM1: $VM1_IP  (joke-vm: joke-service + etl-service + MySQL)"
echo " VM2: $VM2_IP  (submit-vm: submit-service + RabbitMQ)"
echo " VM3: $VM3_IP  (moderate-vm: moderate-service — CI/CD handles this)"
echo "========================================"

# ── Helper: ssh command with consistent options ───────────────────────────────
SSH_OPTS="-i $SSH_KEY -o StrictHostKeyChecking=accept-new"

ssh_vm() {
  local ip="$1"
  shift
  ssh $SSH_OPTS "${REMOTE_USER}@${ip}" "$@"
}

scp_to() {
  local ip="$1"
  shift
  scp -r $SSH_OPTS "$@" "${REMOTE_USER}@${ip}:${REMOTE_DIR}/"
}

# ── Helper: poll a remote service's /health endpoint ─────────────────────────
# Usage: health_check_remote LABEL IP PORT [MAX_ATTEMPTS]
# MAX_ATTEMPTS × 5 s = total wait time (default 6 × 5 s = 30 s)
health_check_remote() {
  local label="$1" ip="$2" port="$3" max="${4:-6}"
  echo "[${label}] Waiting for http://localhost:${port}/health…"
  local STATUS
  for i in $(seq 1 "$max"); do
    STATUS=$(ssh $SSH_OPTS "${REMOTE_USER}@${ip}" \
      "curl -s -o /dev/null -w '%{http_code}' http://localhost:${port}/health 2>/dev/null || echo 000" 2>/dev/null)
    echo "[${label}]   Attempt ${i}/${max}: HTTP ${STATUS}"
    if [[ "$STATUS" == "200" ]]; then
      echo "[${label}] ✅ Port ${port} is healthy."
      return 0
    fi
    sleep 5
  done
  echo "[${label}] ❌ Port ${port} did not return 200 after $((max * 5)) s — check container logs."
  return 1
}

# ── Warn if PUBLIC_GATEWAY_BASE placeholders were not filled in ───────────────
if grep -q 'PUBLIC_GATEWAY_BASE=https://REPLACE_WITH_KONG_PUBLIC_IP' \
     "${PROJECT_ROOT}/infra/.env.vm1" 2>/dev/null; then
  echo "⚠️  WARNING: PUBLIC_GATEWAY_BASE in infra/.env.vm1 is still a placeholder."
  echo "   The joke-service SYSTEM STATUS card will show 'Checking…' until this is set."
  echo "   Get the value: terraform -chdir=infra/terraform output -raw kong_public_ip"
fi
if grep -q 'PUBLIC_GATEWAY_BASE=https://REPLACE_WITH_KONG_PUBLIC_IP' \
     "${PROJECT_ROOT}/infra/.env.vm2" 2>/dev/null; then
  echo "⚠️  WARNING: PUBLIC_GATEWAY_BASE in infra/.env.vm2 is still a placeholder."
  echo "   Swagger 'Try it out' will fail with connection refused until this is set."
fi

# ─────────────────────────────────────────────────────────────────────────────
# VM1 — joke-service, etl-service, mysql init, vm1-compose.yml, .env.vm1
# ─────────────────────────────────────────────────────────────────────────────
echo ""
echo "[VM1] Creating remote directory..."
ssh_vm "$VM1_IP" "mkdir -p ${REMOTE_DIR}"

echo "[VM1] Copying service source files..."
scp_to "$VM1_IP" \
  "${PROJECT_ROOT}/joke-service" \
  "${PROJECT_ROOT}/etl-service" \
  "${PROJECT_ROOT}/db"

# Copy the DB index migration script so it is available on VM1
scp $SSH_OPTS \
  "${PROJECT_ROOT}/infra/scripts/fix-db-index.sh" \
  "${REMOTE_USER}@${VM1_IP}:${REMOTE_DIR}/fix-db-index.sh"

echo "[VM1] Copying docker-compose and .env..."
scp $SSH_OPTS \
  "${PROJECT_ROOT}/infra/vm1-compose.yml" \
  "${REMOTE_USER}@${VM1_IP}:${REMOTE_DIR}/docker-compose.yml"

scp $SSH_OPTS \
  "${PROJECT_ROOT}/infra/.env.vm1" \
  "${REMOTE_USER}@${VM1_IP}:${REMOTE_DIR}/.env"

echo "[VM1] ✅ Files deployed."

# Purge any node_modules that may have been copied from the dev machine.
# The Dockerfiles run npm install --production inside the image; we don't want
# dev-machine node_modules (wrong arch / dev-deps) overwriting that install.
echo "[VM1] Cleaning remote node_modules before build…"
ssh_vm "$VM1_IP" "find ${REMOTE_DIR}/joke-service ${REMOTE_DIR}/etl-service -maxdepth 3 -type d -name node_modules | xargs rm -rf 2>/dev/null; true"

# Pull joke-service image from Docker Hub BEFORE taking the service down.
# This ensures the new image is cached locally when 'up' runs, minimising
# downtime. etl-service uses build: so its image is (re-)built by 'up --build'.
echo "[VM1] Pulling joke-service image from Docker Hub…"
ssh_vm "$VM1_IP" "cd ${REMOTE_DIR} && docker compose pull joke-service"

# Full rebuild on VM1 — ensures no stale cached image remains
echo "[VM1] Rebuilding containers (down → up --build)…"
ssh_vm "$VM1_IP" "cd ${REMOTE_DIR} && docker compose down --remove-orphans && docker compose up -d --build"
echo "[VM1] ✅ Services restarted."

# Run DB index migration AFTER MySQL is running.
# Idempotent: if the index is already correct (prefix=255) this is a no-op.
# Required on Azure when a data volume already exists with the old (500,500) index.
echo "[VM1] Running DB index migration (idempotent — safe on fresh and existing volumes)…"
ssh_vm "$VM1_IP" "
  chmod +x ${REMOTE_DIR}/fix-db-index.sh
  # Wait up to 30 s for MySQL to accept connections before migrating
  for i in \$(seq 1 6); do
    if docker exec jokes_mysql mysqladmin ping -u root -p\"\${DB_ROOT_PASSWORD:-rootpassword}\" --silent 2>/dev/null; then
      break
    fi
    echo '  MySQL not ready yet — waiting 5 s…'
    sleep 5
  done
  bash ${REMOTE_DIR}/fix-db-index.sh
"

# Health checks — verifies services are serving before declaring success
health_check_remote "VM1/joke-service"  "$VM1_IP" 3000
health_check_remote "VM1/etl-service"   "$VM1_IP" 3001

# ─────────────────────────────────────────────────────────────────────────────
# VM2 — submit-service, vm2-compose.yml, .env.vm2
# ─────────────────────────────────────────────────────────────────────────────
echo ""
echo "[VM2] Creating remote directory..."
ssh_vm "$VM2_IP" "mkdir -p ${REMOTE_DIR}"

echo "[VM2] Copying service source files..."
scp_to "$VM2_IP" \
  "${PROJECT_ROOT}/submit-service"

echo "[VM2] Copying docker-compose and .env..."
scp $SSH_OPTS \
  "${PROJECT_ROOT}/infra/vm2-compose.yml" \
  "${REMOTE_USER}@${VM2_IP}:${REMOTE_DIR}/docker-compose.yml"

scp $SSH_OPTS \
  "${PROJECT_ROOT}/infra/.env.vm2" \
  "${REMOTE_USER}@${VM2_IP}:${REMOTE_DIR}/.env"

echo "[VM2] Files deployed."

# Purge any node_modules copied from the dev machine
echo "[VM2] Cleaning remote node_modules before build…"
ssh_vm "$VM2_IP" "find ${REMOTE_DIR}/submit-service -maxdepth 3 -type d -name node_modules | xargs rm -rf 2>/dev/null; true"

# Pull submit-service image from Docker Hub BEFORE taking the service down.
echo "[VM2] Pulling submit-service image from Docker Hub…"
ssh_vm "$VM2_IP" "cd ${REMOTE_DIR} && docker compose pull submit-service"

# Full rebuild on VM2 — ensures new PUBLIC_GATEWAY_BASE reaches Swagger
echo "[VM2] Rebuilding containers (down → up --build)…"
ssh_vm "$VM2_IP" "cd ${REMOTE_DIR} && docker compose down --remove-orphans && docker compose up -d --build"
echo "[VM2] ✅ Services restarted."

health_check_remote "VM2/submit-service" "$VM2_IP" 3200

# ─────────────────────────────────────────────────────────────────────────────
# VM3 — moderate-service (manual fallback; GitHub Actions CI/CD normally handles this)
# ─────────────────────────────────────────────────────────────────────────────
# The moderate-service is deployed automatically by
#   .github/workflows/deploy-moderate.yml on every push to main.
# Use this block ONLY for a first-time manual setup or if CI/CD is unavailable.
#
# Prerequisites:
#   1. Run vm3-setup.sh on VM3 first (installs Docker).
#   2. Create infra/.env.vm3 from .env.vm3.example with Auth0 + RabbitMQ credentials.
#      → Fill in AUTH0_SECRET, AUTH0_BASE_URL, AUTH0_CLIENT_ID, AUTH0_CLIENT_SECRET,
#        AUTH0_ISSUER_BASE_URL to enable Auth0 (BUG-H6 fix).
#      → Leave AUTH0_* as REPLACE_WITH_* to run in unauthenticated demo mode.
# ─────────────────────────────────────────────────────────────────────────────
if [[ "$VM3_IP" != "REPLACE_WITH_VM3_PUBLIC_IP" ]]; then
  echo ""
  echo "[VM3] Creating remote directory..."
  ssh_vm "$VM3_IP" "mkdir -p /home/azureuser/moderate"

  echo "[VM3] Copying docker-compose..."
  scp $SSH_OPTS \
    "${PROJECT_ROOT}/infra/vm3-compose.yml" \
    "${REMOTE_USER}@${VM3_IP}:/home/azureuser/moderate/docker-compose.yml"

  if [[ -f "${PROJECT_ROOT}/infra/.env.vm3" ]]; then
    scp $SSH_OPTS \
      "${PROJECT_ROOT}/infra/.env.vm3" \
      "${REMOTE_USER}@${VM3_IP}:/home/azureuser/moderate/.env"
    echo "[VM3] Files deployed."
    echo "[VM3] Rebuilding moderate-service…"
    ssh_vm "$VM3_IP" "cd /home/azureuser/moderate && docker compose down --remove-orphans && docker compose pull && docker compose up -d"
    echo "[VM3] ✅ moderate-service restarted."
  else
    echo "[VM3] WARNING: vm3-compose.yml copied but infra/.env.vm3 not found."
    echo "         Create infra/.env.vm3 from infra/.env.vm3.example and re-run,"
    echo "         or set env vars manually on VM3."
  fi
else
  echo ""
  echo "[VM3] Skipped — VM3_IP not set. GitHub Actions CI/CD handles moderate-service deployment."
fi

# ─────────────────────────────────────────────────────────────────────────────
# KONG VM4 — Reload Kong config to apply security fixes (ip-restriction, /health, /config.js routes)
#
# The Kong container on VM4 uses a declarative config file (kong.yml) that
# is mounted into the container.  After scp-ing the new kong.yml the container
# must be restarted (or kong reload called) to pick up changes.
#
# This is the CRITICAL fix for:
#   BUG-H7 — /mq-admin publicly accessible (ip-restriction not applied)
#   BUG-L1 — /health route missing (System Status stuck on "Checking…")
#   BUG-L2 — /config.js route missing (Joke Types stat card shows "—")
# ─────────────────────────────────────────────────────────────────────────────
if [[ "$KONG4_IP" != "REPLACE_WITH_KONG4_PUBLIC_IP" ]]; then
  KONG_DIR="/home/azureuser/kong"
  echo ""
  echo "[Kong VM4] Copying Kong config, compose, and certs…"
  ssh_vm "$KONG4_IP" "mkdir -p ${KONG_DIR}"

  # Always copy the declarative config (the file that contains routes/plugins)
  scp $SSH_OPTS \
    "${PROJECT_ROOT}/infra/kong/kong.yml" \
    "${REMOTE_USER}@${KONG4_IP}:${KONG_DIR}/kong.yml"

  # Copy docker-compose.yml so VM4 can start Kong even on a fresh machine
  scp $SSH_OPTS \
    "${PROJECT_ROOT}/infra/kong/docker-compose.yml" \
    "${REMOTE_USER}@${KONG4_IP}:${KONG_DIR}/docker-compose.yml"

  # Copy TLS certificates if the certs directory contains files.
  # The certs/ directory holds a self-signed cert+key generated by Terraform
  # (or manually via vm4-setup). If empty on the dev machine, skip silently —
  # VM4 may already have certs from a previous Terraform provisioning run.
  if [[ -n "$(ls -A "${PROJECT_ROOT}/infra/kong/certs/" 2>/dev/null)" ]]; then
    echo "[Kong VM4] Copying TLS certs…"
    scp -r $SSH_OPTS \
      "${PROJECT_ROOT}/infra/kong/certs" \
      "${REMOTE_USER}@${KONG4_IP}:${KONG_DIR}/"
  else
    echo "[Kong VM4] certs/ directory is empty — skipping cert copy (VM4 keeps existing certs)."
  fi

  echo "[Kong VM4] Reloading Kong (docker compose restart)…"
  ssh_vm "$KONG4_IP" "cd ${KONG_DIR} && docker compose down && docker compose up -d"
  echo "[Kong VM4] ✅ Kong restarted with new config."
  echo "[Kong VM4]    ip-restriction on /mq-admin is now active (BUG-H7 fixed)."
  echo "[Kong VM4]    /health and /config.js routes are now live (BUG-L1, BUG-L2 fixed)."
else
  echo ""
  echo "[Kong VM4] Skipped — KONG4_IP not set."
  echo "           To apply Kong config fixes manually on VM4:"
  echo "             1. scp infra/kong/kong.yml azureuser@<KONG_IP>:~/kong/kong.yml"
  echo "             2. ssh azureuser@<KONG_IP> 'cd ~/kong && docker compose down && docker compose up -d'"
fi

# ─────────────────────────────────────────────────────────────────────────────
echo ""
echo "========================================"
echo " Deploy complete!"
echo ""
echo " VM1 ($VM1_IP): joke-service + etl-service rebuilt and running"
echo " VM2 ($VM2_IP): submit-service rebuilt and running (Swagger server fixed)"
if [[ "$VM3_IP" != "REPLACE_WITH_VM3_PUBLIC_IP" ]]; then
  echo " VM3 ($VM3_IP): moderate-service restarted"
else
  echo " VM3: deployed by GitHub Actions CI/CD on push to main"
fi
if [[ "$KONG4_IP" != "REPLACE_WITH_KONG4_PUBLIC_IP" ]]; then
  echo " VM4 ($KONG4_IP): Kong reloaded — /health, /config.js routes active, /mq-admin restricted"
else
  echo " VM4 (Kong): NOT updated — set KONG4_IP in this script to apply Kong config fixes"
  echo "             Manual steps:  scp infra/kong/kong.yml azureuser@<KONG_IP>:~/kong/kong.yml"
  echo "                            ssh azureuser@<KONG_IP> 'cd ~/kong && docker compose down && docker compose up -d'"
fi
echo "========================================"
