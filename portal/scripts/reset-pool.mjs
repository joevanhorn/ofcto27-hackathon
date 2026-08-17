// reset-pool.mjs — CLI wrapper around the shared reset core (src/reset.mjs).
// The portal's in-UI "Reset demo" button uses the same core.
//
// Usage:
//   node portal/scripts/reset-pool.mjs             # reset every configured spoke
//   node portal/scripts/reset-pool.mjs spoke1-sub  # reset one spoke by subdomain
//
// Credentials come from the gitignored ~/okta-demo-creds.env (config.mjs).

import { loadCreds, spokePool, normalizeOrgDomain } from "../src/config.mjs";
import { subdomainOf } from "../src/provision.mjs";
import { resetPool } from "../src/reset.mjs";

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

const { clean } = await resetPool(spokes, hub, (line) => console.log(line));
console.log(clean
  ? "\nReset complete — restart the portal server (or use the in-UI button) for a fresh pool."
  : "\nWARNING: at least one spoke is not clean — check tokens and re-run.");
process.exit(clean ? 0 : 1);
