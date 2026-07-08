# The apply targets one spoke org. Credentials are passed in as variables by the
# portal (sourced from the gitignored ~/okta-demo-creds.env) — never hardcoded.
provider "okta" {
  org_name  = var.spoke_org_name
  base_url  = var.spoke_base_url
  api_token = var.spoke_api_token
}
