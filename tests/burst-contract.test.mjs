import assert from "node:assert/strict";
import test from "node:test";
import { MAX_BURST_GOAL } from "../server/burst-contract.mjs";
import { MAX_GOAL_TEXT } from "../server/goal-limits.mjs";

test("the burst goal limit is the goal session limit", () => {
  // server/goal-session-service.mjs rejects a goal above MAX_GOAL_TEXT. The
  // burst name is a re-export of it, so an approved candidate never fails
  // there instead of here.
  assert.equal(MAX_BURST_GOAL, MAX_GOAL_TEXT);
  assert.equal(MAX_GOAL_TEXT, 4_000);
});
