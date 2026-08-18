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
import { APP_CATALOG, DEMO_USERS, TEMPLATES, makePool, resolveTemplate } from "./src/data.mjs";
import {
  DEMO_MODE,
  IS_REAL,
  loadCreds,
  normalizeOrgDomain,
  sswsHeader,
  spokePool,
} from "./src/config.mjs";
import { provisionSpoke, subdomainOf, TERRAFORM_DIR } from "./src/provision.mjs";
import { createCertificationCampaign } from "./src/governance.mjs";
import { chatApiKey, runChat } from "./src/chat.mjs";
import { resetPool } from "./src/reset.mjs";

// Chat assistant availability: key comes from env or the gitignored creds
// file, in both sim and real mode. Never sent to the client.
const CHAT_API_KEY = chatApiKey(loadCreds());

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
// `resolved` is the concrete spec from resolveTemplate(): apps, realms, campaign.
function buildPlan(org, template, user, resolved) {
  const controls = template.requiredControls.join(", ");
  const steps = [
    `Claim blank org ${org.id} from the pre-warmed pool`,
    `Apply the ${template.name} baseline — enforces: ${controls}`,
  ];
  if (resolved) {
    if (resolved.apps.length) {
      steps.push(`Deploy applications: ${resolved.apps.map((a) => a.label).join(", ")}`);
    }
    if (resolved.realms.length) {
      steps.push(`Create realm${resolved.realms.length > 1 ? "s" : ""}: ${resolved.realms.join(", ")}`);
    }
    if (resolved.campaign) {
      steps.push(`Schedule a ${resolved.campaign.cadence} access certification campaign ("${resolved.campaign.name}")`);
    }
  }
  steps.push(
    "Federate to the hub via SAML Org2Org (hub is IdP)",
    `Assign ${user.name} as scoped owner of ${org.id} only — no hub access`
  );
  return steps;
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
  const hubDomain = normalizeOrgDomain(creds.HUB_ORG_DOMAIN || "");
  const issuer = "https://" + hubDomain;
  const spokes = spokePool(creds);
  // Pre-compute each spoke's subdomain once; it names the claimed org record
  // and the per-spoke terraform state file.
  for (const s of spokes) s.subdomain = subdomainOf(s);
  // Split the hub domain into { subdomain, base } for the terraform hub
  // provider (real SAML Org2Org federation). Token stays raw here — the
  // terraform layer strips any "SSWS " prefix and passes it via env only.
  const dot = hubDomain.indexOf(".");
  const hub = {
    orgName: dot > 0 ? hubDomain.slice(0, dot) : hubDomain,
    baseUrl: dot > 0 ? hubDomain.slice(dot + 1) : "oktapreview.com",
    apiToken: creds.HUB_API_TOKEN || "",
  };
  return {
    issuer,
    authorizeEndpoint: `${issuer}/oauth2/v1/authorize`,
    tokenEndpoint: `${issuer}/oauth2/v1/token`,
    userinfoEndpoint: `${issuer}/oauth2/v1/userinfo`,
    clientId: creds.OIDC_CLIENT_ID,
    clientSecret: creds.OIDC_CLIENT_SECRET,
    redirectUri: creds.OIDC_REDIRECT_URI,
    sswsAuth: sswsHeader(creds.HUB_API_TOKEN),
    spokes,
    hub,
    // DEMO_FEDERATION=off -> the recorded Provision runs baseline-only (fast),
    // and the SSO finale uses a pre-staged federation launch URL below.
    federationInProvision: (process.env.DEMO_FEDERATION || "").toLowerCase() !== "off",
    ssoEntryUrl: creds.HUB_SSO_ENTRY_URL || null,
  };
}

const REAL = IS_REAL ? buildRealConfig() : null;

// A spoke whose per-spoke terraform state file already holds resources has
// been handed out (possibly by a previous server process) — treat it as
// claimed so restarts never double-provision the same org.
function spokeStateHasResources(subdomain) {
  try {
    const raw = fs.readFileSync(
      path.join(TERRAFORM_DIR, "state", `${subdomain}.tfstate`),
      "utf8"
    );
    const state = JSON.parse(raw);
    return Array.isArray(state.resources) && state.resources.length > 0;
  } catch {
    return false; // no state file -> blank
  }
}

// Boot-time credential probe: preview-org SSWS tokens expire after 30 idle
// days, and a dead token surfacing mid-demo is the worst possible moment.
// Marks each spoke (and the hub) so /api/pool can report it up front.
async function probeToken(domain, token) {
  if (!token) return false;
  try {
    const r = await fetch(`https://${domain}/api/v1/users/me`, {
      headers: { authorization: sswsHeader(token), accept: "application/json" },
    });
    return r.ok;
  } catch {
    return false;
  }
}

