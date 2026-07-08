// Spoke Provisioning Portal — front-end controller.
// Plain vanilla JS, no build step, no dependencies. Talks only to the
// same-origin backend API described in the story contract.

"use strict";

const API = {
  session: "/api/session",
  login: "/api/login",
  logout: "/api/logout",
  templates: "/api/templates",
  requests: "/api/requests",
  myOrgs: "/api/my-orgs",
};

// Shared fetch options — always carry the session cookie.
const CREDS = { credentials: "same-origin" };

// In-memory client state.
const state = {
  user: null,
  templates: [],
  mode: "sim", // "sim" | "real" — set from GET /api/session
};

// ---------------------------------------------------------------------------
// Tiny DOM helpers
// ---------------------------------------------------------------------------
const $ = (sel) => document.querySelector(sel);
const el = (tag, props = {}, children = []) => {
  const node = document.createElement(tag);
  Object.assign(node, props);
  for (const c of [].concat(children)) {
    if (c == null) continue;
    node.appendChild(typeof c === "string" ? document.createTextNode(c) : c);
  }
  return node;
};

let toastTimer = null;
function toast(msg, isError = false) {
  const t = $("#toast");
  t.textContent = msg;
  t.className = "toast" + (isError ? " toast-error" : "");
  t.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { t.hidden = true; }, 3200);
}

async function jsonFetch(url, opts = {}) {
  const res = await fetch(url, { ...CREDS, ...opts });
  let body = null;
  try { body = await res.json(); } catch { /* non-JSON */ }
  return { status: res.status, ok: res.ok, body };
}

// ---------------------------------------------------------------------------
// Identity / session
// ---------------------------------------------------------------------------
// Real Okta OIDC identity strip: a single "Sign in with Okta" link, or the
// signed-in user's name/email + a "Sign out" link. Navigations (not fetches)
// because /login and /logout are server-side redirect endpoints.
function renderRealIdentity(host) {
  const label = $(".identity-label");
  if (label) label.textContent = "Signed in with Okta at the hub";

  if (!state.user) {
    host.appendChild(
      el("a", {
        className: "btn btn-login",
        href: "/login",
        textContent: "Sign in with Okta",
      })
    );
    return;
  }

  const u = state.user;
  const isLead = (u.groups || []).includes("Division Leads");
  const initials = (u.name || u.email || "?")
    .replace(/\(.*?\)/g, "")
    .trim()
    .split(/\s+/)
    .slice(0, 2)
    .map((w) => w[0])
    .join("")
    .toUpperCase();

  host.appendChild(
    el("div", { className: "who" + (isLead ? "" : " who-nonmember") }, [
      el("span", { className: "avatar", textContent: initials || "?" }),
      el("div", { className: "who-text" }, [
        el("div", { className: "who-name", textContent: u.name || u.email }),
        el("div", {
          className: "who-groups",
          textContent: u.email
            ? u.email + (isLead ? " · Division Leads ✓" : "")
            : isLead
            ? "Division Leads ✓"
            : "No provisioning group",
        }),
      ]),
    ])
  );
  host.appendChild(
    el("a", {
      className: "btn btn-signout",
      href: "/logout",
      textContent: "Sign out",
    })
  );
}

function renderIdentity() {
  const host = $("#identity-controls");
  host.textContent = "";

  if (state.mode === "real") {
    return renderRealIdentity(host);
  }

  if (!state.user) {
    host.appendChild(
      el("button", {
        className: "btn btn-login",
        onclick: () => login("lead"),
        textContent: "Sign in as Division Lead",
      })
    );
    host.appendChild(
      el("button", {
        className: "btn btn-login ghost",
        onclick: () => login("nonmember"),
        textContent: "Sign in as Non-member",
      })
    );
    return;
  }

  const u = state.user;
  const isLead = (u.groups || []).includes("Division Leads");
  const initials = (u.name || "?")
    .replace(/\(.*?\)/g, "")
    .trim()
    .split(/\s+/)
    .slice(0, 2)
    .map((w) => w[0])
    .join("")
    .toUpperCase();

  const who = el("div", { className: "who" + (isLead ? "" : " who-nonmember") }, [
    el("span", { className: "avatar", textContent: initials || "?" }),
    el("div", { className: "who-text" }, [
      el("div", { className: "who-name", textContent: u.name }),
      el("div", {
        className: "who-groups",
        textContent: isLead ? "Division Leads ✓" : "No provisioning group",
      }),
    ]),
  ]);
  host.appendChild(who);
  host.appendChild(
    el("button", {
      className: "btn btn-signout",
      onclick: logout,
      textContent: "Sign out",
    })
  );
}

