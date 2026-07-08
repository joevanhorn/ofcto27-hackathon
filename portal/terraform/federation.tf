# =============================================================================
# SAML Org2Org federation — hub is IdP, freshly-provisioned spoke is SP
# =============================================================================
# Both sides are created in ONE root apply via two module instances of
# ./modules/saml-federation, each bound to its own aliased provider:
#   - hub_federation   (provider okta.hub)   -> okta_app_saml (IdP side)
#   - spoke_federation (provider okta,default) -> okta_idp_saml (SP side)
#
# The two modules NEVER reference each other (that would cycle the graph).
# Instead the portal runs a 3-pass converge loop, threading outputs of one pass
# into the *_url / hub_* variables of the next:
#   pass 1  hub app is created            -> emits hub_issuer/sso/certificate
#   pass 2  spoke IdP is created (needs hub creds) -> emits spoke_idp_id/acs_url
#   pass 3  hub app is updated to point recipient/destination at the real spoke ACS
# =============================================================================

# The hub group whose members may IdP-initiate into spokes. Unassigned users
# cannot launch the app, so this gates who can SSO.
data "okta_group" "hub_division_leads" {
  count    = var.enable_federation ? 1 : 0
  provider = okta.hub
  name     = "Division Leads"
}

# --- Hub side: SAML app that asserts INTO the spoke ---------------------------
module "hub_federation" {
  count  = var.enable_federation ? 1 : 0
  source = "./modules/saml-federation"
  providers = {
    okta = okta.hub
  }

  federation_mode = "idp"
  federation_name = var.spoke_org_name
  okta_org_name   = var.hub_org_name
  okta_base_url   = var.hub_base_url
  use_remote_state = false

  app_label   = var.federation_label
  sp_acs_url = var.spoke_acs_url
  # Carry the spoke IdP's REAL SP entity ID (opaque, e.g.
  # https://www.okta.com/saml2/service-provider/xxx) once the spoke exists;
  # a placeholder on pass 1 just lets the hub app be created (non-empty).
  sp_audience = var.spoke_audience != "" ? var.spoke_audience : "https://${var.spoke_org_name}.${var.spoke_base_url}"

  # Only members of this group can IdP-initiate into the spoke.
  assigned_group_ids = var.enable_federation ? [data.okta_group.hub_division_leads[0].id] : []

  # Expose the tile on the hub dashboard so the Division Lead can launch it
  # (finale of the recording). The module hides federation apps by default.
  hide_from_dashboard = false

  status = "ACTIVE"
}

# --- Spoke side: external IdP that TRUSTS the hub -----------------------------
module "spoke_federation" {
  count  = var.enable_federation ? 1 : 0
  source = "./modules/saml-federation"

  federation_mode = "sp"
  federation_name = "hub"
  okta_org_name   = var.spoke_org_name
  okta_base_url   = var.spoke_base_url
  use_remote_state = false

  idp_name        = "Hub SSO (${var.hub_org_name})"
  idp_issuer      = var.hub_issuer
  idp_sso_url     = var.hub_sso_url
  idp_certificate = var.hub_certificate

  # JIT: create + link the hub user in the spoke on first SSO, matched by email.
  provisioning_action = "AUTO"
  account_link_action = "AUTO"
  subject_match_type  = "EMAIL"
  username_template   = "idpuser.email"
  groups_action       = "NONE"

  status = "ACTIVE"
}
