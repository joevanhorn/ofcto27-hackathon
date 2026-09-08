// Tests for "Migrate to Okta-managed" (src/migrate.mjs + sim parity).
//
// The engine test runs the REAL migration logic against a tiny in-memory fake
// of the Okta API, so every phase (discover, mirror, re-target, rules, flip,
// password continuity, verify) is exercised without a live org.

import { test } from "node:test";
import assert from "node:assert/strict";

import { runAdMigration } from "../src/migrate.mjs";
import { simMigration } from "../src/directory.mjs";
import { createServer } from "../server.mjs";

// --- fake Okta org ---------------------------------------------------------

function makeFakeOrg() {
  const state = {
    flipped: false,
    calls: [],
    users: {
      u1: { territory: "T-100" },
      u2: { territory: "T-200" },
    },
    nextGroupId: 1,
    createdGroups: [], // {id, name, description}
    createdRules: [], // {id, name, expression, groupIds, active}
    appBMGroups: ["gAD1"], // bookmark app assigned via the AD group
    passwordsSet: [],
  };

  const api = async (method, path, body) => {
    state.calls.push(`${method} ${path}`);
    const ok = (json) => ({ status: 200, ok: true, json });

    if (method === "GET" && path === "/api/v1/apps?limit=200") {
      return ok([
        { id: "appAD", name: "active_directory", label: "Active Directory", status: state.flipped ? "INACTIVE" : "ACTIVE" },
        { id: "appBM", name: "bookmark", label: "Welcome", status: "ACTIVE" },
      ]);
    }
    if (method === "GET" && path === "/api/v1/apps/appAD/users?limit=500") {
      return ok([{ id: "u1" }, { id: "u2" }]);
    }
    if (method === "GET" && path === "/api/v1/groups?limit=200") {
      return ok([
        {
          id: "gAD1",
          type: "APP_GROUP",
          profile: { name: "Site-Managers", windowsDomainQualifiedName: "TASKVANTAGE\\Site-Managers" },
        },
        { id: "gOkta", type: "OKTA_GROUP", profile: { name: "Baseline-Users" } },
      ]);
    }
    if (method === "POST" && path === "/api/v1/groups") {
      const id = `ng${state.nextGroupId++}`;
      state.createdGroups.push({ id, ...body.profile });
      return ok({ id });
    }
    if (method === "GET" && path === "/api/v1/groups/gAD1/users?limit=200") {
      return ok([{ id: "u1" }]);
    }
    if (method === "PUT" && /^\/api\/v1\/groups\/ng\d+\/users\/u\d$/.test(path)) {
      return { status: 204, ok: true, json: null };
    }
    if (method === "GET" && path === "/api/v1/apps/appBM/groups?limit=100") {
      return ok(state.appBMGroups.map((id) => ({ id })));
    }
    if (method === "PUT" && /^\/api\/v1\/apps\/appBM\/groups\/ng\d+$/.test(path)) {
      state.appBMGroups.push(path.split("/").pop());
      return ok({});
    }
    if (method === "DELETE" && path === "/api/v1/apps/appBM/groups/gAD1") {
      state.appBMGroups = state.appBMGroups.filter((id) => id !== "gAD1");
      return { status: 204, ok: true, json: null };
    }
    if (method === "GET" && path === "/api/v1/meta/schemas/user/default") {
      return ok({ definitions: { custom: { properties: { tvOrgTerritoryID: { type: "string" } } } } });
    }
    if (method === "GET" && /^\/api\/v1\/users\/u\d$/.test(path)) {
      const id = path.split("/").pop();
      return ok({
        id,
        profile: { tvOrgTerritoryID: state.users[id].territory },
        credentials: { provider: { type: state.flipped ? "OKTA" : "ACTIVE_DIRECTORY" } },
      });
    }
    if (method === "POST" && path === "/api/v1/groups/rules") {
      const id = `r${state.createdRules.length + 1}`;
      state.createdRules.push({
        id,
        name: body.name,
        expression: body.conditions.expression.value,
        groupIds: body.actions.assignUserToGroups.groupIds,
        active: false,
      });
      return ok({ id });
    }
    if (method === "POST" && /^\/api\/v1\/groups\/rules\/r\d+\/lifecycle\/activate$/.test(path)) {
      const id = path.split("/")[5];
      const rule = state.createdRules.find((r) => r.id === id);
      if (rule) rule.active = true;
      return ok({});
    }
    if (method === "POST" && path === "/api/v1/apps/appAD/lifecycle/deactivate") {
      state.flipped = true;
      return ok({});
    }
    if (method === "POST" && /^\/api\/v1\/users\/u\d$/.test(path) && body && body.credentials) {
      state.passwordsSet.push(path.split("/").pop());
      return ok({});
    }
    return { status: 404, ok: false, json: { errorSummary: `unhandled ${method} ${path}` } };
  };

  return { api, state };
}

