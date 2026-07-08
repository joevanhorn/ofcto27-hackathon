# Self-Service Okta Spoke Provisioning Portal

A self-service portal that lets authorized **Division Leads** stand up governed, templated Okta
**spoke** orgs in minutes — no Okta expertise required — each auto-federated to a central hub in a
hub-and-spoke architecture. A GUI and an expert agentic assistant both drive the same governed,
Terraform-backed provisioning flow.

**Guiding principle:** *good security is easier for the end user than being insecure.* The governed
path is faster and lower-friction than shadow IT (a rogue AD instance or an ungoverned dev tenant),
so the insecure option dies on its own.

> Built at the OFCTO Velocity 27 Summit hackathon. **Day 1** produced the spec
> (`docs/solution.md`, `docs/prd.md`); **Day 2** designed the multi-agent build team that
> constructs it (`docs/multiAgentDesign.md`, `.claude/agents/`).

## What it does

1. A Division Lead signs in to the portal (Okta OIDC on the hub). Authorization to request an org
   is gated by the **`Division Leads`** group — no group, no request.
2. They pick a **template** and name their org; the portal shows a **plain-language preview** of
   the Terraform plan.
3. On approval, Terraform **claims a pre-warmed blank org** from a pool, applies a baseline
   security template, and configures **SAML Org2Org federation** to the hub (hub-as-IdP).
4. The requester is scoped as owner of **only their new spoke**, which appears in their "My Orgs"
   dashboard — and they **SSO straight into it from the hub, no new password** (the demo hero
   moment).

Central security/identity govern the fleet through **Okta Aerial** (inventory + JIT time-bound
access), holding no standing super-admin across the estate. See `docs/solution.md` and
`docs/prd.md` for the full spec and the resolved-decisions log (federation, template governance,
pool lifecycle, agentic on-behalf-of auth).

## Agent Team (the build)

This project is built by a **two-tier team of Claude Code sub-agents**, modelled on the
`ai-scrum-starter` harness. The point is context-window discipline: each agent holds exactly what
it needs and nothing more. Full rationale in [`docs/multiAgentDesign.md`](docs/multiAgentDesign.md);
definitions in [`.claude/agents/`](.claude/agents/).

**You are the human Product Owner + Project Manager.** You talk to one chat — the Scrum Master —
and it routes everything else.

| Tier | Agent | Role |
|---|---|---|
| 1 — Strategic | [Architect](.claude/agents/strategic/architect.md) | Turns your goal into a READY backlog + spikes; no code, no priority calls |
| 1 — Strategic | [Scrum Master](.claude/agents/strategic/scrum-master.md) | Orchestrates & tracks; dispatches Engineers, surfaces decisions to you |
| 2 — Implementation | [Engineer](.claude/agents/implementation/engineer.md) | Ephemeral; executes ONE story, reports a handoff block, then terminates |
| 2 — Specialist | [Okta / Identity](.claude/agents/implementation/okta-identity-specialist.md) | The *what/why* of identity — federation, OIDC, gating, Aerial, XAA |
| 2 — Specialist | [Terraform](.claude/agents/implementation/terraform-specialist.md) | The *how* of IaC — Okta/AWS providers, reusable modules, state |
| 2 — Specialist | [Platform](.claude/agents/implementation/platform-specialist.md) | Ground-truth facts of the existing AWS hosting environment |

## How to run the build

1. Open Claude Code **inside this repo** (as the workspace), on a branch.
2. Hand the **Architect** a goal (start with the tracer thread in `docs/multiAgentDesign.md`); it
   returns a READY backlog.
3. Give the approved backlog to the **Scrum Master**; it checks the Definition of Ready and
   dispatches **Engineers** in parallel for independent stories. Ask "where are we?" any time.
4. When an Engineer **stops and surfaces**, that's by design — answer its handoff question and a
   fresh Engineer continues. You own every direction call.

New to the team model? Read *"How this team works for you (the human)"* in
[`docs/multiAgentDesign.md`](docs/multiAgentDesign.md) first — it covers the one-chat-box model,
build-agents vs. the product's own agent, the Definition of Ready, and what to do when an Engineer
stops.

## Reuse

Most of the provisioning back end already exists in
[`joevanhorn/okta-terraform-demo-template`](https://github.com/joevanhorn/okta-terraform-demo-template)
— `modules/saml-federation`, the `environments/<org>` pattern, `aws-backend`, `demo-builder`, and
the `ai-assisted` generator. See [`docs/building-blocks.md`](docs/building-blocks.md) for the reuse
map vs. the net-new portal + pool-claim work.

## Security note

The build team is threat-modelled (see the *Threat Model & Hardening* section of
`docs/multiAgentDesign.md`). The ephemeral one-Engineer-per-story pattern contains prompt-injection
blast radius; agent definitions are read-only at runtime; the "trivial fix" exception never applies
to auth/SAML paths. Adopters running this outside the hackathon should also apply the hard
guardrails listed there (`settings.json` allow-list, tool-target-based autonomy gating, `git push`
egress control).
