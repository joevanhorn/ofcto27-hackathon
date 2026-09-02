// Tests for the "Include Active Directory" option: template resolution,
// helpers in src/directory.mjs, the sim-mode request flow + AD status
// endpoint, and the generated OU data. Sim-mode only — no Okta/AWS calls.

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

import { TEMPLATES, resolveTemplate } from "../src/data.mjs";
import { computerNameFor, generateAdPassword, describePhase } from "../src/directory.mjs";
import { createServer } from "../server.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

function startEphemeral() {
  return new Promise((resolve) => {
    const server = createServer();
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address();
      resolve({
        base: `http://127.0.0.1:${port}`,
        close: () => new Promise((r) => server.close(() => r())),
      });
    });
  });
}

function makeClient(base) {
  let cookie = "";
  return async function call(p, opts = {}) {
    const headers = { ...(opts.headers || {}) };
    if (cookie) headers.cookie = cookie;
    if (opts.body && !headers["content-type"]) headers["content-type"] = "application/json";
    const res = await fetch(base + p, { ...opts, headers, redirect: "manual" });
    const setCookie = res.headers.get("set-cookie");
    if (setCookie) cookie = setCookie.split(";")[0];
    return res;
  };
}

// --- resolveTemplate -------------------------------------------------------

test("every template offers the include_ad toggle", () => {
  for (const t of TEMPLATES) {
    const opt = (t.options || []).find((o) => o.id === "include_ad");
    assert.ok(opt, `${t.id} missing include_ad`);
    assert.equal(opt.type, "toggle");
    assert.equal(opt.ad, true);
    assert.equal(opt.default, false);
  }
});

test("resolveTemplate: include_ad toggles activeDirectory", () => {
  const t = TEMPLATES[0];
  assert.equal(resolveTemplate(t, {}).activeDirectory, false);
  assert.equal(resolveTemplate(t, { include_ad: true }).activeDirectory, true);
  assert.equal(resolveTemplate(t, { include_ad: "true" }).activeDirectory, true);
  assert.equal(resolveTemplate(t, { include_ad: false }).activeDirectory, false);
  // A toggle the template doesn't offer is ignored.
  const bare = { ...t, options: [] };
  assert.equal(resolveTemplate(bare, { include_ad: true }).activeDirectory, false);
  // The AD toggle must not leak into realms.
  assert.deepEqual(resolveTemplate(t, { include_ad: true }).realms, resolveTemplate(t, {}).realms);
});

// --- directory.mjs helpers -------------------------------------------------

test("computerNameFor: NetBIOS-safe and unique per spoke", () => {
  const subs = ["velocity27-spoke1", "velocity27-spoke2", "a", "spoke-with-a-very-long-name"];
  const names = subs.map(computerNameFor);
  for (const n of names) {
    assert.ok(n.length <= 15, `${n} exceeds 15 chars`);
    assert.match(n, /^TV-[A-Z0-9]*$/);
  }
  assert.equal(new Set(names).size, subs.length, "collision between pool spokes");
});

