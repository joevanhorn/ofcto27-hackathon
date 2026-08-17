// reset-pool.mjs — return spoke orgs to the pre-warmed blank pool.
//
// Removes EVERYTHING the Org Factory portal provisions, via the Okta APIs
// (more reliable than `terraform destroy` when state has drifted), then
// clears the per-spoke terraform state so the server re-offers the org:
//   spoke: Baseline-Users group, all bookmark apps, external IdPs ("Hub SSO"),
//          IdP signing keys, non-default realms, certification campaigns
//   hub:   the "Federation to …" SAML app pointing at the spoke
//   local: portal/terraform/state/<subdomain>.tfstate*
//
// Usage:
//   node portal/scripts/reset-pool.mjs             # reset every configured spoke
//   node portal/scripts/reset-pool.mjs spoke1-sub  # reset one spoke by subdomain
//
// Credentials come from the gitignored ~/okta-demo-creds.env (config.mjs).
// Tokens are only ever sent in Authorization headers — never printed.

import { rmSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

import { loadCreds, spokePool, normalizeOrgDomain, sswsHeader } from "../src/config.mjs";
import { subdomainOf } from "../src/provision.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const STATE_DIR = path.resolve(__dirname, "..", "terraform", "state");

function client(domain, token) {
  const headers = {
    authorization: sswsHeader(token),
    accept: "application/json",
    "content-type": "application/json",
  };
  return async (method, p, body) => {
    const r = await fetch(`https://${domain}${p}`, {
      method,
      headers,
      body: body ? JSON.stringify(body) : undefined,
    });
    let json = null;
    try { json = await r.json(); } catch { /* empty/no body */ }
    return { status: r.status, ok: r.ok, json };
  };
}

async function resetSpoke(spoke, hub) {
  const sub = subdomainOf(spoke);
  console.log(`\n=== ${spoke.domain} ===`);
  if (!spoke.token) {
    console.log("  no token configured — skipped");
    return false;
  }
  const api = client(spoke.domain, spoke.token);

  const me = await api("GET", "/api/v1/users/me");
  if (!me.ok) {
    console.log(`  token check failed (HTTP ${me.status}) — skipped`);
    return false;
  }

  let removed = 0;

  // 1. Certification campaigns (must be ended before deletion when active).
  const camps = await api("GET", "/governance/api/v1/campaigns?limit=50");
  if (camps.ok) {
    const list = (camps.json && camps.json.data) || [];
    for (const c of list) {
      if (c.status === "ACTIVE" || c.status === "LAUNCHED") {
        await api("POST", `/governance/api/v1/campaigns/${c.id}/end`);
      }
      const del = await api("DELETE", `/governance/api/v1/campaigns/${c.id}`);
      if (del.ok || del.status === 204) removed++;
    }
    if (list.length) console.log(`  campaigns: removed ${list.length}`);
  }

  // 2. All bookmark apps (welcome + template-deployed) — deactivate then delete.
  const apps = await api("GET", "/api/v1/apps?limit=200");
  for (const a of Array.isArray(apps.json) ? apps.json : []) {
    if (a.signOnMode !== "BOOKMARK") continue;
    await api("POST", `/api/v1/apps/${a.id}/lifecycle/deactivate`);
    const del = await api("DELETE", `/api/v1/apps/${a.id}`);
    if (del.ok || del.status === 204) { removed++; console.log(`  app: deleted '${a.label}'`); }
  }

  // 3. Baseline group.
  const groups = await api("GET", "/api/v1/groups?q=Baseline-Users&limit=25");
  for (const g of Array.isArray(groups.json) ? groups.json : []) {
    if (g.profile && g.profile.name === "Baseline-Users") {
      const del = await api("DELETE", `/api/v1/groups/${g.id}`);
      if (del.ok || del.status === 204) { removed++; console.log("  group: deleted Baseline-Users"); }
    }
  }

  // 4. External IdPs from federation (and their signing keys).
  const idps = await api("GET", "/api/v1/idps?limit=100");
  const kids = new Set();
  for (const idp of Array.isArray(idps.json) ? idps.json : []) {
    if (idp.type !== "SAML2") continue;
    const kid = idp.protocol && idp.protocol.credentials && idp.protocol.credentials.trust
      ? idp.protocol.credentials.trust.kid
      : null;
    if (kid) kids.add(kid);
    await api("POST", `/api/v1/idps/${idp.id}/lifecycle/deactivate`);
    const del = await api("DELETE", `/api/v1/idps/${idp.id}`);
    if (del.ok || del.status === 204) { removed++; console.log(`  idp: deleted '${idp.name}'`); }
  }
  for (const kid of kids) {
    await api("DELETE", `/api/v1/idps/credentials/keys/${kid}`);
  }

  // 5. Non-default realms.
  const realms = await api("GET", "/api/v1/realms?limit=100");
  const realmList = (realms.json && (realms.json.realms || realms.json)) || [];
  for (const r of Array.isArray(realmList) ? realmList : []) {
    if (r.isDefault || (r.profile && r.profile.isDefault)) continue;
    const del = await api("DELETE", `/api/v1/realms/${r.id}`);
    const name = (r.profile && r.profile.name) || r.name || r.id;
    if (del.ok || del.status === 204) { removed++; console.log(`  realm: deleted '${name}'`); }
  }

  // 6. Hub side: the federation SAML app that targets this spoke.
  if (hub && hub.token) {
    const hubApi = client(hub.domain, hub.token);
    const hubApps = await hubApi("GET", "/api/v1/apps?limit=200");
    for (const a of Array.isArray(hubApps.json) ? hubApps.json : []) {
      if (a.signOnMode !== "SAML_2_0") continue;
      if (!/^Federation to /.test(a.label || "")) continue;
      if (!JSON.stringify(a.settings || {}).includes(spoke.domain)) continue;
      await hubApi("POST", `/api/v1/apps/${a.id}/lifecycle/deactivate`);
      const del = await hubApi("DELETE", `/api/v1/apps/${a.id}`);
      if (del.ok || del.status === 204) { removed++; console.log(`  hub: deleted '${a.label}'`); }
    }
  }

  // 7. Local terraform state — the server treats a state-less spoke as blank.
  for (const suffix of [".tfstate", ".tfstate.backup"]) {
    try { rmSync(path.join(STATE_DIR, `${sub}${suffix}`)); console.log(`  state: removed ${sub}${suffix}`); } catch { /* absent */ }
  }

  // Verify blank: no baseline group, no bookmark apps.
  const vg = await api("GET", "/api/v1/groups?q=Baseline-Users&limit=5");
  const va = await api("GET", "/api/v1/apps?limit=200");
  const leftoverApps = (Array.isArray(va.json) ? va.json : []).filter((a) => a.signOnMode === "BOOKMARK").length;
  const clean = (Array.isArray(vg.json) ? vg.json.length : 1) === 0 && leftoverApps === 0;
  console.log(`  ${clean ? "CLEAN — back in the pool" : `NOT CLEAN (groups=${vg.json && vg.json.length}, bookmark apps=${leftoverApps})`}`);
  return clean;
}

const only = process.argv[2] || null;
const creds = loadCreds();
const spokes = spokePool(creds).filter((s) => !only || subdomainOf(s) === only);
if (!spokes.length) {
  console.error(only ? `no configured spoke matches '${only}'` : "no spokes configured");
  process.exit(1);
}
const hubDomain = normalizeOrgDomain(creds.HUB_ORG_DOMAIN || "");
const hub = hubDomain && creds.HUB_API_TOKEN ? { domain: hubDomain, token: creds.HUB_API_TOKEN } : null;
if (!hub) console.log("(hub creds missing — hub-side federation apps will not be cleaned)");

let allClean = true;
for (const spoke of spokes) {
  allClean = (await resetSpoke(spoke, hub)) && allClean;
}
console.log(allClean
  ? "\nReset complete — restart the portal server for a fresh pool."
  : "\nWARNING: at least one spoke is not clean — check tokens and re-run.");
process.exit(allClean ? 0 : 1);
