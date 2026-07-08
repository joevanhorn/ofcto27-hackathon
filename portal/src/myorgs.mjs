// "My Orgs" owner-scoped listing for the self-service Okta spoke-provisioning portal.
//
// Least-privilege visibility: a requester (Division Lead) sees ONLY the spoke
// orgs they own — never another owner's. Scoping is enforced here, server-side,
// not by UI hiding.
//
// This is a pure, read-only function. It does not mutate its input. For this
// tracer the org set is an in-memory array; the real store is a later story.
// Org shape: { id: string, status: "blank" | "claimed", ownerId: string | null }.

/**
 * Return only the orgs owned by the given owner.
 *
 * Fails closed: a null/undefined/absent ownerId returns an empty list, never
 * "all orgs". Orgs with a null ownerId (unclaimed/blank) are only returned when
 * the caller explicitly asks for null — which the fail-closed guard forbids, so
 * unclaimed orgs are never visible via this listing.
 *
 * @param {Array<{ id: string, status: "blank" | "claimed", ownerId: string | null }>} orgs
 * @param {string | null | undefined} ownerId
 * @returns {Array<{ id: string, status: "blank" | "claimed", ownerId: string | null }>}
 */
export function listMyOrgs(orgs, ownerId) {
  // Fail closed: without a concrete owner identity, reveal nothing.
  if (ownerId === null || ownerId === undefined || ownerId === "") {
    return [];
  }

  if (!Array.isArray(orgs)) {
    return [];
  }

  // Read-only scoping: filter() returns a new array; inputs are untouched.
  return orgs.filter((org) => org && org.ownerId === ownerId);
}
