// Integration test for the spoke-provisioning portal HTTP server.
//
// Boots the real server on an ephemeral port and drives the demo flow over
// HTTP with the global fetch (Node 20). Cookies are preserved manually across
// requests so the session survives, exactly as a browser would.

import { test } from "node:test";
import assert from "node:assert/strict";

import { createServer } from "../server.mjs";

// Start the server on an ephemeral port (port 0) and return { base, close }.
function startEphemeral() {
  return new Promise((resolve) => {
    const server = createServer();
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address();
      resolve({
        base: `http://127.0.0.1:${port}`,
        close: () =>
          new Promise((r) => server.close(() => r())),
      });
    });
  });
}

// Tiny cookie-preserving fetch wrapper. Reads set-cookie, stores the sid, and
// sends it back on subsequent calls.
function makeClient(base) {
  let cookie = "";
  return async function call(path, opts = {}) {
    const headers = { ...(opts.headers || {}) };
    if (cookie) headers.cookie = cookie;
    if (opts.body && !headers["content-type"]) {
      headers["content-type"] = "application/json";
    }
    const res = await fetch(base + path, { ...opts, headers, redirect: "manual" });
    const setCookie = res.headers.get("set-cookie");
    if (setCookie) {
      // Keep just the "name=value" pair (drop attributes).
      cookie = setCookie.split(";")[0];
    }
    return res;
  };
}

test("Division Lead can provision a spoke and SSO into it", async () => {
  const { base, close } = await startEphemeral();
  try {
    const client = makeClient(base);

    // Login as the Division Lead.
    const login = await client("/api/login", {
      method: "POST",
      body: JSON.stringify({ role: "lead" }),
    });
    assert.equal(login.status, 200);
    const { user } = await login.json();
    assert.equal(user.id, "00uLEAD");

    // Fetch templates and use the first one.
    const tmplRes = await client("/api/templates");
    assert.equal(tmplRes.status, 200);
    const { templates } = await tmplRes.json();
    assert.ok(templates.length >= 2, "expected at least two templates");
    const template = templates[0];

    // Submit a provisioning request.
    const reqRes = await client("/api/requests", {
      method: "POST",
      body: JSON.stringify({
        name: "Marketing Division Spoke",
        templateId: template.id,
        options: { retention: "1y", region: "US" },
      }),
    });
    assert.equal(reqRes.status, 200);
    const { org, plan } = await reqRes.json();
    assert.equal(org.status, "claimed");
    assert.equal(org.ownerId, "00uLEAD");
    assert.equal(org.federation, "federated");
    assert.ok(Array.isArray(plan) && plan.length >= 3, "expected a plan");

    // The org shows up under my-orgs.
    const mine = await client("/api/my-orgs");
    assert.equal(mine.status, 200);
    const { orgs } = await mine.json();
    assert.ok(
      orgs.some((o) => o.id === org.id),
      "provisioned org should appear in my-orgs"
    );

    // Hero moment: SSO landing page for the owned, federated org.
    const sso = await client(`/sso/${org.id}`);
    assert.equal(sso.status, 200);
    const html = await sso.text();
    assert.match(html, /Signed in to .* via the hub/);
    assert.match(html, /SAML Org2Org/);
  } finally {
    await close();
  }
});

test("non-member is denied provisioning with 403", async () => {
  const { base, close } = await startEphemeral();
  try {
    const client = makeClient(base);

    const login = await client("/api/login", {
      method: "POST",
      body: JSON.stringify({ role: "nonmember" }),
    });
    assert.equal(login.status, 200);

    const reqRes = await client("/api/requests", {
      method: "POST",
      body: JSON.stringify({
        name: "Sneaky Spoke",
        templateId: "standard-spoke",
        options: {},
      }),
    });
    assert.equal(reqRes.status, 403);
    const body = await reqRes.json();
    assert.equal(body.error, "not authorized");
    assert.equal(body.reason, "not authorized");
  } finally {
    await close();
  }
});
