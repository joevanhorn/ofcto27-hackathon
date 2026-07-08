# Demo Script — Self-Service Okta Spoke Provisioning Portal

*Finalist presentation. Target: 3 minutes. Everything below runs locally, offline, with no
external calls — nothing can fail against a live tenant on stage.*

## Run it

```bash
cd ofcto27-hackathon          # your clone (personal or org repo)
node portal/server.mjs        # serves http://localhost:3000
```
Open **http://localhost:3000** in a browser.

**Reset between rehearsals:** the pool + sessions are in-memory — just **restart the server**
(Ctrl-C, re-run) to get all 5 blank orgs back and a clean slate.

**Prove it's real (optional pre-show sanity):** `node --test portal/test/` → 25/25 passing.

## What's real vs. simulated (say this if asked)

- **Real:** the authorization gate (`Division Leads` group), the atomic single-use pool claim,
  owner-scoped visibility — the exact logic, 25 automated tests.
- **Simulated for a safe stage demo:** the Okta OIDC login (the identity switcher), the SAML
  federation apply, and the Terraform apply. This is the same posture as the spec's decision to
  claim from a *pre-warmed pool of blank orgs* — a legitimate production pattern, not a shortcut.

---

## The 3-minute narrative

**0:00 — The problem (one sentence, customer voice).**
> "A division lead needs their own Okta org — for an M&A, a partner portal, a demo — and today
> they file a ticket and wait days, so they go rogue and stand up a shadow AD instead. Central
> security is stuck being the bottleneck *and* policing the sprawl."

Land the thesis: **"Good security has to be *easier* than the insecure path. That's the whole
product."**

**0:30 — Self-service, governed.** Sign in (top-right) as **Division Lead**.
> "I'm a division lead. I sign in with my existing hub identity — no new account."

Pick the **Standard Division Spoke** template, name it e.g. *"NA Sales Demo,"* set the two
options. Point at them:
> "Everything I *can* choose is a dropdown — never free text. I physically cannot configure this
> org into an insecure state. And these controls" *(the 🔒 chips)* "are locked by central
> security and re-enforced on every Terraform apply."

**1:15 — Plain-language plan → provision.** Click **Preview plan**, then **Provision**.
> "Before anything happens, I see in plain English exactly what it will do — claim an org, apply
> the baseline, federate to the hub, and scope me as owner of *only* this spoke."

It provisions instantly (pool claim).

**1:45 — The hero moment.** Go to **My Orgs**, click **Open (SSO)** on the new org.
> "There's my new org, already federated. I click in — and I'm *signed straight in from the hub,
> no new password.* SAML Org2Org, hub as IdP. Governed, and effortless."

**2:15 — The guardrail (proof it's real).** Sign in as **Non-member**, try to provision.
> "And if I'm *not* authorized — the request is blocked at the API, not just hidden in the UI.
> The `Division Leads` group in Okta is the gate."

**2:35 — How it was built (the meta-story judges love).**
> "This was built spec-first (Day 1), then by a *team of AI sub-agents I architected* (Day 2) —
> an Architect and a Scrum Master dispatching ephemeral Engineers against deep Okta, Terraform,
> and platform specialists. This running app was built by that team, in parallel, and I
> orchestrated it."

**2:50 — What's next (shows you know the edges).**
> "Next: wire the real OIDC tokens and the `saml-federation` Terraform module against a live hub,
> and close the loop to central admins with Okta Aerial for fleet inventory and JIT access."

---

## If you have 60 seconds, not 3

Sign in as Lead → provision → **Open (SSO)** hero page → sign in as Non-member → blocked. That's
the whole story: *governed, effortless, and safe by default.*

## Mapping to the judging dimensions

- **Applicability:** it's built on reusable Terraform modules any Okta hub-and-spoke customer has.
- **Customer voice:** the framing is the central-security + division-lead pain, not the tech.
- **Innovativeness:** deterministic-knob templates + on-behalf-of agent provisioning via Cross App
  Access.
- **Wow factor:** one click → SSO into a brand-new, federated org with no new password.
