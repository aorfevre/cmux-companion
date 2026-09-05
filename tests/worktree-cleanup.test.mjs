import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, mkdir, readFile, realpath, rename, rm, symlink, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { WorktreeInventory, git } from "../server/worktree-inventory.mjs";
import { WorktreeCleanup } from "../server/worktree-cleanup.mjs";
import { withWorkspaceLaunch } from "../server/worktree-operations.mjs";

async function fixture(t) {
  const temp = await realpath(await mkdtemp(join(tmpdir(), "companion-gc-")));
  t.after(() => rm(temp, { recursive: true, force: true }));
  const roots = [join(temp, "karven"), join(temp, "rekord")];
  await Promise.all(roots.map((path) => mkdir(path)));
  const repo = join(roots[0], "repo");
  const remote = join(temp, "remote.git");
  await git(temp, ["init", "--bare", remote]);
  await git(temp, ["init", "-b", "main", repo]);
  await git(repo, ["config", "user.email", "gc@example.test"]);
  await git(repo, ["config", "user.name", "GC test"]);
  await writeFile(join(repo, "file"), "base\n");
  await writeFile(join(repo, ".gitignore"), "node_modules/\ndist/\n.env\n");
  await git(repo, ["add", "."]);
  await git(repo, ["commit", "-m", "base"]);
  await git(repo, ["remote", "add", "origin", remote]);
  await git(repo, ["push", "-u", "origin", "main"]);
  await git(repo, ["symbolic-ref", "refs/remotes/origin/HEAD", "refs/remotes/origin/main"]);
  let active = { available: true, paths: [] };
  let now = Date.now();
  let plans = [];
  let pr = null;
  const inventory = new WorktreeInventory({ roots, github: false, managedReleaseRoots: [join(temp, "releases")], activity: async () => active, now: () => now, goalPlans: () => plans, readGoalPr: async () => pr });
  const cleanup = new WorktreeCleanup({ inventory, directory: join(temp, "state"), now: () => now });
  const add = async (name, path = join(roots[1], name)) => { await git(repo, ["worktree", "add", "-b", name, path, "main"]); return path; };
  const row = (report, path) => report.entries.find((entry) => entry.path === path);
  const run = async (report, path) => cleanup.run({ previewId: report.previewId, ids: [row(report, path).id] });
  return { temp, roots, repo, remote, inventory, cleanup, add, row, run, setActivity: (value) => { active = value; }, advance: (days) => { now += days * 86_400_000; }, goal: (value, pullRequest) => { plans = [value]; pr = pullRequest; } };
}

test("recursive discovery deduplicates aliases by common directory and includes external registrations", async (t) => {
  const f = await fixture(t);
  await f.add("linked");
  const outside = await f.add("outside", join(f.temp, "outside"));
  const nested = join(f.roots[0], "container", "nested");
  await mkdir(nested, { recursive: true });
  await git(nested, ["init", "-b", "main"]);
  const report = await f.inventory.snapshot();
  assert.equal(report.repositoryCount, 2);
  assert.equal(report.entries.filter((entry) => entry.common.endsWith("repo/.git")).length, 3);
  assert.match(f.row(report, outside).reasons.join(), /outside development roots/);
  assert.equal(f.row(report, f.repo).classification, "primary");
});

test("disabled by default; grace observes exact HEAD; clean merged checkout deletes ignored build output but preserves branch", async (t) => {
  const f = await fixture(t);
  const path = await f.add("done");
  await mkdir(join(path, "node_modules"));
  await writeFile(join(path, "node_modules", "artifact"), "build");
  assert.equal((await f.cleanup.status()).policy.enabled, false);
  assert.equal((await f.cleanup.run({ automatic: true })).disabled, true);
  let report = await f.cleanup.preview();
  assert.equal(f.row(report, path).eligible, false);
  assert.match(f.row(report, path).reasons.join(), /Grace period/);
  f.advance(7);
  report = await f.cleanup.preview();
  assert.equal(f.row(report, path).eligible, true);
  const result = await f.run(report, path);
  assert.equal(result.results[0].outcome, "removed");
  assert.ok((await git(f.repo, ["rev-parse", "refs/heads/done"])).trim());
  await assert.rejects(readFile(join(path, "node_modules", "artifact")), { code: "ENOENT" });
  await assert.rejects(f.run(report, path), /Refresh the cleanup preview/);
});

test("clean is insufficient; squash merge of exact tree qualifies, newer work does not", async (t) => {
  const f = await fixture(t);
  await f.cleanup.configure({ graceDays: 0 });
  const path = await f.add("squashed");
  await writeFile(join(path, "feature"), "change");
  await git(path, ["add", "."]); await git(path, ["commit", "-m", "feature"]);
  assert.equal(f.row(await f.cleanup.preview(), path).eligible, false);
  await git(f.repo, ["merge", "--squash", "squashed"]); await git(f.repo, ["commit", "-m", "squashed feature"]);
  await git(f.repo, ["push", "origin", "main"]);
  let row = f.row(await f.cleanup.preview(), path);
  assert.equal(row.eligible, true);
  assert.match(row.completion.reason, /Exact HEAD tree/);
  await writeFile(join(path, "new-work"), "keep");
  await git(path, ["add", "."]); await git(path, ["commit", "-m", "not merged"]);
  row = f.row(await f.cleanup.preview(), path);
  assert.equal(row.eligible, false);
});

