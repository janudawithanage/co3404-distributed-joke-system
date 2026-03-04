# =============================================================================
# infra/terraform/main.tf
#
# Phase 3 — Kong API Gateway on Azure
#
# Creates VM3 (vm-kong) in the existing Phase 2 VNet and deploys Kong Gateway
# in DB-less mode with:
#   - Rate limiting on the Joke API (5 req/min)
#   - HTTPS with a self-signed TLS certificate (IP SAN)
#   - Declarative routing: /joke/* → VM1:3001, /submit/* → VM2:3002
#
# Prerequisites:
#   1. Phase 2 is running (rg-co3404-jokes, vnet-jokes, VM1, VM2)
#   2. Azure CLI logged in:   az login
#   3. Terraform installed:   brew install terraform
#   4. SSH key exists:        ~/.ssh/co3404_key + ~/.ssh/co3404_key.pub
#
# Usage:
#   cd infra/terraform
#   cp terraform.tfvars.example terraform.tfvars
#   # Edit terraform.tfvars — set subscription_id and my_ip
#   terraform init
#   terraform apply
# =============================================================================

terraform {
  required_version = ">= 1.5"
  required_providers {
    azurerm = {
      source  = "hashicorp/azurerm"
      version = "~> 4.0"
    }
    local = {
      source  = "hashicorp/local"
      version = "~> 2.0"
    }
    null = {
      source  = "hashicorp/null"
      version = "~> 3.0"
    }
  }
}

provider "azurerm" {
  features         {}
  subscription_id  = var.subscription_id
}

# =============================================================================
# Data sources — reference existing Phase 2 infrastructure
# =============================================================================

data "azurerm_resource_group" "rg" {
  name = var.resource_group_name
}

data "azurerm_subnet" "subnet" {
  name                 = var.subnet_name
  virtual_network_name = var.vnet_name
  resource_group_name  = var.resource_group_name
}

# =============================================================================
# Locals — render Kong declarative config from template
# =============================================================================

locals {
  kong_config = templatefile("${path.module}/kong.yml.tpl", {
    vm1_private_ip        = var.vm1_private_ip
    vm2_private_ip        = var.vm2_private_ip
    rate_limit_per_minute = var.rate_limit_per_minute
  })
}

# Write rendered kong.yml to disk so the file provisioner can upload it
resource "local_file" "kong_config" {
  content         = local.kong_config
  filename        = "${path.module}/../kong/kong.yml"
  file_permission = "0644"
}

# =============================================================================
# NSG — Kong VM (HTTPS + SSH only)
# =============================================================================

resource "azurerm_network_security_group" "nsg_kong" {
  name                = "nsg-kong"
  location            = data.azurerm_resource_group.rg.location
  resource_group_name = data.azurerm_resource_group.rg.name

  # SSH — locked to your IP only (prevents brute-force attacks)
  security_rule {
    name                       = "Allow-SSH"
    priority                   = 100
    direction                  = "Inbound"
    access                     = "Allow"
    protocol                   = "Tcp"
    source_port_range          = "*"
    destination_port_range     = "22"
    source_address_prefix      = var.my_ip
    destination_address_prefix = "*"
  }

  # HTTPS — public access for API gateway traffic
  security_rule {
    name                       = "Allow-HTTPS"
    priority                   = 200
    direction                  = "Inbound"
    access                     = "Allow"
    protocol                   = "Tcp"
    source_port_range          = "*"
    destination_port_range     = "443"
    source_address_prefix      = "*"
    destination_address_prefix = "*"
  }

  # HTTP — for plain-text testing (rate-limit demo with curl -k)
  security_rule {
    name                       = "Allow-HTTP"
    priority                   = 300
    direction                  = "Inbound"
    access                     = "Allow"
    protocol                   = "Tcp"
    source_port_range          = "*"
    destination_port_range     = "80"
    source_address_prefix      = "*"
    destination_address_prefix = "*"
  }

  # Deny all other inbound — defence-in-depth
  security_rule {
    name                       = "Deny-All"
    priority                   = 4096
    direction                  = "Inbound"
    access                     = "Deny"
    protocol                   = "*"
    source_port_range          = "*"
    destination_port_range     = "*"
    source_address_prefix      = "*"
    destination_address_prefix = "*"
  }
}

