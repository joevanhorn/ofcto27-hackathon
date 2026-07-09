#!/bin/bash
cd ~/ofcto27-hackathon
rd(){ node --input-type=module -e "import {loadCreds} from './portal/src/config.mjs'; process.stdout.write(loadCreds().$1||'')"; }
# Fully clean spoke1 so the BEFORE console is empty.
SPK=$(node --input-type=module -e "import {loadCreds,spokePool} from './portal/src/config.mjs'; process.stdout.write((spokePool(loadCreds())[0].token||'').replace(/^SSWS[ _]/i,''))")
HUB=$(rd HUB_API_TOKEN | sed -E 's/^SSWS[ _]//')
cd portal/terraform
for ST in state/fed-velocity27-spoke1.tfstate state/velocity27-spoke1.tfstate; do
  [ -f "$ST" ] && env TF_VAR_spoke_org_name=velocity27-spoke1 TF_VAR_spoke_base_url=oktapreview.com TF_VAR_spoke_api_token="$SPK" TF_VAR_org_display_name="NA Sales Demo" TF_VAR_template_id=standard-spoke TF_VAR_retention_days=90 TF_VAR_data_region=us TF_VAR_enable_federation=true TF_VAR_hub_org_name=velocity27-hub TF_VAR_hub_base_url=oktapreview.com TF_VAR_hub_api_token="$HUB" TF_VAR_federation_label="Federation to NA Sales Demo" terraform destroy -auto-approve -no-color -state="$ST" -target=module.hub_federation -target=module.spoke_federation -target=data.okta_group.hub_division_leads >/dev/null 2>&1
done
rm -f state/velocity27-spoke1.tfstate* state/fed-velocity27-spoke1.tfstate* state/*.lock.info
cd ~/ofcto27-hackathon
node --input-type=module -e '
import {loadCreds,spokePool,sswsHeader} from "./portal/src/config.mjs";
const sp=spokePool(loadCreds())[0]; const h={Authorization:sswsHeader(sp.token),Accept:"application/json"};
const j=async(m,p)=>{const r=await fetch(`https://${sp.domain}${p}`,{method:m,headers:h});try{return{s:r.status,j:await r.json()}}catch{return{s:r.status}}};
for(const g of ((await j("GET","/api/v1/groups?q=Baseline-Users&limit=10")).j||[])) if(g.profile?.name==="Baseline-Users") await j("DELETE",`/api/v1/groups/${g.id}`);
for(const a of ((await j("GET","/api/v1/apps?limit=50")).j||[])) if(a.signOnMode==="BOOKMARK"&&/Welcome/i.test(a.label)){await j("POST",`/api/v1/apps/${a.id}/lifecycle/deactivate`);await j("DELETE",`/api/v1/apps/${a.id}`);}
for(const i of ((await j("GET","/api/v1/idps?limit=20")).j||[])){await j("POST",`/api/v1/idps/${i.id}/lifecycle/deactivate`);await j("DELETE",`/api/v1/idps/${i.id}`);}
console.log("spoke1 clean (before-state ready)");
'
pkill -9 -f "portal/server.mjs" 2>/dev/null
OUT=/tmp/proof; rm -rf "$OUT"; mkdir -p "$OUT"
OKTA_DEMO_CREDS=$HOME/okta-demo-creds.env DEMO_MODE=real node portal/server.mjs >/tmp/proof-server.log 2>&1 &
SRV=$!
for i in $(seq 1 25); do [ "$(curl -s -o /dev/null -w '%{http_code}' --max-time 2 http://localhost:3000/api/session)" = "200" ] && break; done
echo "server up; recording proof clip…"
LOGIN_USER="$(rd DEMO_LEAD_USER)" LOGIN_PASS="$(rd DEMO_LEAD_PASS)" TOTP_SECRET="$(rd DANA_TOTP_SECRET)" \
  SPOKE_ADMIN_CONSOLE="$(rd SPOKE_ADMIN_CONSOLE)" REC_DIR="$OUT" \
  node portal/recording/proof-clip.mjs
kill $SRV 2>/dev/null
V=$(ls "$OUT"/*.webm 2>/dev/null | head -1)
[ -z "$V" ] && { echo "NO VIDEO"; exit 1; }
echo "raw: $(ffprobe -v error -show_entries format=duration -of default=nk=1:nw=1 "$V")s"
ffmpeg -y -i "$V" -vf "fps=30,format=yuv420p" -c:v libx264 -preset medium -crf 20 -movflags +faststart "$OUT/spoke-portal-proof.mp4" >/tmp/proof-ffmpeg.log 2>&1
echo "MP4: $OUT/spoke-portal-proof.mp4 ($(ffprobe -v error -show_entries format=duration -of default=nk=1:nw=1 "$OUT/spoke-portal-proof.mp4")s)"