test("dirty, untracked, ignored personal files, locks, sessions and unknown activity all preserve worktrees", async (t) => {
  const f = await fixture(t);
  await f.cleanup.configure({ graceDays: 0 });
  const dirty = await f.add("dirty"); await writeFile(join(dirty, "file"), "edited");
  const untracked = await f.add("untracked"); await writeFile(join(untracked, "notes"), "keep");
  const ignored = await f.add("ignored"); await writeFile(join(ignored, ".env"), "keep");
  const locked = await f.add("locked"); await git(f.repo, ["worktree", "lock", "--reason", "agent", locked]);
  const active = await f.add("active"); f.setActivity({ available: true, paths: [join(active, "src")] });
  let report = await f.cleanup.preview();
  for (const path of [dirty, untracked, ignored, locked, active]) assert.equal(f.row(report, path).eligible, false, path);
  assert.match(f.row(report, locked).reasons.join(), /locked/);
  assert.match(f.row(report, active).reasons.join(), /session or process/);
  f.setActivity({ available: false, paths: [] });
  report = await f.cleanup.preview();
  assert.match(f.row(report, active).reasons.join(), /unavailable/);
});

test("submodules, nested repositories and broken references are protected", async (t) => {
  const f = await fixture(t);
  const sub = await f.add("submodule");
  const head = (await git(sub, ["rev-parse", "HEAD"])).trim();
  await git(sub, ["update-index", "--add", "--cacheinfo", `160000,${head},sub`]);
  const nested = await f.add("nested"); await mkdir(join(nested, "child")); await git(join(nested, "child"), ["init"]);
  const broken = await f.add("broken"); await writeFile(join(broken, ".git"), "gitdir: /no/such/reference\n");
  const report = await f.inventory.snapshot();
  assert.match(f.row(report, sub).reasons.join(), /Submodules/);
  assert.match(f.row(report, nested).reasons.join(), /nested repository/);
  assert.equal(f.row(report, broken).classification, "broken");
  assert.ok(report.errors.some((entry) => entry.path === broken));
});

test("missing paths use separately enabled Git prune and keep branches", async (t) => {
  const f = await fixture(t);
  const path = await f.add("missing");
  await rm(path, { recursive: true });
  const stamp = new Date(Date.now() - 40 * 86_400_000);
  for (const name of ["gitdir", "index"]) await utimes(join(f.repo, ".git", "worktrees", "missing", name), stamp, stamp);
  let report = await f.cleanup.preview();
  assert.equal(f.row(report, path).classification, "missing");
  assert.equal(report.prune[0].eligible, false);
  await f.cleanup.configure({ pruneEnabled: true });
  report = await f.cleanup.preview();
  assert.equal(report.prune[0].eligible, true, JSON.stringify(report.prune));
  const outcome = await f.cleanup.run({ previewId: report.previewId, ids: [], prune: [report.prune[0].common] });
  assert.equal(outcome.results[0].outcome, "pruned");
  assert.ok((await git(f.repo, ["rev-parse", "missing"])).trim());
  assert.equal(f.row(await f.cleanup.preview(), path), undefined);
});

test("revalidation catches changes, symlinks and activity appearing after preview", async (t) => {
  const f = await fixture(t); await f.cleanup.configure({ graceDays: 0 });
  const path = await f.add("changed");
  let report = await f.cleanup.preview();
  await writeFile(join(path, "new-untracked"), "keep");
  assert.equal((await f.run(report, path)).results[0].outcome, "skipped");
  await rm(join(path, "new-untracked"));
  report = await f.cleanup.preview();
  f.setActivity({ available: true, paths: [path] });
  assert.equal((await f.run(report, path)).results[0].outcome, "skipped");
  f.setActivity({ available: true, paths: [] });
  report = await f.cleanup.preview();
  await rename(path, `${path}-saved`); await symlink(`${path}-saved`, path);
  const result = await f.run(report, path);
  assert.equal(result.results[0].outcome, "skipped");
  assert.match(result.results[0].reason, /Symlink/);
  assert.equal(await readFile(join(`${path}-saved`, "file"), "utf8"), "base\n");
});

test("cleanup runs and new launches cannot overlap in the same repository", async (t) => {
  const f = await fixture(t); await f.cleanup.configure({ graceDays: 0 });
  const path = await f.add("concurrent"); const report = await f.cleanup.preview();
  let release; let entered;
  const gate = new Promise((resolve) => { release = resolve; });
  const acquired = new Promise((resolve) => { entered = resolve; });
  const inspect = f.inventory.inspect.bind(f.inventory);
  f.inventory.inspect = async (...args) => { entered(); await gate; return inspect(...args); };
  const pending = f.run(report, path);
  await acquired;
  await assert.rejects(f.run(report, path), /Another worktree operation/);
  await assert.rejects(withWorkspaceLaunch(path, async () => assert.fail("launched during cleanup")), /Another worktree operation/);
  release();
  assert.equal((await pending).results[0].outcome, "removed");
});