# =============================================================================
# Public IP — Static allocation required so the TLS cert SAN stays valid
# =============================================================================

resource "azurerm_public_ip" "pip_kong" {
  name                = "pip-kong"
  location            = data.azurerm_resource_group.rg.location
  resource_group_name = data.azurerm_resource_group.rg.name
  allocation_method   = "Static"
  sku                 = "Standard"
}

# =============================================================================
# Network Interface
# =============================================================================

resource "azurerm_network_interface" "nic_kong" {
  name                = "nic-kong"
  location            = data.azurerm_resource_group.rg.location
  resource_group_name = data.azurerm_resource_group.rg.name

  ip_configuration {
    name                          = "ipconfig-kong"
    subnet_id                     = data.azurerm_subnet.subnet.id
    private_ip_address_allocation = "Dynamic"
    public_ip_address_id          = azurerm_public_ip.pip_kong.id
  }
}

resource "azurerm_network_interface_security_group_association" "nic_nsg_kong" {
  network_interface_id      = azurerm_network_interface.nic_kong.id
  network_security_group_id = azurerm_network_security_group.nsg_kong.id
}

# =============================================================================
# VM3 — Kong Gateway (Ubuntu 22.04 LTS)
# =============================================================================

resource "azurerm_linux_virtual_machine" "vm_kong" {
  name                = "vm-kong"
  resource_group_name = data.azurerm_resource_group.rg.name
  location            = data.azurerm_resource_group.rg.location
  size                = var.vm_size
  admin_username      = "azureuser"

  network_interface_ids = [
    azurerm_network_interface.nic_kong.id
  ]

  admin_ssh_key {
    username   = "azureuser"
    public_key = file(pathexpand(var.ssh_public_key_path))
  }

  os_disk {
    caching              = "ReadWrite"
    storage_account_type = "StandardSSD_LRS"
    disk_size_gb         = 30
  }

  # Ubuntu 22.04 LTS Gen2 — matches the image used for VM1/VM2 in Phase 2
  source_image_reference {
    publisher = "Canonical"
    offer     = "0001-com-ubuntu-server-jammy"
    sku       = "22_04-lts-gen2"
    version   = "latest"
  }

  depends_on = [
    azurerm_network_interface_security_group_association.nic_nsg_kong
  ]
}

# =============================================================================
# Provisioner Step 1: Install Docker on VM3
# Separate null_resource so re-runs on config change don't reinstall Docker.
# =============================================================================

resource "null_resource" "install_docker" {
  depends_on = [azurerm_linux_virtual_machine.vm_kong]

  # Trigger re-run only when the VM is replaced
  triggers = {
    vm_id = azurerm_linux_virtual_machine.vm_kong.id
  }

  connection {
    type        = "ssh"
    host        = azurerm_public_ip.pip_kong.ip_address
    user        = "azureuser"
    private_key = file(pathexpand(var.ssh_private_key_path))
    timeout     = "10m"
  }

  provisioner "remote-exec" {
    inline = [
      # Cloud-init may still be running; wait for it to settle
      "echo 'Waiting for VM to finish booting...' && sleep 30",
      "sudo apt-get update -qq",
      "sudo apt-get install -y -qq ca-certificates curl gnupg",
      "sudo install -m 0755 -d /etc/apt/keyrings",
      "curl -fsSL https://download.docker.com/linux/ubuntu/gpg | sudo gpg --dearmor -o /etc/apt/keyrings/docker.gpg",
      "sudo chmod a+r /etc/apt/keyrings/docker.gpg",
      "echo \"deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.gpg] https://download.docker.com/linux/ubuntu $(. /etc/os-release && echo $VERSION_CODENAME) stable\" | sudo tee /etc/apt/sources.list.d/docker.list > /dev/null",
      "sudo apt-get update -qq",
      "sudo apt-get install -y -qq docker-ce docker-ce-cli containerd.io docker-compose-plugin",
      "sudo usermod -aG docker azureuser",
      "sudo systemctl enable docker",
      "sudo systemctl start docker",
      # Create directory structure for Kong
      "mkdir -p /home/azureuser/kong/certs",
      "echo 'Docker installed ✅'"
    ]
  }
}

