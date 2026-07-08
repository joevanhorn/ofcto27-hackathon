// Real-mode spoke provisioning core.
//
// DEMO_MODE=real only. Spawns a real `terraform apply` against ONE claimed
// spoke org and streams every stdout/stderr line to a callback as it arrives —
// this is the on-camera "backend flash" the portal UI renders as a live
// terminal. Sim mode never imports the running of this (it is invoked only from
// IS_REAL-guarded paths in server.mjs), so the deterministic in-memory demo is
// untouched.
//
// SECURITY: the spoke admin token is passed to terraform ONLY through the child
// process environment (TF_VAR_spoke_api_token). It is NEVER placed in argv and
// NEVER passed to onLine. Nothing in this module logs the token.

import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { mkdirSync } from "node:fs";
import path from "node:path";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
// portal/src -> portal/terraform
export const TERRAFORM_DIR = path.resolve(__dirname, "..", "terraform");

// First DNS label of a spoke domain, e.g. "velocity27-spoke1.oktapreview.com"
// -> "velocity27-spoke1". This is the Okta org subdomain terraform wants as
// `spoke_org_name`, and also names the per-spoke state file.
export function subdomainOf(spoke) {
  if (spoke && spoke.subdomain) return spoke.subdomain;
  const domain = (spoke && spoke.domain) || "";
  return domain.split(".")[0];
}

// The base URL domain (everything after the first label), e.g.
// "velocity27-spoke1.oktapreview.com" -> "oktapreview.com".
export function baseUrlOf(spoke) {
  const domain = (spoke && spoke.domain) || "";
  const i = domain.indexOf(".");
  return i > 0 ? domain.slice(i + 1) : domain;
}

// Strip any leading "SSWS " / "SSWS_" prefix — terraform's okta provider wants
// the BARE token. Never logged.
function bareToken(token) {
  return (token || "").trim().replace(/^SSWS[ _]/i, "");
}

// Run a single `terraform apply`, streaming stdout+stderr line-by-line to
// onLine as soon as each newline arrives. Token never touches argv/onLine.
function runApply(stateFile, env, onLine) {
  const applyArgs = [
    "apply",
    "-auto-approve",
    "-no-color",
    "-input=false",
    `-state=${stateFile}`,
  ];

  return new Promise((resolve) => {
    const child = spawn("terraform", applyArgs, { cwd: TERRAFORM_DIR, env });

    // Line splitter shared across stdout+stderr so a callback fires per line as
    // soon as a newline arrives (not buffered until process exit).
    const makeSplitter = () => {
      let buf = "";
      return {
        push(chunk) {
          buf += chunk;
          let nl;
          while ((nl = buf.indexOf("\n")) !== -1) {
            const line = buf.slice(0, nl).replace(/\r$/, "");
            buf = buf.slice(nl + 1);
            onLine(line);
          }
        },
        flush() {
          if (buf.length) {
            onLine(buf.replace(/\r$/, ""));
            buf = "";
          }
        },
      };
    };

    const out = makeSplitter();
    const err = makeSplitter();
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (c) => out.push(c));
    child.stderr.on("data", (c) => err.push(c));

    child.on("error", (e) => {
      // e.g. terraform not on PATH. Surface a line but never a token.
      onLine(`error: failed to launch terraform (${e && e.message})`);
      resolve({ ok: false, code: null });
    });

    child.on("close", (code) => {
      out.flush();
      err.flush();
      resolve({ ok: code === 0, code });
    });
  });
}

/**
 * Provision one spoke with a live-streamed `terraform apply`, then converge
 * real SAML Org2Org federation (hub IdP -> spoke SP) over up to 3 passes.
 *
 * The two federation module instances (hub SAML app, spoke external IdP) never
 * reference each other — that would cycle the graph. Instead we thread outputs
 * of one pass into the *_url / hub_* carrier variables of the next:
 *   pass 1  hub SAML app is created                 -> hub_issuer/sso/certificate
 *   pass 2  spoke external IdP is created (needs hub creds) -> spoke_idp_id/acs
 *   pass 3  hub app updated so recipient/destination target the real spoke ACS
 *
 * @param {object} args
 * @param {{domain: string, token: string, subdomain?: string}} args.spoke
 * @param {{org_display_name: string, template_id?: string, retention_days?: string, data_region?: string}} args.vars
 * @param {{orgName: string, baseUrl?: string, apiToken: string}} [args.hub] - hub org creds; omit to skip federation.
 * @param {(line: string) => void} args.onLine - called for every output line as it arrives (real streaming).
 * @returns {Promise<{ok: true, outputs: object} | {ok: false, code: number|null}>}
 */