test("goal worktrees qualify immediately only after the exact goal PR is merged", async (t) => {
  const f = await fixture(t); const path = await f.add("goal");
  const head = (await git(path, ["rev-parse", "HEAD"])).trim();
  const plan = { planId: "goal-plan", status: "launched", cwd: f.repo, deliveryMode: "single", baseRef: "origin/main", boardPrNumber: 12, tasks: [{ id: "task", branch: "goal", worktreePath: path, launchStatus: "launched" }] };
  const pr = { number: 12, url: "https://github.test/pull/12", state: "OPEN", headRefOid: head, headRefName: "goal", baseRefName: "main", mergeCommit: { oid: head } };
  f.goal(plan, pr);
  assert.equal(f.row(await f.cleanup.preview(), path).eligible, false);
  f.goal(plan, { ...pr, state: "MERGED" });
  const report = await f.cleanup.preview();
  assert.equal(f.row(report, path).eligible, true, "merged goal bypasses seven-day grace");
  assert.equal((await f.run(report, path)).results[0].outcome, "removed");
});

test("an older merged goal PR cannot authorize newer commits", async (t) => {
  const f = await fixture(t); const path = await f.add("goal-newer");
  const original = (await git(path, ["rev-parse", "HEAD"])).trim();
  await writeFile(join(path, "extra"), "unmerged"); await git(path, ["add", "."]); await git(path, ["commit", "-m", "extra"]);
  f.goal({ status: "launched", cwd: f.repo, deliveryMode: "single", boardPrNumber: 12, tasks: [{ branch: "goal-newer", worktreePath: path, launchStatus: "launched" }] }, { state: "MERGED", headRefOid: original, headRefName: "goal-newer", baseRefName: "main", mergeCommit: { oid: original } });
  assert.equal(f.row(await f.cleanup.preview(), path).eligible, false);
});

test("combined goal cleanup requires the exact integrated task trailer in the merged PR", async (t) => {
  const f = await fixture(t); const task = await f.add("goal-task");
  await writeFile(join(task, "feature"), "completed"); await git(task, ["add", "."]); await git(task, ["commit", "-m", "task"]);
  const taskHead = (await git(task, ["rev-parse", "HEAD"])).trim();
  const integration = await f.add("goal-integration");
  await git(integration, ["merge", "--squash", "goal-task"]);
  await git(integration, ["commit", "-m", `Integrated task\n\nCmux-Goal-Task: plan/task/${taskHead}`]);
  const prHead = (await git(integration, ["rev-parse", "HEAD"])).trim();
  const plan = { planId: "plan", status: "launched", cwd: f.repo, deliveryMode: "combined", finalPrNumber: 22, integrationBranch: "goal-integration", integrationWorktreePath: integration, tasks: [{ id: "task", branch: "goal-task", worktreePath: task, launchStatus: "launched", deliveryStatus: "integrated", headSha: taskHead }] };
  const pr = { state: "MERGED", headRefOid: prHead, headRefName: "goal-integration", baseRefName: "main", mergeCommit: { oid: prHead } };
  f.goal(plan, pr);
  const report = await f.cleanup.preview();
  assert.equal(f.row(report, task).eligible, true);
  assert.equal(f.row(report, integration).eligible, true);
  f.goal({ ...plan, tasks: [{ ...plan.tasks[0], headSha: "a".repeat(40) }] }, pr);
  assert.equal(f.row(await f.cleanup.preview(), task).eligible, false);
});

test("nested repositories in ignored build output are never discarded", async (t) => {
  const f = await fixture(t); const path = await f.add("nested-build");
  await f.cleanup.configure({ graceDays: 0 });
  const child = join(path, "node_modules", "local-development");
  await mkdir(child, { recursive: true }); await git(child, ["init"]);
  const row = f.row(await f.cleanup.preview(), path);
  assert.equal(row.eligible, false);
  assert.match(row.reasons.join(), /nested repository/);
});

test("Wrangler deployment metadata is disposable but local databases are protected", async (t) => {
  const f = await fixture(t); await f.cleanup.configure({ graceDays: 0 });
  const path = await f.add("wrangler");
  await writeFile(join(f.repo, ".git", "info", "exclude"), ".wrangler/\n");
  await mkdir(join(path, ".wrangler", "deploy"), { recursive: true });
  await writeFile(join(path, ".wrangler", "deploy", "config.json"), "{}");
  assert.equal(f.row(await f.cleanup.preview(), path).eligible, true);
  await mkdir(join(path, ".wrangler", "state")); await writeFile(join(path, ".wrangler", "state", "local.db"), "local data");
  assert.equal(f.row(await f.cleanup.preview(), path).eligible, false);
});
