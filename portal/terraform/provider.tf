# The apply targets one spoke org. Credentials are passed in as variables by the
# portal (sourced from the gitignored ~/okta-demo-creds.env) — never hardcoded.
provider "okta" {
  org_name  = var.spoke_org_name
  base_url  = var.spoke_base_url
  api_token = var.spoke_api_token
}

# Second, aliased provider for the HUB org. Real SAML Org2Org federation needs
# resources created on BOTH sides in the SAME root apply: the hub's SAML app
# (IdP side) and the spoke's external IdP (SP side). Cross-org values are carried
# between the two module calls as plain VARIABLES (see federation.tf) — never as
# module -> module references, which would cycle the graph. Hub creds arrive from
# the portal via TF_VAR_hub_* (token env-only, never argv/logs).
provider "okta" {
  alias     = "hub"
  org_name  = var.hub_org_name  # subdomain, e.g. "velocity27-hub"
  base_url  = var.hub_base_url   # e.g. "oktapreview.com"
  api_token = var.hub_api_token  # bare token, sensitive
}
