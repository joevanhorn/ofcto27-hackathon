// Post-apply Okta Identity Governance step: schedule the template's recurring
// access certification campaign on the freshly-provisioned org.
//
// The okta terraform provider has no campaign resource, so this talks to the
// Governance API directly with the spoke's admin token. OIG is SKU-gated on
// trial orgs — availability is probed first and the skip is EXPLICIT (a line
// in the live console + a "skipped" status on the org record), never silent.
//
// SECURITY: the token is used only in the Authorization header. It is never
// logged and never included in onLine output.

const CADENCE = {
  monthly: { recurrenceType: "MONTHLY", label: "monthly" },
  quarterly: { recurrenceType: "QUARTERLY", label: "quarterly" },
};

function sswsHeaders(token) {
  return {
    authorization: "SSWS " + String(token || "").trim().replace(/^SSWS[ _]/i, ""),
    accept: "application/json",
    "content-type": "application/json",
  };
}

// GET the campaigns collection to learn whether OIG is enabled on this org.
// 200 -> available; 401/403/404 on an org whose token just ran a successful
// terraform apply -> the governance surface itself is absent.
async function probeGovernance(base, headers) {
  try {
    const r = await fetch(`${base}/governance/api/v1/campaigns?limit=1`, { headers });
    return r.ok;
  } catch {
    return false;
  }
}

// The reviewer: the admin who owns the API token (always exists on the org).
async function tokenOwnerId(base, headers) {
  const r = await fetch(`${base}/api/v1/users/me`, { headers });
  if (!r.ok) return null;
  const u = await r.json();
  return (u && u.id) || null;
}

/**
 * Create a recurring access-certification campaign for the baseline group.
 *
 * @param {object} args
 * @param {string} args.domain - spoke org domain, e.g. "acme.oktapreview.com"
 * @param {string} args.token - spoke admin SSWS token (never logged)
 * @param {string} args.groupId - baseline group to certify
 * @param {string} args.orgDisplayName - human org name for the campaign name
 * @param {{cadence: string, name: string}} args.campaign - from resolveTemplate()
 * @param {(line: string) => void} [args.onLine] - live console feed
 * @returns {Promise<{status: "scheduled"|"skipped", id?: string, cadence?: string, reason?: string}>}
 */
export async function createCertificationCampaign({
  domain,
  token,
  groupId,
  orgDisplayName,
  campaign,
  onLine = () => {},
}) {
  const base = `https://${domain}`;
  const headers = sswsHeaders(token);
  const cadence = CADENCE[campaign && campaign.cadence] || CADENCE.quarterly;

  onLine(`>> governance: scheduling ${cadence.label} access certification campaign…`);

  if (!(await probeGovernance(base, headers))) {
    onLine(">> governance: skipped — Identity Governance is not enabled on this org");
    return { status: "skipped", reason: "OIG not enabled on this org" };
  }

  const reviewerId = await tokenOwnerId(base, headers);
  if (!reviewerId) {
    onLine(">> governance: skipped — could not resolve a reviewer on the org");
    return { status: "skipped", reason: "no reviewer resolved" };
  }

  // Start tomorrow (the API rejects past/immediate start dates), run 14 days,
  // recur on the template's cadence.
  const start = new Date(Date.now() + 24 * 60 * 60 * 1000);

  const payload = {
    name: `${campaign.name} — ${orgDisplayName}`.slice(0, 100),
    description: `Recurring ${cadence.label} review of baseline access, scheduled automatically by the Org Factory portal.`,
    campaignType: "RESOURCE",
    principalScopeSettings: { type: "ALL_USERS" },
    resourceSettings: {
      type: "GROUP",
      targetResources: [{ resourceId: groupId, resourceType: "GROUP" }],
    },
    reviewerSettings: { type: "USER", reviewerId },
    scheduleSettings: {
      type: "RECURRING",
      startDate: start.toISOString(),
      durationInDays: 14,
      recurrenceType: cadence.recurrenceType,
      timeZone: "America/New_York",
    },
    remediationSettings: {
      accessApproved: "NO_ACTION",
      accessRevoked: "NO_ACTION",
      noResponse: "NO_ACTION",
    },
  };

  try {
    const r = await fetch(`${base}/governance/api/v1/campaigns`, {
      method: "POST",
      headers,
      body: JSON.stringify(payload),
    });
    if (r.ok) {
      const body = await r.json().catch(() => ({}));
      onLine(`>> governance: ✓ ${cadence.label} certification campaign scheduled`);
      return { status: "scheduled", id: body && body.id, cadence: cadence.label };
    }
    // Surface the API's error summary (no secrets in it), then degrade.
    const err = await r.json().catch(() => null);
    const summary = (err && (err.errorSummary || err.message)) || `HTTP ${r.status}`;
    onLine(`>> governance: skipped — campaign create failed (${summary})`);
    return { status: "skipped", reason: summary };
  } catch (e) {
    onLine(`>> governance: skipped — ${String(e && e.message)}`);
    return { status: "skipped", reason: String(e && e.message) };
  }
}
