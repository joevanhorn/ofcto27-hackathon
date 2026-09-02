# Secrets and the progress marker live in SSM, never in userdata or S3.
# The DC reads the passwords with its instance role; the portal reads the
# phase marker (and, on operator request, the admin password) with the host role.

resource "aws_ssm_parameter" "admin_password" {
  name  = "/taskvantage/${var.spoke_org_name}/admin-password"
  type  = "SecureString"
  value = var.admin_password
}

resource "aws_ssm_parameter" "safe_mode_password" {
  name  = "/taskvantage/${var.spoke_org_name}/safe-mode-password"
  type  = "SecureString"
  value = var.safe_mode_password
}

resource "aws_ssm_parameter" "setup_phase" {
  name  = "/taskvantage/${var.spoke_org_name}/setup-phase"
  type  = "String"
  value = "LAUNCHING"

  # The DC updates this as it progresses; terraform must never fight it.
  lifecycle {
    ignore_changes = [value]
  }
}
