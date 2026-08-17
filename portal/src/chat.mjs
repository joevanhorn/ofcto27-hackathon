// In-portal agentic chat concierge.
//
// Server-side proxy to the Anthropic Messages API (raw fetch — this portal is
// deliberately zero-dependency). The assistant helps a non-technical business
// user pick a template and fill in the request form; it never provisions
// directly. Instead its draft_request / submit_request tools return structured
// actions the browser applies to the SAME form + /api/requests flow a human
// would use — so authorization (Division Leads) and the guardrail stay
// enforced server-side on the one code path.
//
// SECURITY: the API key is read from the creds env / process env at call time
// and used only in the request header. Never logged, never sent to the client.

import { APP_CATALOG, TEMPLATES, resolveTemplate } from "./data.mjs";

const API_URL = "https://api.anthropic.com/v1/messages";
const MODEL = "claude-opus-5";
const MAX_TOOL_TURNS = 6;

export function chatApiKey(creds) {
  return (
    process.env.ANTHROPIC_API_KEY ||
    (creds && creds.ANTHROPIC_API_KEY) ||
    null
  );
}

const SYSTEM_PROMPT = `You are the Org Factory assistant, a concierge inside Accenture's internal Okta org-provisioning portal. Your users are business leads, not identity engineers — plain language, no jargon, no Okta internals.

What the portal does: an authorized Division Lead requests a new, fully governed Okta organization from a pre-warmed pool. They pick one of a few security-approved templates, optionally customize it with closed choices (add-on applications, extra realms, retention, region), and the platform provisions it automatically with security controls, applications, user realms, and a recurring access certification campaign already in place, federated to the corporate hub for single sign-on.

Your job: help the user choose the right template and options, then prepare the request for them.

How to work:
- Use list_templates to ground yourself in the current catalog before recommending anything.
- Ask only for what you actually need (usually: what the org is for, a name, and any special needs). One or two questions at a time.
- When you have enough, call draft_request — the portal fills the request form and shows the user the exact plan.
- Only call submit_request after the user has seen the draft and clearly confirms (e.g. "go ahead", "submit it").
- If the user isn't authorized, the platform will refuse at submission — that guardrail is a feature; explain it matter-of-factly.
- Keep replies to a few sentences. You are a helper in a side panel, not a report writer.`;

// Closed-choice tool schemas. draft/submit share the same request shape.
function requestSchema() {
  return {
    type: "object",
    properties: {
      templateId: {
        type: "string",
        enum: TEMPLATES.map((t) => t.id),
        description: "Template to base the org on",
      },
      name: { type: "string", description: "Human-readable organization name" },
      options: {
        type: "object",
        description:
          "Closed-choice customization, keyed by option id from list_templates (multi options take arrays, toggles take booleans)",
      },
    },
    required: ["templateId", "name"],
    additionalProperties: false,
  };
}

function tools() {
  return [
    {
      name: "list_templates",
      description:
        "List the org templates: what each one always deploys (apps, realms, certification cadence) and which customization options it offers. Call this before recommending a template.",
      input_schema: { type: "object", properties: {}, additionalProperties: false },
    },
    {
      name: "get_pool_status",
      description: "How many pre-warmed blank orgs are ready to be claimed right now.",
      input_schema: { type: "object", properties: {}, additionalProperties: false },
    },
    {
      name: "draft_request",
      description:
        "Fill the portal's request form with a draft org request so the user can review the exact provisioning plan. Does NOT provision anything.",
      input_schema: requestSchema(),
    },
    {
      name: "submit_request",
      description:
        "Submit the org request through the portal (same governed path as clicking Provision). Only after the user explicitly confirms a draft. Authorization is enforced server-side.",
      input_schema: requestSchema(),
    },
  ];
}

