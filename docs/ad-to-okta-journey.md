# From Active Directory to Okta-managed: the full journey

The question this document answers: **"Can we connect our AD, import everything, and end
up with Okta managing it all — then turn AD off?"** Yes, and this is the complete path.
Five phases. AD keeps working through the first four; users notice nothing until the
moment there is nothing left for them to notice.

The portal demonstrates this end to end with the TaskVantage directory (see
[ad-integration.md](ad-integration.md) for the mechanics): phases 1–2 are the guided
import, phases 3–4 are the portal's **Migrate to Okta-managed** action, and phase 5 is
teardown.

---

## Phase 0 — Assess what AD is actually doing

Active Directory typically plays four roles:

| Role | Example | Okta replaces it? |
|---|---|---|
| Authentication | passwords, Kerberos/NTLM | **Yes** — Okta credentials + MFA/passwordless |
| Authorization | security groups gating app access | **Yes** — Okta groups + group rules + policies |
| Profile authority | user attributes, the schema extensions | **Yes** — Universal Directory |
| Machine management | domain join, GPOs, file-share ACLs | **No** — that's MDM territory (Intune/Jamf) + Okta Device Trust |

Be explicit about the fourth row: workforce *identity* moves to Okta completely;
*machine* management moves to an MDM. A customer with domain-joined workstations retires
AD when both moves are done. (The TaskVantage demo AD has no member machines, so the
demo path is pure identity.)

Also inventoried now, because each needs a landing spot before AD can be turned off:

- **Apps doing direct LDAP binds** → Okta LDAP Interface, or convert to SAML/OIDC.
- **RADIUS/VPN against AD** → Okta RADIUS agent.
- **Service accounts** → never migrate; retire or replace with OAuth clients / API tokens.
- **Stale objects** — disabled users, dead OUs. Migration is the best cleanup deadline
  you will ever get: scope the import so the junk simply never crosses.

## Phase 1 — Connect

Install the Okta AD agent (two agents for HA in production), register it to the org, and
configure the integration:

- Scope imports to the user/group OUs that matter — and deliberately *exclude*
  `Disabled Users` and `Service Accounts`.
- Username format (UPN), import schedule, matching rules.
- Create custom Universal Directory attributes and map the AD schema extensions onto
  them (the TaskVantage `tv*` attributes in the demo).
- **Credential strategy decision**: install the AD Password Sync agent on the DCs so
  users' current passwords flow to Okta ahead of the flip, or plan a reset campaign at
  cutover. Password sync makes the flip invisible to users; pick it when possible.

## Phase 2 — Import and match

Run a Full Import, review the match results, confirm, activate. Two things are true at
the end of this phase:

- Users are **AD-sourced**: AD masters their profile, and sign-in is delegated
  authentication back to the domain controller. Nothing about daily life has changed —
  Okta is a veneer over AD. That is the point: this phase is safe and reversible.
- **The OU hierarchy is already gone.** Okta has no OU concept. The tree flattens on
  import: users arrive flat, AD security groups arrive as read-only mirrored groups, and
  the only survivors of the hierarchy are attribute values on each user (in the demo:
  `tvOrgSiteID`, `tvOrgTerritoryID`, `tvCostCenter`). Your org structure just became
  *data* instead of *topology* — which is exactly what phase 3 needs.

## Phase 3 — Rebuild the structure natively (where the migration is won)

Everything in this phase happens while AD is still connected and authoritative, so there
is no risk window. The goal: by the end, **nothing in Okta depends on AD anymore** — AD
is still attached, but load-bearing nothing.

1. **Mirror the groups.** Every AD-mastered group that gates access gets an Okta-native
   twin. Where the imported attributes carry the org structure, prefer **group rules**
   over static copies — `user.tvOrgTerritoryID == "T-100"` replaces an OU-placement
   script and a regional AD group in one line, and keeps itself correct forever.
2. **Re-target access.** Move app assignments and policies from the AD-mastered groups
   to the native twins. Access now derives from attributes and rules, not from where an
   account object happens to sit in a tree.
3. **Prepare the post-AD world.**
   - Password policy for the soon-to-be-Okta-sourced users.
   - MFA enrollment now, while users still authenticate via AD — nobody is locked out
     at flip time.
   - **Choose the new lifecycle source.** AD was creating and disabling accounts;
     something must inherit joiner/mover/leaver — HR-as-a-source, SCIM, or admin-driven.
     Skipping this is the classic silent failure: the flip works perfectly and
     onboarding breaks three weeks later.
4. **Repoint the stragglers** found in phase 0 (LDAP Interface, RADIUS agent, app
   conversions).

## Phase 4 — The flip

Deliberately anticlimactic. With passwords synced, groups mirrored, MFA enrolled, and a
lifecycle successor in place: deactivate the AD integration's sourcing (org-wide, or
unassign users from the AD app in waves for a phased cutover). Profile sourcing falls
through to Okta, delegated authentication ends, users sign in with the same password —
now against Okta.

Verify per user: profile source shows Okta, profile fields are editable (they were
read-only under AD mastery — the best before/after screenshot in the demo), sign-in
works, app access unchanged because it rides the native groups. The frozen AD-mastered
groups are now irrelevant; nothing references them.

## Phase 5 — Disconnect and retire

Deactivate and uninstall the agents, hold a soak window, delete the AD app instance
(which clears the frozen mirrored groups), then decommission the domain controllers. In
the demo, pool reset tears the whole environment down in one action.

---

## The demo mapping

| Journey phase | In the portal |
|---|---|
| 1 — Connect | Provision with "Include Active Directory"; org card walks the agent setup |
| 2 — Import | Admin Console import checklist (org card + [ad-integration.md](ad-integration.md)) |
| 3 — Rebuild | **Migrate to Okta-managed** (automated: mirror groups, attribute rules, re-target apps) |
| 4 — Flip | **Migrate to Okta-managed** (automated: deactivate AD sourcing, verify Okta-sourced; password continuity stands in for the Password Sync agent) |
| 5 — Retire | Pool reset (destroys the DC, cleans the org) |

Two honest caveats to state in any customer conversation: agent registration is an
interactive browser activation (no unattended mode exists), and machine
management/GPOs are an MDM conversation, not an Okta-workforce one.
