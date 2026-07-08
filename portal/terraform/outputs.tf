# Surfaced back to the portal after a successful apply — the plain-language
# "what got created" the UI shows, and the spoke sign-in URL for beat 3.

output "spoke_login_url" {
  description = "Where the end user signs in to the provisioned spoke"
  value       = "https://${var.spoke_org_name}.${var.spoke_base_url}"
}

output "baseline_group" {
  description = "Baseline group created on the spoke"
  value       = okta_group.baseline_users.name
}

output "baseline_app" {
  description = "Baseline app assigned to spoke users"
  value       = okta_app_bookmark.welcome.label
}

output "applied_summary" {
  description = "Plain-language summary of the baseline applied"
  value = [
    "Created baseline group '${okta_group.baseline_users.name}'",
    "Assigned app '${okta_app_bookmark.welcome.label}' to baseline users",
    "Template '${var.template_id}' — retention ${var.retention_days}d, region ${var.data_region}",
  ]
}

# -----------------------------------------------------------------------------
# SAML federation re-exports (consumed by the portal's 3-pass converge loop).
# try() keeps a baseline-only apply (enable_federation=false) from erroring when
# the module instances have count = 0.
# -----------------------------------------------------------------------------

# Hub SAML app -> carried into the spoke's external IdP on the next pass.
output "hub_issuer" {
  description = "Hub SAML app issuer/entity ID"
  value       = try(module.hub_federation[0].federation_issuer, "")
}

output "hub_sso_url" {
  description = "Hub SAML app SSO URL"
  value       = try(module.hub_federation[0].federation_sso_url, "")
}

output "hub_certificate" {
  description = "Hub SAML app signing cert (bare base64)"
  value       = try(module.hub_federation[0].federation_certificate, "")
  sensitive   = true
}

output "hub_app_id" {
  description = "Hub SAML app ID"
  value       = try(module.hub_federation[0].app_id, "")
}

# Spoke external IdP -> ACS URL carried back into the hub app on the next pass.
output "spoke_idp_id" {
  description = "Spoke external-IdP resource ID"
  value       = try(module.spoke_federation[0].idp_id, "")
}

output "spoke_acs_url" {
  description = "Spoke external-IdP ACS URL (recipient/destination the hub must target)"
  value       = try(module.spoke_federation[0].idp_acs_url, "")
}

# The federated launch URL the portal 'Open (SSO)' button deep-links to.
output "hub_sso_entry_url" {
  description = "Hub IdP-initiated SSO launch URL for the spoke app"
  value       = try(module.hub_federation[0].federation_sso_url, "")
}
