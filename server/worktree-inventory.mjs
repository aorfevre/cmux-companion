import { goalWorktreeProof } from "./goal-worktree-proof.mjs";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { readdir, realpath } from "node:fs/promises";
import { basename, join, resolve, sep } from "node:path";
import { defaultManagedReleaseRoots, isManagedReleasePath } from "./worktree-dashboard.mjs";
import { digest, parseWorktreePorcelain, plainPath, runGit } from "./worktree-operations.mjs";

const execute = promisify(execFile);
const OMIT = new Set([".git", "node_modules", ".next", "dist", "build", "coverage", ".cache", ".turbo", ".venv", "venv", "vendor"]);
const BUILD_OUTPUT = new Set(["node_modules", ".next", "dist", "build", "coverage", ".turbo"]);
export const inside = (root, path) => path === root || path.startsWith(`${root}${sep}`);
export async function git(cwd, args, executeGit = execute) {
  return (await runGit(cwd, args, { encoding: "utf8", timeout: 30_000, maxBuffer: 16 * 1024 * 1024, env: { ...process.env, GIT_OPTIONAL_LOCKS: "0", GIT_TERMINAL_PROMPT: "0" } }, executeGit)).stdout;
}
export function parseWorktrees(output) {
  return parseWorktreePorcelain(output).map((record, index) => ({
    path: record.path?.trimStart(),
    head: record.head?.trimStart() ?? undefined,
    // Only a prefix hidden behind whitespace remains after canonical parsing.
    branch: (record.branch?.trimStart() === record.branch ? record.branch : record.branch?.trimStart().replace(/^refs\/heads\//, "")) || null,
    primary: index === 0,
    bare: record.bare,
    locked: record.locked,
    lockReason: record.lockReason?.trimStart() || null,
    prunable: record.prunable,
  }));
}
export async function processActivity(cmux) {
  try {
    const payload = await (cmux.loadWorkspaceListDetailed ? cmux.loadWorkspaceListDetailed() : cmux.workspaceListDetailed());
    if (!Array.isArray(payload?.workspaces)) throw new Error("Invalid cmux session inventory");
    if (payload.workspaces.some((s) => !s.current_directory && !s.cwd)) throw new Error("A session has no known working directory");
    const sessions = payload.workspaces.flatMap((s) => [s.current_directory, s.cwd, ...(s.surfaces || []).map((surface) => surface.current_directory || surface.cwd)]).filter(Boolean);
    const result = await execute("/usr/sbin/lsof", ["-n", "-a", "-u", String(process.getuid()), "-d", "cwd", "-F", "pn"], { timeout: 15_000, maxBuffer: 8 * 1024 * 1024 });
    if (result.stderr.trim()) throw new Error("Process inventory is incomplete");
    const processes = result.stdout.split("\n").filter((line) => line.startsWith("n")).map((line) => line.slice(1));
    return { available: true, paths: [...sessions, ...processes] };
  } catch (error) { return { available: false, paths: [], error: error.message }; }
}
export class WorktreeInventory {
  constructor({ roots, managedReleaseRoots = defaultManagedReleaseRoots(), activity = async () => ({ available: false, paths: [] }), now = () => Date.now(), github = true, goalPlans = () => [], readGoalPr = undefined } = {}) {
    this.roots = roots.map(resolvePath);
    this.managedReleaseRoots = managedReleaseRoots;
    this.activity = activity;
    this.now = now;
    this.github = github;
    this.goalPlans = goalPlans;
    this.readGoalPr = readGoalPr;
  }
  async discover() {
    const repositories = new Map();
    const errors = [];
    const markers = [];
    const walk = async (path) => {
      let entries;
      try { entries = await readdir(path, { withFileTypes: true }); }
      catch (error) { errors.push({ path, error: error.message }); return; }
      if (entries.some((entry) => entry.name === ".git")) {
        markers.push(path);
        try {
          await plainPath(join(path, ".git"));
          const common = await realpath((await git(path, ["rev-parse", "--path-format=absolute", "--git-common-dir"])).trim());
          if (!repositories.has(common)) repositories.set(common, { common, path, name: basename(path) });
        } catch (error) { errors.push({ path, classification: "broken", error: `Broken Git reference: ${error.message}` }); }
      }
      for (const entry of entries) {
        if (entry.isDirectory() && !OMIT.has(entry.name)) await walk(join(path, entry.name));
      }
    };
    for (const root of this.roots) {
      try { await plainPath(root); await walk(root); }
      catch (error) { errors.push({ path: root, error: error.message }); }
    }
    for (const repo of repositories.values()) {
      try {
        repo.worktrees = parseWorktrees(await git(repo.path, ["worktree", "list", "--porcelain", "-z"]));
        repo.name = basename(repo.worktrees[0]?.path || repo.path);
        repo.primaryPath = repo.worktrees[0]?.path;
      } catch (error) { errors.push({ path: repo.path, error: error.message }); repo.worktrees = []; }
    }
    return { repositories: [...repositories.values()], errors, markers };
  }
  async baseEvidence(repo) {
    try {
      const ref = (await git(repo.path, ["symbolic-ref", "refs/remotes/origin/HEAD"])).trim();
      if (!ref.startsWith("refs/remotes/origin/")) throw new Error("Default branch unavailable");
      const branch = ref.slice("refs/remotes/origin/".length);
      const head = (await git(repo.path, ["rev-parse", `${ref}^{commit}`])).trim();
      const remote = (await git(repo.path, ["ls-remote", "--exit-code", "origin", `refs/heads/${branch}`])).trim().split(/\s+/)[0];
      if (head !== remote) throw new Error("Local default-branch reference is stale; fetch before cleanup");
      return { ref, branch, head };
    } catch (error) { return { error: error.message }; }
  }
  async completion(repo, row, base) {
    const plans = this.goalPlans();
    const goal = await goalWorktreeProof(repo, row, plans, { readPr: this.readGoalPr });
    if (goal) return goal;
    if (plans.some((plan) => plan.integrationWorktreePath === row.path || plan.tasks?.some((task) => task.worktreePath === row.path))) return { proven: false, reason: "Goal PR is not verified merged for this exact worktree HEAD" };
    if (base.error) return { proven: false, reason: "Default branch could not be verified against origin" };
    try {
      await git(repo.path, ["merge-base", "--is-ancestor", row.head, base.head]);
      return { proven: true, reason: "HEAD is contained in the current origin default branch", baseHead: base.head };
    } catch { /* Squash merges need independent evidence of the exact HEAD. */ }
    try {
      const tree = (await git(row.path, ["rev-parse", "HEAD^{tree}"])).trim();
      const trees = await git(repo.path, ["log", "--format=%T", base.head]);
      if (trees.split("\n").includes(tree)) return { proven: true, reason: "Exact HEAD tree appears in default-branch history (including squash merges)", baseHead: base.head };
    } catch { return { proven: false, reason: "Commit history is unreadable" }; }
    if (this.github && row.branch) {
      try {
        const result = await execute("gh", ["pr", "list", "--state", "merged", "--head", row.branch, "--limit", "100", "--json", "number,url,headRefOid,baseRefName,mergeCommit,mergedAt"], { cwd: repo.path, timeout: 20_000, maxBuffer: 2 * 1024 * 1024 });
        for (const pr of JSON.parse(result.stdout)) {
          if (pr.headRefOid !== row.head || pr.baseRefName !== base.branch || !pr.mergeCommit?.oid) continue;
          await git(repo.path, ["merge-base", "--is-ancestor", pr.mergeCommit.oid, base.head]);
          return { proven: true, reason: `Merged PR #${pr.number} matches this exact HEAD`, url: pr.url, baseHead: base.head };
        }
      } catch { /* No verified PR evidence means preserve. */ }
    }
    return { proven: false, reason: "No merged evidence for this exact HEAD; clean alone is insufficient" };
  }
  async inspect(repo, registered, { activity, markers = [], base, estimate = false } = {}) {
    const row = { ...registered, id: digest(`${repo.common}\0${registered.path}`), common: repo.common, repositoryPath: repo.path, repository: repo.name, classification: "development", reasons: [], eligible: false, estimatedBytes: null };
    if (!row.path || !row.head || row.bare) { row.classification = "broken"; row.reasons.push("Unreadable registration or bare repository"); return row; }
    if (row.primary) { row.classification = "primary"; row.reasons.push("Primary checkout"); }
    if (isManagedReleasePath(row.path, this.managedReleaseRoots)) { row.classification = "managed-release"; row.reasons.push("Managed release: retention belongs to the updater"); }
    if (row.locked) row.reasons.push(`Git worktree is locked${row.lockReason ? `: ${row.lockReason}` : ""}`);
    if (!this.roots.some((root) => inside(root, row.path)) && row.classification === "development") row.reasons.push("Registered outside development roots; inventory only");
    let info;
    try {
      info = await plainPath(row.path, { missing: true });
      if (!info) { row.classification = "missing"; row.active = Boolean(activity?.paths?.some((path) => inside(row.path, path))); row.reasons.push(row.active ? "Directory missing but an open session references it" : "Directory missing; registration can only be handled by Git prune"); return row; }
      if (!info.isDirectory()) throw new Error("Worktree path is not a directory");
      row.identity = `${info.dev}:${info.ino}`;
      await plainPath(join(row.path, ".git"));
      if (await realpath((await git(row.path, ["rev-parse", "--path-format=absolute", "--git-common-dir"])).trim()) !== repo.common) throw new Error("Git common directory changed");
      if ((await git(row.path, ["rev-parse", "HEAD"])).trim() !== row.head) throw new Error("HEAD changed during inspection");
      await git(row.path, ["cat-file", "-e", `${row.head}^{commit}`]);
    } catch (error) { row.classification = "broken"; row.reasons.push(`Path or Git reference requires repair: ${error.message}`); return row; }
    if (!activity?.available) row.reasons.push("Session/process inventory unavailable; activity cannot be ruled out");
    else if (activity.paths.some((path) => inside(row.path, path))) row.reasons.push("An open session or process uses this worktree");
    if (markers.some((path) => path !== row.path && inside(row.path, path))) row.reasons.push("Contains a nested repository");
    try {
      const status = await git(row.path, ["status", "--porcelain=v1", "-z", "--untracked-files=all", "--ignore-submodules=none"]);
      row.dirty = Boolean(status);
      if (row.dirty) row.reasons.push("Tracked changes or untracked files would be lost");
      const tracked = await git(row.path, ["ls-files", "--stage", "-z"]);
      if (tracked.split("\0").some((entry) => entry.startsWith("160000 "))) row.reasons.push("Submodules require manual cleanup");
      const ignored = (await git(row.path, ["ls-files", "--others", "--ignored", "--exclude-standard", "--directory", "-z"])).split("\0").filter(Boolean);
      if (ignored.includes(".wrangler/")) {
        const generated = (await git(row.path, ["ls-files", "--others", "--ignored", "--exclude-standard", "-z", "--", ".wrangler"])).split("\0").filter(Boolean);
        if (generated.every((path) => path === ".wrangler/deploy/config.json" || path === ".wrangler/wrangler.log" || path.startsWith(".wrangler/logs/"))) ignored.splice(ignored.indexOf(".wrangler/"), 1);
        else row.protectedWrangler = generated;
      }
      row.ignoredOutput = ignored.filter((path) => BUILD_OUTPUT.has(path.split("/")[0]));
      row.protectedIgnored = ignored.filter((path) => !BUILD_OUTPUT.has(path.split("/")[0]));
      if (row.protectedIgnored.length) row.reasons.push(`Ignored files outside known build directories are protected: ${row.protectedIgnored.slice(0, 8).join(", ")}`);
    } catch { row.reasons.push("Git status or index is unreadable; never treated as clean"); row.classification = "broken"; }
    // Proof is useful in the preview even while a clean worktree is in grace.
    if (!row.reasons.length) {
      try { if (await nestedRepository(row.path)) row.reasons.push("Contains a nested repository, including ignored build output"); }
      catch { row.reasons.push("Nested repository inspection incomplete"); }
      row.completion = await this.completion(repo, row, base || await this.baseEvidence(repo));
      if (!row.completion.proven) row.reasons.push(row.completion.reason);
    }
    row.eligible = row.reasons.length === 0;
    if (estimate && row.eligible) {
      try { row.estimatedBytes = Number((await execute("du", ["-sk", row.path], { timeout: 10_000 })).stdout.split(/\s+/)[0]) * 1024; } catch { /* Size is an optional estimate. */ }
    }
    return row;
  }
  async snapshot({ estimate = true } = {}) {
    const inventory = await this.discover();
    const activity = await this.activity();
    const entries = [];
    // Four repositories at a time, rather than one process per worktree at once.
    const queue = [...inventory.repositories];
    await Promise.all(Array.from({ length: 4 }, async () => {
      while (queue.length) {
        const repo = queue.shift();
        const base = await this.baseEvidence(repo);
        for (const row of repo.worktrees) entries.push(await this.inspect(repo, row, { activity, base, markers: inventory.markers, estimate }));
      }
    }));
    return { generatedAt: new Date(this.now()).toISOString(), roots: this.roots, repositoryCount: inventory.repositories.length, entries: entries.sort((a, b) => a.path.localeCompare(b.path)), errors: inventory.errors, activityAvailable: activity.available };
  }
}
function resolvePath(path) { return resolve(path); }

// Git does not protect nested repositories hidden inside an ignored build
// directory. Check those too; never follow symlinks while walking contents.
async function nestedRepository(root) {
  const queue = [root];
  let visited = 0;
  while (queue.length) {
    if (++visited > 200_000) throw new Error("Nested repository inspection exceeded its safe limit");
    const path = queue.pop();
    for (const entry of await readdir(path, { withFileTypes: true })) {
      if (entry.name === ".git") { if (path !== root) return true; continue; }
      if (entry.isDirectory()) queue.push(join(path, entry.name));
    }
  }
  return false;
}
