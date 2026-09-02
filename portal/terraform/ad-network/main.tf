# ==============================================================================
# Shared network for TaskVantage AD domain controllers — applied ONCE per host
# account (see portal/scripts/setup-ad.sh). Per-spoke DCs discover these
# resources by Name tag; keep the tags in sync with var.network_tag.
#
# Deliberately per-account-singleton: the demo account's VPC quota is tight, so
# every AD-enabled spoke shares this VPC/subnet/SG rather than creating its own.
# ==============================================================================

terraform {
  required_version = ">= 1.9.0"
  required_providers {
    aws = {
      source  = "hashicorp/aws"
      version = "~> 5.60"
    }
  }
}

provider "aws" {
  region = var.aws_region
  default_tags {
    tags = {
      Project   = "velocity27-portal"
      Component = "taskvantage-ad"
    }
  }
}

resource "aws_vpc" "ad" {
  cidr_block           = var.vpc_cidr
  enable_dns_hostnames = true
  enable_dns_support   = true

  tags = { Name = var.network_tag }
}

resource "aws_internet_gateway" "ad" {
  vpc_id = aws_vpc.ad.id
  tags   = { Name = "${var.network_tag}-igw" }
}

resource "aws_subnet" "public" {
  vpc_id                  = aws_vpc.ad.id
  cidr_block              = var.public_subnet_cidr
  map_public_ip_on_launch = true

  tags = { Name = "${var.network_tag}-public" }
}

resource "aws_route_table" "public" {
  vpc_id = aws_vpc.ad.id

  route {
    cidr_block = "0.0.0.0/0"
    gateway_id = aws_internet_gateway.ad.id
  }

  tags = { Name = "${var.network_tag}-public" }
}

resource "aws_route_table_association" "public" {
  subnet_id      = aws_subnet.public.id
  route_table_id = aws_route_table.public.id
}

# Keeps S3 bootstrap traffic (setup script + agent installer) off the internet
# path and immune to egress filtering.
resource "aws_vpc_endpoint" "s3" {
  vpc_id            = aws_vpc.ad.id
  service_name      = "com.amazonaws.${var.aws_region}.s3"
  vpc_endpoint_type = "Gateway"
  route_table_ids   = [aws_route_table.public.id]

  tags = { Name = "${var.network_tag}-s3" }
}

# Zero inbound rules on purpose: all management is SSM (outbound HTTPS) and RDP
# happens over SSM port-forwarding. This also means the account's SG
# auto-remediation sweeps have nothing to strip.
resource "aws_security_group" "dc" {
  name        = "${var.network_tag}-dc"
  description = "TaskVantage AD domain controllers - no inbound, SSM-managed"
  vpc_id      = aws_vpc.ad.id

  egress {
    from_port   = 0
    to_port     = 0
    protocol    = "-1"
    cidr_blocks = ["0.0.0.0/0"]
  }

  tags = { Name = "${var.network_tag}-dc" }
}
