# Day 2 Summary — Handoff to Day 3

**Concept practised:** Multi-Agent Design & Managing the Context Window. The primary deliverable
is the agent team design; a working tracer bullet was also built by that team.

## What was designed

A two-tier team of Claude Code **build** agents (modelled on `joevanhorn/ai-scrum-starter`) that
constructs the Day-1 product. Full design + rationale: `docs/multiAgentDesign.md`. Definitions:
`.claude/agents/`. Do not re-derive — read those.

- **Human = Product Owner + Project Manager.** Main session = Scrum Master (orchestrator).
- **Tier 1 strategic:** `architect` (goal → READY backlog + spikes), `scrum-master` (dispatch/track;
  procedural-vs-substantive bright line).
- **Tier 2 implementation:** ephemeral `engineer` (one story, handoff block, surface-on-failure) +
  three consulted specialists — `okta-identity-specialist` (what/why of identity),
  `terraform-specialist` (how of IaC), `platform-specialist` (existing-AWS-env ground-truth cache).
- **Context-window reasoning is explicit** (`docs/multiAgentDesign.md`): implementation context is
  created per story and destroyed at teardown; specialists are static reusable caches.

## Hardening (from two challenger sub-agents)

A confused-user and a malicious-user persona stress-tested the design; findings folded in:
- Usability: "How this team works for you" onboarding (one chat box; build-vs-product agents; DoR
  with a worked example; what to do when an Engineer stops); vocabulary reconciled to
  Architect+Scrum Master (no PO/PM agent file); contextual teaching duty on Tier 1.
- Security: untrusted-data framing vs prompt injection; trivial-fix carve-out excludes auth/SAML
  paths; Scrum Master retries only on harness spawn faults; DoR evaluated at dispatch (no trusted
  READY flag); agent defs read-only. Hard-guardrail recommendations (settings.json, tool-target
  autonomy gating, git-push egress) documented for adopters; the hackathon harness left untouched.

## What was built (tracer bullet)

Scrum Master dispatched three ephemeral Engineers in parallel; main session orchestrated + verified
only. Node 20, ES modules, `node:test`, zero external deps. Under `portal/`:
- `src/authz.mjs` — Division Leads group-gate (7 tests)
- `src/pool.mjs` — atomic single-use pool claim (6 tests)
- `src/myorgs.mjs` — least-privilege owner-scoped listing (10 tests)
- **23/23 tests passing** (`node --test portal/test/`). Commit `a4f87bb`.

Open decisions surfaced by Engineers (PO-aware, non-blocking): pool exhaustion throws vs returns;
`myorgs` fails closed and hides unclaimed orgs; authz matches group display-name (confirm name vs id
when OIDC wiring lands).

## State of the repo

- Day 1 spec + resolved decisions (federation, template model, pool lifecycle, agentic path) intact.
- Day 2 agent design + tracer build committed and pushed to `origin` = `ofctoV27/joevanhorn-hackathon`.
- Follow-on stories (not built): real RDS-backed pool store, OIDC token wiring, SAML Org2Org apply
  via `modules/saml-federation`, XAA/Aerial spikes.

## Suggested skills (Day 3)

- No `/wrap-day` on Day 3.
- `/handoff` if capturing the three-day arc for personal reference.
- If continuing the build later: open Claude Code **inside the repo**, hand the Architect the next
  goal, let the Scrum Master dispatch Engineers.

## Sensitive info

None in these artifacts. No API keys, secrets, or PII. Real tenant IDs, tokens, and pool-org
credentials remain outside the repo.
