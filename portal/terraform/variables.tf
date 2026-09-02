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

# Resolved template spec: apps to deploy (baseline + chosen add-ons). The
# portal passes this as JSON via TF_VAR_deploy_apps.
variable "deploy_apps" {
  description = "Bookmark apps to create and assign to Baseline-Users"
  type = list(object({
    id    = string
    label = string
    url   = string
  }))
  default = []
}

# Realms are feature-gated on trial orgs; the portal probes the spoke's
# /api/v1/realms at claim time and only enables when supported.
variable "enable_realms" {
  description = "Create the template's realms (org must support the Realms feature)"
  type        = bool
  default     = false
}

variable "realm_names" {
  description = "Realm names from the resolved template (e.g. [\"Employees\", \"Partners\"])"
  type        = list(string)
  default     = []
}

# -----------------------------------------------------------------------------
# SAML Org2Org federation (hub IdP -> spoke SP)
# -----------------------------------------------------------------------------
# All default to "" / safe values so a baseline-only apply (no federation) still
# plans and applies. The portal sets these via TF_VAR_* in the 3-pass converge
# loop (see portal/src/provision.mjs). Cross-org carrier values (spoke_acs_url,
# hub_issuer/sso/certificate) are threaded pass-to-pass — never module->module.

variable "enable_federation" {
  description = "Create the hub SAML app + spoke external IdP for Org2Org SSO"
  type        = bool
  default     = true
}

variable "hub_org_name" {
  description = "Hub org Okta subdomain (e.g. 'velocity27-hub')"
  type        = string
  default     = ""
}

variable "hub_base_url" {
  description = "Hub org base URL domain"
  type        = string
  default     = "oktapreview.com"
}

variable "hub_api_token" {
  description = "Admin SSWS token for the hub org (bare, env-only)"
  type        = string
  default     = ""
  sensitive   = true
}

variable "federation_label" {
  description = "Label for the hub SAML federation app"
  type        = string
  default     = ""
}

# Carrier: spoke's external-IdP ACS URL, fed to the hub SAML app so its
# recipient/destination/sso_url target the real spoke IdP instance.
variable "spoke_acs_url" {
  description = "Spoke external-IdP ACS URL (carried into the hub app; PENDING on pass 1)"
  type        = string
  default     = ""
}

# Carriers: hub SAML app issuer / SSO URL / signing cert, fed to the spoke's
# external IdP so it trusts assertions from the hub.
variable "hub_issuer" {
  description = "Hub SAML app issuer/entity ID (carried into the spoke IdP)"
  type        = string
  default     = ""
}

variable "hub_sso_url" {
  description = "Hub SAML app SSO URL (carried into the spoke IdP)"
  type        = string
  default     = ""
}

variable "hub_certificate" {
  description = "Hub SAML app signing cert, bare base64 (carried into the spoke IdP)"
  type        = string
  default     = ""
  sensitive   = true
}

variable "spoke_audience" {
  description = "Spoke external-IdP SP entity ID / audience (carried into the hub app; empty on pass 1)"
  type        = string
  default     = ""
}

# ------------------------------------------------------------------------------
# Optional TaskVantage Active Directory (see active-directory.tf). All defaulted
# so existing non-AD applies are completely unaffected.
# ------------------------------------------------------------------------------

variable "enable_active_directory" {
  description = "Launch a TaskVantage AD domain controller for this spoke"
  type        = bool
  default     = false
}

variable "aws_region" {
  description = "AWS region hosting the shared AD network + DCs"
  type        = string
  default     = "us-east-1"
}

variable "ad_computer_name" {
  description = "Unique NetBIOS computer name for this spoke's DC (<=15 chars)"
  type        = string
  default     = ""
}

variable "ad_domain_name" {
  description = "AD DNS domain name"
  type        = string
  default     = "taskvantage.local"
}

variable "ad_netbios_name" {
  description = "AD NetBIOS domain name"
  type        = string
  default     = "TASKVANTAGE"
}

variable "ad_admin_password" {
  description = "Local/domain Administrator password (generated per request by the portal)"
  type        = string
  default     = ""
  sensitive   = true
}

variable "ad_safe_mode_password" {
  description = "DSRM safe-mode password (generated per request by the portal)"
  type        = string
  default     = ""
  sensitive   = true
}

variable "ad_s3_bucket" {
  description = "S3 bucket holding the staged DC setup artifacts"
  type        = string
  default     = "okta-terraform-demo"
}

variable "ad_s3_prefix" {
  description = "S3 key prefix for the staged DC setup artifacts"
  type        = string
  default     = "ad/taskvantage"
}

variable "ad_network_tag" {
  description = "Name tag of the shared AD network (see terraform/ad-network)"
  type        = string
  default     = "taskvantage-ad"
}
