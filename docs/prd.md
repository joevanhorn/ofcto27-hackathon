# PRD: Self-Service Okta Spoke Provisioning Portal

## Problem Statement

I lead a business division and I need to own and run my own Okta org — for a new business
unit, an M&A integration, a partner portal, or a demo/POC. Today I can't just get one. I
have to file a ticket with the central identity team and wait days, because I don't have the
Okta expertise to stand an org up myself and I can't safely be given super-admin on the
shared hub. While I wait, the fastest way to unblock myself is the wrong way: spin up a
rogue AD instance or a free Okta dev tenant that nobody governs.

From the central security & identity team's side, the same problem looks like a different
pain: we are a manual bottleneck for every new org, and the delay we introduce is exactly
what pushes our business units into ungoverned shadow IT that we then have to hunt down and
remediate.

## Solution

A self-service portal that turns "I need a new Okta org" into a governed, templated request
I can complete myself in minutes. I sign in with my existing hub Okta identity; if I'm an
authorized Division Lead, I pick a template, name my org, and submit. The portal shows me,
in plain language, exactly what it's going to do, then provisions a new spoke org from a
pre-warmed pool — applying a baseline security template and federating it to the hub
automatically. Moments later I open my new org from a dashboard and I'm signed straight in
from the hub, no new password. I own my spoke and nothing else.

For the central team, the governed path is now faster and easier than shadow IT, so the
insecure option dies on its own — good security is the path of least resistance. The hub
team governs the whole fleet of spokes through Okta Aerial: a single-pane inventory plus
time-bound, requestable access into any spoke, so they hold no standing super-admin across
the estate.

## User Stories

### Division Lead — access & authorization
1. As a Division Lead, I want to sign in to the portal with my existing hub Okta identity, so that I don't have to manage yet another account.
2. As a Division Lead, I want my ability to request an org to depend on my membership of the `Division Leads` group, so that authorization is centrally controlled and I never have to be granted hub admin.
3. As an unauthorized user, I want to be clearly told I can't request an org, so that I understand the guardrail rather than hitting a confusing error.

### Division Lead — requesting a spoke
4. As a Division Lead, I want to request a new spoke org by naming it and picking a template, so that I don't need Okta expertise to get a correctly-configured org.
5. As a Division Lead, I want to specify the owner email for the new org, so that ownership is explicit from the start.
6. As a Division Lead, I want to choose from predefined templates (e.g. "Sales Demo Org", "Partner Portal"), so that the org comes pre-configured for my use case.
6a. As a Division Lead, I want the options I can set to be presented as deterministic choices (dropdowns/toggles), not free-text fields, so that I cannot accidentally configure my org into an insecure or broken state.
7. As a Division Lead, I want to see a plain-language preview of exactly what will be created and changed before I commit, so that I understand and trust what the portal is about to do.
8. As a Division Lead, I want provisioning to feel near-instant, so that the governed path is faster than standing up shadow IT.

### Division Lead — using the result
9. As a Division Lead, I want my new spoke to be federated to the hub automatically, so that my users authenticate through the hub without extra setup.
10. As a Division Lead, I want to be auto-assigned as owner/admin of only my new spoke, so that I can run my org without ever touching the hub or other divisions' orgs.
11. As a Division Lead, I want to open my new spoke from the portal and be SSO'd straight in from the hub with no new password, so that the experience is seamless.
12. As a Division Lead, I want a "My Orgs" dashboard listing every org I own, so that I can see and access all my environments in one place.

### Division Lead — agentic path
13. As a Division Lead, I want to request a spoke conversationally through an agent/assistant, so that I can provision an org without navigating a GUI.
14. As a Division Lead, I want the agentic path to enforce the same authorization and guardrails as the GUI, so that convenience never weakens security.
14a. As a Division Lead who is not an Okta expert, I want the agent to explain options and guide me all the way to a completed request, so that I don't have to escalate to a human team.
14b. As a central identity admin, I want the agent to hold no standing provisioning power and instead act on-behalf-of the authenticated user via Okta Cross App Access, so that talking to the agent can never bypass the `Division Leads` gate.
14c. As a central identity admin, I want the agent to have its own first-class Okta agent identity so every action is attributable as "agent acting for user Y", so that agent activity is fully auditable.
14d. As a central identity admin, I want the agent to keep a human-in-the-loop approval before any apply, so that the agent proposes but an authorized human commits.

