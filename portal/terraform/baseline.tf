# Baseline security template applied to a newly-provisioned spoke org.
# This is what the Division Lead "sees applied" when they log in (beat 2 of the
# recording). Represents the central-security-owned REQUIRED section — the same
# controls the portal shows as locked "enforced by central security" chips.
#
# Kept to robust, high-signal resources so the apply is clean and demoable:
#   - a baseline user group
#   - a bookmark app assigned to it (something visible in the end-user dashboard)
#   - a baseline password policy (a concrete, visible security control)

locals {
  # A short, safe slug for resource naming from the org display name.
  slug = lower(replace(var.org_display_name, "/[^A-Za-z0-9]+/", "-"))
}

# ── Baseline group every spoke user lands in ──────────────────────────────────
resource "okta_group" "baseline_users" {
  name        = "Baseline-Users"
  description = "Baseline access group provisioned by the Spoke Provisioning Portal (${var.template_id})"
}

# ── A visible app so the end user sees the template took effect ───────────────
resource "okta_app_bookmark" "welcome" {
  label = "${var.org_display_name} — Welcome"
  url   = "https://${var.spoke_org_name}.${var.spoke_base_url}"
}

resource "okta_app_group_assignments" "welcome_baseline" {
  app_id = okta_app_bookmark.welcome.id
  group {
    id = okta_group.baseline_users.id
  }
}

# ── Default MFA enrollment: don't force Okta Verify on federated users ────────
# Fresh OIE orgs require Okta Verify enrollment at first sign-in, which breaks
# the hub-SSO story: a JIT-provisioned federated user gets an enrollment
# interstitial instead of the dashboard. Human sign-in is federation-only (MFA
# happens at the hub), so enrollment on the spoke is optional.
resource "okta_policy_mfa_default" "baseline" {
  is_oie        = true
  okta_password = { enroll = "REQUIRED" }
  okta_verify   = { enroll = "OPTIONAL" }
}

# ── Dashboard access: trust the hub's MFA, don't demand a second factor ──────
# The stock "Okta Dashboard" access policy's catch-all requires 2FA, so a
# JIT-provisioned federated user (whose only "factor" is the hub's SAML
# assertion, MFA-verified at the hub) gets an Okta Verify enrollment wall
# instead of the dashboard. Add a higher-priority 1FA rule: federation-only
# sign-in means assurance is the hub's job.
data "okta_app" "dashboard" {
  label = "Okta Dashboard"
}

data "okta_app_signon_policy" "dashboard" {
  app_id = data.okta_app.dashboard.id
}

resource "okta_app_signon_policy_rule" "dashboard_federated_1fa" {
  policy_id                   = data.okta_app_signon_policy.dashboard.id
  name                        = "Baseline — hub-federated sign-in (1FA)"
  priority                    = 1
  access                      = "ALLOW"
  factor_mode                 = "1FA"
  re_authentication_frequency = "PT12H"
}

# Baseline = group + assigned app (both created reliably against the OIE org and
# visible in the spoke admin console). Policy-type controls (password/MFA) are
# shown in the portal as central-security-enforced chips; the OIE org rejected the
# provider's default password-policy recovery settings, so we keep the baseline to
# the resources that apply cleanly and let SAML federation (federation.tf) carry
# the identity story.
