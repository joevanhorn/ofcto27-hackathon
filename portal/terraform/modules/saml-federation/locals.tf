# =============================================================================
# SAML Federation Module - Local Values
# =============================================================================
# Handles remote state lookups and value resolution using the coalesce pattern:
# 1. Try remote state value first (if enabled)
# 2. Fall back to variable value
# =============================================================================

# -----------------------------------------------------------------------------
# Remote State Data Source
# -----------------------------------------------------------------------------
# Conditionally reads outputs from partner organization's Terraform state
# This enables automatic configuration exchange between federated orgs
# -----------------------------------------------------------------------------

data "terraform_remote_state" "partner" {
  count   = var.use_remote_state ? 1 : 0
  backend = var.remote_state_backend

  config = var.remote_state_config
}

# -----------------------------------------------------------------------------
# SP Mode Value Resolution
# -----------------------------------------------------------------------------
# When this org is the SP (receiving assertions), read IdP config from:
# 1. Partner's remote state (federation_issuer, federation_sso_url, federation_certificate)
# 2. Manual variable configuration
# -----------------------------------------------------------------------------

locals {
  # IdP configuration for SP mode (from partner's IdP mode outputs).
  # Null-safe "remote else manual" resolution — coalesce() errors when every
  # argument is empty, which happens on early converge passes (carriers still
  # PENDING) and whenever manual vars are used without remote state.
  _remote_idp_issuer = try(data.terraform_remote_state.partner[0].outputs.federation_issuer, "")
  _remote_idp_sso    = try(data.terraform_remote_state.partner[0].outputs.federation_sso_url, "")
  _remote_idp_cert   = try(data.terraform_remote_state.partner[0].outputs.federation_certificate, "")
  _remote_idp_org    = try(data.terraform_remote_state.partner[0].outputs.okta_org_name, "")

  idp_issuer      = local._remote_idp_issuer != "" ? local._remote_idp_issuer : var.idp_issuer
  idp_sso_url     = local._remote_idp_sso != "" ? local._remote_idp_sso : var.idp_sso_url
  idp_certificate = local._remote_idp_cert != "" ? local._remote_idp_cert : var.idp_certificate

  idp_name = var.idp_name != "" ? var.idp_name : "Federation from ${local._remote_idp_org != "" ? local._remote_idp_org : "External IdP"}"
}

# -----------------------------------------------------------------------------
# IdP Mode Value Resolution
# -----------------------------------------------------------------------------
# When this org is the IdP (sending assertions), read SP config from:
# 1. Partner's remote state (idp_id, okta_org_name, okta_base_url)
# 2. Manual variable configuration
# -----------------------------------------------------------------------------

locals {
  # SP configuration for IdP mode (from partner's SP mode outputs).
  # Same null-safe "remote else manual else default" resolution as above.
  _remote_sp_org  = try(data.terraform_remote_state.partner[0].outputs.okta_org_name, "")
  _remote_sp_base = try(data.terraform_remote_state.partner[0].outputs.okta_base_url, "")
  _remote_sp_idp  = try(data.terraform_remote_state.partner[0].outputs.idp_id, "")

  sp_org_name = local._remote_sp_org != "" ? local._remote_sp_org : var.sp_org_name
  sp_base_url = local._remote_sp_base != "" ? local._remote_sp_base : (var.sp_base_url != "" ? var.sp_base_url : "okta.com")
  sp_idp_id   = local._remote_sp_idp != "" ? local._remote_sp_idp : var.sp_idp_id

  app_label = var.app_label != "" ? var.app_label : "Federation to ${local.sp_org_name}"
}

# -----------------------------------------------------------------------------
# URL Construction
# -----------------------------------------------------------------------------
# Build SAML endpoint URLs based on resolved values
# -----------------------------------------------------------------------------

locals {
  # This org's SAML endpoints (for SP mode - what we tell the IdP)
  this_org_acs_base = "https://${var.okta_org_name}.${var.okta_base_url}/sso/saml2"
  this_org_audience = "https://${var.okta_org_name}.${var.okta_base_url}"

  # SP's SAML endpoints (for IdP mode - where we send assertions)
  # For Okta-to-Okta: use standard Okta URL format
  # For external SPs: use provided sp_acs_url and sp_audience
  # Null-safe: resolves to "" (not an error) when nothing is configured, so the
  # SP-mode module instance — which never sets these — validates cleanly.
  sp_acs_url = var.sp_acs_url != "" ? var.sp_acs_url : (
    local.sp_idp_id != "" ? "https://${local.sp_org_name}.${local.sp_base_url}/sso/saml2/${local.sp_idp_id}" : ""
  )

  sp_audience_url = var.sp_audience != "" ? var.sp_audience : (
    local.sp_org_name != "" ? "https://${local.sp_org_name}.${local.sp_base_url}" : ""
  )
}

# -----------------------------------------------------------------------------
# Resource Creation Conditions
# -----------------------------------------------------------------------------
# Determine which resources should be created based on mode and config
# -----------------------------------------------------------------------------

locals {
  # SP mode conditions
  create_sp_resources = var.federation_mode == "sp"
  has_idp_config      = local.idp_issuer != "" && local.idp_sso_url != ""
  create_idp_saml     = local.create_sp_resources && local.has_idp_config

  # IdP mode conditions
  create_idp_resources = var.federation_mode == "idp"
  has_sp_config        = local.sp_acs_url != "" && local.sp_audience_url != ""
  create_app_saml      = local.create_idp_resources && local.has_sp_config

  # Routing rule conditions
  create_routing_rule = local.create_sp_resources && var.enable_routing_rule && var.routing_domain_suffix != ""
}

# -----------------------------------------------------------------------------
# Default Attribute Statements
# -----------------------------------------------------------------------------
# Standard SAML attributes for Okta-to-Okta federation
# -----------------------------------------------------------------------------

locals {
  default_attribute_statements = [
    {
      name         = "firstName"
      namespace    = "urn:oasis:names:tc:SAML:2.0:attrname-format:unspecified"
      type         = "EXPRESSION"
      values       = ["user.firstName"]
      filter_type  = null
      filter_value = null
    },
    {
      name         = "lastName"
      namespace    = "urn:oasis:names:tc:SAML:2.0:attrname-format:unspecified"
      type         = "EXPRESSION"
      values       = ["user.lastName"]
      filter_type  = null
      filter_value = null
    },
    {
      name         = "email"
      namespace    = "urn:oasis:names:tc:SAML:2.0:attrname-format:unspecified"
      type         = "EXPRESSION"
      values       = ["user.email"]
      filter_type  = null
      filter_value = null
    }
  ]

  # Use provided attributes or fall back to defaults
  attribute_statements = length(var.attribute_statements) > 0 ? var.attribute_statements : local.default_attribute_statements
}
