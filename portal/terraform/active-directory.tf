# ==============================================================================
# Optional per-spoke TaskVantage Active Directory
#
# Same count-gating pattern as federation.tf: with enable_active_directory=false
# (the default) the module — including its data-source lookups against AWS —
# never evaluates, so non-AD spokes work even before the shared ad-network root
# has been applied.
#
# The DC builds itself asynchronously after the apply returns (3 boots,
# ~20 min); progress is reported through the SSM parameter in
# ad_status_parameter, which the portal watches (src/directory.mjs).
# ==============================================================================

module "active_directory" {
  count  = var.enable_active_directory ? 1 : 0
  source = "./modules/active-directory"

  spoke_org_name     = var.spoke_org_name
  computer_name      = var.ad_computer_name
  ad_domain_name     = var.ad_domain_name
  ad_netbios_name    = var.ad_netbios_name
  admin_password     = var.ad_admin_password
  safe_mode_password = var.ad_safe_mode_password
  s3_bucket          = var.ad_s3_bucket
  s3_prefix          = var.ad_s3_prefix
  network_tag        = var.ad_network_tag
  aws_region         = var.aws_region
}
