# Per-spoke instance role: SSM management, read-only access to the staged
# setup artifacts, and get/put on this spoke's own SSM parameters (read the
# generated passwords, write the setup-phase progress marker).

data "aws_caller_identity" "current" {}

resource "aws_iam_role" "dc" {
  name = "tv-ad-${var.spoke_org_name}"

  assume_role_policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        Action    = "sts:AssumeRole"
        Effect    = "Allow"
        Principal = { Service = "ec2.amazonaws.com" }
      }
    ]
  })
}

resource "aws_iam_role_policy_attachment" "ssm_core" {
  role       = aws_iam_role.dc.name
  policy_arn = "arn:aws:iam::aws:policy/AmazonSSMManagedInstanceCore"
}

resource "aws_iam_role_policy" "dc" {
  name = "tv-ad-${var.spoke_org_name}"
  role = aws_iam_role.dc.id

  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        Effect   = "Allow"
        Action   = ["s3:GetObject"]
        Resource = "arn:aws:s3:::${var.s3_bucket}/${var.s3_prefix}/*"
      },
      {
        Effect   = "Allow"
        Action   = ["ssm:GetParameter", "ssm:PutParameter"]
        Resource = "arn:aws:ssm:${var.aws_region}:${data.aws_caller_identity.current.account_id}:parameter/taskvantage/${var.spoke_org_name}/*"
      }
    ]
  })
}

resource "aws_iam_instance_profile" "dc" {
  name = "tv-ad-${var.spoke_org_name}"
  role = aws_iam_role.dc.name
}
