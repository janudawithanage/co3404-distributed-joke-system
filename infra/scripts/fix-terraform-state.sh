#!/usr/bin/env bash
# =============================================================================
# infra/scripts/fix-terraform-state.sh
#
# HIGH FIX C2 — BUG-004: Reconcile Terraform state drift for Kong VM
#
# The tfstate shows azurerm_linux_virtual_machine.vm_kong has instances:[]
# (the VM exists in Azure but is not tracked in Terraform state).
# This script detects and imports the VM into state before running apply.
#
# Usage:
#   cd infra/terraform
#   ../../infra/scripts/fix-terraform-state.sh
#
# Prerequisites:
#   - `az` CLI logged in (run: az login)
#   - `terraform` CLI installed
#   - terraform.tfvars populated with real values
# =============================================================================
set -euo pipefail

RESOURCE_GROUP="rg-co3404-jokes"
VM_NAME_KONG="vm-kong"
VM_NAME_MODERATE="vm-moderate"
SUBSCRIPTION_ID=$(az account show --query id -o tsv 2>/dev/null || echo "")

if [[ -z "$SUBSCRIPTION_ID" ]]; then
  echo "❌  Not logged into Azure. Run: az login"
  exit 1
fi

echo "🔍  Checking Azure for existing VMs…"

# Check if vm-kong exists in Azure
KONG_VM_ID=$(az vm show \
  --resource-group "$RESOURCE_GROUP" \
  --name "$VM_NAME_KONG" \
  --query id -o tsv 2>/dev/null || echo "")

MODERATE_VM_ID=$(az vm show \
  --resource-group "$RESOURCE_GROUP" \
  --name "$VM_NAME_MODERATE" \
  --query id -o tsv 2>/dev/null || echo "")

echo ""
echo "── Azure resource discovery ──"
echo "  Kong VM:     ${KONG_VM_ID:-NOT FOUND}"
echo "  Moderate VM: ${MODERATE_VM_ID:-NOT FOUND}"

# Run terraform init first
echo ""
echo "🔧  Running terraform init…"
terraform init -upgrade

# Run terraform state list to see what is currently tracked
echo ""
echo "── Current Terraform state resources ──"
terraform state list || true

echo ""

# Import Kong VM if it exists in Azure but not in state
KONG_IN_STATE=$(terraform state list | grep "azurerm_linux_virtual_machine.vm_kong" || echo "")

if [[ -n "$KONG_VM_ID" && -z "$KONG_IN_STATE" ]]; then
  echo "⚠️   Kong VM exists in Azure but NOT in Terraform state."
  echo "     Importing: $KONG_VM_ID"
  terraform import azurerm_linux_virtual_machine.vm_kong "$KONG_VM_ID"
  echo "✅  Kong VM imported into state"
elif [[ -z "$KONG_VM_ID" ]]; then
  echo "ℹ️   Kong VM does not exist in Azure — will be created by terraform apply"
else
  echo "✅  Kong VM already tracked in Terraform state"
fi

# Import Moderate VM if it exists in Azure but not in state
MOD_IN_STATE=$(terraform state list | grep "azurerm_linux_virtual_machine.vm_moderate" || echo "")

if [[ -n "$MODERATE_VM_ID" && -z "$MOD_IN_STATE" ]]; then
  echo "⚠️   Moderate VM exists in Azure but NOT in Terraform state."
  echo "     Importing: $MODERATE_VM_ID"
  terraform import azurerm_linux_virtual_machine.vm_moderate "$MODERATE_VM_ID" || true
  echo "✅  Moderate VM imported into state (or skipped if resource name differs)"
fi

echo ""
echo "🔄  Running terraform refresh to sync state with Azure reality…"
terraform refresh -var-file="terraform.tfvars" || {
  echo "⚠️   terraform refresh had errors (may be OK if some provisioners failed)"
}

echo ""
echo "📋  Running terraform plan to preview changes before apply…"
terraform plan -var-file="terraform.tfvars" -out=tfplan.out

echo ""
echo "✅  Plan complete. Review the output above."
echo ""
echo "   To apply: terraform apply tfplan.out"
echo "   This will:"
echo "     - Reconcile any missing resources"
echo "     - Upload latest kong.yml (with rate-limit scope fix)"
echo "     - Redeploy Kong container"
echo ""
echo "   Alternatively, run: infra/scripts/redeploy-kong.sh"
echo "   to ONLY update the Kong config without re-running Terraform."
