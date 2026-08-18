# Accenture branding applied to every provisioned org.
#
# Real Okta customization, not window dressing: the default brand's theme gets
# the Accenture palette + logo + favicon (sign-in page, end-user dashboard,
# browser tab), and the org's company name becomes the requested display name —
# so the spoke reads "EMEA Financial Services", not a raw tenant subdomain.
# All three resources adopt org singletons and update in place; the pool reset
# intentionally leaves them (re-adopted on the next provision, no conflicts).

data "okta_brands" "all" {}

locals {
  default_brand_id = tolist(data.okta_brands.all.brands)[0].id
}

data "okta_themes" "default_brand" {
  brand_id = local.default_brand_id
}

resource "okta_theme" "accenture" {
  brand_id = local.default_brand_id
  theme_id = tolist(data.okta_themes.default_brand.themes)[0].id

  logo    = "${path.module}/assets/accenture-logo.png"
  favicon = "${path.module}/assets/accenture-favicon.png"

  primary_color_hex   = "#A100FF"
  secondary_color_hex        = "#7500C0"

  sign_in_page_touch_point_variant       = "BACKGROUND_SECONDARY_COLOR"
  end_user_dashboard_touch_point_variant = "WHITE_LOGO_BACKGROUND"
  error_page_touch_point_variant         = "OKTA_DEFAULT"
  email_template_touch_point_variant     = "OKTA_DEFAULT"
}

resource "okta_org_configuration" "identity" {
  # Okta company names are globally unique per cell — compound with the brand
  # to keep collisions implausible while staying presentable on screen.
  company_name = "${var.org_display_name} | Accenture"
  website      = "https://www.accenture.com"
}
