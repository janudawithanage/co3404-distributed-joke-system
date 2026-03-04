#!/usr/bin/env bash
# =============================================================================
# infra/vm2-setup.sh
# Bootstrap script for VM2 (submit-vm, Ubuntu 22.04 LTS)
#
# Identical to vm1-setup.sh — both VMs run Ubuntu 22.04 and need
# the same Docker installation. Kept as a separate file so each VM
# can have independent customisations later (e.g. different monitoring).
#
# Run once after the VM is created:
#   scp -i ~/.ssh/co3404_key infra/vm2-setup.sh azureuser@<VM2_IP>:~/
#   ssh -i ~/.ssh/co3404_key azureuser@<VM2_IP> "bash ~/vm2-setup.sh"
#
# After the script finishes, LOG OUT AND BACK IN, then run:
#   cd ~/co3404 && docker compose up -d --build
# =============================================================================

set -euo pipefail

echo "========================================"
echo " VM2 Bootstrap — $(date)"
echo "========================================"

echo "[1/5] Updating system packages..."
sudo apt-get update -y
sudo apt-get upgrade -y

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

echo "[3/5] Installing Docker Engine..."

sudo install -m 0755 -d /etc/apt/keyrings
curl -fsSL https://download.docker.com/linux/ubuntu/gpg \
  | sudo gpg --dearmor -o /etc/apt/keyrings/docker.gpg
sudo chmod a+r /etc/apt/keyrings/docker.gpg

echo \
  "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.gpg] \
  https://download.docker.com/linux/ubuntu \
  $(lsb_release -cs) stable" \
  | sudo tee /etc/apt/sources.list.d/docker.list > /dev/null

sudo apt-get update -y
sudo apt-get install -y \
  docker-ce \
  docker-ce-cli \
  containerd.io \
  docker-buildx-plugin \
  docker-compose-plugin

echo "[4/5] Configuring Docker permissions..."
sudo usermod -aG docker azureuser
sudo systemctl enable docker
sudo systemctl start docker

echo "[5/5] Verifying installation..."
docker --version
docker compose version

echo ""
echo "========================================"
echo " Bootstrap complete!"
echo " ACTION REQUIRED: Log out and SSH back"
echo " in before running docker compose."
echo "========================================"
