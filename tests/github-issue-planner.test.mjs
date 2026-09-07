import assert from "node:assert/strict";
import test from "node:test";
import { GitHubIssuePlanner, normalizeTopics, parseGroupingReply } from "../server/github-issue-planner.mjs";

const REPOSITORY_ID = "repositoryABCDEFGH";
const issues = [
  { number: 54, title: "Restore editor focus", body: "Focus the editor after playback", labels: [{ name: "editor" }], url: "https://github.com/acme/app/issues/54", updatedAt: "2026-09-01T08:00:00Z" },
  { number: 55, title: "Keep caret visible", body: "Scroll the caret into view", labels: [{ name: "editor" }], url: "https://github.com/acme/app/issues/55", updatedAt: "2026-09-01T08:10:00Z" },
  { number: 57, title: "Correction diagnostics", body: "Add observability", labels: [{ name: "backend" }], url: "https://github.com/acme/app/issues/57", updatedAt: "2026-09-01T08:20:00Z" },
];

function harness({ refreshedIssues = issues, existingPlans = [], worktrees: injected = null } = {}) {
  const starts = [];
  const launches = [];
  const calls = [];
  let issueLoads = 0;
  const planner = {
    list: async () => ({ plans: existingPlans }),
    start: async (input) => {
      starts.push(input);
      input.onEvent?.({ k: "tool", t: "Read app/editor.tsx" });
      return { planId: `plan-${starts.length}`, status: "ready", questions: [], tasks: [{ id: "t1", title: "Task", branch: `feature/task-${starts.length}`, prompt: "Do it", agent: "codex", agentReason: "" }] };
    },
    launch: async (planId) => { launches.push(planId); return { planId, launched: 2, deliveryMode: "combined", results: [{}, {}] }; },
  };
  const execute = async (bin, args, options) => {
    calls.push([bin, args, options]);
    if (bin === "gh" && args[0] === "repo") return { stdout: JSON.stringify({ nameWithOwner: "acme/app", url: "https://github.com/acme/app" }) };
    if (bin === "gh" && args[0] === "issue") {
      issueLoads += 1;
      return { stdout: JSON.stringify(issueLoads === 1 ? issues : refreshedIssues) };
    }
    if (bin === "ccs") return { stdout: JSON.stringify({ result: JSON.stringify({ topics: [
      { title: "Editor reliability", goal: "Make editing reliable", rationale: "Shared editor surface", issueNumbers: [54, 55], questions: [{ text: "Which browser?", options: ["All", "Safari"] }], acceptanceCriteria: ["Caret stays visible"], overlapRisk: "Both issues touch the editor", dependencies: [] },
      { title: "Correction observability", goal: "Add correction diagnostics", rationale: "Separate backend delivery", issueNumbers: [57], questions: [], acceptanceCriteria: ["Failures are diagnosable"], overlapRisk: "low", dependencies: [] },
    ] }) }) };
    throw new Error(`Unexpected ${bin} ${args.join(" ")}`);
  };
  const worktrees = injected || { snapshot: async () => ({ repositories: [{ id: REPOSITORY_ID, name: "app", path: "/repo/app" }] }) };
  return { service: new GitHubIssuePlanner({ worktrees, planner, execute }), starts, launches, calls };
}

test("parses a CCS envelope and preserves issues omitted by the model", () => {
  const reply = parseGroupingReply(JSON.stringify({ result: JSON.stringify({ topics: [{ title: "Editor", issueNumbers: [54, 55] }] }) }));
  const topics = normalizeTopics(reply.topics, issues.map((issue) => ({ ...issue, labels: issue.labels.map((label) => label.name) })));
  assert.deepEqual(topics[0].issueNumbers, [54, 55]);
  assert.equal(topics[1].title, "Correction diagnostics");
  assert.deepEqual(topics[1].issueNumbers, [57]);
});

test("analyzes, clarifies, and creates one durable goal plan per selected topic", async () => {
  const { service, starts, calls } = harness();
  const analysis = await service.analyze({ repositoryId: REPOSITORY_ID });
  assert.equal(analysis.repository.nameWithOwner, "acme/app");
  assert.equal(analysis.topics.length, 2);
  assert.equal(analysis.issues[0].body, undefined);

  const prepared = await service.prepare({
    analysisId: analysis.analysisId,
    topics: [{ id: "topic-1", answers: { "question-1": "Safari and Chrome" } }],
  });
  assert.equal(prepared.results[0].status, "planned");
  assert.deepEqual(starts[0].issueNumbers, [54, 55]);
  assert.deepEqual(starts[0].issueUrls, ["https://github.com/acme/app/issues/54", "https://github.com/acme/app/issues/55"]);
  assert.match(starts[0].goal, /Which browser\?: Safari and Chrome/);
  const issueCall = calls.find(([bin, args]) => bin === "gh" && args[0] === "issue");
  assert.deepEqual(issueCall[1], ["issue", "list", "--state", "open", "--limit", "100", "--json", "number,title,body,labels,url,updatedAt"]);
  const modelCall = calls.find(([bin]) => bin === "ccs");
  assert.equal(modelCall[1].includes("--allowed-tools"), false);
  assert.match(modelCall[1][modelCall[1].indexOf("--disallowed-tools") + 1], /Read.*Bash.*Skill.*WebSearch/);
  assert.equal(modelCall[1].at(-2), "--");
});