async function login(role) {
  const { ok, body } = await jsonFetch(API.login, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ role }),
  });
  if (!ok || !body || !body.user) {
    toast("Sign-in failed.", true);
    return;
  }
  state.user = body.user;
  toast(`Signed in as ${body.user.name.replace(/\s*\(.*?\)\s*/g, "")}.`);
  onIdentityChange();
}

async function logout() {
  await jsonFetch(API.logout, { method: "POST" });
  state.user = null;
  onIdentityChange();
  toast("Signed out.");
}

// Called whenever the signed-in identity changes.
function onIdentityChange() {
  renderIdentity();
  resetFlowPanels();
  const form = $("#request-form");
  const notice = $("#signed-out-notice");
  if (state.user) {
    form.hidden = false;
    notice.hidden = true;
  } else {
    form.hidden = true;
    notice.hidden = false;
  }
  refreshMyOrgs();
}

// Hide plan/result/guardrail — used on identity change.
function resetFlowPanels() {
  $("#plan-card").hidden = true;
  $("#result-card").hidden = true;
  $("#guardrail-banner").hidden = true;
  $("#provision-btn").hidden = true;
  const term = $("#terraform-card");
  if (term) term.hidden = true;
}

// ---------------------------------------------------------------------------
// Templates + request form
// ---------------------------------------------------------------------------
function selectedTemplate() {
  const id = $("#template-select").value;
  return state.templates.find((t) => t.id === id) || null;
}

function renderTemplateSelect() {
  const sel = $("#template-select");
  sel.textContent = "";
  for (const t of state.templates) {
    sel.appendChild(el("option", { value: t.id, textContent: t.name }));
  }
  renderTemplateDetails();
}

function renderTemplateDetails() {
  const tpl = selectedTemplate();
  if (!tpl) return;

  $("#template-desc").textContent = tpl.description || "";

  // Required controls -> read-only chips.
  const chips = $("#controls-chips");
  chips.textContent = "";
  for (const c of tpl.requiredControls || []) {
    chips.appendChild(
      el("span", { className: "chip" }, [
        el("span", { className: "lock", textContent: "🔒" }),
        c,
      ])
    );
  }

  // Options -> selects only (never free-text).
  const wrap = $("#options-fields");
  wrap.textContent = "";
  for (const opt of tpl.options || []) {
    const select = el("select", { id: `opt-${opt.id}` });
    for (const ch of opt.choices || []) {
      select.appendChild(el("option", { value: ch.value, textContent: ch.label }));
    }
    wrap.appendChild(
      el("label", { className: "field" }, [
        el("span", { className: "field-label", textContent: opt.label }),
        select,
      ])
    );
  }

  // Changing template invalidates any shown preview.
  $("#plan-card").hidden = true;
  $("#provision-btn").hidden = true;
}

function collectOptions(tpl) {
  const out = {};
  for (const opt of tpl.options || []) {
    const node = document.getElementById(`opt-${opt.id}`);
    if (node) out[opt.id] = node.value;
  }
  return out;
}

// Human-readable option label lookup for the preview text.
function choiceLabel(tpl, optId, value) {
  const opt = (tpl.options || []).find((o) => o.id === optId);
  const ch = opt && (opt.choices || []).find((c) => c.value === value);
  return ch ? ch.label : value;
}

// Client-side plain-language plan (shown before committing).
function buildPreviewPlan(tpl, name, options) {
  const orgName = name || `${tpl.name}`;
  const steps = [
    `Claim a pre-warmed blank spoke org for "${orgName}".`,
    `Apply the ${tpl.name} baseline, enforcing: ${(tpl.requiredControls || []).join(", ")}.`,
  ];
  const optSummary = (tpl.options || [])
    .map((o) => `${o.label}: ${choiceLabel(tpl, o.id, options[o.id])}`)
    .join(" · ");
  if (optSummary) steps.push(`Configure options — ${optSummary}.`);
  steps.push("Federate the spoke to the hub via SAML Org2Org (hub is IdP).");
  steps.push("Assign you as scoped owner of this spoke only — no hub-wide access.");
  return steps;
}

function renderPlan(listSel, steps) {
  const list = $(listSel);
  list.textContent = "";
  for (const s of steps) list.appendChild(el("li", { textContent: s }));
}

function onPreview() {
  const tpl = selectedTemplate();
  if (!tpl) return;
  const name = $("#org-name").value.trim();
  const options = collectOptions(tpl);

  $("#guardrail-banner").hidden = true;
  renderPlan("#plan-list", buildPreviewPlan(tpl, name, options));
  $("#plan-card").hidden = false;
  $("#provision-btn").hidden = false;
  $("#plan-card").scrollIntoView({ behavior: "smooth", block: "nearest" });
}

