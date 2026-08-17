// Unit test for the chat assistant's tool loop (mocked Anthropic API — no
// network). Verifies the manual loop executes tools, surfaces draft actions
// for the browser, and threads history correctly.

import { test } from "node:test";
import assert from "node:assert/strict";

import { runChat } from "../src/chat.mjs";

function jsonResponse(body) {
  return {
    ok: true,
    status: 200,
    json: async () => body,
  };
}

test("chat loop executes draft_request and returns the action + reply", async () => {
  const calls = [];
  // Turn 1: model calls draft_request. Turn 2: model replies with text.
  const responses = [
    jsonResponse({
      stop_reason: "tool_use",
      content: [
        { type: "text", text: "Drafting that for you." },
        {
          type: "tool_use",
          id: "toolu_1",
          name: "draft_request",
          input: {
            templateId: "partner-sandbox",
            name: "Acme Partner Pilot",
            options: { addon_apps: ["confluence"] },
          },
        },
      ],
    }),
    jsonResponse({
      stop_reason: "end_turn",
      content: [{ type: "text", text: "Draft is in the form — review the plan and confirm." }],
    }),
  ];
  const fetchImpl = async (url, opts) => {
    calls.push(JSON.parse(opts.body));
    return responses.shift();
  };

  const result = await runChat({
    messages: [{ role: "user", content: "I need a sandbox for partner Acme with Confluence" }],
    user: { name: "Dana Lead", groups: ["Division Leads"] },
    poolStatus: () => ({ ready: 3, total: 5 }),
    apiKey: "test-key",
    fetchImpl,
  });

  // The browser gets a draft action mirroring the tool input.
  assert.equal(result.actions.length, 1);
  assert.equal(result.actions[0].type, "draft");
  assert.equal(result.actions[0].templateId, "partner-sandbox");
  assert.equal(result.actions[0].name, "Acme Partner Pilot");

  assert.match(result.reply, /review the plan/);

  // Second API call carried the assistant turn + a tool_result back.
  assert.equal(calls.length, 2);
  const secondMessages = calls[1].messages;
  const last = secondMessages[secondMessages.length - 1];
  assert.equal(last.role, "user");
  assert.equal(last.content[0].type, "tool_result");
  assert.equal(last.content[0].tool_use_id, "toolu_1");
  const toolResult = JSON.parse(last.content[0].content);
  // resolveTemplate ran server-side: baseline Jira + chosen Confluence.
  assert.deepEqual(toolResult.resolved.apps, ["Jira", "Confluence"]);

  // Request shape: model + tools + effort config present, key only in headers.
  assert.equal(calls[0].model, "claude-opus-5");
  assert.ok(calls[0].tools.some((t) => t.name === "submit_request"));
  assert.deepEqual(calls[0].output_config, { effort: "low" });
});

test("chat loop flags unauthorized users on submit_request", async () => {
  const responses = [
    jsonResponse({
      stop_reason: "tool_use",
      content: [{
        type: "tool_use",
        id: "toolu_2",
        name: "submit_request",
        input: { templateId: "standard-division", name: "Sneaky Org", options: {} },
      }],
    }),
    jsonResponse({
      stop_reason: "end_turn",
      content: [{ type: "text", text: "Submitted — though the platform will enforce authorization." }],
    }),
  ];
  const bodies = [];
  const fetchImpl = async (url, opts) => {
    bodies.push(JSON.parse(opts.body));
    return responses.shift();
  };

  const result = await runChat({
    messages: [{ role: "user", content: "submit it" }],
    user: { name: "Sam Ployee", groups: [] },
    poolStatus: () => ({ ready: 1, total: 5 }),
    apiKey: "test-key",
    fetchImpl,
  });

  // Action still returned — the browser's submit hits the real guardrail.
  assert.equal(result.actions[0].type, "submit");
  // Tool result warned the model about the guardrail.
  const last = bodies[1].messages[bodies[1].messages.length - 1];
  const toolResult = JSON.parse(last.content[0].content);
  assert.match(toolResult.note, /not in Division Leads/);
});
