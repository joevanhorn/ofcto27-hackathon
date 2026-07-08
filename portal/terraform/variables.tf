# Inputs for a single spoke provisioning apply. The portal writes a tfvars file
# per request (org name, template, deterministic options) and injects the target
# spoke org's credentials from ~/okta-demo-creds.env — nothing secret is stored here.

variable "spoke_org_name" {
  description = "Spoke org Okta subdomain (e.g. 'dev-12345')"
  type        = string
}

variable "spoke_base_url" {
  description = "Spoke org base URL domain"
  type        = string
  default     = "okta.com"
}

variable "spoke_api_token" {
  description = "Admin SSWS token for the spoke org"
  type        = string
  sensitive   = true
}

variable "org_display_name" {
  description = "Human name the Division Lead gave the org (e.g. 'NA Sales Demo')"
  type        = string
}

variable "template_id" {
  description = "Template id chosen in the portal (e.g. 'standard-spoke')"
  type        = string
  default     = "standard-spoke"
}

variable "retention_days" {
  description = "Deterministic knob: archive retention window on teardown"
  type        = string
  default     = "90"
}

variable "data_region" {
  description = "Deterministic knob: data region"
  type        = string
  default     = "us"
}
