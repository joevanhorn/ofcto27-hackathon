# Shared network discovery — by Name tag, so this module has no state coupling
# to the one-time ad-network root (portal/scripts/setup-ad.sh applies it).

data "aws_vpc" "ad" {
  filter {
    name   = "tag:Name"
    values = [var.network_tag]
  }
}

data "aws_subnet" "public" {
  vpc_id = data.aws_vpc.ad.id

  filter {
    name   = "tag:Name"
    values = ["${var.network_tag}-public"]
  }
}

data "aws_security_group" "dc" {
  vpc_id = data.aws_vpc.ad.id

  filter {
    name   = "tag:Name"
    values = ["${var.network_tag}-dc"]
  }
}

data "aws_ami" "windows_2022" {
  most_recent = true
  owners      = ["amazon"]

  filter {
    name   = "name"
    values = ["Windows_Server-2022-English-Full-Base-*"]
  }

  filter {
    name   = "virtualization-type"
    values = ["hvm"]
  }

  filter {
    name   = "root-device-type"
    values = ["ebs"]
  }
}
