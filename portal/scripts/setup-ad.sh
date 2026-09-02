#!/usr/bin/env bash
# One-time host setup for the "Include Active Directory" portal option.
# Idempotent — safe to re-run. Does four things:
#   1. terraform init -upgrade in portal/terraform (vendors the aws provider)
#   2. applies portal/terraform/ad-network (shared VPC/subnet/SG, own state)
#   3. stages ad-setup.ps1 + ou-structure.json to the S3 prefix the DCs read
#   4. checks the Okta AD agent installer is staged (manual, once)
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
TF_DIR="$REPO_ROOT/portal/terraform"
MODULE_FILES="$TF_DIR/modules/active-directory/files"

AD_S3_BUCKET="${AD_S3_BUCKET:-okta-terraform-demo}"
AD_S3_PREFIX="${AD_S3_PREFIX:-ad/taskvantage}"
AD_AWS_REGION="${AD_AWS_REGION:-us-east-1}"
EXPECTED_ACCOUNT="${EXPECTED_ACCOUNT:-357013128720}"

echo "== preflight =="
ACCOUNT=$(aws sts get-caller-identity --query Account --output text)
if [[ "$ACCOUNT" != "$EXPECTED_ACCOUNT" ]]; then
  echo "ERROR: AWS identity is account $ACCOUNT, expected $EXPECTED_ACCOUNT (host instance role)." >&2
  echo "       Unset AWS_PROFILE or export EXPECTED_ACCOUNT to override." >&2
  exit 1
fi
terraform version -json | grep -q '"1\.' || { echo "ERROR: terraform >= 1.9 required" >&2; exit 1; }
echo "account $ACCOUNT, terraform $(terraform version | head -1)"

echo
echo "== 1/4 terraform init (root module, vendors hashicorp/aws) =="
terraform -chdir="$TF_DIR" init -upgrade -input=false
echo "NOTE: commit the .terraform.lock.hcl change if this added the aws provider."

echo
echo "== 2/4 shared AD network (VPC 10.77.0.0/16) =="
VPC_COUNT=$(aws ec2 describe-vpcs --region "$AD_AWS_REGION" --query 'length(Vpcs)' --output text)
echo "existing VPCs in $AD_AWS_REGION: $VPC_COUNT (quota is typically 10)"
terraform -chdir="$TF_DIR/ad-network" init -input=false
terraform -chdir="$TF_DIR/ad-network" apply -auto-approve -input=false \
  -var "aws_region=$AD_AWS_REGION"
terraform -chdir="$TF_DIR/ad-network" output

echo
echo "== 3/4 stage DC setup artifacts to s3://$AD_S3_BUCKET/$AD_S3_PREFIX/ =="
echo "stage-test $(date -u +%FT%TZ)" > /tmp/.tv-ad-stage-test
if ! aws s3 cp /tmp/.tv-ad-stage-test "s3://$AD_S3_BUCKET/$AD_S3_PREFIX/.stage-test" --region "$AD_AWS_REGION" >/dev/null; then
  echo "ERROR: cannot write to s3://$AD_S3_BUCKET/$AD_S3_PREFIX/." >&2
  echo "       Create a bucket you own and re-run with AD_S3_BUCKET=<bucket>." >&2
  exit 1
fi
aws s3 cp "$MODULE_FILES/ad-setup.ps1" "s3://$AD_S3_BUCKET/$AD_S3_PREFIX/ad-setup.ps1" --region "$AD_AWS_REGION"
aws s3 cp "$MODULE_FILES/ou-structure.json" "s3://$AD_S3_BUCKET/$AD_S3_PREFIX/ou-structure.json" --region "$AD_AWS_REGION"

echo
echo "== 4/4 Okta AD agent installer =="
if aws s3 ls "s3://$AD_S3_BUCKET/$AD_S3_PREFIX/OktaADAgentSetup.exe" --region "$AD_AWS_REGION" >/dev/null 2>&1; then
  echo "OktaADAgentSetup.exe is staged."
else
  cat <<EOF
WARNING: OktaADAgentSetup.exe is NOT staged. DCs will still build, but the
installer won't be pre-downloaded. To stage it (once):
  1. Any Okta org Admin Console -> Directory -> Directory Integrations ->
     Add Active Directory -> Download Agent (or Settings -> Downloads).
  2. aws s3 cp OktaADAgentSetup.exe s3://$AD_S3_BUCKET/$AD_S3_PREFIX/OktaADAgentSetup.exe
EOF
fi

echo
echo "setup-ad complete."
