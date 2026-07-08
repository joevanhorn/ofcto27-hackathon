# Demo Script — Self-Service Okta Spoke Provisioning Portal

Two ways to run it:
- **REAL mode** (`DEMO_MODE=real`) — real Okta OIDC login, a real `terraform apply` streamed
  live, and a real hub→spoke SAML SSO. This is what you **pre-record**.
- **SIM mode** (default) — fully in-memory, no external calls, 25 passing tests. Your
  **stage-safe fallback** if anything ever misbehaves.

---

## REAL MODE — the recording

### Prerequisites (on the machine you record from)
- Node 20+ and Terraform 1.9+ installed.
- The repo cloned, and `~/okta-demo-creds.env` present (hub + spoke tokens + the OIDC
  client_id/secret). Ask Claude to print it if you need to recreate it on your laptop.
- Run on **port 3000** — the Okta OIDC app's redirect URI is `http://localhost:3000/callback`.

### Launch
```bash
cd ofcto27-hackathon
cd portal/terraform && terraform init >/dev/null && cd ../..   # once
DEMO_MODE=real node portal/server.mjs                          # http://localhost:3000
```

### Recording logins (throwaway org)
- **Division Lead (authorized):** `joe.vanhorn@okta.com` (your password)
- **Non-member (blocked):** `sam.nomember@velocity27demo.com` / `Velocity27!demo`

### Reset between takes
- **Restart the server** — the claimed-spoke set and sessions are in-memory, so a restart
  gives you clean pool + signed-out state.
- If a take actually provisioned a spoke, reset that org so the next take creates on camera:
  ```bash
  cd portal/terraform
  # (Claude can hand you a one-liner that destroys the per-spoke state for a clean reset.)
  ```

### The three beats (~3 minutes)

**0:00 — Problem (one sentence).** "A division lead needs their own Okta org and waits days
on a ticket, so they go shadow IT. We make the governed path the *fast* path."

**0:20 — Beat 1: real login + the gate.** Click **Sign in with Okta** → authenticate as
**joe.vanhorn** (real Okta login on the hub). You're in as a Division Lead.
> *Optional block shot:* sign in as **sam.nomember** and try to provision → real **403**,
> because Okta says he's not in `Division Leads`. Then switch back to joe.

**1:00 — Beat 2: request → the backend flash.** Pick the **Standard Division Spoke** template,
name it (e.g. "NA Sales Demo"), set the deterministic knobs (retention / region — dropdowns,
no free text), **Preview plan**, then **Provision**. The **terraform terminal panel streams
live** — `okta_group… Creating… Creation complete`, `Apply complete!`. That's a real
`terraform apply` configuring a real Okta org on screen.

**1:50 — Beat 3: the SSO finale.** The new org appears in **My Orgs**, federated. Two ways to
land the finale (pick whichever looks cleanest in rehearsal):
- **Portal button:** click **Open (SSO)** — deep-links the hub's IdP-initiated launch → you're
  signed into the brand-new spoke, **no new password** (JIT-created there on the fly).
- **Hub dashboard tile:** on joe's hub Okta dashboard, click the freshly-created spoke tile
  (we made it visible) → same IdP-initiated SSO into the spoke.

**2:40 — How it was built.** "Spec-first, then a team of AI sub-agents I architected — an
Architect and Scrum Master dispatching Engineers against Okta, Terraform, and platform
specialists — built this, in parallel. What you just saw is real Terraform + real Okta."

### What's real vs. simulated (say if asked)
Everything in the recording is real: real OIDC login, real Okta group authorization, a real
`terraform apply` against a real spoke org, real SAML Org2Org federation, real JIT SSO. The
only concession is the **pre-warmed pool** of blank orgs (claimed instead of birthed via the
gated Org Creator API) — which is a legitimate production latency-hiding pattern, exactly as
the spec states.

### Pre-flight checklist (verify before recording)
- `DEMO_MODE=real` server starts; `http://localhost:3000` loads; **Sign in with Okta** appears.
- You can complete the Okta login as joe and land back signed in.
- Provision streams terraform and ends in **My Orgs**.
- **Open (SSO)** signs you into the spoke without a password prompt.
- Both spokes are clean at the start of the take (no leftover baseline/IdP).

---

## SIM MODE — the stage-safe fallback (and the test suite)

```bash
cd ofcto27-hackathon
node portal/server.mjs        # → http://localhost:3000  (DEMO_MODE defaults to sim)
```
Identity switcher (Division Lead vs Non-member), same request → plan → My Orgs → SSO flow, all
in-memory. Prove it's real logic: `node --test portal/test/` → **25/25 passing**.

## Mapping to the judging dimensions
- **Applicability:** built on reusable Terraform modules any Okta hub-and-spoke customer has.
- **Customer voice:** framed around the central-security + division-lead pain, not the tech.
- **Innovativeness:** deterministic-knob templates + AI-agent-orchestrated build + real Org2Org.
- **Wow factor:** one click → a real, freshly-provisioned, federated Okta org you SSO straight into.
