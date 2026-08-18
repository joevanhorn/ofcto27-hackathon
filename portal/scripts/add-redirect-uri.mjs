// Add a redirect URI to the hub OIDC app (idempotent).
// Usage: node portal/scripts/add-redirect-uri.mjs https://org-portal.owi-demo.com/callback
import { loadCreds, normalizeOrgDomain, sswsHeader } from "../src/config.mjs";

const uri = process.argv[2];
if (!uri) { console.error("usage: add-redirect-uri.mjs <uri>"); process.exit(1); }

const creds = loadCreds();
const hub = normalizeOrgDomain(creds.HUB_ORG_DOMAIN);
const h = { authorization: sswsHeader(creds.HUB_API_TOKEN), accept: "application/json", "content-type": "application/json" };
const app = await (await fetch(`https://${hub}/api/v1/apps/${creds.OIDC_CLIENT_ID}`, { headers: h })).json();
const uris = app.settings.oauthClient.redirect_uris || [];
if (uris.includes(uri)) {
  console.log("already present:", uris);
} else {
  app.settings.oauthClient.redirect_uris = [...uris, uri];
  const r = await fetch(`https://${hub}/api/v1/apps/${app.id}`, { method: "PUT", headers: h, body: JSON.stringify(app) });
  const j = await r.json();
  console.log("update:", r.status, j.settings?.oauthClient?.redirect_uris || j.errorSummary);
}
