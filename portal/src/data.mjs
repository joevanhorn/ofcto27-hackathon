// Seed data + template catalog for the org-provisioning portal.
//
// Sim mode serves this data as-is with no Okta/AWS calls. Real mode maps the
// same catalog onto terraform variables (apps, realms) and a Governance API
// post-step (certification campaigns), so sim and real always tell the same
// story.

// Two demo identities the sim login screen can assume. In real mode these
// arrive from the hub's OIDC token; here we hard-code them. `groups` is what
// the authorization gate (authz.mjs) keys on — "Division Leads" is the only
// group that may initiate provisioning.
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

// Catalog of well-known applications a template can deploy (as bookmark apps
// in the demo). Baseline apps are fixed per template; the rest are offered as
// closed-choice add-ons — still no free text anywhere.
export const APP_CATALOG = [
  { id: "servicenow", label: "ServiceNow", url: "https://nav.service-now.com" },
  { id: "workday", label: "Workday", url: "https://www.myworkday.com" },
  { id: "salesforce", label: "Salesforce", url: "https://login.salesforce.com" },
  { id: "jira", label: "Jira", url: "https://id.atlassian.com" },
  { id: "confluence", label: "Confluence", url: "https://id.atlassian.com/login?application=confluence" },
  { id: "m365", label: "Microsoft 365", url: "https://www.office.com" },
];

export function appById(id) {
  return APP_CATALOG.find((a) => a.id === id) || null;
}

// Build a multi-select "additional applications" option from the catalog,
// excluding the template's baseline apps (they always deploy).
function addonAppsOption(excludeIds) {
  return {
    id: "addon_apps",
    type: "multi",
    label: "Additional applications",
    choices: APP_CATALOG.filter((a) => !excludeIds.includes(a.id)).map((a) => ({
      value: a.id,
      label: a.label,
    })),
  };
}

// Toggle offered by every template: provision a TaskVantage Active Directory
// (Windows EC2 DC in the shared AD VPC, tv* schema + enterprise OU tree +
// sample users) and stage the Okta AD agent for Universal Directory import.
// `ad: true` is what resolveTemplate keys on — deliberately not `realm`.
function activeDirectoryOption() {
  return {
    id: "include_ad",
    type: "toggle",
    label: "Include Active Directory (TaskVantage enterprise directory + Okta AD agent)",
    default: false,
    ad: true,
  };
}

// Provisioning templates ("baselines"). Each template enforces a fixed set of
// security controls, always deploys its `baseline` block (apps, realms, and a
// recurring access-certification campaign), and offers only deterministic,
// closed-choice customization — selects, multi-selects, and toggles. No free
// text, so every provisioned org is uniform and auditable.
export const TEMPLATES = [
  {
    id: "standard-division",
    name: "Standard Division Org",
    description:
      "General-purpose org for a business division. Human sign-in is federation-only through the hub; local passwords are never issued. Ships with the workforce app baseline and a quarterly access review.",
    requiredControls: [
      "Phishing-resistant MFA",
      "Federation-only human sign-in",
      "Scoped admin role (this org only)",
      "Break-glass admin",
      "Quarterly access certification",
    ],
    baseline: {
      apps: ["servicenow", "m365"],
      realms: ["Employees"],
      campaign: { cadence: "quarterly", name: "Baseline access review" },
    },
    options: [
      addonAppsOption(["servicenow", "m365"]),
      {
        id: "contractor_realm",
        type: "toggle",
        label: "Add a separate Contractors realm",
        default: false,
        realm: "Contractors",
      },
      activeDirectoryOption(),
    ],
  },
  {
    id: "regulated-client",
    name: "Regulated / Client-Data Org",
    description:
      "Hardened baseline for divisions handling regulated or client data. Same federation-only, scoped-admin controls with a tighter certification cadence.",
    requiredControls: [
      "Phishing-resistant MFA",
      "Federation-only human sign-in",
      "Scoped admin role (this org only)",
      "Break-glass admin",
      "Recurring access certification",
    ],
    baseline: {
      apps: ["servicenow", "workday"],
      realms: ["Employees"],
      campaign: { cadence: "quarterly", name: "Regulated access review" },
    },
    options: [
      addonAppsOption(["servicenow", "workday"]),
      {
        id: "review_cadence",
        type: "select",
        label: "Access review cadence",
        choices: [
          { value: "quarterly", label: "Quarterly" },
          { value: "monthly", label: "Monthly" },
        ],
      },
      activeDirectoryOption(),
    ],
  },
  {
    id: "partner-sandbox",
    name: "Partner & Contractor Sandbox",
    description:
      "Collaboration org for external partners and contractors. Partners live in their own realm, get a limited app set, and every grant is re-certified monthly.",
    requiredControls: [
      "Phishing-resistant MFA",
      "Federation-only human sign-in",
      "Scoped admin role (this org only)",
      "Break-glass admin",
      "Monthly access certification",
      "Partner realm isolation",
    ],
    baseline: {
      apps: ["jira"],
      realms: ["Partners"],
      campaign: { cadence: "monthly", name: "Partner access review" },
    },
    options: [
      {
        id: "addon_apps",
        type: "multi",
        label: "Additional applications",
        // Sandbox add-ons are deliberately limited — no HR/finance systems.
        choices: [
          { value: "confluence", label: "Confluence" },
          { value: "servicenow", label: "ServiceNow" },
        ],
      },
      {
        id: "employee_realm",
        type: "toggle",
        label: "Add an internal Employees realm",
        default: false,
        realm: "Employees",
      },
      activeDirectoryOption(),
    ],
  },
];

/**
 * Resolve a template + the user's chosen options into the concrete spec that
 * gets deployed: full app objects (baseline + add-ons), realm names (baseline
 * + toggled), and the certification campaign. Single source of truth shared by
 * plan builders (sim + real) and the real provisioning pipeline.
 *
 * @param {object} template - an entry from TEMPLATES
 * @param {object} options - { [optionId]: value } — multi values are arrays
 * @returns {{apps: Array<{id,label,url}>, realms: string[], campaign: {cadence, name}, activeDirectory: boolean}}
 */
export function resolveTemplate(template, options = {}) {
  const baseline = template.baseline || {};

  const appIds = [...(baseline.apps || [])];
  const addons = options.addon_apps;
  for (const id of Array.isArray(addons) ? addons : []) {
    // Only accept ids the template actually offered.
    const offered = (template.options || []).some(
      (o) => o.id === "addon_apps" && (o.choices || []).some((c) => c.value === id)
    );
    if (offered && !appIds.includes(id)) appIds.push(id);
  }
  const apps = appIds.map(appById).filter(Boolean);

  const realms = [...(baseline.realms || [])];
  for (const opt of template.options || []) {
    if (opt.type === "toggle" && opt.realm) {
      const v = options[opt.id];
      if (v === true || v === "true" || v === "on") {
        if (!realms.includes(opt.realm)) realms.push(opt.realm);
      }
    }
  }

  const campaign = { ...(baseline.campaign || { cadence: "quarterly", name: "Access review" }) };
  if (options.review_cadence === "monthly" || options.review_cadence === "quarterly") {
    campaign.cadence = options.review_cadence;
  }

  // Non-realm toggles marked `ad: true` opt the spoke into a TaskVantage
  // Active Directory (only honored if the template offers the toggle).
  let activeDirectory = false;
  for (const opt of template.options || []) {
    if (opt.type === "toggle" && opt.ad) {
      const v = options[opt.id];
      if (v === true || v === "true" || v === "on") activeDirectory = true;
    }
  }

  return { apps, realms, campaign, activeDirectory };
}

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
