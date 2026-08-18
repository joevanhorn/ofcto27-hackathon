// Accenture Org Factory — front-end controller.
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
  pool: "/api/pool",
  poolReset: "/api/pool/reset",
  chat: "/api/chat",
};

// Shared fetch options — always carry the session cookie.
const CREDS = { credentials: "same-origin" };

// In-memory client state.
const state = {
  user: null,
  templates: [],
  appCatalog: [], // bookmark-app catalog, for labeling baseline/add-on apps
  mode: "sim", // "sim" | "real" — set from GET /api/session
  chatEnabled: false, // server has an assistant API key configured
  chatHistory: [], // full model-side history (server returns it each turn)
};

function appLabel(id) {
  const a = state.appCatalog.find((x) => x.id === id);
  return a ? a.label : id;
}

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
  // Real mode gates the catalog behind login — fetch it once signed in.
  if (state.user && !state.templates.length) loadTemplates();
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
  refreshChatToggle();
  refreshPool();
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

  // What the template always deploys — visible before any customization.
  const baseline = tpl.baseline || {};
  const baseChips = $("#baseline-chips");
  if (baseChips) {
    baseChips.textContent = "";
    for (const id of baseline.apps || []) {
      baseChips.appendChild(el("span", { className: "chip chip-app", textContent: appLabel(id) }));
    }
    for (const r of baseline.realms || []) {
      baseChips.appendChild(el("span", { className: "chip chip-realm", textContent: `Realm: ${r}` }));
    }
    if (baseline.campaign) {
      baseChips.appendChild(
        el("span", {
          className: "chip chip-campaign",
          textContent: `${baseline.campaign.cadence} access review`,
        })
      );
    }
  }

  // Customization — still closed-choice only (selects, multi-selects, toggles).
  const wrap = $("#options-fields");
  wrap.textContent = "";
  for (const opt of tpl.options || []) {
    const type = opt.type || "select";

    if (type === "multi") {
      const group = el("div", { className: "checks", id: `opt-${opt.id}` });
      for (const ch of opt.choices || []) {
        const box = el("input", { type: "checkbox", value: ch.value });
        group.appendChild(el("label", { className: "check" }, [box, el("span", { textContent: ch.label })]));
      }
      wrap.appendChild(
        el("div", { className: "field field-wide" }, [
          el("span", { className: "field-label", textContent: opt.label }),
          group,
        ])
      );
      continue;
    }

    if (type === "toggle") {
      const box = el("input", { type: "checkbox", id: `opt-${opt.id}`, checked: !!opt.default });
      wrap.appendChild(
        el("label", { className: "field field-toggle" }, [
          box,
          el("span", { className: "field-label", textContent: opt.label }),
        ])
      );
      continue;
    }

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
    if (!node) continue;
    const type = opt.type || "select";
    if (type === "multi") {
      out[opt.id] = [...node.querySelectorAll("input:checked")].map((b) => b.value);
    } else if (type === "toggle") {
      out[opt.id] = node.checked;
    } else {
      out[opt.id] = node.value;
    }
  }
  return out;
}

// Human-readable option label lookup for the preview text.
function choiceLabel(tpl, optId, value) {
  const opt = (tpl.options || []).find((o) => o.id === optId);
  const ch = opt && (opt.choices || []).find((c) => c.value === value);
  return ch ? ch.label : value;
}

// Mirror of the server's resolveTemplate(): concrete apps/realms/campaign for
// the preview. The server recomputes this authoritatively on submit.
function resolveClient(tpl, options) {
  const baseline = tpl.baseline || {};
  const apps = [...(baseline.apps || [])];
  for (const id of options.addon_apps || []) if (!apps.includes(id)) apps.push(id);

  const realms = [...(baseline.realms || [])];
  for (const opt of tpl.options || []) {
    if (opt.type === "toggle" && opt.realm && options[opt.id] && !realms.includes(opt.realm)) {
      realms.push(opt.realm);
    }
  }

  const campaign = { ...(baseline.campaign || {}) };
  if (options.review_cadence) campaign.cadence = options.review_cadence;
  return { apps, realms, campaign };
}

