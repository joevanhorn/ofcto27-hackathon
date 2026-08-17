# Template-driven application deployment.
#
# The portal resolves the chosen template + customization into a concrete list
# of apps (baseline + user-selected add-ons) and passes it as TF_VAR_deploy_apps.
# Bookmark apps stand in for real integrations in the demo — they are instantly
# visible on the end-user dashboard, which is the point.

resource "okta_app_bookmark" "deployed" {
  for_each = { for app in var.deploy_apps : app.id => app }

  label = each.value.label
  url   = each.value.url
}

resource "okta_app_group_assignments" "deployed_baseline" {
  for_each = okta_app_bookmark.deployed

  app_id = each.value.id
  group {
    id = okta_group.baseline_users.id
  }
}
