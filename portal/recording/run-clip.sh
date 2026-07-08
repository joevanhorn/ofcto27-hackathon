#!/bin/bash
# Reproducibly generate the demo clip: real Okta login (incl. MFA) -> request ->
# live terraform apply -> governed spoke provisioned. Outputs an MP4.
#
# Prereqs: ~/okta-demo-creds.env populated (hub + spoke tokens, OIDC client,
# DANA_TOTP_SECRET, DEMO_LEAD_USER/PASS, HUB_SSO_ENTRY_URL); node + terraform +
# ffmpeg; `npm i` already run in portal/recording.
set -u
cd "$(dirname "$0")/../.." || exit 1
CREDS="${OKTA_DEMO_CREDS:-$HOME/okta-demo-creds.env}"
OUT="${OUT_DIR:-/tmp/rec}"
rd() { node --input-type=module -e "import {loadCreds} from './portal/src/config.mjs'; process.stdout.write(loadCreds().$1||'')"; }

echo "› cleaning any leftover baseline on the target spoke…"
node --input-type=module -e '
import { loadCreds, spokePool, sswsHeader } from "./portal/src/config.mjs";
const sp=spokePool(loadCreds())[0];
const h={Authorization:sswsHeader(sp.token),Accept:"application/json"};
const j=async(m,p)=>{const r=await fetch(`https://${sp.domain}${p}`,{method:m,headers:h});try{return {s:r.status,j:await r.json()}}catch{return {s:r.status}}};
for(const g of ((await j("GET","/api/v1/groups?q=Baseline-Users&limit=10")).j||[])) if(g.profile?.name==="Baseline-Users") await j("DELETE",`/api/v1/groups/${g.id}`);
for(const a of ((await j("GET","/api/v1/apps?limit=50")).j||[])) if(a.signOnMode==="BOOKMARK"&&/Welcome/i.test(a.label)){await j("POST",`/api/v1/apps/${a.id}/lifecycle/deactivate`);await j("DELETE",`/api/v1/apps/${a.id}`);}
'
rm -f portal/terraform/state/velocity27-spoke1.tfstate* portal/terraform/state/*.lock.info
rm -rf "$OUT"; mkdir -p "$OUT"

pkill -9 -f "portal/server.mjs" 2>/dev/null
OKTA_DEMO_CREDS="$CREDS" DEMO_MODE=real DEMO_FEDERATION=off node portal/server.mjs >/tmp/clip-server.log 2>&1 &
SRV=$!
for i in $(seq 1 25); do [ "$(curl -s -o /dev/null -w '%{http_code}' --max-time 2 http://localhost:3000/api/session)" = "200" ] && break; done
echo "› server up; recording…"
LOGIN_USER="$(rd DEMO_LEAD_USER)" LOGIN_PASS="$(rd DEMO_LEAD_PASS)" TOTP_SECRET="$(rd DANA_TOTP_SECRET)" REC_DIR="$OUT" \
  node portal/recording/clip.mjs
kill $SRV 2>/dev/null

V=$(ls "$OUT"/*.webm 2>/dev/null | head -1)
[ -z "$V" ] && { echo "✗ no video captured — see /tmp/clip-server.log"; exit 1; }
ffmpeg -y -i "$V" -vf "fps=30,format=yuv420p" -c:v libx264 -preset medium -crf 20 -movflags +faststart "$OUT/spoke-portal-demo.mp4" >/tmp/clip-ffmpeg.log 2>&1
echo "✓ $OUT/spoke-portal-demo.mp4 ($(ffprobe -v error -show_entries format=duration -of default=nk=1:nw=1 "$OUT/spoke-portal-demo.mp4")s)"
