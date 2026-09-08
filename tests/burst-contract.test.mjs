import assert from "node:assert/strict";
import test from "node:test";
import { MAX_BURST_GOAL } from "../server/burst-contract.mjs";

test("the burst goal limit matches the goal session limit", () => {
  // server/goal-session-service.mjs rejects a goal above this literal. Keep
  // the two equal so an approved candidate never fails there instead of here.
  assert.equal(MAX_BURST_GOAL, 4_000);
});