### Central Security / Identity admin
15. As a central identity admin, I want only members of `Division Leads` to be able to request orgs, so that provisioning stays authorized and auditable.
16. As a central identity admin, I want every spoke to be born with a baseline security template applied, so that no org is ever created insecure.
16a. As a central identity admin, I want to own and define the required section of each template, so that compliance requirements are set centrally rather than by the requester.
16b. As a central identity admin, I want Terraform to re-enforce the required baseline on every apply, so that downstream orgs cannot drift out of compliance over time.
16c. As a central identity admin, I want the requester's optional choices restricted to a deterministic, enumerated set, so that no selectable combination can produce a non-compliant org.
17. As a central identity admin, I want requesters to never receive hub or cross-spoke privileges, so that blast radius is minimized by design.
18. As a central identity admin, I want a single-pane inventory of every spoke (via Aerial), so that I always know what exists across the estate.
19. As a central identity admin, I want time-bound, requestable access into any managed spoke (via Aerial), so that I don't hold standing super-admin across every org.
20. As a central identity admin, I want the manual ticket-and-wait provisioning process eliminated, so that I stop being the bottleneck that drives shadow IT.

### Platform / system
21. As the platform, I want to claim orgs atomically from a pre-warmed pool of blank orgs, so that provisioning appears instant and org-birth latency is hidden.
21a. As the platform, I want to replenish the blank-org pool on a low-water mark, so that a requester never waits for an org even under bursty demand.
21b. As the platform, I want claimed orgs to be single-use (never re-blanked or returned to the pool), so that no identity or data can bleed between two different business owners.
21c. As a central identity admin, I want retiring a spoke to revoke its hub federation before anything else, so that the SSO path is cut the moment an org is decommissioned.
21d. As a Division Lead, I want a retired spoke archived for a configurable window (default 90 days, up to 1 year) before destruction, so that I can reactivate it if it turns out to still be needed.
22. As the platform, I want all spoke configuration driven by reusable Terraform templates, so that every org is provisioned consistently and reproducibly.
23. As the platform, I want to surface the Terraform plan as plain language to the user, so that a non-technical requester can understand and approve it.

## Implementation Decisions

- **Provisioning engine:** Terraform is the back end. Spoke configuration (baseline security
  policy, federation, group/admin-role scoping) is expressed as reusable templates so every
  org is consistent and reproducible.
- **Org supply model:** brand-new org creation via the Okta Org Creator API is out of reach
  (gated/partner-only), so the system **claims from a pre-warmed pool of blank orgs**. This
  doubles as a legitimate production pattern for hiding provisioning latency, so it is part
  of the target design, not only a demo shortcut.
- **Portal authentication:** the portal is an Okta OIDC-protected web app registered on the
  **hub** org.
- **Portal authorization:** gated by membership of the hub group `Division Leads`.
- **Ownership model:** the requester is programmatically scoped as owner/admin of only their
  new spoke; no hub or cross-spoke privileges are ever granted.
- **Federation:** **SAML Org2Org with the hub as IdP.** Each spoke is configured as an SP at
  provisioning time; users live in the hub and SSO *down* into their spoke, JIT-provisioned
  on first sign-in. Chosen for a single directory of record (one place to enforce MFA,
  deprovisioning, and audit) and because it is already proven in the reusable
  `modules/saml-federation` (hub IdP mode / spoke SP mode, config auto-exchanged via
  `terraform_remote_state`). Spokes never own their own user population.