// -------------------------------------------------------------------------
// Real-mode provisioning: POST returns a jobId, then we stream the live
// terraform apply over Server-Sent Events into the terminal console panel.
// -------------------------------------------------------------------------
function resetTerminal() {
  const pre = $("#terraform-lines");
  if (pre) pre.textContent = "";
}

function appendTermLine(text, kind) {
  const pre = $("#terraform-lines");
  if (!pre) return;
  const line = el("span", { className: "tline" + (kind ? " tline-" + kind : "") }, [
    text,
  ]);
  line.appendChild(document.createTextNode("\n"));
  pre.appendChild(line);
  // Auto-scroll to the newest line.
  const body = pre.closest(".term-body") || pre;
  body.scrollTop = body.scrollHeight;
}

// Classify a raw terraform line for light syntax coloring in the console.
function termKind(text) {
  if (/error|failed|\bfatal\b/i.test(text)) return "err";
  if (/(Creation complete|Apply complete|Modifications complete)/i.test(text)) return "add";
  if (/(Creating\.\.\.|Modifying\.\.\.|Still creating)/i.test(text)) return null;
  return null;
}

async function onProvisionReal() {
  const tpl = selectedTemplate();
  if (!tpl) return;
  const name = $("#org-name").value.trim();
  const options = collectOptions(tpl);

  const btn = $("#provision-btn");
  btn.disabled = true;
  btn.innerHTML = '<span class="spinner"></span>Provisioning…';

  const { status, body } = await jsonFetch(API.requests, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ name, templateId: tpl.id, options }),
  });

  // Non-200 short-circuits reuse the same guardrail / session / pool handling.
  if (status !== 200 || !body || !body.jobId) {
    btn.disabled = false;
    btn.innerHTML = '<span class="btn-label">Provision spoke</span>';
    if (status === 403) {
      $("#plan-card").hidden = true;
      $("#result-card").hidden = true;
      $("#guardrail-banner").hidden = false;
      $("#guardrail-banner").scrollIntoView({ behavior: "smooth", block: "nearest" });
      toast("Blocked by the governance guardrail.", true);
      return;
    }
    if (status === 401) {
      toast("Your session expired — please sign in again.", true);
      state.user = null;
      onIdentityChange();
      return;
    }
    if (status === 409) {
      toast((body && body.error) || "The spoke pool is exhausted.", true);
      return;
    }
    toast((body && body.error) || "Provisioning failed.", true);
    return;
  }

  // Reveal the live terminal and stream the apply.
  $("#plan-card").hidden = true;
  $("#guardrail-banner").hidden = true;
  $("#result-card").hidden = true;
  resetTerminal();
  $("#terraform-card").hidden = false;
  appendTermLine("$ terraform apply -auto-approve", "done");
  $("#terraform-card").scrollIntoView({ behavior: "smooth", block: "nearest" });

  const es = new EventSource(API.requests.replace(/\/requests$/, "") + "/provision/" + body.jobId + "/stream");

  es.onmessage = (e) => {
    appendTermLine(e.data, termKind(e.data));
  };

  es.addEventListener("done", (e) => {
    es.close();
    btn.disabled = false;
    btn.innerHTML = '<span class="btn-label">Provision spoke</span>';

    let payload = null;
    try { payload = JSON.parse(e.data); } catch { /* ignore */ }

    if (!payload || !payload.org) {
      appendTermLine((payload && payload.error) || "provisioning failed", "err");
      toast((payload && payload.error) || "Provisioning failed.", true);
      return;
    }

    appendTermLine("Apply complete — spoke provisioned.", "done");
    btn.hidden = true;
    $("#result-sub").textContent = `${payload.org.name} · ${payload.org.id} · federated ✓`;
    renderPlan("#result-plan", payload.plan || []);
    $("#result-card").hidden = false;
    $("#result-card").scrollIntoView({ behavior: "smooth", block: "nearest" });
    toast("Spoke provisioned and federated.");
    refreshMyOrgs();
  });

  es.onerror = () => {
    // The server closes the stream after `done`; only surface real failures.
    if (es.readyState === EventSource.CLOSED) return;
    es.close();
    btn.disabled = false;
    btn.innerHTML = '<span class="btn-label">Provision spoke</span>';
    appendTermLine("stream interrupted", "err");
    toast("Live stream interrupted.", true);
  };
}