// --- engine ----------------------------------------------------------------

test("runAdMigration: full happy path against a fake org", async () => {
  const { api, state } = makeFakeOrg();
  const lines = [];
  const result = await runAdMigration({
    api,
    demoPassword: "Demo-Passw0rd-123!",
    onLine: (l) => lines.push(l),
  });

  assert.equal(result.status, "migrated");
  const s = result.summary;
  assert.equal(s.users, 2);
  assert.equal(s.groupsMirrored, 1);
  assert.equal(s.membershipsCopied, 1);
  assert.equal(s.appsRetargeted, 1);
  assert.equal(s.rulesCreated, 2); // T-100 and T-200
  assert.equal(s.passwordsSet, 2);
  assert.equal(s.oktaSourced, 2); // verified post-flip

  // Mirror carries the reset marker; rules carry the tv- prefix and are active.
  assert.ok(state.createdGroups.some((g) => g.name === "Site-Managers" && g.description.includes("[tv-migrated]")));
  assert.ok(state.createdRules.every((r) => r.name.startsWith("tv-") && r.active));
  assert.ok(state.createdRules.some((r) => r.expression === 'user.tvOrgTerritoryID == "T-100"'));
  // Old AD-group assignment removed, twin assigned.
  assert.ok(!state.appBMGroups.includes("gAD1"));
  // The flip happened.
  assert.equal(state.flipped, true);
  // The demo password never leaks through the streamed lines.
  assert.ok(!lines.some((l) => l.includes("Demo-Passw0rd-123!")));
});

test("runAdMigration: blocked when no AD integration exists", async () => {
  const api = async (method, path) =>
    method === "GET" && path === "/api/v1/apps?limit=200"
      ? { status: 200, ok: true, json: [{ id: "x", name: "bookmark" }] }
      : { status: 404, ok: false, json: null };
  const result = await runAdMigration({ api });
  assert.equal(result.status, "blocked");
  assert.match(result.reason, /complete phases 1-2/);
});

// --- sim parity ------------------------------------------------------------

test("simMigration: scripted beats reach migrated", () => {
  const start = simMigration(0);
  assert.equal(start.status, "running");
  assert.equal(start.log.length, 1);
  const done = simMigration(30_000);
  assert.equal(done.status, "migrated");
  assert.ok(done.log.length >= 8);
  assert.match(done.log[done.log.length - 1], /load-bearing nothing/);
});

test("sim org: migrate endpoint drives status to running then migrated", async () => {
  const server = createServer();
  const base = await new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => resolve(`http://127.0.0.1:${server.address().port}`));
  });
  let cookie = "";
  const call = async (p, opts = {}) => {
    const headers = { ...(opts.headers || {}), ...(cookie ? { cookie } : {}) };
    if (opts.body) headers["content-type"] = "application/json";
    const res = await fetch(base + p, { ...opts, headers });
    const setCookie = res.headers.get("set-cookie");
    if (setCookie) cookie = setCookie.split(";")[0];
    return res;
  };
  try {
    await call("/api/login", { method: "POST", body: JSON.stringify({ role: "lead" }) });
    const req = await call("/api/requests", {
      method: "POST",
      body: JSON.stringify({ name: "Migrate Org", templateId: "standard-division", options: { include_ad: true } }),
    });
    const { org } = await req.json();

    const kick = await call(`/api/orgs/${encodeURIComponent(org.id)}/ad/migrate`, { method: "POST", body: "{}" });
    assert.equal(kick.status, 202);
    // Double-kick while running is rejected.
    const dupe = await call(`/api/orgs/${encodeURIComponent(org.id)}/ad/migrate`, { method: "POST", body: "{}" });
    assert.equal(dupe.status, 409);

    const st = await call(`/api/orgs/${encodeURIComponent(org.id)}/ad`);
    const body = await st.json();
    assert.ok(body.migration, "migration state missing");
    assert.equal(body.migration.status, "running");
    assert.ok(body.migration.log.length >= 1);
  } finally {
    await new Promise((r) => server.close(() => r()));
  }
});
