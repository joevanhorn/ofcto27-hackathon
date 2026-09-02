variable "spoke_org_name" {
  description = "Spoke org subdomain — used in resource names, tags, and SSM parameter paths"
  type        = string
}

variable "computer_name" {
  description = "NetBIOS computer name for the DC (<=15 chars, unique per spoke)"
  type        = string

  validation {
    condition     = length(var.computer_name) > 0 && length(var.computer_name) <= 15
    error_message = "computer_name must be 1-15 characters (NetBIOS limit)."
  }
}

variable "ad_domain_name" {
  description = "AD DNS domain name"
  type        = string
  default     = "taskvantage.local"
}

variable "ad_netbios_name" {
  description = "AD NetBIOS domain name"
  type        = string
  default     = "TASKVANTAGE"
}

variable "admin_password" {
  description = "Local/domain Administrator password"
  type        = string
  sensitive   = true
}

variable "safe_mode_password" {
  description = "DSRM safe-mode password"
  type        = string
  sensitive   = true
}

variable "s3_bucket" {
  description = "Bucket with staged setup artifacts (ad-setup.ps1, ou-structure.json, agent installer)"
  type        = string
}

variable "s3_prefix" {
  description = "Key prefix for staged setup artifacts"
  type        = string
}

variable "network_tag" {
  description = "Name tag of the shared AD VPC/subnet/SG (terraform/ad-network)"
  type        = string
}

variable "aws_region" {
  description = "AWS region (must match the shared network)"
  type        = string
}

variable "instance_type" {
  description = "EC2 instance type for the DC"
  type        = string
  default     = "t3.medium"
}

variable "volume_size" {
  description = "Root volume size in GB"
  type        = number
  default     = 60
}