// Client-side plain-language plan (shown before committing).
function buildPreviewPlan(tpl, name, options) {
  const orgName = name || `${tpl.name}`;
  const { apps, realms, campaign } = resolveClient(tpl, options);
  const steps = [
    `Claim a pre-warmed blank org for "${orgName}".`,
    `Apply the ${tpl.name} baseline, enforcing: ${(tpl.requiredControls || []).join(", ")}.`,
  ];
  if (apps.length) steps.push(`Deploy applications: ${apps.map(appLabel).join(", ")}.`);
  if (realms.length) steps.push(`Create realm${realms.length > 1 ? "s" : ""}: ${realms.join(", ")}.`);
  if (campaign.cadence) {
    steps.push(`Schedule a ${campaign.cadence} access certification campaign ("${campaign.name || "Access review"}").`);
  }
  const optSummary = (tpl.options || [])
    .filter((o) => (o.type || "select") === "select")
    .map((o) => `${o.label}: ${choiceLabel(tpl, o.id, options[o.id])}`)
    .join(" · ");
  if (optSummary) steps.push(`Configure options — ${optSummary}.`);
  steps.push("Federate the org to the hub via SAML Org2Org (hub is IdP).");
  steps.push("Assign you as scoped owner of this org only — no hub-wide access.");
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
    btn.innerHTML = '<span class="btn-label">Provision org</span>';
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
      toast((body && body.error) || "The org pool is exhausted.", true);
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
    btn.innerHTML = '<span class="btn-label">Provision org</span>';

    let payload = null;
    try { payload = JSON.parse(e.data); } catch { /* ignore */ }

    if (!payload || !payload.org) {
      appendTermLine((payload && payload.error) || "provisioning failed", "err");
      toast((payload && payload.error) || "Provisioning failed.", true);
      return;
    }

    appendTermLine("Apply complete — org provisioned.", "done");
    btn.hidden = true;
    $("#result-sub").textContent = `${payload.org.name} · ${payload.org.id} · federated ✓`;
    renderPlan("#result-plan", payload.plan || []);
    $("#result-card").hidden = false;
    $("#result-card").scrollIntoView({ behavior: "smooth", block: "nearest" });
    toast("Org provisioned and federated.");
    refreshMyOrgs();
    refreshPool();
  });

  es.onerror = () => {
    // The server closes the stream after `done`; only surface real failures.
    if (es.readyState === EventSource.CLOSED) return;
    es.close();
    btn.disabled = false;
    btn.innerHTML = '<span class="btn-label">Provision org</span>';
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
  btn.innerHTML = '<span class="btn-label">Provision org</span>';

  if (status === 200 && body) {
    // Success — show returned plan (authoritative), hide preview/guardrail.
    $("#plan-card").hidden = true;
    $("#guardrail-banner").hidden = true;
    btn.hidden = true;
    $("#result-sub").textContent = `${body.org.name} · ${body.org.id} · federated ✓`;
    renderPlan("#result-plan", body.plan || []);
    $("#result-card").hidden = false;
    $("#result-card").scrollIntoView({ behavior: "smooth", block: "nearest" });
    toast("Org provisioned and federated.");
    refreshMyOrgs();
    refreshPool();
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
    toast((body && body.error) || "The org pool is exhausted.", true);
    return;
  }

  toast((body && body.error) || "Provisioning failed.", true);
}

// ---------------------------------------------------------------------------
// Chat assistant
// ---------------------------------------------------------------------------
function chatVisible() {
  return state.chatEnabled && !!state.user;
}

function refreshChatToggle() {
  const toggle = $("#chat-toggle");
  const panel = $("#chat-panel");
  if (!toggle) return;
  toggle.hidden = !chatVisible() || !panel.hidden;
  if (!chatVisible()) panel.hidden = true;
}

function appendChatMsg(text, who) {
  const box = $("#chat-messages");
  // Bubbles are plain text (textContent — no HTML injection); just strip the
  // markdown bold/italic markers the model sometimes emits.
  const plain = String(text).replace(/\*\*(.+?)\*\*/g, "$1").replace(/(^|\s)\*(\S[^*]*)\*/g, "$1$2");
  const node = el("div", { className: `chat-msg chat-msg-${who}`, textContent: plain });
  box.appendChild(node);
  box.scrollTop = box.scrollHeight;
  return node;
}

// Apply a draft/submit action from the assistant through the NORMAL form flow
// — same preview, same Provision button path, same server-side authz.
function applyChatAction(action) {
  const sel = $("#template-select");
  if (sel.value !== action.templateId) {
    sel.value = action.templateId;
    renderTemplateDetails();
  }
  $("#org-name").value = action.name || "";

  const tpl = selectedTemplate();
  for (const opt of (tpl && tpl.options) || []) {
    const node = document.getElementById(`opt-${opt.id}`);
    if (!node || !(opt.id in (action.options || {}))) continue;
    const val = action.options[opt.id];
    const type = opt.type || "select";
    if (type === "multi") {
      for (const box of node.querySelectorAll("input")) {
        box.checked = Array.isArray(val) && val.includes(box.value);
      }
    } else if (type === "toggle") {
      node.checked = !!val;
    } else {
      node.value = val;
    }
  }

  onPreview();
  if (action.type === "submit") {
    onProvision();
  }
}

