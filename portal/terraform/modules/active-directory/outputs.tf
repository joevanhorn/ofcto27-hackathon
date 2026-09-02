output "instance_id" {
  value = aws_instance.dc.id
}

output "private_ip" {
  value = aws_instance.dc.private_ip
}

output "public_ip" {
  value = aws_instance.dc.public_ip
}

output "computer_name" {
  value = var.computer_name
}

output "status_parameter" {
  description = "SSM parameter the DC writes its setup phase to"
  value       = aws_ssm_parameter.setup_phase.name
}

output "password_parameter" {
  description = "SSM SecureString parameter holding the Administrator password"
  value       = aws_ssm_parameter.admin_password.name
}

output "summary" {
  description = "Plain-language lines for the portal's applied summary"
  value = [
    "Launched TaskVantage AD domain controller ${var.computer_name} (${var.ad_domain_name})",
    "Directory build continues in the background (~20 min): tv* schema, 242 OUs, groups, sample users",
    "Okta AD agent staged on the DC for Universal Directory import",
  ]
}