export async function provisionSpoke({ spoke, vars = {}, hub = null, federation = true, onLine = () => {} }) {
  const subdomain = subdomainOf(spoke);
  const baseUrl = baseUrlOf(spoke);
  const stateFile = path.join("state", `${subdomain}.tfstate`);

  // Ensure the per-spoke state directory exists.
  mkdirSync(path.join(TERRAFORM_DIR, "state"), { recursive: true });

  // Federation resources are created only when real hub creds are threaded AND
  // federation isn't explicitly disabled (baseline-only fast mode).
  const hubCreds = !!(hub && hub.orgName && hub.apiToken);
  const federationEnabled = federation !== false && hubCreds;
  const hubBase = (hub && hub.baseUrl) || "oktapreview.com";

  // Tokens (spoke AND hub) flow ONLY through env — never argv, never onLine.
  const env = {
    ...process.env,
    TF_IN_AUTOMATION: "1",
    TF_VAR_spoke_org_name: subdomain,
    TF_VAR_spoke_base_url: baseUrl,
    TF_VAR_spoke_api_token: bareToken(spoke && spoke.token),
    TF_VAR_org_display_name: vars.org_display_name || subdomain,
    TF_VAR_template_id: vars.template_id || "standard-spoke",
    TF_VAR_retention_days: String(vars.retention_days || "90"),
    TF_VAR_data_region: vars.data_region || "us",
    TF_VAR_enable_federation: federationEnabled ? "true" : "false",
  };
  // Hub creds are set whenever available — the aliased okta.hub PROVIDER must
  // initialize even in baseline-only mode (federation resources are count=0 then).
  if (hubCreds) {
    env.TF_VAR_hub_org_name = hub.orgName;
    env.TF_VAR_hub_base_url = hubBase;
    env.TF_VAR_hub_api_token = bareToken(hub.apiToken);
    env.TF_VAR_federation_label = `Federation to ${vars.org_display_name || subdomain}`;
  }

  // Cross-org carriers, threaded pass-to-pass. Seed from any existing state so
  // idempotent re-runs converge immediately instead of restarting from PENDING.
  let spokeAcs = `https://${subdomain}.${baseUrl}/sso/saml2/PENDING`;
  let hubIssuer = "";
  let hubSso = "";
  let hubCert = "";
  if (federationEnabled) {
    try {
      const seed = await collectOutputs(stateFile, env);
      if (seed.hub_issuer) hubIssuer = seed.hub_issuer;
      if (seed.hub_sso_url) hubSso = seed.hub_sso_url;
      if (seed.hub_certificate) hubCert = seed.hub_certificate;
      if (seed.spoke_idp_id) {
        spokeAcs = `https://${subdomain}.${baseUrl}/sso/saml2/${seed.spoke_idp_id}`;
      }
    } catch {
      /* no prior state — start from PENDING */
    }
  }

  const passes = federationEnabled ? 3 : 1;
  let out = {};
  for (let pass = 1; pass <= passes; pass++) {
    // Feed the current carrier values into this apply.
    env.TF_VAR_spoke_acs_url = spokeAcs;
    env.TF_VAR_hub_issuer = hubIssuer;
    env.TF_VAR_hub_sso_url = hubSso;
    env.TF_VAR_hub_certificate = hubCert; // env only — never onLine

    if (passes > 1) onLine(`>> federation converge pass ${pass}/${passes}`);

    const r = await runApply(stateFile, env, onLine);
    if (!r.ok) return { ok: false, code: r.code };

    try {
      out = await collectOutputs(stateFile, env);
    } catch {
      out = {};
    }

    if (!federationEnabled) break;

    // Absorb this pass's outputs into the carriers for the next pass.
    hubIssuer = out.hub_issuer || hubIssuer;
    hubSso = out.hub_sso_url || hubSso;
    hubCert = out.hub_certificate || hubCert;
    const fedAcs = spokeAcs; // the ACS the hub app was configured with this pass
    if (out.spoke_idp_id) {
      spokeAcs = `https://${subdomain}.${baseUrl}/sso/saml2/${out.spoke_idp_id}`;
    }
    // Converged once the hub app has real creds AND was applied with the real
    // spoke ACS (fedAcs === spokeAcs) — otherwise the hub still points at the
    // PENDING placeholder and another pass is required.
    if (
      hubCert &&
      out.spoke_idp_id &&
      out.spoke_acs_url === spokeAcs &&
      fedAcs === spokeAcs
    ) {
      break;
    }
  }

  return { ok: true, outputs: out };
}

// Read `terraform output -json` for the given state file and flatten the
// {value,...} wrappers into plain values. Does not stream — used post-apply.
function collectOutputs(stateFile, env) {
  return new Promise((resolve, reject) => {
    const child = spawn(
      "terraform",
      ["output", "-json", "-no-color", `-state=${stateFile}`],
      { cwd: TERRAFORM_DIR, env }
    );
    let json = "";
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (c) => (json += c));
    child.on("error", reject);
    child.on("close", (code) => {
      if (code !== 0) return reject(new Error("terraform output failed"));
      try {
        const raw = JSON.parse(json);
        const flat = {};
        for (const k of Object.keys(raw)) flat[k] = raw[k] && raw[k].value;
        resolve(flat);
      } catch (e) {
        reject(e);
      }
    });
  });
}
