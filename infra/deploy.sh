#!/usr/bin/env bash
# =============================================================================
# infra/deploy.sh
# Copies project source files from your Mac to Azure VMs via scp.
#
# Handles VM1 (joke-vm) and VM2 (submit-vm).
# VM3 (moderate-vm) is deployed via GitHub Actions CI/CD on push to main.
# VM4 (kong-vm) is fully managed by Terraform provisioners.
#
# Usage:
#   1. Fill in VM1_IP, VM2_IP (and optionally VM3_IP) below.
#   2. chmod +x infra/deploy.sh
#   3. ./infra/deploy.sh
#
# Run from the project root directory:
#   cd /path/to/co3404-distributed-joke-system
#   ./infra/deploy.sh
# =============================================================================

set -euo pipefail

# ─── CONFIGURE THESE ────────────────────────────────────────────────────────
# Replace these with your actual VM public IPs from the Azure portal.
# To find them: az vm list-ip-addresses -g rg-co3404-jokes -o table
VM1_IP="REPLACE_WITH_VM1_PUBLIC_IP"
VM2_IP="REPLACE_WITH_VM2_PUBLIC_IP"
VM3_IP="REPLACE_WITH_VM3_PUBLIC_IP"   # moderate-vm (optional — CI/CD handles main branch)
SSH_KEY="$HOME/.ssh/co3404_key"
REMOTE_USER="azureuser"
REMOTE_DIR="~/co3404"
# ─────────────────────────────────────────────────────────────────────────────

# Guard: fail fast if IPs are still placeholders
if [[ "$VM1_IP" == "REPLACE_WITH_VM1_PUBLIC_IP" || "$VM2_IP" == "REPLACE_WITH_VM2_PUBLIC_IP" ]]; then
  echo "❌ ERROR: Please set VM1_IP and VM2_IP at the top of this script before running."
  exit 1
fi

# Resolve absolute project root (works regardless of where the script is called from)
PROJECT_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

echo "========================================"
echo " CO3404 Deploy Script"
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

echo "[VM1] Copying docker-compose and .env..."
scp $SSH_OPTS \
  "${PROJECT_ROOT}/infra/vm1-compose.yml" \
  "${REMOTE_USER}@${VM1_IP}:${REMOTE_DIR}/docker-compose.yml"

scp $SSH_OPTS \
  "${PROJECT_ROOT}/infra/.env.vm1" \
  "${REMOTE_USER}@${VM1_IP}:${REMOTE_DIR}/.env"

echo "[VM1] ✅ Files deployed."

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

# ─────────────────────────────────────────────────────────────────────────────
# VM3 — moderate-service (manual fallback; GitHub Actions CI/CD normally handles this)
# ─────────────────────────────────────────────────────────────────────────────
# The moderate-service is deployed automatically by
#   .github/workflows/deploy-moderate.yml on every push to main.
# Use this block ONLY for a first-time manual setup or if CI/CD is unavailable.
#
# Prerequisites:
#   1. Run vm3-setup.sh on VM3 first (installs Docker).
#   2. Create infra/.env.vm3 from .env.example with Auth0 + RabbitMQ credentials.
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
    echo "      Run on VM3: cd ~/moderate && docker compose pull && docker compose up -d"
  else
    echo "[VM3] WARNING: vm3-compose.yml copied but infra/.env.vm3 not found."
    echo "         Create infra/.env.vm3 from infra/.env.vm3.example and re-run, or set env vars manually."
  fi
else
  echo ""
  echo "[VM3] Skipped — VM3_IP not set. GitHub Actions CI/CD handles moderate-service deployment."
fi

# ─────────────────────────────────────────────────────────────────────────────
echo ""
echo "========================================"
echo " Deploy complete!"
echo ""
echo " VM1: ssh -i $SSH_KEY ${REMOTE_USER}@${VM1_IP} && cd ~/co3404 && docker compose up -d --build"
echo " VM2: ssh -i $SSH_KEY ${REMOTE_USER}@${VM2_IP} && cd ~/co3404 && docker compose up -d --build"
echo " VM3: deployed by GitHub Actions CI/CD on push to main (.github/workflows/deploy-moderate.yml)"
echo " VM4: managed by Terraform provisioners"
echo "========================================"