test("generateAdPassword: Windows complexity, 20 chars, no shell-hostile chars", () => {
  for (let i = 0; i < 20; i++) {
    const p = generateAdPassword();
    assert.equal(p.length, 20);
    assert.match(p, /[A-Z]/);
    assert.match(p, /[a-z]/);
    assert.match(p, /[0-9]/);
    assert.match(p, /[!@#%^*\-_=+]/);
    assert.doesNotMatch(p, /["'`$\\{}()<>|;&\s]/);
  }
});

test("describePhase covers terminal and error states", () => {
  assert.match(describePhase("READY"), /ready/i);
  assert.match(describePhase("ERROR:populate:schema"), /error/i);
  assert.equal(describePhase("SOMETHING_NEW"), "SOMETHING_NEW");
});

// --- sim-mode request flow -------------------------------------------------

test("sim provision with include_ad: plan lines + org.ad + status endpoint", async () => {
  const { base, close } = await startEphemeral();
  try {
    const client = makeClient(base);
    await client("/api/login", { method: "POST", body: JSON.stringify({ role: "lead" }) });

    const res = await client("/api/requests", {
      method: "POST",
      body: JSON.stringify({
        name: "AD Test Org",
        templateId: "standard-division",
        options: { include_ad: true },
      }),
    });
    assert.equal(res.status, 200);
    const { org, plan } = await res.json();

    assert.ok(org.ad, "org record missing ad block");
    assert.equal(org.ad.enabled, true);
    assert.equal(org.ad.status, "building");
    assert.match(org.ad.computerName, /^TV-/);
    assert.ok(plan.some((s) => /domain controller/i.test(s)), "plan missing DC step");
    assert.ok(plan.some((s) => /242 OUs/.test(s)), "plan missing directory step");
    assert.ok(plan.some((s) => /AD agent/.test(s)), "plan missing agent step");

    const st = await client(`/api/orgs/${encodeURIComponent(org.id)}/ad`);
    assert.equal(st.status, 200);
    const body = await st.json();
    assert.ok(["building", "ready"].includes(body.status));
    assert.ok(body.message);

    const pw = await client(`/api/orgs/${encodeURIComponent(org.id)}/ad/password`, {
      method: "POST",
      body: "{}",
    });
    assert.equal(pw.status, 200);
    assert.equal((await pw.json()).password, "SimMode-NoRealPassword");
  } finally {
    await close();
  }
});

test("sim provision without include_ad: no ad block, /ad 404s", async () => {
  const { base, close } = await startEphemeral();
  try {
    const client = makeClient(base);
    await client("/api/login", { method: "POST", body: JSON.stringify({ role: "lead" }) });
    const res = await client("/api/requests", {
      method: "POST",
      body: JSON.stringify({ name: "Plain Org", templateId: "standard-division", options: {} }),
    });
    const { org, plan } = await res.json();
    assert.equal(org.ad, undefined);
    assert.ok(!plan.some((s) => /domain controller/i.test(s)));
    const st = await client(`/api/orgs/${encodeURIComponent(org.id)}/ad`);
    assert.equal(st.status, 404);
  } finally {
    await close();
  }
});

// --- generated OU data -----------------------------------------------------

test("ou-structure.json: parseable, ordered, de-identified", () => {
  const p = path.join(__dirname, "..", "terraform", "modules", "active-directory", "files", "ou-structure.json");
  assert.ok(existsSync(p), "ou-structure.json missing — run tools/gen-taskvantage-ous.mjs");
  const raw = readFileSync(p, "utf8");
  const ous = JSON.parse(raw);
  assert.ok(ous.length >= 200, `only ${ous.length} OUs`);

  const deny = /STARBUCKS|SBUX|Starbucks|sbux|Barista|Pike ?Place|DHL|Danzas|MICROS|Kronos|CyberArk|VISFed|Licensee|Licensed Store|GlobalPSP|China/;
  assert.doesNotMatch(raw, deny, "de-identification gate failed");
  assert.ok(ous.some((o) => o.name === "TASKVANTAGE" && o.path === ""), "missing TASKVANTAGE root OU");

  // Parent-before-child ordering (what lets the DC create them in one pass).
  const seen = new Set([""]);
  for (const { name, path: parent } of ous) {
    assert.ok(seen.has(parent), `"${name}" appears before its parent "${parent}"`);
    seen.add(parent === "" ? `OU=${name}` : `OU=${name},${parent}`);
  }
});

// The setup scripts must stay de-identified too (cheap regression gate).
test("ad-setup.ps1 / ad-bootstrap.ps1 are de-identified", () => {
  const dir = path.join(__dirname, "..", "terraform", "modules", "active-directory", "files");
  const deny = /STARBUCKS|SBUX|Starbucks|sbux|Barista|Pike ?Place|DHL|Danzas|MICROS|Kronos/;
  for (const f of ["ad-setup.ps1", "ad-bootstrap.ps1"]) {
    assert.doesNotMatch(readFileSync(path.join(dir, f), "utf8"), deny, `${f} failed the gate`);
  }
});
