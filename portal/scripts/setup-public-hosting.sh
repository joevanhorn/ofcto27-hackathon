#!/bin/bash
# One-shot finisher for public hosting at https://org-portal.owi-demo.com
# (Caddy + DNS record already configured; this does the privileged remainder.)
#
#   bash portal/scripts/setup-public-hosting.sh
#
# Steps:
#   1. AWS: dedicated security group with 80/443, attached alongside the
#      existing corporate SG (Okta-SWG-All-US stays untouched)
#   2. Hub OIDC app: add https://org-portal.owi-demo.com/callback redirect URI
#   3. ~/okta-demo-creds.env: point OIDC_REDIRECT_URI at the public URL
#   4. systemd: install + start org-portal.service (replaces any nohup server)
set -euo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")/../.."

HOST=org-portal.owi-demo.com
INSTANCE=i-036523bca034d282c
CORP_SG=sg-0cb1bef488acd96f2

echo "== [1/4] security group =="
VPC=$(aws ec2 describe-instances --instance-ids $INSTANCE \
  --query 'Reservations[0].Instances[0].VpcId' --output text)
SG=$(aws ec2 describe-security-groups \
  --filters Name=group-name,Values=org-portal-web Name=vpc-id,Values=$VPC \
  --query 'SecurityGroups[0].GroupId' --output text 2>/dev/null || true)
if [ -z "$SG" ] || [ "$SG" = "None" ]; then
  SG=$(aws ec2 create-security-group --group-name org-portal-web \
    --description "$HOST HTTPS (Caddy)" --vpc-id "$VPC" --query GroupId --output text)
fi
echo "   sg: $SG"
for port in 80 443; do
  aws ec2 authorize-security-group-ingress --group-id "$SG" \
    --protocol tcp --port $port --cidr 0.0.0.0/0 2>/dev/null \
    && echo "   opened $port" || echo "   $port already open"
done
aws ec2 modify-instance-attribute --instance-id $INSTANCE --groups $CORP_SG "$SG"
echo "   attached to $INSTANCE"

echo "== [2/4] hub OIDC redirect URI =="
node portal/scripts/add-redirect-uri.mjs "https://$HOST/callback"

echo "== [3/4] creds redirect URI =="
sed -i "s|^OIDC_REDIRECT_URI=.*|OIDC_REDIRECT_URI=https://$HOST/callback|" ~/okta-demo-creds.env
grep '^OIDC_REDIRECT_URI' ~/okta-demo-creds.env

echo "== [4/4] systemd service =="
sudo tee /etc/systemd/system/org-portal.service >/dev/null <<'EOF'
[Unit]
Description=Accenture Org Factory portal (real mode)
After=network-online.target

[Service]
User=ubuntu
WorkingDirectory=/home/ubuntu/ofcto27-hackathon/portal
Environment=DEMO_MODE=real
Environment=PORT=3210
Environment=OKTA_DEMO_CREDS=/home/ubuntu/okta-demo-creds.env
ExecStart=/usr/bin/env node server.mjs
Restart=on-failure
RestartSec=3

[Install]
WantedBy=multi-user.target
EOF
# stop any hand-launched server holding 3210
PID=$(ss -tlnp | grep ':3210 ' | grep -oP 'pid=\K[0-9]+' | head -1 || true)
[ -n "${PID:-}" ] && kill "$PID" && sleep 1
sudo systemctl daemon-reload
sudo systemctl enable --now org-portal
sleep 2
systemctl --no-pager --lines=0 status org-portal | head -3
# nudge caddy to retry the TLS cert now that 80/443 are reachable
sudo systemctl restart caddy

echo
echo "Done. Verify with:  curl -s https://$HOST/api/session"
