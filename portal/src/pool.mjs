// Atomic single-use pool claim.
//
// Pool element shape: { id: string, status: "blank" | "claimed", ownerId: string | null }
//
// This is the tracer implementation: the pool is an in-memory array. A later
// story replaces this with an RDS-backed pool store. The contract this module
// guarantees — claim the first blank org, mark it claimed for an owner, and
// never hand the same org out twice — is what the real store must preserve.

/**
 * Atomically claim the first available blank org from the pool.
 *
 * The claim mutates the org in place: sets `status` to `"claimed"` and
 * `ownerId` to the given owner. Claimed orgs are single-use — they are never
 * re-blanked, returned to the pool, or handed out again.
 *
 * @param {Array<{id: string, status: "blank" | "claimed", ownerId: string | null}>} pool
 * @param {string} ownerId - the Okta user id claiming the org.
 * @returns {{id: string, status: "claimed", ownerId: string}} the claimed org.
 * @throws {Error} if no blank org is available (pool exhausted).
 */
export function claimOrg(pool, ownerId) {
  if (!Array.isArray(pool)) {
    throw new Error("pool must be an array");
  }

  // Scan for the first blank org. Because Node runs this synchronously to
  // completion with no await in between, the find-then-mutate is atomic with
  // respect to other claimOrg calls on the same array — no two claims can
  // observe the same blank org as available.
  const org = pool.find((o) => o && o.status === "blank");

  if (org === undefined) {
    throw new Error("pool exhausted");
  }

  org.status = "claimed";
  org.ownerId = ownerId;
  return org;
}
