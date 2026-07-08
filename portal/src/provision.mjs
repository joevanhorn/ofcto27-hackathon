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

/**
 * Run `terraform apply` for one spoke, streaming output line-by-line.
 *
 * @param {object} args
 * @param {{domain: string, token: string, subdomain?: string}} args.spoke
 * @param {{org_display_name: string, template_id?: string, retention_days?: string, data_region?: string}} args.vars
 * @param {(line: string) => void} args.onLine - called for every output line as it arrives (real streaming).
 * @returns {Promise<{ok: true, outputs: object} | {ok: false, code: number|null}>}
 */
export function provisionSpoke({ spoke, vars = {}, onLine = () => {} }) {
  const subdomain = subdomainOf(spoke);
  const baseUrl = baseUrlOf(spoke);
  const stateFile = path.join("state", `${subdomain}.tfstate`);

  // Ensure the per-spoke state directory exists.
  mkdirSync(path.join(TERRAFORM_DIR, "state"), { recursive: true });

  // Token flows ONLY through env — never argv, never onLine.
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
  };

  const applyArgs = [
    "apply",
    "-auto-approve",
    "-no-color",
    "-input=false",
    `-state=${stateFile}`,
  ];

  return new Promise((resolve) => {
    const child = spawn("terraform", applyArgs, {
      cwd: TERRAFORM_DIR,
      env,
    });

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
      if (code !== 0) {
        resolve({ ok: false, code });
        return;
      }
      // Collect outputs via a second, quiet terraform invocation.
      collectOutputs(stateFile, env)
        .then((outputs) => resolve({ ok: true, outputs }))
        .catch(() => resolve({ ok: true, outputs: {} }));
    });
  });
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
