// Post-apply orchestration for the optional TaskVantage Active Directory.
//
// Terraform only LAUNCHES the DC; the directory then builds itself across
// three boots (~20 min) and reports progress through an SSM parameter
// (/taskvantage/<spoke>/setup-phase — see modules/active-directory). This
// module watches that parameter in the background so the provisioning job can
// return immediately, and owns the teardown used by reset.mjs.
//
// Zero-dependency by design (like the rest of the portal): all AWS access goes
// through the `aws` CLI with the host instance role — no SDK, no static keys.
// SECURITY: the Administrator password only ever moves SSM -> caller; it is
// never logged and never lands in orgs.json (only the parameter NAME does).

import { spawn } from "node:child_process";
import { randomInt } from "node:crypto";

const POLL_MS = 30_000;
const WATCH_TIMEOUT_MS = 40 * 60_000;

function aws(args, { timeoutMs = 30_000 } = {}) {
  return new Promise((resolve) => {
    const child = spawn("aws", args, { stdio: ["ignore", "pipe", "pipe"] });
    let out = "";
    let err = "";
    const timer = setTimeout(() => child.kill("SIGKILL"), timeoutMs);
    child.stdout.on("data", (d) => (out += d));
    child.stderr.on("data", (d) => (err += d));
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({ code, out: out.trim(), err: err.trim() });
    });
    child.on("error", () => {
      clearTimeout(timer);
      resolve({ code: -1, out: "", err: "aws CLI not available" });
    });
  });
}

// Windows-complexity password: length 20, all four character classes, and no
// shell/PowerShell-hostile characters (it transits TF_VAR env + SSM only).
export function generateAdPassword() {
  const sets = [
    "ABCDEFGHJKLMNPQRSTUVWXYZ",
    "abcdefghijkmnopqrstuvwxyz",
    "23456789",
    "!@#%^*-_=+",
  ];
  const all = sets.join("");
  const chars = sets.map((s) => s[randomInt(s.length)]);
  while (chars.length < 20) chars.push(all[randomInt(all.length)]);
  for (let i = chars.length - 1; i > 0; i--) {
    const j = randomInt(i + 1);
    [chars[i], chars[j]] = [chars[j], chars[i]];
  }
  return chars.join("");
}

// Unique NetBIOS computer name per spoke — every DC shares one subnet, so
// duplicate computer names would collide (duplicate DOMAIN names are fine).
export function computerNameFor(subdomain) {
  const cleaned = String(subdomain || "").replace(/[^a-z0-9]/gi, "");
  return ("TV-" + cleaned.slice(-12)).toUpperCase().slice(0, 15);
}

export async function getAdPhase(statusParam) {
  const r = await aws([
    "ssm", "get-parameter",
    "--name", statusParam,
    "--query", "Parameter.Value",
    "--output", "text",
  ]);
  return r.code === 0 ? r.out : null;
}

export async function revealAdPassword(passwordParam) {
  const r = await aws([
    "ssm", "get-parameter",
    "--name", passwordParam,
    "--with-decryption",
    "--query", "Parameter.Value",
    "--output", "text",
  ]);
  return r.code === 0 ? r.out : null;
}

const PHASE_TEXT = {
  LAUNCHING: "instance booting",
  ADDS_INSTALLED: "AD Domain Services installed — rebooting",
  PROMOTION_STARTED: "promoting taskvantage.local forest (longest step, ~10 min)",
  SCHEMA_APPLIED: "tv* schema extensions applied",
  USERS_CREATED: "core OUs, groups and sample users populated",
  OUS_CREATED: "242-OU enterprise tree created",
  AGENT_STAGED: "Okta AD agent staged on the DC",
  READY: "directory ready — finish the Okta import (see checklist on the org card)",
};

export function describePhase(phase) {
  if (!phase) return "status unknown";
  if (phase.startsWith("ERROR:")) return `setup error (${phase.slice(6)})`;
  return PHASE_TEXT[phase] || phase;
}