async function sendChat(text) {
  state.chatHistory.push({ role: "user", content: text });
  appendChatMsg(text, "user");
  let pending = appendChatMsg("…", "assistant");

  const { status, body } = await jsonFetch(API.chat, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ messages: state.chatHistory }),
  });

  // A demo reset can clear the chat DOM while this turn is in flight —
  // re-attach so the reply is never written to a detached node.
  if (!pending.isConnected) pending = appendChatMsg("…", "assistant");

  if (status !== 200 || !body) {
    pending.textContent =
      status === 401
        ? "Your session expired — please sign in again."
        : "Sorry, the assistant is unavailable right now.";
    return;
  }

  state.chatHistory = body.messages || state.chatHistory;
  pending.textContent = body.reply || "(done)";
  for (const action of body.actions || []) {
    applyChatAction(action);
  }
}

function wireChat() {
  const toggle = $("#chat-toggle");
  const panel = $("#chat-panel");
  if (!toggle || !panel) return;
  toggle.addEventListener("click", () => {
    panel.hidden = false;
    toggle.hidden = true;
    $("#chat-text").focus();
  });
  $("#chat-close").addEventListener("click", () => {
    panel.hidden = true;
    refreshChatToggle();
  });
  $("#chat-form").addEventListener("submit", (e) => {
    e.preventDefault();
    const input = $("#chat-text");
    const text = input.value.trim();
    if (!text) return;
    input.value = "";
    sendChat(text);
  });
}

// ---------------------------------------------------------------------------
// Demo reset button
// ---------------------------------------------------------------------------
async function onResetDemo() {
  if (!window.confirm("Reset the demo? This wipes everything the portal created on every org and returns them to the blank pool.")) {
    return;
  }
  const btn = $("#reset-btn");
  btn.disabled = true;
  btn.innerHTML = '<span class="spinner"></span>Resetting…';

  const { status, body } = await jsonFetch(API.poolReset, { method: "POST" });

  btn.disabled = false;
  btn.innerHTML = "&#8635; Reset demo";

  if (status !== 200 || !body) {
    toast((body && body.error) || "Reset failed.", true);
    return;
  }
  if (!body.clean) {
    toast("Reset ran, but at least one org is not fully clean — check the server log.", true);
  } else {
    toast("Demo reset — all orgs back in the pool.");
  }
  resetFlowPanels();
  state.chatHistory = [];
  const chatBox = $("#chat-messages");
  if (chatBox) {
    while (chatBox.children.length > 1) chatBox.removeChild(chatBox.lastChild);
  }
  refreshPool();
  refreshMyOrgs();
}

// ---------------------------------------------------------------------------
// Pre-warmed pool badge
// ---------------------------------------------------------------------------
async function refreshPool() {
  const badge = $("#pool-badge");
  const resetBtn = $("#reset-btn");
  if (resetBtn) resetBtn.hidden = !state.user;
  if (!badge) return;
  const { status, body } = await jsonFetch(API.pool);
  if (status !== 200 || !body) {
    badge.hidden = true;
    return;
  }
  const bad = (body.orgs || []).filter((o) => o.status === "bad-token").length;
  let text = `${body.ready} of ${body.total} pre-warmed orgs ready`;
  if (bad) text += ` · ${bad} token issue${bad > 1 ? "s" : ""}`;
  $("#pool-badge-text").textContent = text;
  badge.classList.toggle("pool-low", body.ready === 0 || bad > 0 || body.hubTokenOk === false);
  badge.hidden = false;
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
    list.innerHTML = '<div class="empty">Sign in to see the orgs you own.</div>';
    return;
  }

  const { status, body } = await jsonFetch(API.myOrgs);
  if (status !== 200 || !body) {
    list.innerHTML = '<div class="empty">Could not load your orgs.</div>';
    return;
  }

  const orgs = body.orgs || [];
  if (orgs.length === 0) {
    list.innerHTML = '<div class="empty">No orgs yet. Provision one to see it here.</div>';
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

    // Real mode: the federated IdP-initiated launch URL (hub -> spoke SSO, no new
    // password), from terraform outputs; fall back to the spoke login URL.
    // Sim mode: the simulated hub SSO landing page.
    const target =
      state.mode === "real" && (org.sso_entry_url || org.login_url)
        ? (org.sso_entry_url || org.login_url)
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
    state.appCatalog = Array.isArray(body.appCatalog) ? body.appCatalog : [];
    renderTemplateSelect();
  }
}

async function loadSession() {
  const { status, body } = await jsonFetch(API.session);
  state.user = status === 200 && body ? body.user : null;
  if (status === 200 && body && body.mode) state.mode = body.mode;
  state.chatEnabled = !!(status === 200 && body && body.chatEnabled);
}

function wireEvents() {
  $("#template-select").addEventListener("change", renderTemplateDetails);
  $("#preview-btn").addEventListener("click", onPreview);
  $("#provision-btn").addEventListener("click", onProvision);
  $("#reset-btn").addEventListener("click", onResetDemo);
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
  wireChat();
  await loadTemplates();
  await loadSession();
  onIdentityChange();
  refreshPool();
  showLoginErrorFromUrl();
}

boot();
