# =============================================================================
# infra/terraform/variables.tf
# Input variables for the Kong API Gateway deployment (Phase 3)
# =============================================================================

# ── Azure identity ────────────────────────────────────────────────────────────

variable "subscription_id" {
  description = "Azure subscription ID (run: az account show --query id -o tsv)"
  type        = string
}

# ── Existing Phase 2 resources ────────────────────────────────────────────────

variable "resource_group_name" {
  description = "Resource group created in Phase 2"
  type        = string
  default     = "rg-co3404-jokes"
}

variable "location" {
  description = "Azure region — must be university-allowed (malaysiawest confirmed working)"
  type        = string
  default     = "malaysiawest"
}

variable "vnet_name" {
  description = "Virtual network created in Phase 2"
  type        = string
  default     = "vnet-jokes"
}

variable "subnet_name" {
  description = "Subnet created in Phase 2"
  type        = string
  default     = "snet-jokes"
}

# ── VM sizing ─────────────────────────────────────────────────────────────────

variable "vm_size" {
  description = <<-EOT
    Azure VM size for Kong. Standard_B2ls_v2 (2 vCPU, 4 GiB) confirmed
    available in malaysiawest. Kong requires at minimum 1 GiB RAM.
    Cheaper alternative: Standard_B2ts_v2 (1 GiB) — tight but works for demo.
  EOT
  type    = string
  default = "Standard_B2ls_v2"
}

# ── SSH access ────────────────────────────────────────────────────────────────

variable "ssh_public_key_path" {
  description = "Path to SSH public key file — used to authorise login to VM3"
  type        = string
  default     = "~/.ssh/co3404_key.pub"
}

variable "ssh_private_key_path" {
  description = "Path to SSH private key — used by Terraform provisioners to connect to VM3"
  type        = string
  default     = "~/.ssh/co3404_key"
}

# ── Security ─────────────────────────────────────────────────────────────────

variable "my_ip" {
  description = <<-EOT
    Your public IPv4 address — restricts SSH access to Kong VM to only your IP.
    Find it with: curl -4 -s ifconfig.me
  EOT
  type = string
}

# ── Phase 2 service IPs (used in Kong declarative config) ────────────────────

variable "vm1_private_ip" {
  description = "Private IP of VM1 running joke-service (assigned by Azure, usually 10.0.1.4)"
  type        = string
  default     = "10.0.1.4"
}

variable "vm2_private_ip" {
  description = "Private IP of VM2 running submit-service + RabbitMQ (usually 10.0.1.5)"
  type        = string
  default     = "10.0.1.5"
}

# ── Kong configuration ────────────────────────────────────────────────────────

variable "rate_limit_per_minute" {
  description = <<-EOT
    Max requests per minute to the Joke API per client IP.
    Set deliberately low (5) for assignment demonstration.
    Trigger the limit by sending 6+ requests in under 60 seconds.
  EOT
  type    = number
  default = 5
}
