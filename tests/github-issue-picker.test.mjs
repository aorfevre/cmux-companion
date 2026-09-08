import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { GitHubIssueStore } from "../server/github-issue-store.mjs";
import { GitHubIssueSync } from "../server/github-issue-sync.mjs";
const id = "repository12345678";

test("repository issue picker fetches data without a model and uses the board's same session entry", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "cmux-issue-picker-")); t.after(() => rm(directory, { recursive: true, force: true }));
  const calls = [], starts = [];
  const store = new GitHubIssueStore({ path: join(directory, "issues.json") });
  const service = new GitHubIssueSync({ store, worktrees: { resolveRepository: async (value) => { assert.equal(value, id); return { id, name: "Fixture", primaryPath: "/repo/fixture" }; } }, planner: { list: async () => ({ plans: [] }) }, goalSessions: { start: async (input) => { starts.push(input); return { planId: "native", workflow: "goal_session" }; } }, execute: async (bin, args, options) => { calls.push([bin, args, options.cwd]); return { stdout: JSON.stringify([{ number: 8, title: "Billing", body: "Repository context", labels: [], url: "https://github.com/example/repo/issues/8", updatedAt: "2026-09-08" }]) }; } });
  const data = await service.readRepository(id);
  assert.equal(data.issues.length, 1); assert.equal(starts.length, 0);
  assert.deepEqual(calls.map((call) => call[0]), ["gh"]);
  assert.equal(calls[0][2], "/repo/fixture");
  const result = await service.startGoal({ repositoryId: id, number: 8 });
  assert.equal(result.plan.workflow, "goal_session");
  assert.deepEqual(starts[0].issueNumbers, [8]);
  assert.match(starts[0].goal, /untrusted data/);
  assert.match(starts[0].goal, /Repository context/);
});

test("an existing legacy issue goal continues through the canonical migration service", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "cmux-issue-picker-")); t.after(() => rm(directory, { recursive: true, force: true }));
  const store = new GitHubIssueStore({ path: join(directory, "issues.json") });
  store.replace([id], [{ repositoryId: id, repositoryName: "Fixture", number: 8, title: "Billing", body: "", labels: [], url: "", updatedAt: "2026-09-08", syncedAt: "2026-09-08" }], { syncedAt: "2026-09-08" });
  const continued = [];
  const service = new GitHubIssueSync({ store, worktrees: {}, planner: { list: async () => ({ plans: [{ planId: "old", status: "draft", issueNumbers: [8] }] }) }, goalSessions: { continueDiscovery: async (planId) => { continued.push(planId); return { planId: "native", workflow: "goal_session" }; }, start: () => { throw new Error("Must migrate the existing owner"); } } });
  const result = await service.startGoal({ repositoryId: id, number: 8 });
  assert.deepEqual(continued, ["old"]); assert.equal(result.plan.planId, "native"); assert.equal(store.get(id, 8).planId, "native");
});
