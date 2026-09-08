import assert from "node:assert/strict";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, test, vi } from "vitest";
import { PlanDraft, WorktreePlannerSheet } from "../app/worktree-planner";
const source: PlanDraft = { planId: "old", repositoryId: "repo", goal: "Fix old issue", round: 0, status: "questions", boardStatus: "aborted", questions: [], tasks: [], issueNumbers: [8] };
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });
test("restart is explicit, preserves the old card on failure and opens its successor", async () => {
  let posts = 0;
  const opened = vi.fn();
  vi.stubGlobal("fetch", vi.fn(async (url: RequestInfo | URL, init?: RequestInit) => {
    if (init?.method === "POST") {
      assert.equal(String(url), "/api/goal-sessions/old/restart"); posts++;
      return new Response(JSON.stringify(posts === 1 ? { error: "Old runner is still active" } : { ...source, planId: "new", boardStatus: null, workflow: "goal_session", goalSessionWorkspaceId: "fresh" }), { status: posts === 1 ? 400 : 200 });
    }
    return new Response(JSON.stringify({}), { status: 200 });
  }));
  render(<WorktreePlannerSheet repository={{ id: "repo", name: "Sample" }} initialDraft={source} onClose={() => {}} onNotice={() => {}} onGoalSessionStarted={opened} />);
  assert.equal(posts, 0);
  fireEvent.click(screen.getByRole("button", { name: "Restart discovery" }));
  await screen.findByText("Old runner is still active");
  assert.ok(screen.getByText("old"));
  fireEvent.click(screen.getByRole("button", { name: "Restart discovery" }));
  await waitFor(() => assert.equal(opened.mock.calls.length, 1));
  assert.equal(opened.mock.calls[0][0].planId, "new");
});
test("blocked discovery explains Abort first and cannot launch another writer", () => {
  vi.stubGlobal("fetch", vi.fn(async () => new Response("{}")));
  render(<WorktreePlannerSheet repository={{ id: "repo", name: "Sample" }} initialDraft={{ ...source, boardStatus: null, boardState: "blocked" }} onClose={() => {}} onNotice={() => {}} />);
  assert.ok(screen.getByText(/Abort the old goal on the Goals board/));
  assert.equal(screen.queryAllByRole("button", { name: "Restart discovery" }).length, 0);
});
