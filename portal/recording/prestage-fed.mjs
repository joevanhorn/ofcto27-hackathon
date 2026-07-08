// Pre-stage SAML federation for one spoke, isolated from the portal (direct
// terraform, its own state, -target the federation modules so baseline is
// untouched). 3-pass carrier convergence. Prints hub_sso_entry_url.
import { spawn } from "node:child_process";
import { loadCreds, normalizeOrgDomain, spokePool } from "../src/config.mjs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const TF_DIR = join(dirname(fileURLToPath(import.meta.url)), "..", "terraform");
const c = loadCreds();
const hubDom = normalizeOrgDomain(c.HUB_ORG_DOMAIN);
const spoke = spokePool(c)[Number(process.env.SPOKE_INDEX || 0)];
const sub = spoke.domain.split(".")[0];
const base = spoke.domain.split(".").slice(1).join(".");
const bare = (t) => (t || "").replace(/^SSWS[ _]/i, "");
const STATE = `state/fed-${sub}.tfstate`;
const TARGETS = ["-target=data.okta_group.hub_division_leads",
  "-target=module.hub_federation", "-target=module.spoke_federation"];

const baseEnv = {
  ...process.env,
  TF_VAR_spoke_org_name: sub, TF_VAR_spoke_base_url: base, TF_VAR_spoke_api_token: bare(spoke.token),
  TF_VAR_org_display_name: process.env.ORG_NAME || "NA Sales Demo",
  TF_VAR_template_id: "standard-spoke", TF_VAR_retention_days: "90", TF_VAR_data_region: "us",
  TF_VAR_enable_federation: "true",
  TF_VAR_hub_org_name: hubDom.split(".")[0], TF_VAR_hub_base_url: hubDom.split(".").slice(1).join("."),
  TF_VAR_hub_api_token: bare(c.HUB_API_TOKEN),
  TF_VAR_federation_label: `Federation to ${process.env.ORG_NAME || "NA Sales Demo"}`,
};

function run(args, env) {
  return new Promise((resolve, reject) => {
    const p = spawn("terraform", args, { cwd: TF_DIR, env });
    let out = "";
    p.stdout.on("data", (d) => { out += d; process.stdout.write(d); });
    p.stderr.on("data", (d) => process.stdout.write(d));
    p.on("close", (code) => (code === 0 ? resolve(out) : reject(new Error("terraform exit " + code))));
  });
}
async function outputs() {
  const o = await run(["output", "-json", "-state=" + STATE], baseEnv);
  const j = JSON.parse(o);
  const g = (k) => (j[k] ? j[k].value : "");
  return { hubIssuer: g("hub_issuer"), hubSso: g("hub_sso_url"), hubCert: g("hub_certificate"),
    spokeIdp: g("spoke_idp_id"), spokeAcs: g("spoke_acs_url"), spokeAud: g("spoke_audience"),
    entry: g("hub_sso_entry_url") };
}

let spokeAcs = `https://${sub}.${base}/sso/saml2/PENDING`, spokeAud = "", hubIssuer = "", hubSso = "", hubCert = "";
// Seed carriers from any existing state so re-runs converge without churn.
try {
  const s = await outputs();
  if (s.hubIssuer) hubIssuer = s.hubIssuer;
  if (s.hubSso) hubSso = s.hubSso;
  if (s.hubCert) hubCert = s.hubCert;
  if (s.spokeIdp) spokeAcs = `https://${sub}.${base}/sso/saml2/${s.spokeIdp}`;
  if (s.spokeAud) spokeAud = s.spokeAud;
} catch { /* no prior state */ }
for (let pass = 1; pass <= 3; pass++) {
  const t0 = Date.now();
  const fedAcs = spokeAcs; // ACS actually fed to the hub app this pass
  const fedAud = spokeAud; // audience actually fed to the hub app this pass
  const env = { ...baseEnv, TF_VAR_spoke_acs_url: fedAcs, TF_VAR_spoke_audience: fedAud, TF_VAR_hub_issuer: hubIssuer, TF_VAR_hub_sso_url: hubSso, TF_VAR_hub_certificate: hubCert };
  console.log(`\n===== PASS ${pass} =====`);
  await run(["apply", "-auto-approve", "-no-color", "-input=false", "-state=" + STATE, ...TARGETS], env);
  const o = await outputs();
  hubIssuer = o.hubIssuer; hubSso = o.hubSso; hubCert = o.hubCert;
  if (o.spokeIdp) spokeAcs = `https://${sub}.${base}/sso/saml2/${o.spokeIdp}`;
  if (o.spokeAud) spokeAud = o.spokeAud;
  console.log(`pass ${pass} done in ${((Date.now() - t0) / 1000).toFixed(0)}s | spokeIdp=${o.spokeIdp ? "set" : "-"} | fedAcs=${fedAcs.endsWith("PENDING") ? "PENDING" : "real"} | fedAud=${fedAud ? "set" : "-"}`);
  // Converge once the hub app was applied with the REAL spoke ACS *and* audience.
  if (hubCert && o.spokeIdp && fedAcs === spokeAcs && fedAud === spokeAud && spokeAud) { console.log("CONVERGED"); break; }
}
const fin = await outputs();
console.log("\nHUB_SSO_ENTRY_URL=" + fin.entry);
