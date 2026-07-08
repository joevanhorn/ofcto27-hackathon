// Real-mode config + credential loader.
// DEMO_MODE=sim (default) keeps the fully in-memory, stage-safe demo.
// DEMO_MODE=real loads credentials from a gitignored env file (default
// ~/okta-demo-creds.env, override with OKTA_DEMO_CREDS) and wires real Okta.
// Credentials are NEVER committed or logged.
import { readFileSync, existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export const DEMO_MODE = (process.env.DEMO_MODE || "sim").toLowerCase();
export const IS_REAL = DEMO_MODE === "real";

export function loadCreds() {
  const path =
    process.env.OKTA_DEMO_CREDS || join(homedir(), "okta-demo-creds.env");
  const creds = {};
  if (existsSync(path)) {
    for (const line of readFileSync(path, "utf8").split("\n")) {
      if (/^\s*#/.test(line) || !line.trim()) continue;
      const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
      if (m) creds[m[1]] = m[2].replace(/^["']|["']$/g, "").trim();
    }
  }
  return creds;
}

// Parse the comma-separated spoke pool into {domain, token} pairs.
export function spokePool(creds) {
  const domains = (creds.SPOKE_ORG_DOMAINS || "").split(",").map((s) => s.trim()).filter(Boolean);
  const tokens = (creds.SPOKE_API_TOKENS || "").split(",").map((s) => s.trim()).filter(Boolean);
  return domains.map((domain, i) => ({ domain, token: tokens[i] || null }));
}
