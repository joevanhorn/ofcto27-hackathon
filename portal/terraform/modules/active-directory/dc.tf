resource "aws_instance" "dc" {
  ami                  = data.aws_ami.windows_2022.id
  instance_type        = var.instance_type
  iam_instance_profile = aws_iam_instance_profile.dc.name

  subnet_id                   = data.aws_subnet.public.id
  vpc_security_group_ids      = [data.aws_security_group.dc.id]
  associate_public_ip_address = true # egress to Okta/AWS endpoints; SG has zero inbound

  root_block_device {
    volume_type           = "gp3"
    volume_size           = var.volume_size
    delete_on_termination = true
    encrypted             = true
  }

  metadata_options {
    http_endpoint               = "enabled"
    http_tokens                 = "required"
    http_put_response_hop_limit = 1
  }

  # No secrets in userdata — the bootstrap pulls passwords from SSM and the big
  # setup script from S3 using the instance role.
  user_data = templatefile("${path.module}/files/ad-bootstrap.ps1", {
    spoke_org_name  = var.spoke_org_name
    aws_region      = var.aws_region
    s3_bucket       = var.s3_bucket
    s3_prefix       = var.s3_prefix
    computer_name   = var.computer_name
    ad_domain_name  = var.ad_domain_name
    ad_netbios_name = var.ad_netbios_name
  })

  # The portal re-applies this root up to 3 times per provision (federation
  # converge passes) and AMIs refresh weekly — neither may replace a live DC.
  lifecycle {
    ignore_changes = [ami, user_data]
  }

  tags = {
    Name             = "tv-ad-${var.spoke_org_name}"
    Role             = "Domain-Controller"
    Domain           = var.ad_domain_name
    TaskVantageSpoke = var.spoke_org_name # reset.mjs terminates by this tag as fallback
  }

  depends_on = [
    aws_ssm_parameter.admin_password,
    aws_ssm_parameter.safe_mode_password,
    aws_ssm_parameter.setup_phase,
  ]
}
