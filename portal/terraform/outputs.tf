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

output "baseline_group_id" {
  description = "ID of the baseline group (certification campaign target)"
  value       = okta_group.baseline_users.id
}

output "baseline_app" {
  description = "Baseline app assigned to spoke users"
  value       = okta_app_bookmark.welcome.label
}

output "applied_summary" {
  description = "Plain-language summary of the baseline applied"
  value = concat(
    [
      "Created baseline group '${okta_group.baseline_users.name}'",
      "Assigned app '${okta_app_bookmark.welcome.label}' to baseline users",
    ],
    [for app in okta_app_bookmark.deployed : "Deployed app '${app.label}' and assigned it to baseline users"],
    length(okta_realm.template) > 0
      ? [for r in okta_realm.template : "Created realm '${r.name}' (${r.realm_type})"]
      : (length(var.realm_names) > 0 ? ["Realms skipped — feature not available on this org"] : []),
    try(module.active_directory[0].summary, []),
    [
      "Template '${var.template_id}' baseline applied",
    ]
  )
}

# -----------------------------------------------------------------------------
# Active Directory re-exports (consumed by src/directory.mjs). try() keeps
# non-AD applies from erroring when the module instance has count = 0.
# -----------------------------------------------------------------------------

output "ad_instance_id" {
  description = "EC2 instance ID of the spoke's TaskVantage DC"
  value       = try(module.active_directory[0].instance_id, "")
}

output "ad_computer_name" {
  description = "NetBIOS computer name of the DC"
  value       = try(module.active_directory[0].computer_name, "")
}

output "ad_status_parameter" {
  description = "SSM parameter carrying the DC's setup phase"
  value       = try(module.active_directory[0].status_parameter, "")
}

output "ad_password_parameter" {
  description = "SSM SecureString parameter holding the DC Administrator password"
  value       = try(module.active_directory[0].password_parameter, "")
}

output "ad_private_ip" {
  description = "Private IP of the DC inside the shared AD VPC"
  value       = try(module.active_directory[0].private_ip, "")
}

output "deployed_app_ids" {
  description = "IDs of the template-deployed bookmark apps, keyed by catalog id"
  value       = { for k, app in okta_app_bookmark.deployed : k => app.id }
}

output "realm_ids" {
  description = "IDs of the created realms, keyed by name"
  value       = { for k, r in okta_realm.template : k => r.id }
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
# Embed link, NOT federation_sso_url — the latter is the AuthnRequest endpoint
# and 404s when a browser opens it directly.
output "hub_sso_entry_url" {
  description = "Hub IdP-initiated SSO launch URL for the spoke app"
  value       = try(module.hub_federation[0].federation_embed_url, "")
}

output "spoke_audience" {
  description = "Spoke external-IdP audience / SP entity ID (opaque) the hub app must send"
  value       = try(module.spoke_federation[0].idp_audience, "")
}
