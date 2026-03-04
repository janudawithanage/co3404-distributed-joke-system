#!/usr/bin/env bash
# =============================================================================
# infra/deploy.sh
# Copies project source files from your Mac to both Azure VMs via scp.
#
# Usage:
#   1. Fill in VM1_IP, VM2_IP, and SSH_KEY below.
#   2. chmod +x infra/deploy.sh
#   3. ./infra/deploy.sh
#
# Run from the project root directory:
#   cd /path/to/co3404-distributed-joke-system
#   ./infra/deploy.sh
# =============================================================================

set -euo pipefail

# ─── CONFIGURE THESE ────────────────────────────────────────────────────────
VM1_IP="85.211.178.130"
VM2_IP="85.211.241.251"
SSH_KEY="$HOME/.ssh/co3404_key"
REMOTE_USER="azureuser"
REMOTE_DIR="~/co3404"
# ─────────────────────────────────────────────────────────────────────────────

# Resolve absolute project root (works regardless of where the script is called from)
PROJECT_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

echo "========================================"
echo " CO3404 Deploy Script"
echo " Project root: $PROJECT_ROOT"
echo " VM1:          $VM1_IP"
echo " VM2:          $VM2_IP"
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

echo "[VM2] ✅ Files deployed."

# ─────────────────────────────────────────────────────────────────────────────
echo ""
echo "========================================"
echo " Deploy complete!"
echo ""
echo " Next steps:"
echo "   SSH VM1:  ssh -i $SSH_KEY ${REMOTE_USER}@${VM1_IP}"
echo "             cd ~/co3404 && docker compose up -d --build"
echo ""
echo "   SSH VM2:  ssh -i $SSH_KEY ${REMOTE_USER}@${VM2_IP}"
echo "             cd ~/co3404 && docker compose up -d --build"
echo "========================================"
