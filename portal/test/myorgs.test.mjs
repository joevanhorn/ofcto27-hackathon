import { test } from "node:test";
import assert from "node:assert/strict";

import { listMyOrgs } from "../src/myorgs.mjs";

const ORGS = [
  { id: "spoke-a", status: "claimed", ownerId: "00uALICE" },
  { id: "spoke-b", status: "claimed", ownerId: "00uALICE" },
  { id: "spoke-c", status: "claimed", ownerId: "00uBOB" },
  { id: "spoke-d", status: "blank", ownerId: null },
];

test("owner with two orgs sees exactly those two", () => {
  const mine = listMyOrgs(ORGS, "00uALICE");
  assert.deepEqual(
    mine.map((o) => o.id).sort(),
    ["spoke-a", "spoke-b"]
  );
});

test("an owner never sees another owner's orgs", () => {
  const mine = listMyOrgs(ORGS, "00uALICE");
  assert.ok(mine.every((o) => o.ownerId === "00uALICE"));
  assert.ok(!mine.some((o) => o.id === "spoke-c"));
});

test("a different owner sees only their own org", () => {
  const bobs = listMyOrgs(ORGS, "00uBOB");
  assert.deepEqual(
    bobs.map((o) => o.id),
    ["spoke-c"]
  );
});

test("owner with no orgs gets an empty list", () => {
  assert.deepEqual(listMyOrgs(ORGS, "00uNOBODY"), []);
});

test("null ownerId returns an empty list (never all orgs)", () => {
  assert.deepEqual(listMyOrgs(ORGS, null), []);
});

test("undefined/absent ownerId returns an empty list (never all orgs)", () => {
  assert.deepEqual(listMyOrgs(ORGS, undefined), []);
  assert.deepEqual(listMyOrgs(ORGS), []);
});

test("empty-string ownerId returns an empty list (fails closed)", () => {
  assert.deepEqual(listMyOrgs(ORGS, ""), []);
});

test("unclaimed (null-owner) orgs are not leaked to a real owner", () => {
  const mine = listMyOrgs(ORGS, "00uALICE");
  assert.ok(!mine.some((o) => o.ownerId === null));
});

test("does not mutate the input array or its elements", () => {
  const input = [
    { id: "spoke-a", status: "claimed", ownerId: "00uALICE" },
    { id: "spoke-c", status: "claimed", ownerId: "00uBOB" },
  ];
  const snapshot = JSON.stringify(input);
  const result = listMyOrgs(input, "00uALICE");
  assert.equal(JSON.stringify(input), snapshot);
  assert.notEqual(result, input); // returns a new array
});

test("non-array orgs input returns an empty list (no crash)", () => {
  assert.deepEqual(listMyOrgs(undefined, "00uALICE"), []);
  assert.deepEqual(listMyOrgs(null, "00uALICE"), []);
});