- **Template model (two-part, central-governed):** each template has a **required section**
  owned by the central security & identity team — locked, not editable by the tool or the
  requester, and **re-enforced on every Terraform apply** so downstream orgs cannot drift out
  of compliance — plus an **optional section** exposed in the GUI as **deterministic,
  enumerated choices only (no free text)**. The selectable option set is constrained so no
  combination a requester can pick produces an insecure or broken org; guardrails live in the
  shape of the choices, not in after-the-fact review. Exact required-section controls are
  customer-defined (owned by their central team), not prescribed by the tool.
- **Pool refill & governed teardown:** the blank-org pool is replenished on a **low-water
  mark** (central automation pre-creates + baseline-configures new blanks below a threshold),
  so requesters never wait. **Claimed orgs are single-use** — never re-blanked or returned to
  the pool (re-blanking risks identity/data bleed between different owners). Retiring a spoke
  runs a **governed teardown**: revoke hub↔spoke federation first (SSO cut immediately),
  remove the owner's admin scoping, **archive** the org for a retention window
  (**default 90 days, configurable up to 1 year** as a deterministic enumerated choice), then
  **destroy** at window end unless reactivated.
- **Plan transparency:** the Terraform plan is translated into plain language and shown to
  the requester for approval before apply.
- **Agentic path (on-behalf-of, expert self-service):** the agent is an **expert assistant**
  whose purpose is to make a non-expert requester self-sufficient so the central human team is
  not pulled back in (the value collapses if users still need human help). It holds **no
  standing provisioning power**: the Division Lead authenticates with their hub identity and
  the agent acts **on behalf of that user** via Okta's **AI agent-security + Cross App Access
  (XAA)**, so Okta evaluates the *same* `Division Leads` gate as the GUI. The agent is a
  **first-class Okta agent identity** (actions attributable as "agent acting for user Y"),
  exposes provisioning over an **MCP bridge** where useful, and always keeps a
  **human-in-the-loop approval** before apply.
- **Dual entry points:** the same provisioning action is exposed through both the GUI and an
  agentic assistant; the agentic path must carry the requester's authorization so identical
  guardrails apply.
- **Central governance plane:** Okta Aerial is the target central-admin surface for fleet
  inventory and JIT time-bound admin access into spokes.

## Out of Scope

- Real org creation from nothing via the Org Creator API (replaced by pool-claim).
- Day-2 operations inside a spoke beyond the initial baseline template (ongoing user
  lifecycle, app assignment, custom policy tuning).
- Building the Aerial integration in the Day-1/demo tracer bullet — Aerial is target
  architecture and roadmap, not the demo path.
- Pool auto-refill and full deprovision/return-to-pool lifecycle (noted as an open question,
  not built for the demo).
- Billing, quota, and cost-allocation concerns for spawned orgs.

## Further Notes

- **Guiding principle:** "Good security is easier for the end user than being insecure." Every
  scope and UX decision is measured against whether the governed path beats the shadow-IT
  path on speed and friction.
- **Demo hero moment:** live SSO from the hub into a freshly-claimed, auto-federated spoke —
  no new password. The request → plain-language plan → approve flow is the supporting
  evidence; the seamless federated sign-in is the climax.
- **Resolved decisions log:** (1) federation → **SAML Org2Org, hub-as-IdP, users-in-hub
  SSO-down**; (2) template model → **central-owned required section (TF-enforced on every
  apply) + deterministic enumerated GUI knobs, no free text**; (3) pool lifecycle →
  **low-water-mark refill; single-use claimed orgs; governed teardown = revoke federation →
  archive 90d (up to 1y) → destroy**; (4) agentic path → **on-behalf-of via Okta agent
  identity + Cross App Access, MCP bridge, HITL approval; an expert agent whose job is to keep
  humans out of the loop** (see Implementation Decisions).
- **Open questions carried from `docs/solution.md`:** Aerial automation/API surface for
  auto-onboarding spokes; exact XAA / agent-security feature coverage needs a validation spike.
