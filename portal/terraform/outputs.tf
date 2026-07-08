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
