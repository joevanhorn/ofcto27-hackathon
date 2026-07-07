# Solution: Self-Service Okta Spoke Provisioning Portal

*Field CTO Summit Hackathon — Day 1 spec (statement of intent, not a design doc).*

## Problem statement

Organizations that run a hub-and-spoke Okta estate need to stand up new "spoke" orgs
regularly — for a new business unit, an M&A integration, a partner portal, a demo/POC
environment. Today that is a slow, expert-only task: a **Division Lead** who needs to own
and run a new org has to file a ticket and wait days for the central identity team to
hand-provision an org, apply security baselines, and wire up federation — because that
Division Lead cannot safely be handed super-admin on the hub.

The pain is felt on **both sides**:
- **Division Leads** are blocked, so the tempting shortcut is shadow IT — spinning up a
  rogue AD instance or a free Okta dev tenant that no one governs.
- **Central security & identity** are stuck being a manual bottleneck *and* policing the
  shadow-IT sprawl that results from being slow.

## Guiding principle

**Good security is easier for the end user than being insecure.** The portal must make the
governed path *faster and lower-friction* than the wrong path. If self-service through the
portal is easier than standing up a rogue AD, the insecure option dies on its own.

## Identity / Auth connection

Identity is not an add-on here — it *is* the product. The whole system is Okta lifecycle
management expressed as self-service:

- **Authentication:** the portal is an Okta-protected OIDC web app on the **hub** org.
- **Authorization:** access to request an org is gated by membership of the hub group
  **`Division Leads`**. No group, no portal.
- **Least-privilege ownership:** the requester is auto-assigned as owner/admin of **only
  their new spoke** — never the hub, never anyone else's spoke.
- **Federation:** every spoke is born already federated to the hub (hub-and-spoke),
  so users authenticate once at the hub and SSO into their spoke.
- **Central governance (Okta Aerial):** the hub team manages the fleet of spokes through
  Okta Aerial — single-pane inventory of every spoke plus **time-bound, requestable**
  access into any managed org, so central admins hold *no standing super-admin* across the
  estate.

## Solution description

A GUI portal (with an equivalent agentic entry point) that turns "I need a new Okta org"
into a governed, templated, self-service request:

1. A Division Lead signs in to the portal (Okta OIDC on the hub).
2. They fill a short form: org name, **template** (e.g. "Sales Demo Org", "Partner
   Portal"), owner email.
3. The portal generates a **Terraform plan** and shows it back **in plain language**:
   *"This will claim org X, apply the baseline security template, and federate it to the hub."*
4. On submit, Terraform runs against a **pre-warmed pool of blank Okta orgs** — one is
   *claimed* (simulating instant org creation while hiding org-birth latency), the baseline
   template is applied, and federation to the hub is configured.
5. The new spoke appears in the Lead's "My Orgs" dashboard, already federated, with the
   Lead scoped as its owner.

**What it does NOT do (Day 1 scope boundary):**
- It does not create brand-new Okta orgs from nothing via the Org Creator API (gated,
  partner-only). It **claims from a pre-warmed pool** instead — which is also a legitimate
  production pattern for hiding provisioning latency.
- It does not manage day-2 operations inside a spoke (user lifecycle, app assignment)
  beyond the initial baseline template.
- It does not build the Aerial integration in the demo — Aerial is the target
  central-admin governance plane (architecture/roadmap), not the tracer bullet.

## Demo scenario (the 3-minute story)

**Setup:** a pool of blank orgs pre-staged on the back end; the `Division Leads` group and
the portal OIDC app configured on the hub.

1. Division Lead logs into the portal (Okta SSO). A non-member is shown they can't request —
   proving the guardrail.
2. Lead requests a spoke from the "Sales Demo Org" template; the portal shows the
   plain-language Terraform plan.
3. On approval, Terraform claims a pool org, applies the baseline, and federates it.
4. **Hero moment:** the Lead opens the freshly-provisioned spoke from their dashboard and is
   **SSO'd straight in from the hub — no new password.** Governed, templated, effortless.

**What it proves:** the governed path is faster and easier than shadow IT, with
least-privilege ownership and hub federation baked in from birth.

## Technical approach

> **Reuse:** most of the provisioning back end already exists in
> `joevanhorn/okta-terraform-demo-template` — see [`docs/building-blocks.md`](building-blocks.md)
> for the reuse map (federation, per-org environment pattern, S3 state backend, template
> generation, agentic generator) versus the net-new portal + pool-claim work.

- **Backend:** Terraform (Okta provider + `oktapam`/related) as the provisioning engine;
  spoke config driven by reusable **templates** (baseline security policy, federation, group
  and admin-role scoping).
- **Org supply:** pre-warmed pool of blank Okta orgs, claimed atomically on request.
- **Frontend:** a GUI portal (Okta OIDC-protected) with request form, plain-language plan
  preview, and "My Orgs" dashboard.
- **Agentic entry point:** the same provisioning action exposed to an agent/assistant so a
  spoke can be requested conversationally, not only through the GUI.
- **Federation:** hub-and-spoke — spoke org configured to federate to the hub at creation.
- **Central governance:** Okta Aerial for fleet inventory + JIT time-bound admin access
  (target architecture).

## Open questions

- **Aerial automation surface:** does Aerial expose an API / Terraform coverage to
  auto-onboard each newly claimed spoke into its managed-org inventory, or is onboarding
  console-only? (Determines whether the loop to central governance can be fully automated.)
- **Template model:** how many baseline templates for the demo, and what exactly does the
  "baseline security" template enforce (MFA policy, admin roles, password policy, sign-on)?
- **Federation direction & type:** Org2Org / SAML / OIDC federation between hub and spoke —
  which mechanism, and is it fully Terraform-able against the pool orgs available?
- **Pool exhaustion & lifecycle:** how is the pool refilled, and what happens on
  deprovision (does a claimed org return to the pool)?
- **Agentic path auth:** how does the agent authenticate and carry the Division Lead's
  authorization (on-behalf-of) so the same guardrails apply as the GUI?
