import test from "node:test";
import assert from "node:assert/strict";
import { claimOrg } from "../src/pool.mjs";

function makePool(n) {
  return Array.from({ length: n }, (_, i) => ({
    id: `org-${i}`,
    status: "blank",
    ownerId: null,
  }));
}

test("claim returns a formerly-blank org now marked claimed with the ownerId", () => {
  const pool = makePool(3);
  const claimed = claimOrg(pool, "user-A");

  assert.equal(claimed.status, "claimed");
  assert.equal(claimed.ownerId, "user-A");
  // It is the same object living in the pool (claimed in place).
  assert.equal(pool.includes(claimed), true);
  // First blank was org-0.
  assert.equal(claimed.id, "org-0");
});

test("a second claim returns a DIFFERENT org", () => {
  const pool = makePool(3);
  const first = claimOrg(pool, "user-A");
  const second = claimOrg(pool, "user-B");

  assert.notEqual(first.id, second.id);
  assert.equal(second.status, "claimed");
  assert.equal(second.ownerId, "user-B");
});

test("the same org is never returned twice across sequential claims", () => {
  const pool = makePool(5);
  const owners = ["u1", "u2", "u3", "u4", "u5"];
  const claimedIds = new Set();

  for (const owner of owners) {
    const org = claimOrg(pool, owner);
    assert.equal(claimedIds.has(org.id), false, `org ${org.id} handed out twice`);
    claimedIds.add(org.id);
    assert.equal(org.ownerId, owner);
  }

  assert.equal(claimedIds.size, 5);
  // Every org in the pool is now claimed.
  assert.equal(pool.every((o) => o.status === "claimed"), true);
});

test("claiming from an all-claimed pool signals exhaustion", () => {
  const pool = makePool(2);
  claimOrg(pool, "u1");
  claimOrg(pool, "u2");

  assert.throws(() => claimOrg(pool, "u3"), /pool exhausted/);
});

test("claiming from an empty pool signals exhaustion", () => {
  assert.throws(() => claimOrg([], "u1"), /pool exhausted/);
});

test("an already-claimed org is never re-blanked or re-handed out", () => {
  const pool = makePool(2);
  const first = claimOrg(pool, "owner-1");

  // Claim the remaining org; the already-claimed one must be untouched.
  const second = claimOrg(pool, "owner-2");
  assert.notEqual(first.id, second.id);
  assert.equal(first.ownerId, "owner-1", "existing claim owner was overwritten");
  assert.equal(first.status, "claimed", "claimed org was re-blanked");

  // Pool is now exhausted — the claimed orgs are not returned to the pool.
  assert.throws(() => claimOrg(pool, "owner-3"), /pool exhausted/);
});