/**
 * Background watcher: polls the DC's setup-phase parameter until READY /
 * ERROR / timeout, recording transitions on org.ad and persisting via
 * saveOrgs. Fire-and-forget — never throws.
 *
 * @param {object} args
 * @param {object} args.org - org record with .ad {statusParam, log, ...}
 * @param {() => void} args.saveOrgs - persistence hook
 * @param {(line: string) => void} [args.onLine] - optional live console feed
 */
export function startDirectoryWatch({ org, saveOrgs, onLine = () => {} }) {
  const ad = org && org.ad;
  if (!ad || !ad.statusParam) return;
  const deadline = Date.now() + WATCH_TIMEOUT_MS;
  let lastPhase = ad.phase || "";

  const tick = async () => {
    try {
      const phase = await getAdPhase(ad.statusParam);
      if (phase && phase !== lastPhase) {
        lastPhase = phase;
        ad.phase = phase;
        ad.updatedAt = new Date().toISOString();
        ad.log = [...(ad.log || []), `${ad.updatedAt} ${phase}`].slice(-50);
        onLine(`>> active directory: ${describePhase(phase)}`);
        if (phase === "READY") ad.status = "ready";
        else if (phase.startsWith("ERROR:")) {
          ad.status = "error";
          ad.reason = phase;
        }
        saveOrgs();
      }
      if (ad.status === "ready" || ad.status === "error") return;
      if (Date.now() > deadline) {
        ad.status = "timeout";
        ad.reason = "no READY signal within 40 min — check C:\\Terraform\\bootstrap.log via SSM";
        ad.updatedAt = new Date().toISOString();
        saveOrgs();
        return;
      }
    } catch {
      // transient — keep polling until the deadline
    }
    setTimeout(tick, POLL_MS).unref?.();
  };
  setTimeout(tick, POLL_MS).unref?.();
}

// Sim-mode "Migrate to Okta-managed": the same beats the real engine
// (src/migrate.mjs) streams, scripted off elapsed time so the demo is
// deterministic and stage-safe. Pure function — unit-tested directly.
const SIM_MIGRATION_SCRIPT = [
  [0, ">> migrate: found AD integration 'Active Directory' (ACTIVE)"],
  [2_000, ">> migrate: 20 AD-imported user(s), 14 AD-mastered group(s) to mirror"],
  [5_000, ">> migrate: mirrored 'Site-Managers', 'Field-Technicians', 'Territory-Managers' + 11 more"],
  [8_000, ">> migrate: no app assignments were riding AD groups — nothing to re-target"],
  [11_000, '>> migrate: rule: tvOrgTerritoryID == "T-100" -> group \'Territory T-100\' (the OU tree is now policy)'],
  [13_000, '>> migrate: rule: tvOrgTerritoryID == "T-200" -> group \'Territory T-200\''],
  [16_000, ">> migrate: AD integration deactivated — profile sourcing falls through to Okta"],
  [19_000, ">> migrate: password continuity: 20/20 users keep their password (Password Sync stand-in)"],
  [22_000, ">> migrate: verified: 20/20 users now Okta-sourced"],
  [24_000, ">> migrate: complete — 14 groups mirrored, 2 attribute rule(s), 20/20 users Okta-sourced. AD is now load-bearing nothing."],
];
const SIM_MIGRATION_DONE_MS = 24_000;

export function simMigration(elapsedMs) {
  const log = SIM_MIGRATION_SCRIPT.filter(([at]) => elapsedMs >= at).map(([, l]) => l);
  return {
    status: elapsedMs >= SIM_MIGRATION_DONE_MS ? "migrated" : "running",
    log,
  };
}

