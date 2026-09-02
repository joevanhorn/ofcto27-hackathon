variable "aws_region" {
  description = "AWS region for the shared AD network"
  type        = string
  default     = "us-east-1"
}

variable "network_tag" {
  description = "Name tag used by per-spoke DCs to discover the VPC/subnet/SG"
  type        = string
  default     = "taskvantage-ad"
}

# 10.77/16 avoids the account's existing 10.0/16 AD VPC and the black-holed
# 172.31/16 default VPC range.
variable "vpc_cidr" {
  description = "CIDR for the shared AD VPC"
  type        = string
  default     = "10.77.0.0/16"
}

variable "public_subnet_cidr" {
  description = "CIDR for the DC subnet"
  type        = string
  default     = "10.77.1.0/24"
}