async function onProvision() {
  if (state.mode === "real") {
    return onProvisionReal();
  }

  const tpl = selectedTemplate();
  if (!tpl) return;
  const name = $("#org-name").value.trim();
  const options = collectOptions(tpl);

  const btn = $("#provision-btn");
  btn.disabled = true;
  btn.innerHTML = '<span class="spinner"></span>Provisioning…';

  const { status, body } = await jsonFetch(API.requests, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ name, templateId: tpl.id, options }),
  });

  btn.disabled = false;
  btn.innerHTML = '<span class="btn-label">Provision spoke</span>';

  if (status === 200 && body) {
    // Success — show returned plan (authoritative), hide preview/guardrail.
    $("#plan-card").hidden = true;
    $("#guardrail-banner").hidden = true;
    btn.hidden = true;
    $("#result-sub").textContent = `${body.org.name} · ${body.org.id} · federated ✓`;
    renderPlan("#result-plan", body.plan || []);
    $("#result-card").hidden = false;
    $("#result-card").scrollIntoView({ behavior: "smooth", block: "nearest" });
    toast("Spoke provisioned and federated.");
    refreshMyOrgs();
    return;
  }

  if (status === 403) {
    // The guardrail — the whole point of the demo. Do NOT hide the form.
    $("#plan-card").hidden = true;
    $("#result-card").hidden = true;
    $("#guardrail-banner").hidden = false;
    $("#guardrail-banner").scrollIntoView({ behavior: "smooth", block: "nearest" });
    toast("Blocked by the governance guardrail.", true);
    return;
  }

  if (status === 401) {
    toast("Your session expired — please sign in again.", true);
    state.user = null;
    onIdentityChange();
    return;
  }

  if (status === 409) {
    toast((body && body.error) || "The spoke pool is exhausted.", true);
    return;
  }

  toast((body && body.error) || "Provisioning failed.", true);
}

// ---------------------------------------------------------------------------
// My orgs
// ---------------------------------------------------------------------------
function templateName(id) {
  const t = state.templates.find((x) => x.id === id);
  return t ? t.name : id || "—";
}

async function refreshMyOrgs() {
  const list = $("#orgs-list");
  if (!state.user) {
    list.innerHTML = '<div class="empty">Sign in to see the spokes you own.</div>';
    return;
  }

  const { status, body } = await jsonFetch(API.myOrgs);
  if (status !== 200 || !body) {
    list.innerHTML = '<div class="empty">Could not load your orgs.</div>';
    return;
  }

  const orgs = body.orgs || [];
  if (orgs.length === 0) {
    list.innerHTML = '<div class="empty">No spokes yet. Provision one to see it here.</div>';
    return;
  }

  list.textContent = "";
  for (const org of orgs) {
    const federated = org.federation === "federated";
    const info = el("div", { className: "org-info" }, [
      el("div", { className: "org-name" }, [
        org.name || org.id,
        federated ? el("span", { className: "fed-badge", textContent: "federated ✓" }) : null,
      ]),
      el("div", { className: "org-meta" }, [
        templateName(org.template),
        "  ·  ",
        el("code", { textContent: org.id }),
      ]),
    ]);

    // Real mode: open the actual spoke sign-in URL from terraform outputs.
    // Sim mode: the simulated hub SSO landing page.
    const target =
      state.mode === "real" && org.login_url
        ? org.login_url
        : `/sso/${encodeURIComponent(org.id)}`;
    const openBtn = el("button", {
      className: "btn btn-primary",
      textContent: "Open (SSO)",
      onclick: () => { window.location.href = target; },
    });

    list.appendChild(el("div", { className: "org" }, [info, openBtn]));
  }
}

// ---------------------------------------------------------------------------
// Boot
// ---------------------------------------------------------------------------
async function loadTemplates() {
  const { status, body } = await jsonFetch(API.templates);
  if (status === 200 && body && Array.isArray(body.templates)) {
    state.templates = body.templates;
    renderTemplateSelect();
  }
}

async function loadSession() {
  const { status, body } = await jsonFetch(API.session);
  state.user = status === 200 && body ? body.user : null;
  if (status === 200 && body && body.mode) state.mode = body.mode;
}

function wireEvents() {
  $("#template-select").addEventListener("change", renderTemplateDetails);
  $("#preview-btn").addEventListener("click", onPreview);
  $("#provision-btn").addEventListener("click", onProvision);
  // Any form edit invalidates a stale preview so the user re-previews.
  $("#request-form").addEventListener("input", (e) => {
    if (e.target.id === "template-select") return;
    $("#plan-card").hidden = true;
    $("#provision-btn").hidden = true;
  });
}

// Surface a real-mode login error passed back on the redirect URL, then strip
// it so a refresh is clean. Never contains tokens — just a short code.
function showLoginErrorFromUrl() {
  const err = new URLSearchParams(window.location.search).get("error");
  if (!err) return;
  toast(`Sign-in failed (${err}). Please try again.`, true);
  const clean = window.location.pathname;
  window.history.replaceState({}, "", clean);
}

async function boot() {
  wireEvents();
  await loadTemplates();
  await loadSession();
  onIdentityChange();
  showLoginErrorFromUrl();
}

boot();
