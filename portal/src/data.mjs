// Seed data + template catalog for the self-service Okta spoke-provisioning portal.
//
// Everything here is in-memory demo data. There are NO real Okta/AWS calls
// anywhere in this portal — the identity login and SAML Org2Org federation are
// simulated behind the API so the flow is demo-safe and deterministic.

// Two demo identities the login screen can assume. In the real system these
// arrive from an OIDC token; here we hard-code them. `groups` is what the
// authorization gate (authz.mjs) keys on — "Division Leads" is the only group
// that may initiate provisioning.
export const DEMO_USERS = {
  lead: {
    id: "00uLEAD",
    email: "dana.lead@hub.example",
    name: "Dana Lead (Division Lead)",
    groups: ["Division Leads"],
  },
  nonmember: {
    id: "00uNON",
    email: "sam@hub.example",
    name: "Sam Ployee (no access)",
    groups: [],
  },
};

// Provisioning templates ("baselines"). Each template enforces a fixed set of
// security controls and offers only deterministic, closed-choice options — no
// free-text — so every provisioned spoke is uniform and auditable.
export const TEMPLATES = [
  {
    id: "standard-spoke",
    name: "Standard Division Spoke",
    description:
      "General-purpose spoke org for a business division. Human sign-in is federation-only through the hub; local passwords are never issued.",
    requiredControls: [
      "Phishing-resistant MFA",
      "Federation-only human sign-in",
      "Scoped admin role (spoke only)",
      "Break-glass admin",
    ],
    options: [
      {
        id: "retention",
        label: "Log retention period",
        choices: [
          { value: "90d", label: "90 days" },
          { value: "180d", label: "180 days" },
          { value: "1y", label: "1 year" },
        ],
      },
      {
        id: "region",
        label: "Data residency region",
        choices: [
          { value: "US", label: "United States" },
          { value: "EU", label: "European Union" },
        ],
      },
    ],
  },
  {
    id: "regulated-spoke",
    name: "Regulated Division Spoke",
    description:
      "Hardened baseline for divisions handling regulated data. Same federation-only, scoped-admin controls plus longer default retention.",
    requiredControls: [
      "Phishing-resistant MFA",
      "Federation-only human sign-in",
      "Scoped admin role (spoke only)",
      "Break-glass admin",
    ],
    options: [
      {
        id: "retention",
        label: "Log retention period",
        choices: [
          { value: "90d", label: "90 days" },
          { value: "180d", label: "180 days" },
          { value: "1y", label: "1 year" },
        ],
      },
      {
        id: "region",
        label: "Data residency region",
        choices: [
          { value: "US", label: "United States" },
          { value: "EU", label: "European Union" },
        ],
      },
    ],
  },
];

// A fresh pool of pre-warmed blank spoke orgs. Returning a new array (with new
// object literals) each call means each server instance / test gets an
// isolated pool with no shared mutable state.
export function makePool() {
  const pool = [];
  for (let n = 1; n <= 5; n++) {
    pool.push({
      id: `0oaSPOKE0${n}`,
      status: "blank",
      ownerId: null,
      name: null,
      template: null,
      federation: "pending",
      createdAt: null,
    });
  }
  return pool;
}
