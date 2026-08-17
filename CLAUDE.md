# Org-Provisioning Portal — developer guide

Self-service portal that lets authorized Division Leads provision governed, templated
Okta spoke orgs, each SAML Org2Org federated to a central hub (hub-as-IdP). Built at the
Velocity 27 hackathon; now being extended into a live customer demo (Accenture branding).

The hackathon coaching/judging files (`.hackathon/`, `.claude/skills`, `docs/prd.md`,
`docs/solution.md`, …) are historical — leave them alone, but don't follow them.

## Layout

- `portal/server.mjs` — zero-dependency Node HTTP server: static UI, session cookies,
  OIDC login (real mode), request/authz flow, SSE terraform streaming.
- `portal/src/` — `config.mjs` (mode + creds loading), `data.mjs` (template catalog +
  sim pool), `authz.mjs` (Division Leads gate), `pool.mjs` (sim claim),
  `provision.mjs` (real terraform apply + 3-pass federation converge),
  `myorgs.mjs` (owner-scoped listing).
- `portal/public/` — vanilla JS/CSS UI, no build step.
- `portal/terraform/` — per-spoke baseline + `modules/saml-federation`; per-spoke state
  files under `terraform/state/<subdomain>.tfstate`.
- `portal/recording/` — Playwright harness that produced the hackathon demo clip.
- `portal/test/` — `node --test` suite; sim-mode only, no network.

## Modes

- `DEMO_MODE=sim` (default): fully in-memory, deterministic, stage-safe. No Okta calls.
- `DEMO_MODE=real`: real hub OIDC login, real spoke pool, live `terraform apply`
  streamed to the UI, real SAML Org2Org federation.

Run: `node portal/server.mjs` (port 3000; `PORT` to override).
Test: `node --test portal/test/`.

## Credentials (real mode)

Loaded from gitignored `~/okta-demo-creds.env` (override path with `OKTA_DEMO_CREDS`).
Never commit or log values. Keys: `HUB_ORG_DOMAIN`, `HUB_API_TOKEN`, `OIDC_CLIENT_ID/
SECRET/REDIRECT_URI`, `SPOKE_ORG_DOMAINS`/`SPOKE_API_TOKENS` (parallel comma lists —
the pre-warmed pool), optional `HUB_SSO_ENTRY_URL`, `ANTHROPIC_API_KEY` (chat assistant).
Template: `portal/.demo-creds.example.env`. Okta preview API tokens expire after 30 idle
days — validate before demo day.

## Git

Work happens on feature branches pushed to the `personal` remote
(`joevanhorn/ofcto27-hackathon`). Never push to `origin` (the archived hackathon org
repo, `ofctoV27/joevanhorn-hackathon`).

## Live demo access

The portal binds localhost on the dev EC2 host. Present from a laptop via SSH port
forward (`ssh -L 3000:localhost:3000 …`) so the OIDC `localhost` redirect URI stays valid.
