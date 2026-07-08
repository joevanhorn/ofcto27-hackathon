import { test } from "node:test";
import assert from "node:assert/strict";

import { authorizeRequest, REQUIRED_GROUP } from "../src/authz.mjs";

test("member of 'Division Leads' is allowed", () => {
  const user = {
    id: "00u123",
    email: "lead@example.com",
    groups: ["Division Leads"],
  };
  assert.deepEqual(authorizeRequest(user), { allowed: true });
});

test("member with additional groups is still allowed", () => {
  const user = {
    id: "00u456",
    email: "lead2@example.com",
    groups: ["Everyone", "Division Leads", "Finance"],
  };
  assert.deepEqual(authorizeRequest(user), { allowed: true });
});

test("non-member is not allowed with reason", () => {
  const user = {
    id: "00u789",
    email: "user@example.com",
    groups: ["Everyone", "Finance"],
  };
  assert.deepEqual(authorizeRequest(user), {
    allowed: false,
    reason: "not authorized",
  });
});

test("user with empty groups is not allowed (no crash)", () => {
  const user = { id: "00u000", email: "empty@example.com", groups: [] };
  assert.deepEqual(authorizeRequest(user), {
    allowed: false,
    reason: "not authorized",
  });
});

test("user with missing groups is not allowed (no crash)", () => {
  const user = { id: "00u001", email: "nogroups@example.com" };
  assert.deepEqual(authorizeRequest(user), {
    allowed: false,
    reason: "not authorized",
  });
});

test("undefined user is not allowed (no crash)", () => {
  assert.deepEqual(authorizeRequest(undefined), {
    allowed: false,
    reason: "not authorized",
  });
});

test("group name gate is exact — case-sensitive, no partial match", () => {
  assert.deepEqual(
    authorizeRequest({ id: "1", email: "a@b.co", groups: ["division leads"] }),
    { allowed: false, reason: "not authorized" }
  );
  assert.equal(REQUIRED_GROUP, "Division Leads");
});
