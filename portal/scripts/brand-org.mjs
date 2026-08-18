// Apply Accenture branding to an org via the Brands API (theme colors, logo,
// favicon, company name). The spokes get this through the terraform baseline
// on every provision; this script is for one-time branding of the HUB (and
// handy for manual re-brands).
//
// Usage:
//   node portal/scripts/brand-org.mjs hub  [companyName]
//   node portal/scripts/brand-org.mjs <spoke-subdomain> [companyName]

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { loadCreds, spokePool, normalizeOrgDomain, sswsHeader } from "../src/config.mjs";
import { subdomainOf } from "../src/provision.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ASSETS = path.resolve(__dirname, "..", "terraform", "assets");

const target = process.argv[2];
const companyName = process.argv[3] || "Accenture | Identity Hub"; // company names are globally unique per Okta cell
if (!target) { console.error("usage: brand-org.mjs hub|<spoke-subdomain> [companyName]"); process.exit(1); }

const creds = loadCreds();
let domain, token;
if (target === "hub") {
  domain = normalizeOrgDomain(creds.HUB_ORG_DOMAIN);
  token = creds.HUB_API_TOKEN;
} else {
  const spoke = spokePool(creds).find((s) => subdomainOf(s) === target);
  if (!spoke) { console.error(`no configured spoke '${target}'`); process.exit(1); }
  domain = spoke.domain;
  token = spoke.token;
}

const h = { authorization: sswsHeader(token), accept: "application/json" };
const api = async (method, p, body, extraHeaders = {}) => {
  const r = await fetch(`https://${domain}${p}`, {
    method,
    headers: { ...h, ...extraHeaders },
    body,
  });
  const j = await r.json().catch(() => null);
  if (!r.ok) throw new Error(`${method} ${p} -> ${r.status} ${(j && j.errorSummary) || ""}`);
  return j;
};

const brands = await api("GET", "/api/v1/brands");
const brand = brands[0];
const themes = await api("GET", `/api/v1/brands/${brand.id}/themes`);
const theme = themes[0];
console.log(`brand ${brand.id} theme ${theme.id} on ${domain}`);

await api(
  "PUT",
  `/api/v1/brands/${brand.id}/themes/${theme.id}`,
  JSON.stringify({
    primaryColorHex: "#A100FF",
    secondaryColorHex: "#7500C0",
    signInPageTouchPointVariant: "BACKGROUND_SECONDARY_COLOR",
    endUserDashboardTouchPointVariant: "WHITE_LOGO_BACKGROUND",
    errorPageTouchPointVariant: "OKTA_DEFAULT",
    emailTemplateTouchPointVariant: "OKTA_DEFAULT",
  }),
  { "content-type": "application/json" }
);
console.log("theme colors + variants set");

async function uploadImage(kind, file) {
  const form = new FormData();
  form.append("file", new Blob([readFileSync(path.join(ASSETS, file))], { type: "image/png" }), file);
  await api("POST", `/api/v1/brands/${brand.id}/themes/${theme.id}/${kind}`, form);
  console.log(`${kind} uploaded`);
}
await uploadImage("logo", "accenture-logo.png");
await uploadImage("favicon", "accenture-favicon.png");

// POST is Okta's partial update for org settings (PUT is a strict full replace).
await api(
  "POST",
  "/api/v1/org",
  JSON.stringify({ companyName }),
  { "content-type": "application/json" }
);
console.log(`company name -> ${companyName}`);
console.log("done");