// Realms are feature-gated on trial orgs: probe the spoke before the apply so
// terraform only creates them where they can exist (explicit skip otherwise).
async function orgSupportsRealms(spoke) {
  try {
    const r = await fetch(`https://${spoke.domain}/api/v1/realms?limit=1`, {
      headers: { authorization: sswsHeader(spoke.token), accept: "application/json" },
    });
    return r.ok;
  } catch {
    return false;
  }
}

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

// Authoritative name/email from the hub profile (userinfo may omit them).
async function fetchProfile(sub) {
  const r = await fetch(
    `${REAL.issuer}/api/v1/users/${encodeURIComponent(sub)}`,
    { headers: { authorization: REAL.sswsAuth, accept: "application/json" } }
  );
  if (!r.ok) return null;
  const u = await r.json();
  return u && u.profile ? u.profile : null;
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

  // Real-mode (IS_REAL) provisioning state — all in-memory, never touched in
  // sim mode. `claimed` guards single-use spoke handout; `jobs` holds live
  // terraform runs (line buffers streamed to SSE); `orgs` is the owner-scoped
  // record of provisioned spokes shown in "My orgs".
  const claimed = new Set(); // spoke subdomains already handed out
  const jobs = new Map(); // jobId -> { lines, done, result, spoke, user, name, templateId }
  const orgs = []; // provisioned org records (real mode: persisted to disk)

  // Real-mode org records survive server restarts: persisted next to the
  // per-spoke terraform state, and reconciled against it at boot so a record
  // never outlives (or ghosts) the org it describes.
  const ORGS_FILE = path.join(TERRAFORM_DIR, "state", "orgs.json");
  function saveOrgs() {
    if (!IS_REAL) return;
    try {
      fs.writeFileSync(ORGS_FILE, JSON.stringify(orgs, null, 2));
    } catch (e) {
      console.error("[orgs] persist failed:", e && e.message);
    }
  }
  if (IS_REAL) {
    try {
      const stored = JSON.parse(fs.readFileSync(ORGS_FILE, "utf8"));
      for (const rec of Array.isArray(stored) ? stored : []) {
        // Only revive records whose spoke still holds provisioned state.
        if (spokeStateHasResources(rec.id)) orgs.push(rec);
      }
      if (orgs.length) console.log(`[orgs] restored ${orgs.length} org record(s)`);
    } catch {
      /* no file yet */
    }
  }

  if (IS_REAL) {
    // Seed claims from per-spoke terraform state so restarts never hand the
    // same org out twice, and probe every token up front (async — the pool
    // endpoint reports "checking" until each probe lands).
    for (const s of REAL.spokes) {
      if (spokeStateHasResources(s.subdomain)) claimed.add(s.subdomain);
      s.tokenOk = null; // null = probe in flight
      probeToken(s.domain, s.token).then((ok) => {
        s.tokenOk = ok;
        if (!ok) console.warn(`[pool] spoke ${s.domain}: API token invalid or expired`);
      });
    }
    probeToken(REAL.issuer.replace(/^https:\/\//, ""), REAL.hub.apiToken).then((ok) => {
      REAL.hubTokenOk = ok;
      if (!ok) console.warn("[pool] hub API token invalid or expired");
    });
  }

  // One row per spoke for /api/pool: ready | claimed | bad-token | checking.
  function poolStatus() {
    if (!IS_REAL) {
      const blank = pool.filter((o) => o.status === "blank").length;
      return {
        mode: "sim",
        ready: blank,
        total: pool.length,
        orgs: pool.map((o) => ({ id: o.id, status: o.status === "blank" ? "ready" : "claimed" })),
      };
    }
    const rows = REAL.spokes.map((s) => ({
      id: s.subdomain,
      status: claimed.has(s.subdomain)
        ? "claimed"
        : s.tokenOk === false
        ? "bad-token"
        : s.tokenOk === null
        ? "checking"
        : "ready",
    }));
    return {
      mode: "real",
      ready: rows.filter((r) => r.status === "ready").length,
      total: rows.length,
      hubTokenOk: REAL.hubTokenOk !== false,
      orgs: rows,
    };
  }

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
          let email = ui.email || ui.preferred_username || null;
          let name =
            ui.name ||
            [ui.given_name, ui.family_name].filter(Boolean).join(" ").trim() ||
            null;
          if (!name || !email) {
            const p = await fetchProfile(sub).catch(() => null);
            if (p) {
              name = name || `${p.firstName || ""} ${p.lastName || ""}`.trim() || p.login;
              email = email || p.email || p.login;
            }
          }
          const user = { id: sub, email: email || null, name: name || email || sub, groups };
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
        return sendJson(res, 200, {
          user: currentUser(req),
          mode: DEMO_MODE,
          chatEnabled: !!CHAT_API_KEY,
        });
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

      // --- Chat assistant --------------------------------------------------
      // The assistant drafts and (on confirmation) submits through the SAME
      // browser-side form flow as a human, so authz stays on /api/requests.
      if (method === "POST" && pathname === "/api/chat") {
        const user = currentUser(req);
        if (!user) return sendJson(res, 401, { error: "not authenticated" });
        if (!CHAT_API_KEY) return sendJson(res, 503, { error: "chat not configured" });

        const body = await readBody(req);
        const chatMessages = Array.isArray(body && body.messages) ? body.messages : null;
        if (!chatMessages || !chatMessages.length) {
          return sendJson(res, 400, { error: "messages required" });
        }

        try {
          const result = await runChat({
            messages: chatMessages,
            user,
            poolStatus,
            apiKey: CHAT_API_KEY,
          });
          return sendJson(res, 200, {
            reply: result.reply,
            actions: result.actions,
            messages: result.messages,
          });
        } catch (e) {
          // Model/API failure — never leak the key or internals.
          console.error("[chat]", e && e.message);
          return sendJson(res, 502, { error: "assistant unavailable" });
        }
      }

      // --- Pool status (the pre-warmed org count badge) --------------------
      if (method === "GET" && pathname === "/api/pool") {
        if (IS_REAL && !currentUser(req)) {
          return sendJson(res, 401, { error: "not authenticated" });
        }
        return sendJson(res, 200, poolStatus());
      }

      // --- Full demo reset (the between-takes button) ----------------------
      // Real mode: API-level teardown of everything the portal created on
      // every spoke (and the hub-side federation apps), then clear in-memory
      // claims/jobs/orgs so the pool reads fully blank without a restart.
      // Sim mode: re-blank the in-memory pool.
      if (method === "POST" && pathname === "/api/pool/reset") {
        const user = currentUser(req);
        if (!user) return sendJson(res, 401, { error: "not authenticated" });

        if (!IS_REAL) {
          for (const org of pool) {
            org.status = "blank";
            org.ownerId = null;
            org.name = null;
            org.template = null;
            org.options = undefined;
            org.resolved = undefined;
            org.federation = "pending";
            org.createdAt = null;
          }
          return sendJson(res, 200, { clean: true, lines: ["sim pool re-blanked"], pool: poolStatus() });
        }

        // Refuse while a provision is running — tearing the org down under a
        // live terraform apply would strand the demo mid-stream.
        for (const job of jobs.values()) {
          if (!job.done) {
            return sendJson(res, 409, { error: "a provision is still running — wait for it to finish" });
          }
        }

        const lines = [];
        try {
          const hub = REAL.hub && REAL.hub.apiToken
            ? { domain: `${REAL.hub.orgName}.${REAL.hub.baseUrl}`, token: REAL.hub.apiToken }
            : null;
          const { clean, results } = await resetPool(REAL.spokes, hub, (l) => lines.push(l));
          // Return cleaned orgs to the in-memory pool.
          for (const r of results) {
            if (r.clean) claimed.delete(r.subdomain);
          }
          for (let i = orgs.length - 1; i >= 0; i--) {
            if (results.some((r) => r.clean && r.subdomain === orgs[i].id)) orgs.splice(i, 1);
          }
          saveOrgs();
          jobs.clear();
          return sendJson(res, 200, { clean, lines, pool: poolStatus() });
        } catch (e) {
          console.error("[reset]", e && e.message);
          return sendJson(res, 500, { error: "reset failed", lines });
        }
      }

      // --- Templates -----------------------------------------------------
      // Real mode is internet-facing: catalog and pool require a session.
      // Sim mode stays open (stage-safe demo + tests).
      if (method === "GET" && pathname === "/api/templates") {
        if (IS_REAL && !currentUser(req)) {
          return sendJson(res, 401, { error: "not authenticated" });
        }
        return sendJson(res, 200, { templates: TEMPLATES, appCatalog: APP_CATALOG });
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

        // --- Real mode: claim a spoke and run a live terraform apply -------
        if (IS_REAL) {
          // Never hand out a spoke whose token failed the boot probe.
          const spoke = (REAL.spokes || []).find(
            (s) => s.token && !claimed.has(s.subdomain) && s.tokenOk !== false
          );
          if (!spoke) {
            return sendJson(res, 409, { error: "pool exhausted" });
          }
          claimed.add(spoke.subdomain);

          const name = (body && body.name) || `${template.name} spoke`;
          const options = (body && body.options) || {};
          const resolved = resolveTemplate(template, options);
          const jobId = crypto.randomUUID();
          const job = {
            lines: [],
            done: false,
            result: null,
            spoke,
            user,
            name,
            templateId,
            resolved,
          };
          jobs.set(jobId, job);

          // Fire the apply asynchronously; the client watches it over SSE.
          (async () => {
            // Feature-gate realms per org BEFORE the apply (explicit skip line).
            const realmsOk =
              resolved.realms.length > 0 ? await orgSupportsRealms(spoke) : false;
            if (resolved.realms.length && !realmsOk) {
              job.lines.push(
                ">> realms: skipped — the Realms feature is not available on this org"
              );
            }

            const r = await provisionSpoke({
              spoke,
              hub: REAL.hub, // hub creds always (provider init); federation gated:
              // DEMO_FEDERATION=off -> baseline-only + pre-staged SSO URL.
              federation: REAL.federationInProvision,
              vars: {
                org_display_name: name,
                template_id: templateId,
                deploy_apps: resolved.apps,
                realm_names: resolved.realms,
                enable_realms: realmsOk,
              },
              onLine: (line) => job.lines.push(line),
            });

            if (r.ok) {
              const outputs = r.outputs || {};

              // Post-apply governance: recurring access certification campaign.
              const campaign = await createCertificationCampaign({
                domain: spoke.domain,
                token: spoke.token,
                groupId: outputs.baseline_group_id,
                orgDisplayName: name,
                campaign: resolved.campaign,
                onLine: (line) => job.lines.push(line),
              });

              const plan = [...(outputs.applied_summary || [])];
              plan.push(
                campaign.status === "scheduled"
                  ? `Scheduled ${campaign.cadence} access certification campaign`
                  : `Certification campaign skipped — ${campaign.reason}`
              );

              const orgRecord = {
                id: spoke.subdomain,
                name,
                template: templateId,
                status: "claimed",
                federation: "federated",
                ownerId: user.id,
                login_url: outputs.spoke_login_url || null,
                // "Open (SSO)" deep-links to the federated hub launch, not the
                // bare spoke login — this is the hub-as-IdP hero moment.
                sso_entry_url: outputs.hub_sso_entry_url || REAL.ssoEntryUrl || null,
                hub_app_id: outputs.hub_app_id || null,
                campaign,
              };
              orgs.push(orgRecord);
              saveOrgs();
              job.result = { org: orgRecord, plan };
            } else {
              job.result = { error: "provisioning failed", code: r.code };
            }
            job.done = true;
          })().catch((e) => {
            job.result = { error: "provisioning failed", detail: String(e && e.message) };
            job.done = true;
          });

          return sendJson(res, 200, { jobId });
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
        org.resolved = resolveTemplate(template, org.options);
        org.federation = "federated";
        org.createdAt = new Date().toISOString();

        const plan = buildPlan(org, template, user, org.resolved);
        return sendJson(res, 200, { org, plan });
      }

      // --- Live terraform stream (SSE, real mode only) -------------------
      if (
        IS_REAL &&
        method === "GET" &&
        pathname.startsWith("/api/provision/") &&
        pathname.endsWith("/stream")
      ) {
        const jobId = pathname.slice(
          "/api/provision/".length,
          -"/stream".length
        );
        const job = jobs.get(jobId);
        if (!job) {
          return sendJson(res, 404, { error: "not found" });
        }

        res.writeHead(200, {
          "content-type": "text/event-stream; charset=utf-8",
          "cache-control": "no-cache",
          connection: "keep-alive",
        });

        let cursor = 0;
        let closed = false;
        const finish = () => {
          if (closed) return;
          closed = true;
          clearInterval(timer);
          res.end();
        };
        const timer = setInterval(() => {
          if (closed) return;
          // Flush any newly-buffered lines.
          while (cursor < job.lines.length) {
            res.write(`data: ${job.lines[cursor++]}\n\n`);
          }
          if (job.done) {
            const payload = job.result && job.result.org
              ? { org: job.result.org, plan: job.result.plan }
              : { error: (job.result && job.result.error) || "provisioning failed" };
            res.write(`event: done\ndata: ${JSON.stringify(payload)}\n\n`);
            finish();
          }
        }, 150);

        req.on("close", finish);
        return; // response stays open, driven by the interval
      }

      // --- My orgs -------------------------------------------------------
      if (method === "GET" && pathname === "/api/my-orgs") {
        const user = currentUser(req);
        if (!user) {
          return sendJson(res, 401, { error: "not authenticated" });
        }
        // Real mode lists the terraform-provisioned orgs; sim lists the pool.
        const source = IS_REAL ? orgs : pool;
        return sendJson(res, 200, { orgs: listMyOrgs(source, user.id) });
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
    console.log(`Org Factory portal listening on http://localhost:${shown}`);
  });
  return server;
}

// Run directly (node portal/server.mjs) but stay importable for the test.
if (import.meta.url === `file://${process.argv[1]}`) {
  start();
}
