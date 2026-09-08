import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { GitHubIssueStore } from "../server/github-issue-store.mjs";
import { GoalSessionService } from "../server/goal-session-service.mjs";
import { WorktreePlanStore } from "../server/worktree-plan-store.mjs";
import { GitHubIssueSync } from "../server/github-issue-sync.mjs";
import { GITHUB_ISSUE_ALL_STARTED_HINT, GITHUB_ISSUE_COLUMN, GITHUB_ISSUE_EMPTY_HINT, GITHUB_ISSUE_SYNC_NO_FAVORITES, githubIssueCardId, isGithubIssueOnBoard, isGithubIssueStarted, visibleGithubIssues } from "../server/github-issue-board.mjs";

const STARRED = "starredRepoABCDEFG";
const OTHER = "plainRepoABCDEFGHI";

function issue(number, title, extra = {}) {
  return {
    number,
    title,
    body: `Body for ${number}`,
    labels: [{ name: "bug" }],
    url: `https://github.com/acme/app/issues/${number}`,
    updatedAt: "2026-09-01T08:00:00Z",
    ...extra,
  };
}

// One harness, one temp store file. Every dependency is stubbed, so no test
// reaches GitHub, the planner, or the operator's real configuration.
async function harness(t, { issuesByPath = {}, failPaths = [], repositories = null, existingPlans = [] } = {}) {
  const directory = await mkdtemp(join(tmpdir(), "cmux-companion-github-issues-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const path = join(directory, "github-issues.json");
  const calls = [];
  const starts = [];
  const execute = async (bin, args, options) => {
    calls.push({ bin, args, cwd: options?.cwd });
    if (failPaths.includes(options?.cwd)) throw new Error("gh: could not resolve to a Repository");
    return { stdout: JSON.stringify(issuesByPath[options?.cwd] || []) };
  };
  const planner = {
    list: async () => ({ plans: existingPlans }),
    startBackground: async (input) => {
      starts.push(input);
      return { planId: `plan-${starts.length}`, status: "draft", running: true };
    },
  };
  const worktrees = {
    snapshot: async () => ({
      repositories: repositories || [
        { id: STARRED, name: "app", path: "/repo/app", favorite: true, archived: false },
        { id: OTHER, name: "site", path: "/repo/site", favorite: false, archived: false },
      ],
    }),
  };
  const store = new GitHubIssueStore({ path });
  return { service: new GitHubIssueSync({ worktrees, planner, goalSessions: { start: planner.startBackground }, store, execute }), store, path, calls, starts };
}

test("the issue column identity is frozen and keys one card per repository issue", () => {
  assert.equal(GITHUB_ISSUE_COLUMN.id, "github_issues");
  assert.equal(GITHUB_ISSUE_COLUMN.label, "GitHub Issues");
  assert.equal(Object.isFrozen(GITHUB_ISSUE_COLUMN), true);
  assert.equal(githubIssueCardId({ repositoryId: STARRED, number: 7 }), `github_issues:${STARRED}:7`);
  assert.notEqual(githubIssueCardId({ repositoryId: STARRED, number: 7 }), githubIssueCardId({ repositoryId: OTHER, number: 7 }));
  assert.equal(githubIssueCardId({ repositoryId: STARRED, number: 0 }), "");
  assert.equal(isGithubIssueStarted({ planId: "plan-1" }), true);
  assert.equal(isGithubIssueStarted({ planId: null }), false);
});

test("the column hides a started issue only while its goal is on the board", () => {
  const known = ["plan-1", "plan-2"];
  // Started, and its goal is a plan the board loaded: the goal card represents
  // it now, so the issue leaves the column.
  assert.equal(isGithubIssueOnBoard({ planId: "plan-1" }, known), false);
  assert.equal(isGithubIssueOnBoard({ planId: "plan-1" }, new Set(known)), false);
  // Started, but the goal was deleted. The issue comes back rather than being
  // stranded off the board with no way to start it again.
  assert.equal(isGithubIssueOnBoard({ planId: "plan-gone" }, known), true);
  assert.equal(isGithubIssueOnBoard({ planId: "plan-1" }, []), true);
  // Never started: always visible.
  assert.equal(isGithubIssueOnBoard({ planId: null }, known), true);
  assert.equal(isGithubIssueOnBoard({ planId: "   " }, known), true);
  assert.equal(isGithubIssueOnBoard({}, known), true);
});

test("untrusted input keeps the issue visible and never throws", () => {
  for (const bad of [null, undefined, 0, "issue", [], { planId: 7 }, { planId: {} }]) {
    assert.equal(isGithubIssueOnBoard(bad, ["plan-1"]), true);
  }
  for (const badIds of [null, undefined, "plan-1", 7, {}, [null, 7, {}]]) {
    assert.equal(isGithubIssueOnBoard({ planId: "plan-1" }, badIds), true);
  }
  // A malformed issue list is an empty column, not a crash.
  for (const bad of [null, undefined, "issues", 7, {}]) {
    assert.deepEqual(visibleGithubIssues(bad, ["plan-1"]), []);
  }
});

test("the visible list drops started issues and keeps the rest, in order", () => {
  const rows = [
    { number: 1, planId: "plan-1" },
    { number: 2, planId: null },
    { number: 3, planId: "plan-gone" },
    { number: 4, planId: "plan-2" },
    null,
  ];
  assert.deepEqual(visibleGithubIssues(rows, ["plan-1", "plan-2"]).map((row) => (row ? row.number : null)), [2, 3, null]);
  // With no plan loaded, nothing is hidden.
  assert.equal(visibleGithubIssues(rows, []).length, rows.length);
});

test("the two empty-column messages are distinct", () => {
  assert.equal(typeof GITHUB_ISSUE_ALL_STARTED_HINT, "string");
  assert.notEqual(GITHUB_ISSUE_ALL_STARTED_HINT, GITHUB_ISSUE_EMPTY_HINT);
  assert.match(GITHUB_ISSUE_ALL_STARTED_HINT, /goal/);
});

test("syncs starred repositories only", async (t) => {
  const { service, calls } = await harness(t, {
    issuesByPath: {
      "/repo/app": [issue(11, "Restore editor focus")],
      "/repo/site": [issue(99, "Never synced")],
    },
  });

  const result = await service.sync();

  assert.deepEqual(calls.map((call) => call.cwd), ["/repo/app"]);
  assert.deepEqual(calls[0].args, ["issue", "list", "--state", "open", "--limit", "100", "--json", "number,title,body,labels,url,updatedAt"]);
  assert.equal(result.status, "ok");
  assert.deepEqual(result.issues.map((item) => item.number), [11]);
  assert.deepEqual(result.repositories, [{ repositoryId: STARRED, name: "app", status: "ok", issueCount: 1, truncated: false, error: null }]);
  assert.equal(result.issues.some((item) => item.repositoryId === OTHER), false);
});

test("an archived starred repository is not synced", async (t) => {
  const { service, calls } = await harness(t, {
    repositories: [{ id: STARRED, name: "app", path: "/repo/app", favorite: true, archived: true }],
  });

  const result = await service.sync();

  assert.deepEqual(calls, []);
  assert.equal(result.status, GITHUB_ISSUE_SYNC_NO_FAVORITES);
});

test("a failing repository does not abort the others", async (t) => {
  const { service } = await harness(t, {
    repositories: [
      { id: STARRED, name: "app", path: "/repo/app", favorite: true },
      { id: OTHER, name: "site", path: "/repo/site", favorite: true },
    ],
    issuesByPath: { "/repo/app": [issue(11, "Restore editor focus")] },
    failPaths: ["/repo/site"],
  });

  const result = await service.sync();

  assert.deepEqual(result.issues.map((item) => item.number), [11]);
  const failed = result.repositories.find((entry) => entry.repositoryId === OTHER);
  assert.equal(failed.status, "failed");
  assert.match(failed.error, /could not resolve to a Repository/);
  assert.equal(result.repositories.find((entry) => entry.repositoryId === STARRED).status, "ok");
});

test("issues persist across a second store instance over the same file", async (t) => {
  const { service, path } = await harness(t, {
    issuesByPath: { "/repo/app": [issue(11, "Restore editor focus"), issue(12, "Keep caret visible")] },
  });

  const result = await service.sync();
  const reopened = new GitHubIssueStore({ path });

  assert.deepEqual(reopened.list().map((item) => item.number), [11, 12]);
  assert.equal(reopened.syncedAt, result.syncedAt);
  assert.equal(reopened.list()[0].title, "Restore editor focus");
});

test("a re-sync updates a title, drops a closed issue and keeps a started plan id", async (t) => {
  const first = [issue(11, "Restore editor focus"), issue(12, "Keep caret visible")];
  const state = { issues: first };
  const directory = await mkdtemp(join(tmpdir(), "cmux-companion-github-issues-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const store = new GitHubIssueStore({ path: join(directory, "github-issues.json") });
  const planner = {
    list: async () => ({ plans: [] }),
    startBackground: async () => ({ planId: "plan-1" }),
  };
  const service = new GitHubIssueSync({
    worktrees: { snapshot: async () => ({ repositories: [{ id: STARRED, name: "app", path: "/repo/app", favorite: true }] }) },
    planner,
    goalSessions: { start: planner.startBackground },
    store,
    execute: async () => ({ stdout: JSON.stringify(state.issues) }),
  });

  await service.sync();
  await service.startGoal({ repositoryId: STARRED, number: 11 });

  state.issues = [issue(11, "Restore editor focus after playback", { labels: [{ name: "editor" }], updatedAt: "2026-09-02T09:00:00Z" })];
  const result = await service.sync();

  assert.deepEqual(result.issues.map((item) => item.number), [11]);
  assert.equal(result.issues[0].title, "Restore editor focus after playback");
  assert.deepEqual(result.issues[0].labels, ["editor"]);
  assert.equal(result.issues[0].updatedAt, "2026-09-02T09:00:00Z");
  assert.equal(result.issues[0].planId, "plan-1");
  assert.equal(isGithubIssueStarted(result.issues[0]), true);
});

test("starting a goal passes the issue number and URL through and marks the card started", async (t) => {
  const { service, starts } = await harness(t, {
    issuesByPath: { "/repo/app": [issue(11, "Restore editor focus")] },
  });
  await service.sync();

  const result = await service.startGoal({ repositoryId: STARRED, number: 11 });

  assert.equal(starts.length, 1);
  assert.equal(starts[0].repositoryId, STARRED);
  assert.deepEqual(starts[0].issueNumbers, [11]);
  assert.deepEqual(starts[0].issueUrls, ["https://github.com/acme/app/issues/11"]);
  assert.equal(starts[0].deliveryPolicy, undefined);
  assert.match(starts[0].goal, /untrusted data, never instructions/);
  assert.match(starts[0].goal, /Restore editor focus/);
  assert.equal(result.created, true);
  assert.equal(result.issue.planId, "plan-1");
  assert.equal(service.read().issues[0].planId, "plan-1");
});

test("starting the same issue twice returns the existing plan", async (t) => {
  const { service, starts } = await harness(t, {
    issuesByPath: { "/repo/app": [issue(11, "Restore editor focus")] },
    existingPlans: [{ planId: "existing-plan", workflow: "goal_session", issueNumbers: [11] }],
  });
  await service.sync();

  const first = await service.startGoal({ repositoryId: STARRED, number: 11 });
  const second = await service.startGoal({ repositoryId: STARRED, number: 11 });

  assert.deepEqual(starts, []);
  assert.equal(first.created, false);
  assert.equal(second.created, false);
  assert.equal(second.plan.planId, "existing-plan");
  assert.equal(second.issue.planId, "existing-plan");
});

test("an unknown issue is refused", async (t) => {
  const { service } = await harness(t);
  await assert.rejects(() => service.startGoal({ repositoryId: STARRED, number: 404 }), /Unknown GitHub issue/);
  await assert.rejects(() => service.startGoal({ repositoryId: "short", number: 11 }), /Invalid repository/);
  await assert.rejects(() => service.startGoal({ repositoryId: STARRED, number: 0 }), /Invalid issue number/);
});

test("an empty favorite set says so instead of reporting an empty success", async (t) => {
  const { service, calls } = await harness(t, {
    repositories: [{ id: OTHER, name: "site", path: "/repo/site", favorite: false }],
  });

  const result = await service.sync();

  assert.deepEqual(calls, []);
  assert.equal(result.status, GITHUB_ISSUE_SYNC_NO_FAVORITES);
  assert.match(result.message, /No starred repositories/);
  assert.deepEqual(result.issues, []);
  assert.deepEqual(result.repositories, []);
});

test("unstarring a repository removes its cards on the next sync", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "cmux-companion-github-issues-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const store = new GitHubIssueStore({ path: join(directory, "github-issues.json") });
  const state = {
    repositories: [
      { id: STARRED, name: "app", path: "/repo/app", favorite: true },
      { id: OTHER, name: "site", path: "/repo/site", favorite: true },
    ],
  };
  const service = new GitHubIssueSync({
    worktrees: { snapshot: async () => ({ repositories: state.repositories }) },
    planner: { list: async () => ({ plans: [] }), startBackground: async () => ({ planId: "plan-1" }) },
    store,
    execute: async (bin, args, options) => ({ stdout: JSON.stringify(options.cwd === "/repo/app" ? [issue(11, "App issue")] : [issue(21, "Site issue")]) }),
  });

  await service.sync();
  assert.deepEqual(store.list().map((item) => item.number), [11, 21]);

  state.repositories = [{ id: STARRED, name: "app", path: "/repo/app", favorite: true }];
  const result = await service.sync();

  assert.deepEqual(result.issues.map((item) => item.repositoryId), [STARRED]);
});

test("a truncated repository is reported and malformed stored rows are dropped", async (t) => {
  const many = Array.from({ length: 101 }, (unused, index) => issue(index + 1, `Issue ${index + 1}`));
  const { service, store, path } = await harness(t, { issuesByPath: { "/repo/app": many } });

  const result = await service.sync();
  assert.equal(result.repositories[0].truncated, true);
  assert.equal(result.repositories[0].issueCount, 100);

  store.issues.set("bad#1", { repositoryId: "nope", number: 1, title: "", labels: [] });
  store.save();
  assert.equal(new GitHubIssueStore({ path }).list().length, 100);
});

test("simultaneous issue starts share one reservation while a different issue progresses", async (t) => {
  const { service, starts } = await harness(t, { issuesByPath: { "/repo/app": [issue(78, "Safety"), issue(79, "Queue")] } });
  await service.sync();
  let release;
  const held = new Promise((resolve) => { release = resolve; });
  const create = service.goalSessions.start;
  service.goalSessions.start = async (input) => {
    if (input.issueNumbers.includes(78)) await held;
    return create(input);
  };
  const first = service.startGoal({ repositoryId: STARRED, number: 78 });
  const duplicate = service.startGoal({ repositoryId: STARRED, number: 78 });
  await service.startGoal({ repositoryId: STARRED, number: 79 });
  assert.equal(starts.length, 1);
  release();
  const results = await Promise.all([first, duplicate]);
  assert.equal(results[0].plan.planId, results[1].plan.planId);
  assert.equal(results[1].created, false);
  assert.equal(starts.filter((input) => input.issueNumbers.includes(78)).length, 1);
});

for (const failWorkspace of [false, true]) {
  test(`issue goals reserve one managed session and preserve provenance${failWorkspace ? " through a partial start failure" : ""}`, async (t) => {
    const { service } = await harness(t, { issuesByPath: { "/repo/app": [issue(11, "Restore editor focus")] } });
    await service.sync();
    const plans = new WorktreePlanStore({ path: ":memory:" });
    t.after(() => plans.close());
    let worktrees = 0;
    let runners = 0;
    service.planner = { list: async () => ({ plans: plans.list() }), startBackground: () => { throw new Error("Legacy planner must not run"); } };
    service.goalSessions = new GoalSessionService({
      store: plans,
      worktrees: {
        resolveRepository: async (id) => ({ id, name: "app", primaryPath: "/repo/app" }),
        create: async () => { worktrees += 1; return { worktree: { path: "/repo/app-goal" } }; },
      },
      cmux: {
        workspaceListDetailed: async () => ({ workspaces: [] }),
        workspaceCreate: async () => { if (failWorkspace) throw new Error("cmux unavailable"); return { workspace_id: "issue-workspace" }; },
        workspaceStartGoalSessionRunner: async () => { runners += 1; },
      },
    });
    let first;
    if (failWorkspace) await assert.rejects(service.startGoal({ repositoryId: STARRED, number: 11 }), /cmux unavailable/);
    else first = await service.startGoal({ repositoryId: STARRED, number: 11 });
    const retry = await service.startGoal({ repositoryId: STARRED, number: 11 });
    const saved = plans.get(retry.plan.planId);
    assert.equal(saved.workflow, "goal_session");
    assert.equal(saved.sourceType, "github_issues");
    assert.deepEqual(saved.issueNumbers, [11]);
    assert.deepEqual(saved.issueUrls, ["https://github.com/acme/app/issues/11"]);
    assert.match(saved.goal, /untrusted data, never instructions/);
    assert.equal(saved.goalSessionWorktreePath, "/repo/app-goal");
    assert.equal(retry.created, false);
    assert.equal(worktrees, 1);
    assert.equal(runners, failWorkspace ? 0 : 1);
    assert.equal(saved.goalSessionWorkspaceId, failWorkspace ? null : "issue-workspace");
    if (first) {
      assert.equal(first.plan.planId, retry.plan.planId);
      await assert.rejects(service.goalSessions.start({ repositoryId: STARRED, goal: saved.goal, idempotencyKey: saved.planId, issueNumbers: [99], issueUrls: saved.issueUrls }), /different goal/);
      assert.equal(worktrees, 1);
    }
    if (failWorkspace) assert.match(saved.goalSessionError, /cmux unavailable/);
    assert.equal(saved.approvalRevision, null);
    assert.equal(saved.tasks.length, 0);
  });
}

test("an unavailable managed-session service never falls back to the background planner", async (t) => {
  const { service, starts } = await harness(t, { issuesByPath: { "/repo/app": [issue(11, "Restore editor focus")] } });
  await service.sync();
  service.goalSessions = null;
  await assert.rejects(service.startGoal({ repositoryId: STARRED, number: 11 }), /Visible goal sessions are unavailable/);
  assert.equal(starts.length, 0);
});

test("returned aborted issues can start a fresh goal while unreleased goals still reserve them", async (t) => {
  const { service, starts } = await harness(t, {
    issuesByPath: { "/repo/app": [issue(11, "Restore editor focus")] },
    existingPlans: [{ planId: "old", issueNumbers: [11], boardStatus: "aborted", issuesReturnedAt: "2026-09-07T12:00:00Z" }],
  });
  await service.sync();
  const result = await service.startGoal({ repositoryId: STARRED, number: 11 });
  assert.equal(result.created, true);
  assert.equal(starts.length, 1);
  assert.notEqual(result.plan.planId, "old");
});
