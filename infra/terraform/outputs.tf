# =============================================================================
# infra/terraform/outputs.tf
# Values printed after `terraform apply` — copy these for testing
# =============================================================================

output "kong_public_ip" {
  description = "Kong VM public IP — use this in all test commands"
  value       = azurerm_public_ip.pip_kong.ip_address
}

output "kong_private_ip" {
  description = "Kong VM private IP within the Azure VNet (10.0.1.x)"
  value       = azurerm_network_interface.nic_kong.private_ip_address
}

output "kong_https_base_url" {
  description = "Base URL for all API requests via Kong"
  value       = "https://${azurerm_public_ip.pip_kong.ip_address}"
}

output "ssh_command" {
  description = "SSH into the Kong VM"
  value       = "ssh -i ~/.ssh/co3404_key azureuser@${azurerm_public_ip.pip_kong.ip_address}"
}

output "trust_cert_command" {
  description = "Add the self-signed cert to macOS System Keychain (removes browser warnings)"
  value       = "sudo security add-trusted-cert -d -r trustRoot -k /Library/Keychains/System.keychain infra/kong/certs/server.crt"
}

output "test_joke_api" {
  description = "Fetch a joke via Kong — triggers rate limiting after 5 requests/min"
  value       = "curl -sk https://${azurerm_public_ip.pip_kong.ip_address}/joke/programming | jq ."
}

output "test_submit_api" {
  description = "Submit a joke via Kong (no rate limit)"
  value       = "curl -sk -X POST https://${azurerm_public_ip.pip_kong.ip_address}/submit -H 'Content-Type: application/json' -d '{\"setup\":\"Why did the DevOps engineer quit?\",\"punchline\":\"Because they kept getting deployed to production.\",\"type\":\"programming\"}' | jq ."
}

output "rate_limit_demo" {
  description = "Send 8 rapid requests to trigger the 5/min rate limit (copy-paste into terminal)"
  # %%{ escapes %{ which Terraform would otherwise treat as a template directive
  value = "KONG_IP=${azurerm_public_ip.pip_kong.ip_address}; for i in $(seq 1 8); do echo -n \"Request $i: \"; curl -sk -o /dev/null -w \"%%{http_code}\\n\" https://$KONG_IP/joke/any; sleep 0.3; done"
}

output "deallocate_command" {
  description = "Deallocate Kong VM to stop billing (preserves disk)"
  value       = "az vm deallocate -g ${var.resource_group_name} -n vm-kong --no-wait"
}

output "start_command" {
  description = "Restart the Kong VM after deallocation"
  value       = "az vm start -g ${var.resource_group_name} -n vm-kong"
}
