// Authorization for the self-service Okta spoke-provisioning portal.
//
// Gate: only members of the Okta group "Division Leads" may initiate
// provisioning. Authorization is keyed solely on Okta group membership
// carried on the user object — no bespoke RBAC layer.
//
// This is a pure, server-side-enforceable function. The API calls it before
// initiating provisioning; it is NOT UI hiding. Real OIDC/token wiring that
// populates the user object is a later story. Here group membership arrives
// on the user object with shape { id: string, email: string, groups: string[] }.

export const REQUIRED_GROUP = "Division Leads";

/**
 * Decide whether a user may initiate provisioning.
 *
 * @param {{ id?: string, email?: string, groups?: string[] }} user
 * @returns {{ allowed: true } | { allowed: false, reason: string }}
 */
export function authorizeRequest(user) {
  const groups = user && Array.isArray(user.groups) ? user.groups : [];

  if (groups.includes(REQUIRED_GROUP)) {
    return { allowed: true };
  }

  return { allowed: false, reason: "not authorized" };
}