// Execute one tool call. Pure/read-only except that draft/submit RETURN an
// action for the browser — the server never provisions from inside the chat.
function runTool(name, input, { poolStatus, user }) {
  if (name === "list_templates") {
    return {
      templates: TEMPLATES.map((t) => ({
        id: t.id,
        name: t.name,
        description: t.description,
        alwaysDeploys: {
          apps: (t.baseline.apps || []).map(
            (id) => (APP_CATALOG.find((a) => a.id === id) || { label: id }).label
          ),
          realms: t.baseline.realms || [],
          certification: t.baseline.campaign,
        },
        options: t.options,
      })),
    };
  }

  if (name === "get_pool_status") {
    return poolStatus();
  }

  if (name === "draft_request" || name === "submit_request") {
    const template = TEMPLATES.find((t) => t.id === input.templateId);
    if (!template) return { error: `unknown template '${input.templateId}'` };
    const resolved = resolveTemplate(template, input.options || {});
    const isLead = (user.groups || []).includes("Division Leads");
    return {
      ok: true,
      resolved: {
        apps: resolved.apps.map((a) => a.label),
        realms: resolved.realms,
        campaign: resolved.campaign,
      },
      note:
        name === "submit_request" && !isLead
          ? "Heads up: this user is not in Division Leads, so the platform will refuse the submission (governance guardrail)."
          : undefined,
      // The browser applies this action through the normal form/submit flow.
      action: {
        type: name === "draft_request" ? "draft" : "submit",
        templateId: input.templateId,
        name: input.name,
        options: input.options || {},
      },
    };
  }

  return { error: `unknown tool '${name}'` };
}

/**
 * Run one chat turn: manual tool loop against the Messages API.
 *
 * @param {object} args
 * @param {Array<{role: "user"|"assistant", content: any}>} args.messages - prior turns (client-held history)
 * @param {object} args.user - the signed-in portal user ({name, groups})
 * @param {() => object} args.poolStatus - live pool snapshot
 * @param {string} args.apiKey
 * @param {typeof fetch} [args.fetchImpl] - injectable for tests
 * @returns {Promise<{reply: string, actions: object[], messages: Array}>}
 *   actions: draft/submit actions for the browser to apply; messages: updated history.
 */
export async function runChat({ messages, user, poolStatus, apiKey, fetchImpl = fetch }) {
  const history = [...messages];
  const actions = [];
  const system =
    SYSTEM_PROMPT +
    `\n\nSigned-in user: ${user.name}${(user.groups || []).includes("Division Leads") ? " (authorized Division Lead)" : " (NOT in Division Leads — cannot provision)"}.`;

  for (let turn = 0; turn < MAX_TOOL_TURNS; turn++) {
    const res = await fetchImpl(API_URL, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-api-key": apiKey,
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify({
        model: MODEL,
        max_tokens: 2048,
        output_config: { effort: "low" },
        system,
        tools: tools(),
        messages: history,
      }),
    });

    if (!res.ok) {
      const err = await res.json().catch(() => null);
      const summary = (err && err.error && err.error.message) || `HTTP ${res.status}`;
      throw new Error(`chat model call failed: ${summary}`);
    }
    const response = await res.json();

    if (response.stop_reason === "refusal") {
      return {
        reply: "I can't help with that request. Anything else about provisioning an org?",
        actions,
        messages: history,
      };
    }

    history.push({ role: "assistant", content: response.content });

    if (response.stop_reason !== "tool_use") {
      const reply = (response.content || [])
        .filter((b) => b.type === "text")
        .map((b) => b.text)
        .join("\n")
        .trim();
      return { reply, actions, messages: history };
    }

    // Execute every tool call in this turn; return all results in ONE user message.
    const results = [];
    for (const block of response.content || []) {
      if (block.type !== "tool_use") continue;
      const result = runTool(block.name, block.input, { poolStatus, user });
      if (result && result.action) actions.push(result.action);
      results.push({
        type: "tool_result",
        tool_use_id: block.id,
        content: JSON.stringify(result),
      });
    }
    history.push({ role: "user", content: results });
  }

  return {
    reply: "I hit my step limit for this turn — could you rephrase or confirm what you'd like to do?",
    actions,
    messages: history,
  };
}
