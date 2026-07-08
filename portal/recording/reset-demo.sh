#!/bin/bash
# reset-demo.sh — reset the STATIC demo tenant pool to a clean state between
# takes / rehearsals. Idempotent and safe to run repeatedly.
#
# What it does:
#   1. Kills stray portal servers + terraform/provider processes and clears
#      terraform state locks (the usual cause of "hung provision").
#   2. Deletes the per-spoke BASELINE provision on EVERY spoke via the Okta API
#      (the "Baseline-Users" group + any "*Welcome" bookmark apps) — more reliable
#      than `terraform destroy` when state has been cleared/drifted.
#   3. Clears the per-spoke BASELINE terraform state, but LEAVES the pre-staged
#      SAML federation state (state/fed-*.tfstate) intact — the SSO finale needs it.
#   4. Verifies each spoke is clean so the next take provisions fresh on camera.
#
# The in-memory org pool + sessions reset automatically on server restart.
#
# Usage:  bash portal/recording/reset-demo.sh
# Creds come from the gitignored ~/okta-demo-creds.env (via portal/src/config.mjs).
set -uo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$ROOT" || { echo "cannot cd to repo root"; exit 1; }

echo "==> [1/4] Killing stray processes + clearing terraform locks"
pkill -9 -f "portal/server.mjs" 2>/dev/null || true
pkill -9 -f "terraform"          2>/dev/null || true
rm -f portal/terraform/state/*.lock.info 2>/dev/null || true

echo "==> [2/4] Deleting leftover BASELINE resources on every spoke (federation left intact)"
node --input-type=module -e '
import { loadCreds, spokePool, sswsHeader } from "./portal/src/config.mjs";
const spokes = spokePool(loadCreds());
if (!spokes.length) { console.log("  (no spokes configured in ~/okta-demo-creds.env)"); process.exit(0); }
for (const sp of spokes) {
  if (!sp.token) { console.log(`  ${sp.domain}: no token — skipped`); continue; }
  const h = { Authorization: sswsHeader(sp.token), Accept: "application/json", "Content-Type": "application/json" };
  const api = async (m, p) => { const r = await fetch(`https://${sp.domain}${p}`, { method: m, headers: h }); let j = null; try { j = await r.json(); } catch {} return { s: r.status, j }; };
  let n = 0;
  const gs = (await api("GET", "/api/v1/groups?q=Baseline-Users&limit=25")).j || [];
  for (const g of gs) if (g.profile?.name === "Baseline-Users") { await api("DELETE", `/api/v1/groups/${g.id}`); n++; }
  const as = (await api("GET", "/api/v1/apps?limit=100")).j || [];
  for (const a of as) if (a.signOnMode === "BOOKMARK" && /Welcome/i.test(a.label || "")) { await api("POST", `/api/v1/apps/${a.id}/lifecycle/deactivate`); await api("DELETE", `/api/v1/apps/${a.id}`); n++; }
  console.log(`  ${sp.domain}: removed ${n} baseline resource(s)`);
}
' || echo "  (cleanup step reported an error — continuing)"

echo "==> [3/4] Clearing per-spoke BASELINE terraform state (keeping fed-*.tfstate)"
find portal/terraform/state -maxdepth 1 -type f -name '*.tfstate*' ! -name 'fed-*' -delete 2>/dev/null || true
kept="$(ls portal/terraform/state/fed-*.tfstate 2>/dev/null | wc -l | tr -d ' ')"
echo "  kept ${kept} pre-staged federation state file(s)"

echo "==> [4/4] Verifying spokes are clean"
node --input-type=module -e '
import { loadCreds, spokePool, sswsHeader } from "./portal/src/config.mjs";
let ok = true;
for (const sp of spokePool(loadCreds())) {
  if (!sp.token) continue;
  const h = { Authorization: sswsHeader(sp.token), Accept: "application/json" };
  const g = await (await fetch(`https://${sp.domain}/api/v1/groups?q=Baseline-Users&limit=5`, { headers: h })).json();
  const apps = await (await fetch(`https://${sp.domain}/api/v1/apps?limit=100`, { headers: h })).json();
  const a = (Array.isArray(apps) ? apps : []).filter(x => x.signOnMode === "BOOKMARK" && /Welcome/i.test(x.label || ""));
  const clean = (Array.isArray(g) ? g.length : 1) === 0 && a.length === 0;
  ok = ok && clean;
  console.log(`  ${sp.domain}: ${clean ? "CLEAN" : `STILL HAS baseline (groups=${g.length}, apps=${a.length})`}`);
}
process.exit(ok ? 0 : 1);
'
RC=$?

echo ""
echo "Restart the server for a fresh in-memory pool + signed-out state:"
echo "  OKTA_DEMO_CREDS=\$HOME/okta-demo-creds.env DEMO_MODE=real DEMO_FEDERATION=off node portal/server.mjs"
if [ "$RC" -eq 0 ]; then
  echo "Reset complete — the demo pool is clean and ready for a fresh take."
else
  echo "WARNING: a spoke still shows baseline resources — re-run, or check the spoke token."
fi
exit "$RC"
