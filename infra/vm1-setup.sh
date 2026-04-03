#!/usr/bin/env bash
# =============================================================================
# infra/vm1-setup.sh
# Bootstrap script for VM1 (joke-vm, Ubuntu 22.04 LTS)
#
# Run once after the VM is created:
#   scp -i ~/.ssh/co3404_key infra/vm1-setup.sh azureuser@<VM1_IP>:~/
#   ssh -i ~/.ssh/co3404_key azureuser@<VM1_IP> "bash ~/vm1-setup.sh"
#
# After the script finishes, LOG OUT AND BACK IN so the docker group
# membership takes effect, then run:
#   cd ~/co3404 && docker compose up -d --build
# =============================================================================

set -euo pipefail   # exit on any error, treat unset vars as errors

echo "========================================"
echo " VM1 Bootstrap — $(date)"
echo "========================================"

# ── 1. System update ─────────────────────────────────────────────────────────
echo "[1/5] Updating system packages..."
sudo apt-get update -y
sudo apt-get upgrade -y

# ── 2. Install prerequisites ──────────────────────────────────────────────────
echo "[2/5] Installing prerequisites..."
sudo apt-get install -y \
  ca-certificates \
  curl \
  gnupg \
  lsb-release \
  git \
  netcat-openbsd \
  unzip
# netcat-openbsd provides the nc command — useful for testing TCP port connectivity

# ── 3. Install Docker Engine (official Docker repo, not Ubuntu snap) ──────────
# Using the official Docker apt repository gives us the latest stable release.
# The Ubuntu default repos ship an older, community-maintained package.
echo "[3/5] Installing Docker Engine..."

# Add Docker's GPG key
sudo install -m 0755 -d /etc/apt/keyrings
curl -fsSL https://download.docker.com/linux/ubuntu/gpg \
  | sudo gpg --dearmor -o /etc/apt/keyrings/docker.gpg
sudo chmod a+r /etc/apt/keyrings/docker.gpg

# Add Docker apt repository
echo \
  "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.gpg] \
  https://download.docker.com/linux/ubuntu \
  $(lsb_release -cs) stable" \
  | sudo tee /etc/apt/sources.list.d/docker.list > /dev/null

# Install Docker Engine + Compose plugin
sudo apt-get update -y
sudo apt-get install -y \
  docker-ce \
  docker-ce-cli \
  containerd.io \
  docker-buildx-plugin \
  docker-compose-plugin

# ── 4. Post-install: add azureuser to docker group ───────────────────────────
# This allows running docker commands without sudo.
# IMPORTANT: the group change only takes effect after logging out and back in.
echo "[4/5] Configuring Docker permissions..."
sudo usermod -aG docker azureuser

# Enable Docker to start automatically when the VM boots.
# Combined with restart: unless-stopped in compose, containers come back
# online automatically after a VM reboot.
sudo systemctl enable docker
sudo systemctl start docker

# ── 5. Verify installation ────────────────────────────────────────────────────
echo "[5/5] Verifying installation..."
docker --version
docker compose version

echo ""
echo "========================================"
echo " Bootstrap complete!"
echo " ACTION REQUIRED: Log out and SSH back"
echo " in before running docker compose."
echo "========================================"
