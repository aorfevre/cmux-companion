import test from "node:test";
import assert from "node:assert/strict";
import { WorktreePlanner } from "../server/worktree-planner.mjs";
import { goalDiscoveryPrompt } from "../server/goal-session-interactive.mjs";

test("legacy delivery controller cannot start a second discovery process", () => {
  for (const name of ["start", "startBackground", "answer", "answerBackground", "feedback", "feedbackBackground", "discuss", "discussBackground", "run"]) {
    assert.equal(WorktreePlanner.prototype[name], undefined, name);
  }
});

test("native discovery receives saved history without inheriting implementation approval", () => {
  const prompt = goalDiscoveryPrompt({
    goal: "Continue the saved goal", goalSessionBranch: "goal/session",
    discoveryContext: { sourcePlanId: "old", spec: { outcome: "Prior outcome" }, questions: [{ text: "Prior question" }], discussion: [{ answer: "Prior answer" }] },
  });
  assert.match(prompt, /historical material, not an approved instruction to implement/);
  for (const text of ["Prior outcome", "Prior question", "Prior answer"]) assert.ok(prompt.includes(text));
  assert.match(prompt, /The user approves the exact revision in Companion/);
});
