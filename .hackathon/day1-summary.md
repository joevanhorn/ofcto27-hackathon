# Day 1 Summary — Handoff to Day 2

**Concept practised:** Spec-Driven Development. A full spec was interrogated and committed
*before any code was written*. Zero application code exists yet — this is intentional.

## What was decided

The build is a **self-service Okta spoke-org provisioning portal**. Full detail lives in the
committed spec — do not re-derive it, read these:

- `docs/solution.md` — statement of intent (problem, principle, identity model, demo, open questions)
- `docs/prd.md` — 23 user stories + implementation decisions + scope boundaries

### One-paragraph orientation
Authorized **Division Leads** self-serve a governed, templated Okta "spoke" org through an
Okta-OIDC-protected portal (GUI + agentic entry point). A **Terraform** back end claims an
org from a **pre-warmed pool of blank orgs**, applies a baseline security template, and
**auto-federates it to a central hub** (hub-and-spoke). The requester is scoped as owner of
*only* their spoke. Central security/identity governs the fleet via **Okta Aerial**
(inventory + JIT time-bound access). Guiding principle: *good security is easier than being
insecure* — the governed path must beat shadow IT (rogue AD / free dev tenants) on speed.

### Key locked decisions
- **Actors:** Division Lead (self-service spoke owner) + central security/identity (anti-shadow-IT).
- **Auth:** portal = Okta OIDC app on the hub; `Division Leads` group gates requests;
  requester auto-scoped to only their spoke, never the hub.
- **Org supply:** pre-warmed pool claim (Org Creator API is gated/partner-only) — also a real
  latency-hiding production pattern, not just a demo hack.
- **Demo hero moment:** live hub → spoke SSO into a freshly-claimed, federated org, no new password.
- **Aerial:** central-admin governance plane — architecture/roadmap, **out of the demo tracer bullet**.

## Head start: existing repo to reuse

Most of the Terraform provisioning back end already exists in
`joevanhorn/okta-terraform-demo-template`. Full reuse map in `docs/building-blocks.md`.
Load-bearing reuse: `modules/saml-federation` (hub-and-spoke Okta→Okta federation, done),
the `environments/<org>/` one-folder-per-tenant pattern, `aws-backend/` (per-spoke S3 state),
`demo-builder/` (template-driven generation), `ai-assisted/` (NL→Terraform, seeds the agentic
path). Net-new = the portal GUI + pool-claim orchestration + `Division Leads` authz + Aerial.
The reuse map already suggests the Day-2 agent seams (provisioning / Okta-specialist /
frontend / orchestration).

## Natural seams for Day 2 (multi-agent decomposition candidates)

These emerged as the independent lanes of the build — useful raw material for `/design-agents`:
- **Terraform provisioning engine** — pool claim, template apply, federation config.
- **Portal frontend + OIDC auth** — sign-in, request form, plain-language plan preview, "My Orgs" dashboard.
- **Template / federation logic** — baseline security template + hub-and-spoke federation mechanism.
- **Agentic entry point** — same provisioning action, on-behalf-of authorization.
- **Identity/Okta specialist** concern threads through all of the above (Aerial, federation, group gating).

## Open questions carried forward (from the spec)

Aerial automation/API surface; exact baseline-template contents; federation mechanism
(Org2Org / SAML / OIDC) + Terraform coverage; pool refill & deprovision lifecycle; agentic
on-behalf-of auth. See `docs/solution.md` → Open Questions and `docs/prd.md` → Further Notes.

## State of the repo
- Spec committed (`2cb39ee`) on top of the initial template commit. No code.
- Nothing blocked. Ready for Day 2 agent-architecture design.

## Suggested skills for Day 2
- `/start-day` — run first; loads Day 2 coaching and orients.
- `/design-agents` — the core Day 2 activity; designs the two-tier agent team from this spec.
- `/to-issues` — optional, if time remains: slice `docs/prd.md` into vertical tracer-bullet issues for the agents to pick up.
- `/wrap-day` — end of Day 2 to tag the submission.

## Sensitive info
None in these artifacts. No API keys, secrets, or PII were introduced. (Real tenant IDs,
tokens, and the org pool remain outside the repo.)
