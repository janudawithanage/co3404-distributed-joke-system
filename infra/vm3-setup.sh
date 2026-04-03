#!/usr/bin/env bash
# =============================================================================
# infra/vm3-setup.sh
# Bootstrap Docker on VM3 (moderate-vm, Ubuntu 22.04 LTS)
#
# ALTERNATIVE to Terraform provisioners — use this for manual setup or
# if you need to re-install Docker without re-running `terraform apply`.
#
# Usage (from your Mac):
#   scp -i ~/.ssh/co3404_key infra/vm3-setup.sh azureuser@<VM3_PUBLIC_IP>:/tmp/
#   ssh -i ~/.ssh/co3404_key azureuser@<VM3_PUBLIC_IP> "chmod +x /tmp/vm3-setup.sh && sudo /tmp/vm3-setup.sh"
# =============================================================================

set -euo pipefail

echo "========================================"
echo " VM3 (Moderate) Bootstrap — $(date)"
echo "========================================"

# ── 1. System update ──────────────────────────────────────────────────────────
echo "[1/4] Updating system packages..."
sudo apt-get update -y -qq
sudo apt-get upgrade -y -qq

# ── 2. Install prerequisites ──────────────────────────────────────────────────
echo "[2/4] Installing prerequisites..."
sudo apt-get install -y -qq \
  ca-certificates \
  curl \
  gnupg \
  lsb-release \
  openssl

# ── 3. Install Docker Engine (official Docker repo) ───────────────────────────
echo "[3/4] Installing Docker Engine..."
sudo install -m 0755 -d /etc/apt/keyrings
curl -fsSL https://download.docker.com/linux/ubuntu/gpg \
  | sudo gpg --dearmor -o /etc/apt/keyrings/docker.gpg
sudo chmod a+r /etc/apt/keyrings/docker.gpg

echo \
  "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.gpg] \
  https://download.docker.com/linux/ubuntu \
  $(. /etc/os-release && echo "$VERSION_CODENAME") stable" \
  | sudo tee /etc/apt/sources.list.d/docker.list > /dev/null

sudo apt-get update -qq
sudo apt-get install -y -qq \
  docker-ce \
  docker-ce-cli \
  containerd.io \
  docker-compose-plugin

# ── 4. Configure Docker ───────────────────────────────────────────────────────
echo "[4/4] Configuring Docker..."
sudo usermod -aG docker azureuser
sudo systemctl enable docker
sudo systemctl start docker

# Create moderate-service working directory
mkdir -p /home/azureuser/moderate

echo ""
echo "========================================"
echo " Bootstrap complete!"
echo " Docker version: $(sudo docker --version)"
echo " Docker Compose: $(sudo docker compose version)"
echo ""
echo " Next steps:"
echo "   1. Upload compose file:  scp infra/vm3-compose.yml azureuser@<VM3_IP>:~/moderate/docker-compose.yml"
echo "   2. Upload .env file:     scp infra/.env.vm3   azureuser@<VM3_IP>:~/moderate/.env"
echo "   3. Start service:        ssh azureuser@<VM3_IP> 'cd ~/moderate && docker compose up -d'"
echo "========================================"
