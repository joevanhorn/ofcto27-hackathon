// HTTP server for the self-service Okta spoke-provisioning portal.
//
// Zero external dependencies — Node built-ins only. Holds an in-memory pool of
// pre-warmed blank spoke orgs and a cookie-based session map. Every "identity"
// and "federation" action here is SIMULATED: no real Okta or AWS calls are
// made. This drives the demo flow end-to-end in-memory.

import http from "node:http";
import fs from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import crypto from "node:crypto";

import { authorizeRequest } from "./src/authz.mjs";
import { claimOrg } from "./src/pool.mjs";
import { listMyOrgs } from "./src/myorgs.mjs";
import { DEMO_USERS, TEMPLATES, makePool } from "./src/data.mjs";
import {
  DEMO_MODE,
  IS_REAL,
  loadCreds,
  normalizeOrgDomain,
  sswsHeader,
} from "./src/config.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC_DIR = path.join(__dirname, "public");

const CONTENT_TYPES = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
};

const PLACEHOLDER_HTML = `<!doctype html>
<meta charset="utf-8">
<title>Spoke Provisioning Portal</title>
<h1>Self-service Okta Spoke-Provisioning Portal</h1>
<p>The API is running. The web UI (portal/public/index.html) has not been built yet
in this environment, but every backend endpoint is live:</p>
<ul>
  <li><code>GET  /api/session</code></li>
  <li><code>POST /api/login</code> — { "role": "lead" | "nonmember" }</li>
  <li><code>POST /api/logout</code></li>
  <li><code>GET  /api/templates</code></li>
  <li><code>POST /api/requests</code> — { name, templateId, options }</li>
  <li><code>GET  /api/my-orgs</code></li>
  <li><code>GET  /sso/&lt;orgId&gt;</code> — simulated hub SSO landing</li>
</ul>`;

// ---------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------

function sendJson(res, status, body) {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "content-length": Buffer.byteLength(payload),
  });
  res.end(payload);
}

function sendHtml(res, status, html) {
  res.writeHead(status, {
    "content-type": "text/html; charset=utf-8",
    "content-length": Buffer.byteLength(html),
  });
  res.end(html);
}

