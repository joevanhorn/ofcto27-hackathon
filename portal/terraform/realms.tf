# Template-driven realms.
#
# Realms partition users for delegated administration (e.g. Employees vs
# Partners). The feature is SKU/flag-gated on trial orgs, so the portal probes
# GET /api/v1/realms with the spoke token at claim time and only sets
# enable_realms=true when the org supports it — the UI reports an explicit
# "skipped" otherwise. Realm names come from the resolved template.

resource "okta_realm" "template" {
  for_each = var.enable_realms ? toset(var.realm_names) : toset([])

  name = each.value
  # Partner-named realms get the PARTNER type (partner admin delegation);
  # everything else is a DEFAULT workforce realm.
  realm_type = lower(each.value) == "partners" ? "PARTNER" : "DEFAULT"
}
