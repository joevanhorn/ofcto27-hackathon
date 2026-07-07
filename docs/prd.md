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

### Central Security / Identity admin
15. As a central identity admin, I want only members of `Division Leads` to be able to request orgs, so that provisioning stays authorized and auditable.
16. As a central identity admin, I want every spoke to be born with a baseline security template applied, so that no org is ever created insecure.
17. As a central identity admin, I want requesters to never receive hub or cross-spoke privileges, so that blast radius is minimized by design.
18. As a central identity admin, I want a single-pane inventory of every spoke (via Aerial), so that I always know what exists across the estate.
19. As a central identity admin, I want time-bound, requestable access into any managed spoke (via Aerial), so that I don't hold standing super-admin across every org.
20. As a central identity admin, I want the manual ticket-and-wait provisioning process eliminated, so that I stop being the bottleneck that drives shadow IT.

### Platform / system
21. As the platform, I want to claim orgs atomically from a pre-warmed pool of blank orgs, so that provisioning appears instant and org-birth latency is hidden.
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
- **Federation:** each spoke is configured to federate to the hub at provisioning time
  (hub-and-spoke), enabling hub → spoke SSO.
- **Plan transparency:** the Terraform plan is translated into plain language and shown to
  the requester for approval before apply.
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
- **Open questions carried from `docs/solution.md`:** Aerial automation/API surface for
  auto-onboarding spokes; exact contents of the baseline security template; federation
  mechanism (Org2Org / SAML / OIDC) and its Terraform coverage against pool orgs; pool
  refill and deprovision lifecycle; agentic-path on-behalf-of authorization.
