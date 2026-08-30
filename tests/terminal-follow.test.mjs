import assert from "node:assert/strict";
import test from "node:test";
import { isNearBottom, nextFollowState } from "../app/terminal-follow.mjs";

test("detects the follow zone near the terminal bottom", () => {
  assert.equal(isNearBottom({ scrollTop: 900, scrollHeight: 1000, clientHeight: 100 }), true);
  assert.equal(isNearBottom({ scrollTop: 500, scrollHeight: 1000, clientHeight: 100 }), false);
});

test("initial output follows while history readers get an unseen marker", () => {
  assert.deepEqual(nextFollowState({ initial: true, following: false, contentChanged: true }), { scroll: true, unseen: false });
  assert.deepEqual(nextFollowState({ initial: false, following: false, contentChanged: true }), { scroll: false, unseen: true });
  assert.deepEqual(nextFollowState({ initial: false, following: true, contentChanged: true }), { scroll: true, unseen: false });
});