/**
 * Tear down a spoke's AD resources. Called by reset.mjs BEFORE it deletes the
 * per-spoke terraform state (otherwise the Windows EC2 would leak and keep
 * billing). Two layers:
 *   1. targeted `terraform destroy -target=module.active_directory` when the
 *      state file records the module
 *   2. tag-sweep fallback: terminate instances tagged TaskVantageSpoke=<sub>,
 *      delete the /taskvantage/<sub>/* SSM params and the tv-ad-<sub> IAM
 *      role/profile
 * Never touches the shared ad-network VPC.
 */
export async function destroySpokeAd({
  sub,
  terraformDir,
  stateFile,
  stateHasAdModule,
  env = {},
  onLine = () => {},
}) {
  let destroyed = false;

  if (stateHasAdModule) {
    onLine(`  ad: destroying domain controller via terraform…`);
    destroyed = await new Promise((resolve) => {
      const child = spawn(
        "terraform",
        [
          "destroy", "-auto-approve", "-no-color", "-input=false", "-lock=false",
          "-target=module.active_directory",
          `-state=state/${sub}.tfstate`,
        ],
        { cwd: terraformDir, env: { ...process.env, ...env } }
      );
      let sawError = false;
      const feed = (d) =>
        String(d)
          .split("\n")
          .filter((l) => l.trim())
          .forEach((l) => {
            if (/error/i.test(l)) sawError = true;
            if (/Destroy complete|Destroying|error/i.test(l)) onLine(`  ad: ${l.trim()}`);
          });
      child.stdout.on("data", feed);
      child.stderr.on("data", feed);
      child.on("close", (code) => resolve(code === 0 && !sawError));
      child.on("error", () => resolve(false));
    });
    if (destroyed) onLine("  ad: terraform destroy complete");
    else onLine("  ad: terraform destroy failed — falling back to tag sweep");
  }

  // Tag sweep — also the primary path when state is missing/corrupt. Idempotent.
  const desc = await aws([
    "ec2", "describe-instances",
    "--filters",
    `Name=tag:TaskVantageSpoke,Values=${sub}`,
    "Name=instance-state-name,Values=pending,running,stopping,stopped",
    "--query", "Reservations[].Instances[].InstanceId",
    "--output", "text",
  ]);
  const ids = desc.out.split(/\s+/).filter(Boolean);
  if (ids.length) {
    onLine(`  ad: terminating ${ids.length} leftover instance(s) by tag`);
    await aws(["ec2", "terminate-instances", "--instance-ids", ...ids]);
  }

  for (const p of ["admin-password", "safe-mode-password", "setup-phase"]) {
    await aws(["ssm", "delete-parameter", "--name", `/taskvantage/${sub}/${p}`]);
  }

  // Best-effort IAM cleanup (only leftovers matter — terraform destroy handles
  // its own). Ordering: role out of profile, delete profile, inline policy,
  // detach managed, delete role.
  const roleName = `tv-ad-${sub}`;
  if (!destroyed) {
    await aws(["iam", "remove-role-from-instance-profile", "--instance-profile-name", roleName, "--role-name", roleName]);
    await aws(["iam", "delete-instance-profile", "--instance-profile-name", roleName]);
    await aws(["iam", "delete-role-policy", "--role-name", roleName, "--policy-name", roleName]);
    await aws(["iam", "detach-role-policy", "--role-name", roleName, "--policy-arn", "arn:aws:iam::aws:policy/AmazonSSMManagedInstanceCore"]);
    await aws(["iam", "delete-role", "--role-name", roleName]);
  }

  // Verify nothing is left running.
  const check = await aws([
    "ec2", "describe-instances",
    "--filters",
    `Name=tag:TaskVantageSpoke,Values=${sub}`,
    "Name=instance-state-name,Values=pending,running,stopping,stopped",
    "--query", "Reservations[].Instances[].InstanceId",
    "--output", "text",
  ]);
  const clean = !check.out.trim();
  onLine(clean ? "  ad: clean" : `  ad: WARNING — instances still present: ${check.out}`);
  return clean;
}