function parseCookies(req) {
  const header = req.headers.cookie || "";
  const out = {};
  for (const part of header.split(";")) {
    const idx = part.indexOf("=");
    if (idx === -1) continue;
    const k = part.slice(0, idx).trim();
    const v = part.slice(idx + 1).trim();
    if (k) out[k] = decodeURIComponent(v);
  }
  return out;
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on("data", (c) => {
      size += c.length;
      // Guard against unbounded bodies — this is a demo, payloads are tiny.
      if (size > 1_000_000) {
        reject(new Error("body too large"));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on("end", () => {
      const raw = Buffer.concat(chunks).toString("utf8");
      if (!raw) return resolve({});
      try {
        resolve(JSON.parse(raw));
      } catch {
        reject(new Error("invalid JSON"));
      }
    });
    req.on("error", reject);
  });
}

function serveStatic(res, relPath) {
  // Confine to PUBLIC_DIR — never serve outside it.
  const target = path.join(PUBLIC_DIR, relPath);
  if (!target.startsWith(PUBLIC_DIR + path.sep) && target !== PUBLIC_DIR) {
    return sendJson(res, 403, { error: "forbidden" });
  }
  fs.readFile(target, (err, data) => {
    if (err) {
      // Root is special: always boots with a placeholder so a missing UI does
      // not break the demo.
      if (relPath === "index.html") {
        return sendHtml(res, 200, PLACEHOLDER_HTML);
      }
      return sendJson(res, 404, { error: "not found" });
    }
    const ext = path.extname(target).toLowerCase();
    const type = CONTENT_TYPES[ext] || "application/octet-stream";
    res.writeHead(200, {
      "content-type": type,
      "content-length": data.length,
    });
    res.end(data);
  });
}

// Human-readable, control-transparent provisioning plan for a claimed org.
function buildPlan(org, template, user) {
  const controls = template.requiredControls.join(", ");
  return [
    `Claim blank org ${org.id} from the pre-warmed pool`,
    `Apply the ${template.name} baseline — enforces: ${controls}`,
    "Federate to the hub via SAML Org2Org (hub is IdP)",
    `Assign ${user.name} as scoped owner of ${org.id} only — no hub access`,
  ];
}

function redirect(res, location) {
  res.writeHead(302, { location });
  res.end();
}

// ---------------------------------------------------------------------------
// Real-mode (DEMO_MODE=real) Okta OIDC wiring
// ---------------------------------------------------------------------------
// Everything below is guarded by IS_REAL. In sim mode REAL stays null and none
// of the real routes are reachable, so the demo flow is untouched. Credentials
// are loaded once at boot from the gitignored creds file and are NEVER logged.
function buildRealConfig() {
  const creds = loadCreds();
  const issuer = "https://" + normalizeOrgDomain(creds.HUB_ORG_DOMAIN || "");
  return {
    issuer,
    authorizeEndpoint: `${issuer}/oauth2/v1/authorize`,
    tokenEndpoint: `${issuer}/oauth2/v1/token`,
    userinfoEndpoint: `${issuer}/oauth2/v1/userinfo`,
    clientId: creds.OIDC_CLIENT_ID,
    clientSecret: creds.OIDC_CLIENT_SECRET,
    redirectUri: creds.OIDC_REDIRECT_URI,
    sswsAuth: sswsHeader(creds.HUB_API_TOKEN),
  };
}

const REAL = IS_REAL ? buildRealConfig() : null;

// Fetch real Okta group membership for a user and return the group names.
async function fetchGroupNames(sub) {
  const r = await fetch(
    `${REAL.issuer}/api/v1/users/${encodeURIComponent(sub)}/groups`,
    { headers: { authorization: REAL.sswsAuth, accept: "application/json" } }
  );
  if (!r.ok) throw new Error("group lookup failed");
  const arr = await r.json();
  return Array.isArray(arr)
    ? arr.map((g) => g && g.profile && g.profile.name).filter(Boolean)
    : [];
}

// ---------------------------------------------------------------------------
// Server factory
// ---------------------------------------------------------------------------

export function createServer() {
  // Per-server isolated state.
  const pool = makePool();
  const sessions = new Map(); // sid -> userId
  const realSessions = new Map(); // sid -> real user object {id,email,name,groups}
  const pendingStates = new Map(); // sid -> { state } (CSRF, pre-callback)

  function currentUser(req) {
    const cookies = parseCookies(req);
    const sid = cookies.sid;
    if (!sid) return null;
    if (IS_REAL) return realSessions.get(sid) || null;
    const userId = sessions.get(sid);
    if (!userId) return null;
    return (
      Object.values(DEMO_USERS).find((u) => u.id === userId) || null
    );
  }

  const server = http.createServer(async (req, res) => {
    let url;
    try {
      url = new URL(req.url, "http://localhost");
    } catch {
      return sendJson(res, 400, { error: "bad request" });
    }
    const pathname = url.pathname;
    const method = req.method || "GET";

    try {
      // --- Static / UI ---------------------------------------------------
      if (method === "GET" && pathname === "/") {
        return serveStatic(res, "index.html");
      }
      if (method === "GET" && (pathname === "/app.js" || pathname === "/style.css")) {
        return serveStatic(res, pathname.slice(1));
      }

      // --- Real-mode Okta OIDC (guarded; unreachable in sim) --------------
      if (IS_REAL && (method === "GET" || method === "HEAD") && pathname === "/login") {
        const state = crypto.randomBytes(16).toString("hex");
        const nonce = crypto.randomBytes(16).toString("hex");
        const sid = crypto.randomUUID();
        pendingStates.set(sid, { state });
        const authz = new URL(REAL.authorizeEndpoint);
        authz.searchParams.set("client_id", REAL.clientId);
        authz.searchParams.set("response_type", "code");
        authz.searchParams.set("scope", "openid profile email");
        authz.searchParams.set("redirect_uri", REAL.redirectUri);
        authz.searchParams.set("state", state);
        authz.searchParams.set("nonce", nonce);
        res.setHeader("set-cookie", `sid=${sid}; Path=/; HttpOnly; SameSite=Lax`);
        return redirect(res, authz.toString());
      }

      if (IS_REAL && method === "GET" && pathname === "/callback") {
        try {
          const code = url.searchParams.get("code");
          const state = url.searchParams.get("state");
          const sid = parseCookies(req).sid;
          const pending = sid ? pendingStates.get(sid) : null;
          if (!pending || !state || state !== pending.state) {
            return redirect(res, "/?error=state");
          }
          pendingStates.delete(sid);
          if (!code) return redirect(res, "/?error=no_code");

          // Exchange the authorization code for tokens (HTTP Basic client auth).
          const basic = Buffer.from(
            `${REAL.clientId}:${REAL.clientSecret}`
          ).toString("base64");
          const tokenRes = await fetch(REAL.tokenEndpoint, {
            method: "POST",
            headers: {
              authorization: `Basic ${basic}`,
              "content-type": "application/x-www-form-urlencoded",
              accept: "application/json",
            },
            body: new URLSearchParams({
              grant_type: "authorization_code",
              code,
              redirect_uri: REAL.redirectUri,
            }).toString(),
          });
          if (!tokenRes.ok) return redirect(res, "/?error=token");
          const tokens = await tokenRes.json();
          const accessToken = tokens && tokens.access_token;
          if (!accessToken) return redirect(res, "/?error=token");

          // Resolve the identity, then real group membership (admin token).
          const uiRes = await fetch(REAL.userinfoEndpoint, {
            headers: {
              authorization: `Bearer ${accessToken}`,
              accept: "application/json",
            },
          });
          if (!uiRes.ok) return redirect(res, "/?error=userinfo");
          const ui = await uiRes.json();
          const sub = ui && ui.sub;
          if (!sub) return redirect(res, "/?error=userinfo");

          const groups = await fetchGroupNames(sub);
          const user = {
            id: sub,
            email: ui.email || null,
            name: ui.name || ui.email || sub,
            groups,
          };
          const newSid = crypto.randomUUID();
          realSessions.set(newSid, user);
          res.setHeader(
            "set-cookie",
            `sid=${newSid}; Path=/; HttpOnly; SameSite=Lax`
          );
          return redirect(res, "/");
        } catch {
          // Never leak tokens or error internals to the client.
          return redirect(res, "/?error=login");
        }
      }

      if (IS_REAL && method === "GET" && pathname === "/logout") {
        const sid = parseCookies(req).sid;
        if (sid) realSessions.delete(sid);
        res.setHeader(
          "set-cookie",
          "sid=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0"
        );
        return redirect(res, "/");
      }

      // --- Session -------------------------------------------------------
      if (method === "GET" && pathname === "/api/session") {
        return sendJson(res, 200, { user: currentUser(req), mode: DEMO_MODE });
      }

      if (method === "POST" && pathname === "/api/login") {
        // Demo identity switcher is sim-only; disabled in real mode.
        if (IS_REAL) return sendJson(res, 404, { error: "not found" });
        const body = await readBody(req);
        const role = body && body.role;
        const user = DEMO_USERS[role];
        if (!user) {
          return sendJson(res, 400, { error: "unknown role" });
        }
        const sid = crypto.randomUUID();
        sessions.set(sid, user.id);
        res.setHeader(
          "set-cookie",
          `sid=${sid}; Path=/; HttpOnly; SameSite=Lax`
        );
        return sendJson(res, 200, { user });
      }

      if (method === "POST" && pathname === "/api/logout") {
        const cookies = parseCookies(req);
        if (cookies.sid) sessions.delete(cookies.sid);
        res.setHeader(
          "set-cookie",
          "sid=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0"
        );
        return sendJson(res, 200, { ok: true });
      }

      // --- Templates -----------------------------------------------------
      if (method === "GET" && pathname === "/api/templates") {
        return sendJson(res, 200, { templates: TEMPLATES });
      }

      // --- Provisioning request -----------------------------------------
      if (method === "POST" && pathname === "/api/requests") {
        const user = currentUser(req);
        if (!user) {
          return sendJson(res, 401, { error: "not authenticated" });
        }

        const decision = authorizeRequest(user);
        if (!decision.allowed) {
          return sendJson(res, 403, {
            error: "not authorized",
            reason: decision.reason,
          });
        }

        const body = await readBody(req);
        const templateId = body && body.templateId;
        const template = TEMPLATES.find((t) => t.id === templateId);
        if (!template) {
          return sendJson(res, 400, { error: "unknown template" });
        }

        let org;
        try {
          org = claimOrg(pool, user.id);
        } catch (e) {
          if (e && e.message === "pool exhausted") {
            return sendJson(res, 409, { error: "pool exhausted" });
          }
          throw e;
        }

        // Simulated provisioning: stamp the claimed org with the request
        // details and mark federation complete. No real Okta/AWS call.
        org.name = (body && body.name) || `${template.name} spoke`;
        org.template = templateId;
        org.options = (body && body.options) || {};
        org.federation = "federated";
        org.createdAt = new Date().toISOString();

        const plan = buildPlan(org, template, user);
        return sendJson(res, 200, { org, plan });
      }

      // --- My orgs -------------------------------------------------------
      if (method === "GET" && pathname === "/api/my-orgs") {
        const user = currentUser(req);
        if (!user) {
          return sendJson(res, 401, { error: "not authenticated" });
        }
        return sendJson(res, 200, { orgs: listMyOrgs(pool, user.id) });
      }

      // --- Simulated hub SSO (the hero moment) ---------------------------
      if (method === "GET" && pathname.startsWith("/sso/")) {
        const orgId = decodeURIComponent(pathname.slice("/sso/".length));
        const user = currentUser(req);
        const org = pool.find((o) => o.id === orgId);
        if (
          !user ||
          !org ||
          org.ownerId !== user.id ||
          org.federation !== "federated"
        ) {
          return sendHtml(
            res,
            403,
            `<!doctype html><meta charset="utf-8"><title>Access denied</title>
<h1>403 — cannot sign in</h1>
<p>This org is not federated to you, or you are not signed in as its owner.</p>`
          );
        }
        return sendHtml(
          res,
          200,
          `<!doctype html><meta charset="utf-8"><title>${org.name}</title>
<h1>&#9989; Signed in to ${org.name} via the hub — no new password (SAML Org2Org, hub-as-IdP).</h1>
<p>Org <code>${org.id}</code> &middot; owner ${user.name} &middot; federation ${org.federation}.</p>`
        );
      }

      // --- Fallback ------------------------------------------------------
      return sendJson(res, 404, { error: "not found" });
    } catch (err) {
      return sendJson(res, 500, { error: "internal error", detail: String(err && err.message) });
    }
  });

  return server;
}

/**
 * Start the server. Pass port 0 for an ephemeral port (tests do this).
 * Returns the http.Server (already listening).
 */
export function start(port = process.env.PORT || 3000) {
  const server = createServer();
  server.listen(port, () => {
    const addr = server.address();
    const shown = addr && typeof addr === "object" ? addr.port : port;
    console.log(`Spoke-provisioning portal listening on http://localhost:${shown}`);
  });
  return server;
}

// Run directly (node portal/server.mjs) but stay importable for the test.
if (import.meta.url === `file://${process.argv[1]}`) {
  start();
}
