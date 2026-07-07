# Building Blocks — Reusing `okta-terraform-demo-template`

The existing repo **`joevanhorn/okta-terraform-demo-template`** (a GitOps toolkit for
managing Okta with Terraform + GitHub Actions + Python) already supplies most of the
**provisioning back end** for this portal. This document maps its assets to the spec so the
Day-2 build reuses instead of reinventing.

> Source repo: https://github.com/joevanhorn/okta-terraform-demo-template
> The template is a GitOps toolkit *for experts*. Our product is the **self-service front
> door that hides it** — so the reused parts are the engine, and the net-new parts are the
> experience that makes the governed path easier than shadow IT.

## Reuse map — existing assets → spec components

| Spec component | Existing building block | Fit | Notes |
|---|---|---|---|
| Hub-and-spoke federation | `modules/saml-federation` | **Excellent** | Okta→Okta federation: hub in **IdP mode**, spoke in **SP mode**, config exchanged automatically via `terraform_remote_state`. Includes JIT provisioning and email-domain IdP-discovery routing. This is the federation lane, already built. |
| "Spoke = a templated org" | `environments/<org>/` pattern | **Excellent** | Repo's core model: *one folder = one complete, isolated Okta tenant* (`terraform/` + `infrastructure/` + `config/` + `imports/`). A new spoke is a new environment folder. This is our templating primitive. |
| Per-spoke Terraform state isolation | `aws-backend/` | **Strong** | S3 backend keyed per-env (`…/Okta-GitOps/<org>/terraform.tfstate`) + DynamoDB locking + GitHub OIDC role (`GitHubActions-OktaTerraform`). Each spoke gets isolated state automatically. |
| "Pick a template" (baseline config) | `demo-builder/` | **Strong** | Declarative, config-driven generation of a full environment (YAML worksheet + `demo-config.schema.json` + industry examples). Our "Sales Demo Org" / "Partner Portal" templates are new entries in this exact pattern. |
| Agentic entry point | `ai-assisted/` (`generate.py`, `providers/anthropic.py`) | **Good prototype** | NL → Terraform with a provider abstraction already exists (Anthropic/OpenAI/Gemini). The agent path builds on this rather than starting from scratch. |
| Baseline template *payload* (optional) | `modules/lifecycle-management`, `modules/opa`, `modules/oag`, `modules/scim-server`, `modules/opc-agent`, `modules/generic-db-connector`, `modules/itp-demo` | **Optional** | Things a baseline template could provision *into* a spoke (joiner/mover/leaver + OIG, privileged access, SCIM, etc.). Not required for the tracer bullet; useful for richer templates. |

## Net-new — the actual hackathon build

The repo configures orgs for experts. Our product adds the **self-service experience** that
does not exist yet. These are the pieces to build:

1. **The portal GUI** — Okta OIDC web app on the hub: request form, **plain-language
   Terraform plan preview**, and a "My Orgs" dashboard. *(Not in the repo.)*
2. **Pool-claim orchestration** — the repo configures an org you already have; it does **not**
   manage a **pre-warmed pool of blank orgs claimed atomically** on request. This claim/assign
   orchestration is net-new.
3. **`Division Leads` group-gated authorization + auto-scoped ownership** — portal-side
   authz (only the group can request; requester is scoped to *only* their new spoke). Net-new.
4. **Aerial governance loop** — central-admin inventory + JIT time-bound access. Not present
   in the repo; target architecture (out of the demo tracer bullet).
5. **Plain-language plan translation** — turning `terraform plan` into an approvable,
   non-technical summary. Could lean on the `ai-assisted/` layer, but the UX is net-new.

## Notable observations

- **The foil is in the box.** `modules/ad-domain-controller` is literally the "spin up an AD
  instance" path this product is designed to replace. Good demo narrative beat: *"here's the
  old, ungoverned way — here's the one-click governed way."*
- **This sharpens the Day-2 agent decomposition.** The seams now map onto *real modules*, not
  hypotheticals:
  - **Provisioning agent** — owns `modules/saml-federation` + the `environments/` generator + `aws-backend` state wiring.
  - **Okta/identity specialist** — owns federation mechanics, group-gating, and Aerial.
  - **Frontend agent** — owns the portal (OIDC, request form, plan preview, dashboard).
  - **Orchestration agent** — owns pool-claim, plan→approve→apply sequencing, ownership scoping.
  - **Agentic-path** reuses `ai-assisted/` as its provisioning primitive.

## How to consume it

Two options to decide in Day 2:
- **Vendor / submodule** the template repo's `modules/` and `aws-backend/` into this project, or
- **Reference** it as an upstream and generate `environments/<spoke>/` folders per claimed org.

Recommendation: treat `modules/saml-federation`, the `environments/<org>/` pattern, and
`aws-backend/` as the load-bearing reuse; wrap them behind the net-new portal + pool-claim
orchestration.