# =============================================================================
# Provisioner Step 2: Upload Kong config files
# Re-runs whenever docker-compose.yml or kong.yml content changes.
# =============================================================================

resource "null_resource" "upload_kong_files" {
  depends_on = [null_resource.install_docker, local_file.kong_config]

  # Trigger re-upload if either config file changes
  triggers = {
    kong_config_md5 = local_file.kong_config.content_md5
    compose_md5     = filemd5("${path.module}/../kong/docker-compose.yml")
  }

  connection {
    type        = "ssh"
    host        = azurerm_public_ip.pip_kong.ip_address
    user        = "azureuser"
    private_key = file(pathexpand(var.ssh_private_key_path))
    timeout     = "5m"
  }

  provisioner "file" {
    source      = "${path.module}/../kong/docker-compose.yml"
    destination = "/home/azureuser/kong/docker-compose.yml"
  }

  provisioner "file" {
    source      = local_file.kong_config.filename
    destination = "/home/azureuser/kong/kong.yml"
  }
}

# =============================================================================
# Provisioner Step 3: Generate TLS cert + deploy Kong
# TLS cert is generated ON the VM so the public IP is baked into the SAN.
# The cert is then downloaded locally for Keychain installation.
# =============================================================================

resource "null_resource" "deploy_kong" {
  depends_on = [null_resource.upload_kong_files]

  triggers = {
    upload_id = null_resource.upload_kong_files.id
    vm_id     = azurerm_linux_virtual_machine.vm_kong.id
  }

  connection {
    type        = "ssh"
    host        = azurerm_public_ip.pip_kong.ip_address
    user        = "azureuser"
    private_key = file(pathexpand(var.ssh_private_key_path))
    timeout     = "10m"
  }

  # Generate self-signed TLS cert with an IP Subject Alternative Name.
  # The SAN (subjectAltName) is what modern browsers and curl use to
  # validate the certificate — CN alone is no longer sufficient.
  provisioner "remote-exec" {
    inline = [
      "openssl req -x509 -newkey rsa:4096 -sha256 -days 365 -nodes -keyout /home/azureuser/kong/certs/server.key -out /home/azureuser/kong/certs/server.crt -subj '/CN=co3404-kong' -addext 'subjectAltName=IP:${azurerm_public_ip.pip_kong.ip_address},IP:127.0.0.1'",
      "chmod 600 /home/azureuser/kong/certs/server.key",
      "echo 'TLS certificate generated for IP ${azurerm_public_ip.pip_kong.ip_address} ✅'"
    ]
  }

  # Start Kong Gateway
  provisioner "remote-exec" {
    inline = [
      "cd /home/azureuser/kong",
      "sudo docker compose pull",
      "sudo docker compose up -d",
      "echo 'Waiting for Kong to become healthy...'",
      "sleep 20",
      "sudo docker compose ps",
      "echo 'Kong Gateway is running ✅'"
    ]
  }

  # Download the TLS certificate to the local Mac so it can be added
  # to the System Keychain (removes browser HTTPS warnings for this session)
  provisioner "local-exec" {
    command = <<-EOT
      mkdir -p ${path.module}/../kong/certs
      scp -i ${pathexpand(var.ssh_private_key_path)} \
          -o StrictHostKeyChecking=no \
          -o UserKnownHostsFile=/dev/null \
          azureuser@${azurerm_public_ip.pip_kong.ip_address}:/home/azureuser/kong/certs/server.crt \
          ${path.module}/../kong/certs/server.crt
      echo ""
      echo "======================================================="
      echo " Certificate saved → infra/kong/certs/server.crt"
      echo " To trust it on this Mac, run:"
      echo "   sudo security add-trusted-cert -d -r trustRoot \\"
      echo "     -k /Library/Keychains/System.keychain \\"
      echo "     ${path.module}/../kong/certs/server.crt"
      echo " Then restart your browser."
      echo "======================================================="
    EOT
  }
}