test("reports real analysis and topic-planning milestones without exposing issue bodies", async () => {
  const { service } = harness();
  const analysisEvents = [];
  const analysis = await service.analyze({ repositoryId: REPOSITORY_ID, onEvent: (event) => analysisEvents.push(event) });
  assert.deepEqual(analysisEvents.map((event) => event.t), [
    "Opening repository…",
    "Fetching repository details and open issues…",
    "Found 3 open issues",
    "Grouping 3 issues by outcome and implementation overlap…",
    "Finalizing delivery topics…",
  ]);
  assert.equal(analysisEvents.some((event) => event.t.includes("Focus the editor after playback")), false);

  const prepareEvents = [];
  await service.prepare({
    analysisId: analysis.analysisId,
    topics: [{ id: "topic-1" }],
    onEvent: (event) => prepareEvents.push(event),
  });
  assert.ok(prepareEvents.some((event) => event.t === "Planning topic 1 of 1: Editor reliability"));
  assert.ok(prepareEvents.some((event) => event.t === "Editor reliability · Read app/editor.tsx"));
  assert.equal(prepareEvents.at(-1).t, "Finished 1 of 1 topic plan");
});

test("refuses stale issues and issues already claimed by a saved goal", async () => {
  const stale = harness({ refreshedIssues: issues.map((issue) => issue.number === 54 ? { ...issue, updatedAt: "2026-09-01T10:00:00Z" } : issue) });
  const analysis = await stale.service.analyze({ repositoryId: REPOSITORY_ID });
  await assert.rejects(() => stale.service.prepare({ analysisId: analysis.analysisId, topics: [{ id: "topic-1" }] }), /#54 changed or closed/);

  const claimed = harness({ existingPlans: [{ planId: "existing", issueNumbers: [55] }] });
  const claimedAnalysis = await claimed.service.analyze({ repositoryId: REPOSITORY_ID });
  await assert.rejects(() => claimed.service.prepare({ analysisId: claimedAnalysis.analysisId, topics: [{ id: "topic-1" }] }), /#55 already belongs/);
});

test("returned issue reservations do not block bulk topic planning", async () => {
  const released = harness({ existingPlans: [{ planId: "old", issueNumbers: [55], boardStatus: "aborted", issuesReturnedAt: "2026-09-07T12:00:00Z" }] });
  const analysis = await released.service.analyze({ repositoryId: REPOSITORY_ID });
  await released.service.prepare({ analysisId: analysis.analysisId, topics: [{ id: "topic-1" }] });
});

test("launches prepared topic plans in order and reports parallel worktree count", async () => {
  const { service, launches } = harness();
  const result = await service.launch({ planIds: ["plan-a", "plan-b", "plan-a"] });
  assert.deepEqual(launches, ["plan-a", "plan-b"]);
  assert.equal(result.launchedTopics, 2);
  assert.equal(result.launchedWorktrees, 4);
});

// Analysing a repository's issues used to scan every repository under both
// roots before it read three fields. The dashboard resolver answers instead.
test("analysis resolves its repository without scanning every repository", async () => {
  let snapshots = 0;
  const worktrees = {
    snapshot: async () => { snapshots += 1; return { repositories: [] }; },
    resolveRepository: async (id) => ({ id, name: "app", primaryPath: "/repo/app" }),
  };
  const { service, calls } = harness({ worktrees });
  const analysis = await service.analyze({ repositoryId: REPOSITORY_ID });
  assert.equal(snapshots, 0, "the analysis must not scan the repository roots");
  assert.equal(analysis.repository.nameWithOwner, "acme/app");
  // The resolver names the checkout `primaryPath`. Every `gh` call still has to
  // run inside it, so it must reach them as `path`.
  const issueCall = calls.find(([bin, args]) => bin === "gh" && args[0] === "issue");
  assert.equal(issueCall[2].cwd, "/repo/app");
});

test("a dashboard without a resolver still analyses through its snapshot", async () => {
  const { service } = harness();
  const analysis = await service.analyze({ repositoryId: REPOSITORY_ID });
  assert.equal(analysis.repository.nameWithOwner, "acme/app");
});

test("issue analysis uses its saved provider and custom model", async () => {
  const { service, calls } = harness();
  service.modelSettings.configure({ roles: { issueAnalyzer: { provider: "codex", models: { codex: "custom-analyzer" } } } });
  await service.analyze({ repositoryId: REPOSITORY_ID });
  const args = calls.find(([bin]) => bin === "ccs")[1];
  assert.equal(args[0], "codex");
  assert.equal(args[args.indexOf("--model") + 1], "custom-analyzer");
  assert.equal(args.at(-2), "--");
});
