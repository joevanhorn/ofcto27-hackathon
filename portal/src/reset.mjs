// Pool reset core — returns spoke orgs to the pre-warmed blank state.
//
// Removes EVERYTHING the portal provisions, via the Okta APIs (more reliable
// than `terraform destroy` when state has drifted), then clears the per-spoke
// terraform state so the org is offered as blank again:
//   spoke: certification campaigns, all bookmark apps, Baseline-Users group,
//          external IdPs ("Hub SSO") + signing keys, non-default realms
//   hub:   the "Federation to …" SAML app pointing at the spoke
//   local: portal/terraform/state/<subdomain>.tfstate*
//
// Used by the POST /api/pool/reset route (demo reset button) and by
// portal/scripts/reset-pool.mjs (CLI). Tokens are only ever sent in
// Authorization headers — never passed to onLine.

import { rmSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

import { sswsHeader } from "./config.mjs";
import { subdomainOf } from "./provision.mjs";

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

/**
 * Reset one spoke org to blank. Returns { subdomain, clean, removed }.
 *
 * @param {{domain: string, token: string|null, subdomain?: string}} spoke
 * @param {{domain: string, token: string}|null} hub - for cleaning the hub-side federation app
 * @param {(line: string) => void} [onLine]
 */
export async function resetSpoke(spoke, hub, onLine = () => {}) {
  const sub = subdomainOf(spoke);
  onLine(`=== ${spoke.domain} ===`);
  if (!spoke.token) {
    onLine("  no token configured — skipped");
    return { subdomain: sub, clean: false, removed: 0 };
  }
  const api = client(spoke.domain, spoke.token);

  const me = await api("GET", "/api/v1/users/me");
  if (!me.ok) {
    onLine(`  token check failed (HTTP ${me.status}) — skipped`);
    return { subdomain: sub, clean: false, removed: 0 };
  }

  let removed = 0;

  // 1. Certification campaigns (end active ones before deletion).
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
    if (list.length) onLine(`  campaigns: removed ${list.length}`);
  }

  // 2. All bookmark apps (welcome + template-deployed).
  const apps = await api("GET", "/api/v1/apps?limit=200");
  for (const a of Array.isArray(apps.json) ? apps.json : []) {
    if (a.signOnMode !== "BOOKMARK") continue;
    await api("POST", `/api/v1/apps/${a.id}/lifecycle/deactivate`);
    const del = await api("DELETE", `/api/v1/apps/${a.id}`);
    if (del.ok || del.status === 204) { removed++; onLine(`  app: deleted '${a.label}'`); }
  }

  // 3. Baseline group.
  const groups = await api("GET", "/api/v1/groups?q=Baseline-Users&limit=25");
  for (const g of Array.isArray(groups.json) ? groups.json : []) {
    if (g.profile && g.profile.name === "Baseline-Users") {
      const del = await api("DELETE", `/api/v1/groups/${g.id}`);
      if (del.ok || del.status === 204) { removed++; onLine("  group: deleted Baseline-Users"); }
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
    if (del.ok || del.status === 204) { removed++; onLine(`  idp: deleted '${idp.name}'`); }
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
    if (del.ok || del.status === 204) { removed++; onLine(`  realm: deleted '${name}'`); }
  }

  // 5a. The baseline's dashboard 1FA rule (portal-created on the "Okta
  // Dashboard" access policy; never touch system rules like Catch-all).
  const spokeApps = await api("GET", "/api/v1/apps?limit=200");
  const dash = (Array.isArray(spokeApps.json) ? spokeApps.json : []).find(
    (a) => a.name === "okta_enduser"
  );
  const dashPolicyId = dash && dash._links && dash._links.accessPolicy
    ? dash._links.accessPolicy.href.split("/").pop()
    : null;
  if (dashPolicyId) {
    const rules = await api("GET", `/api/v1/policies/${dashPolicyId}/rules`);
    for (const rule of Array.isArray(rules.json) ? rules.json : []) {
      if (rule.system || !/^Baseline — /.test(rule.name || "")) continue;
      const del = await api("DELETE", `/api/v1/policies/${dashPolicyId}/rules/${rule.id}`);
      if (del.ok || del.status === 204) { removed++; onLine(`  policy rule: deleted '${rule.name}'`); }
    }
  }

  // 5b. JIT-provisioned federated users (so the next take shows JIT fresh).
  // Only users whose credential provider is FEDERATION — never local admins.
  const users = await api("GET", "/api/v1/users?limit=200");
  for (const u of Array.isArray(users.json) ? users.json : []) {
    const provider = u.credentials && u.credentials.provider && u.credentials.provider.type;
    if (provider !== "FEDERATION") continue;
    await api("POST", `/api/v1/users/${u.id}/lifecycle/deactivate`);
    const del = await api("DELETE", `/api/v1/users/${u.id}`);
    if (del.ok || del.status === 204) {
      removed++;
      onLine(`  user: deleted JIT-provisioned '${(u.profile && u.profile.login) || u.id}'`);
    }
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
      if (del.ok || del.status === 204) { removed++; onLine(`  hub: deleted '${a.label}'`); }
    }
  }

  // 7. Local terraform state — the server treats a state-less spoke as blank.
  for (const suffix of [".tfstate", ".tfstate.backup"]) {
    try { rmSync(path.join(STATE_DIR, `${sub}${suffix}`)); onLine(`  state: removed ${sub}${suffix}`); } catch { /* absent */ }
  }

  // Verify blank: no baseline group, no bookmark apps.
  const vg = await api("GET", "/api/v1/groups?q=Baseline-Users&limit=5");
  const va = await api("GET", "/api/v1/apps?limit=200");
  const leftoverApps = (Array.isArray(va.json) ? va.json : []).filter((a) => a.signOnMode === "BOOKMARK").length;
  const clean = (Array.isArray(vg.json) ? vg.json.length : 1) === 0 && leftoverApps === 0;
  onLine(`  ${clean ? "CLEAN — back in the pool" : `NOT CLEAN (groups=${vg.json && vg.json.length}, bookmark apps=${leftoverApps})`}`);
  return { subdomain: sub, clean, removed };
}

/**
 * Reset every given spoke. Returns { clean, results, lines }.
 */
export async function resetPool(spokes, hub, onLine = () => {}) {
  const results = [];
  for (const spoke of spokes) {
    results.push(await resetSpoke(spoke, hub, onLine));
  }
  return { clean: results.every((r) => r.clean), results };
}
