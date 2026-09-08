import assert from "node:assert/strict";
import test from "node:test";

import {
  DEFAULT_FOLLOWUP_AGENT,
  GOAL_FOLLOWUP_ACTIONS,
  GOAL_FOLLOWUP_AGENTS,
  GOAL_FOLLOWUP_COLUMN_STATE,
  MAX_FOLLOWUP_TEXT,
  followupAction,
  followupActionLabels,
  normalizeFollowupRequest,
} from "../server/goal-followup-actions.mjs";

test("exports the waiting-for-merge state and four ordered actions", () => {
  assert.equal(GOAL_FOLLOWUP_COLUMN_STATE, "in_review");
  assert.deepEqual(GOAL_FOLLOWUP_ACTIONS.map((action) => action.id), ["question", "tests", "review", "custom"]);
  assert.deepEqual(GOAL_FOLLOWUP_ACTIONS.map((action) => action.label), [
    "Ask a question",
    "More unit and e2e tests",
    "Complete code review",
    "Something else",
  ]);
  assert.deepEqual(GOAL_FOLLOWUP_ACTIONS.map(({ requiresText, textKey }) => ({ requiresText, textKey })), [
    { requiresText: true, textKey: "question" },
    { requiresText: false, textKey: null },
    { requiresText: false, textKey: null },
    { requiresText: true, textKey: "custom" },
  ]);
  assert.equal(GOAL_FOLLOWUP_ACTIONS.every((action) => typeof action.description === "string" && action.description.endsWith(".")), true);
  assert.deepEqual(GOAL_FOLLOWUP_AGENTS, ["claude", "codex"]);
  assert.equal(DEFAULT_FOLLOWUP_AGENT, "claude");
  assert.equal(MAX_FOLLOWUP_TEXT, 2000);
});

test("freezes the catalogue, its entries, and the agent list", () => {
  assert.equal(Object.isFrozen(GOAL_FOLLOWUP_ACTIONS), true);
  assert.equal(GOAL_FOLLOWUP_ACTIONS.every(Object.isFrozen), true);
  assert.equal(Object.isFrozen(GOAL_FOLLOWUP_AGENTS), true);

  assert.throws(() => GOAL_FOLLOWUP_ACTIONS.push({ id: "other" }), TypeError);
  assert.throws(() => {
    GOAL_FOLLOWUP_ACTIONS[0].label = "Changed";
  }, TypeError);
  assert.deepEqual(GOAL_FOLLOWUP_ACTIONS.map((action) => action.id), ["question", "tests", "review", "custom"]);
  assert.equal(GOAL_FOLLOWUP_ACTIONS[0].label, "Ask a question");
});

test("finds actions and lists known labels in catalogue order", () => {
  assert.equal(followupAction("review"), GOAL_FOLLOWUP_ACTIONS[2]);
  assert.equal(followupAction("unknown"), null);
  assert.equal(followupAction(null), null);
  assert.deepEqual(followupActionLabels(["custom", "unknown", "tests", "tests"]), ["More unit and e2e tests", "Something else"]);
  assert.deepEqual(followupActionLabels(null), []);
});

test("uses each fixed refusal message in validation order", () => {
  for (const body of [{}, { actions: "tests" }, { actions: [] }]) {
    assert.throws(() => normalizeFollowupRequest(body), { name: "TypeError", message: "Pick at least one follow-up action" });
  }
  assert.throws(() => normalizeFollowupRequest({ actions: ["unknown"] }), { name: "TypeError", message: "Unknown follow-up action" });
  assert.throws(() => normalizeFollowupRequest({ actions: ["question"], question: "  " }), {
    name: "TypeError",
    message: "Write the question you want answered",
  });
  assert.throws(() => normalizeFollowupRequest({ actions: ["custom"], custom: null }), {
    name: "TypeError",
    message: "Write what you want done",
  });
  assert.throws(() => normalizeFollowupRequest({ actions: ["tests"], agent: "other" }), {
    name: "TypeError",
    message: "Follow-up agent must be claude or codex",
  });
});

test("deduplicates actions and restores catalogue order", () => {
  const request = normalizeFollowupRequest({
    actions: ["custom", "tests", "question", "tests"],
    question: "What changed?",
    custom: "Update the docs",
    agent: "codex",
  });
  assert.deepEqual(request, {
    actions: ["question", "tests", "custom"],
    question: "What changed?",
    custom: "Update the docs",
    agent: "codex",
  });
});

test("trims and caps selected text and clears unselected text", () => {
  const longQuestion = `  ${"q".repeat(MAX_FOLLOWUP_TEXT + 50)}  `;
  const request = normalizeFollowupRequest({
    actions: ["question", "tests"],
    question: longQuestion,
    custom: "must be discarded",
  });
  assert.equal(request.question, "q".repeat(MAX_FOLLOWUP_TEXT));
  assert.equal(request.custom, "");
  assert.equal(request.agent, DEFAULT_FOLLOWUP_AGENT);

  assert.deepEqual(normalizeFollowupRequest({ actions: ["review"], question: "discard", custom: "discard" }), {
    actions: ["review"],
    question: "",
    custom: "",
    agent: "claude",
  });
});

test("rejects null, string, and array bodies with the first refusal", () => {
  for (const body of [null, "x", []]) {
    assert.throws(() => normalizeFollowupRequest(body), {
      name: "TypeError",
      message: "Pick at least one follow-up action",
    });
  }
});
