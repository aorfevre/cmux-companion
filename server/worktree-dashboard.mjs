import { createHash } from "node:crypto";
import { realpath } from "node:fs/promises";
import { basename, dirname, join, relative, resolve, sep } from "node:path";
import { normalizePullRequest, parsePorcelainV2 } from "./repo-catalog.mjs";
import { RepositoryArchive } from "./repository-archive.mjs";
import { RepositoryFavorites } from "./repository-favorites.mjs";

const STATUS_PRIORITY = { ready: 0, done: 1, working: 2, attention: 3 };

// The local updater writes these files into a finalized release checkout after
// it checks the commit out. Git reports them as untracked, so every release
// worktree looked permanently dirty and could never be removed. They are build
// bookkeeping, not user work, so they do not count as changes. Only detached
// checkouts get this treatment, and only for untracked entries, so a real edit
// in a branch worktree still blocks removal.
export const UPDATER_ARTIFACTS = new Set(["release-manifest.json", "transaction.json", "bootstrap.next"]);

export function defaultManagedReleaseRoots(homeDirectory = process.env.CMUX_COMPANION_HOME || process.env.HOME) {
  if (!homeDirectory) return [];
  return [
    join(homeDirectory, ".local", "share", "cmux-companion", "releases"),
    join(homeDirectory, ".local", "share", "cmux-companion-updater", "releases"),
  ].map((path) => resolve(path));
}

export function isManagedReleasePath(path, roots = defaultManagedReleaseRoots()) {
  const candidate = resolve(path);
  return roots.some((root) => {
    const managedRoot = resolve(root);
    return candidate === managedRoot || candidate.startsWith(`${managedRoot}${sep}`);
  });
}

export function countUpdaterArtifacts(output, artifacts = UPDATER_ARTIFACTS) {
  let count = 0;
  for (const line of String(output).split("\n")) {
    if (!line.startsWith("? ")) continue;
    if (artifacts.has(line.slice(2).trim())) count += 1;
  }
  return count;
}

export class WorktreeDashboard {
  constructor({ repoCatalog, cacheMs = 5_000, canonicalize = realpath, repositoryArchive = new RepositoryArchive(), repositoryFavorites = new RepositoryFavorites(), managedReleaseRoots = defaultManagedReleaseRoots(), repositoryConcurrency = 6, githubFailureBackoffMs = 60_000, log = null } = {}) {
    if (!repoCatalog) throw new TypeError("A repository catalog is required");
    this.repoCatalog = repoCatalog;
    this.cacheMs = cacheMs;
    this.canonicalize = canonicalize;
    this.repositoryArchive = repositoryArchive;
    this.repositoryFavorites = repositoryFavorites;
    this.managedReleaseRoots = managedReleaseRoots.map((path) => resolve(path));
    this.repositoryConcurrency = Math.max(1, Number(repositoryConcurrency) || 6);
    this.githubFailureBackoffMs = Math.max(0, Number(githubFailureBackoffMs) || 0);
    this.log = log;
    this.cache = null;
    this.pullRequestCache = new Map();
    this.pullRequestPending = new Map();
    this.githubCheckedAt = null;
    this.targets = new Map();
  }

  async snapshot({ workspaces = [], refresh = false, refreshGitHub = false, refreshGitHubRepositoryId = null, refreshGitHubRepositoryIds = null } = {}) {
    const workspaceSignature = (workspaces || []).map((workspace) => [
      workspace.id,
      workspace.current_directory,
      workspace.last_activity_at,
      workspace.has_unread,
      workspace.status?.effective,
      workspace.status?.signals?.any_agent_needs_input,
      workspace.status?.signals?.any_agent_running,
    ].join(":")) .join("|");
    if (!refresh && !refreshGitHub && this.cache && Date.now() - this.cache.at < this.cacheMs && this.cache.workspaceSignature === workspaceSignature) {
      return this.cache.value;
    }

    const repos = await this.repoCatalog.list({ refresh });
    // RepoCatalog intentionally sees each top-level linked worktree. Expanding
    // `git worktree list` from every one of those aliases multiplies the same
    // repository inspection quadratically. Collapse aliases by their common
    // Git directory before inspecting worktrees or asking GitHub anything.
    const uniqueRepos = await this.#uniqueRepositoryCandidates(repos);
    const targets = new Map();
    const scopedRepositoryIds = Array.isArray(refreshGitHubRepositoryIds)
      ? new Set(refreshGitHubRepositoryIds.map(String))
      : refreshGitHubRepositoryId ? new Set([String(refreshGitHubRepositoryId)]) : null;
    const inspected = await mapWithConcurrency(uniqueRepos, this.repositoryConcurrency, (repo) => this.inspectRepository(repo, {
      refreshGitHub,
      refreshGitHubRepositoryIds: scopedRepositoryIds,
      targets,
    }));
    const repositories = dedupeRepositories(inspected.filter(Boolean));
    if (refreshGitHub) this.githubCheckedAt = new Date().toISOString();
    const worktreeIndex = repositories.flatMap((repo) => [...repo.worktrees, ...repo.releases])
      .sort((left, right) => right.path.length - left.path.length);
    const assigned = new Set();

    for (const workspace of workspaces || []) {
      const directory = workspaceDirectory(workspace);
      const worktree = directory && worktreeIndex.find((candidate) => isInside(candidate.path, directory));
      if (!worktree) continue;
      worktree.sessions.push(normalizeSession(workspace));
      assigned.add(workspace.id);
    }

    for (const repository of repositories) {
      for (const worktree of repository.worktrees) finalizeWorktree(worktree);
      for (const release of repository.releases) finalizeWorktree(release);
      repository.summary = { ...summarizeWorktrees(repository.worktrees), releases: repository.releases.length };
      repository.archived = this.repositoryArchive.has(repository.id);
      repository.favorite = this.repositoryFavorites.has(repository.id);
    }

    const orphanSessions = (workspaces || []).filter((workspace) => !assigned.has(workspace.id)).map(normalizeSession);
    const allWorktrees = repositories.flatMap((repository) => repository.worktrees);
    const allReleases = repositories.flatMap((repository) => repository.releases);
    const allSessions = [...allWorktrees.flatMap((worktree) => worktree.sessions), ...allReleases.flatMap((release) => release.sessions), ...orphanSessions];
    const value = {
      generatedAt: new Date().toISOString(),
      github: {
        checkedAt: this.githubCheckedAt,
        status: !this.githubCheckedAt ? "not-loaded" : repositories.every((repository) => repository.pullRequestsAvailable) ? "ready" : "partial",
      },
      summary: {
        repositories: repositories.length,
        worktrees: allWorktrees.length,
        releases: allReleases.length,
        sessions: allSessions.length,
        needsYou: allSessions.filter((session) => session.state.tone === "attention").length,
        working: allSessions.filter((session) => session.state.tone === "working").length,
        dirty: allWorktrees.filter((worktree) => worktree.dirty).length,
        pullRequests: allWorktrees.filter((worktree) => worktree.pullRequest).length,
      },
      repositories,
      orphanSessions,
    };
    this.targets = targets;
    this.cache = { at: Date.now(), workspaceSignature, value };
    return value;
  }

  async #uniqueRepositoryCandidates(repos) {
    const identified = await mapWithConcurrency(repos, this.repositoryConcurrency, async (repo) => {
      const commonDir = await this.repoCatalog.git(repo.path, ["rev-parse", "--git-common-dir"])
        .then((output) => resolve(repo.path, output.trim()))
        .catch(() => resolve(repo.path, ".git"));
      return { repo, commonDir };
    });
    const unique = new Map();
    for (const candidate of identified) {
      const current = unique.get(candidate.commonDir);
      const primaryPath = dirname(candidate.commonDir);
      if (!current || candidate.repo.path === primaryPath) unique.set(candidate.commonDir, candidate.repo);
    }
    return [...unique.values()];
  }

  async inspectRepository(repo, { refreshGitHub = false, refreshGitHubRepositoryIds = null, targets = this.targets } = {}) {
    let records;
    try {
      records = parseWorktreeList(await this.repoCatalog.git(repo.path, ["worktree", "list", "--porcelain", "-z"]));
    } catch {
      records = [{ path: repo.path, head: null, branch: repo.branch, detached: false, locked: null, prunable: null }];
    }
    const primaryPath = await this.canonicalize(records[0]?.path || repo.path).catch(() => resolve(records[0]?.path || repo.path));
    const commonDir = await this.repoCatalog.git(repo.path, ["rev-parse", "--git-common-dir"])
      .then((output) => resolve(repo.path, output.trim()))
      .catch(() => resolve(primaryPath, ".git"));
    const repositoryId = repositoryKey(commonDir);
    const shouldRefreshGitHub = refreshGitHub && (!refreshGitHubRepositoryIds || refreshGitHubRepositoryIds.has(repositoryId));
    const [worktrees, pullRequests] = await Promise.all([
      mapWithConcurrency(records, this.repositoryConcurrency, (record) => this.inspectWorktree(repo, record, { primaryPath, repositoryId, targets })),
      this.loadPullRequests(repo, { refresh: shouldRefreshGitHub, cacheKey: repositoryId }),
    ]);
    const valid = worktrees.filter(Boolean);
    for (const worktree of valid) worktree.pullRequest = pullRequests.byBranch.get(worktree.branch) || null;
    const releases = valid.filter((worktree) => worktree.managedRelease)
      .sort((left, right) => right.lastActivity - left.lastActivity);
    const developerWorktrees = valid.filter((worktree) => !worktree.managedRelease)
      .sort((left, right) => Number(right.isPrimary) - Number(left.isPrimary) || right.lastActivity - left.lastActivity);
    return {
      id: repositoryId,
      name: basename(primaryPath),
      root: repo.root,
      path: primaryPath,
      commonDir,
      pullRequestsAvailable: pullRequests.available,
      worktrees: developerWorktrees,
      releases,
    };
  }

  async inspectWorktree(repo, record, { primaryPath = resolve(repo.path), repositoryId = repo.id, targets = this.targets } = {}) {
    try {
      const path = await this.canonicalize(record.path);
      const topLevel = resolve((await this.repoCatalog.git(path, ["rev-parse", "--show-toplevel"])).trim());
      if (topLevel !== path) return null;
      const [statusOutput, lastActivityOutput] = await Promise.all([
        this.repoCatalog.git(path, ["status", "--porcelain=v2", "--branch"]).catch(() => ""),
        this.repoCatalog.git(path, ["log", "-1", "--format=%ct"]).catch(() => "0"),
      ]);
      const status = parsePorcelainV2(statusOutput);
      const detached = record.detached || status.branch === "HEAD";
      const updaterArtifacts = detached ? countUpdaterArtifacts(statusOutput) : 0;
      const changedFiles = Math.max(0, status.changedFiles - updaterArtifacts);
      const id = worktreeId(repositoryId, path);
      const managedRelease = isManagedReleasePath(path, this.managedReleaseRoots);
      const worktree = {
        id,
        repoId: repositoryId,
        path,
        name: basename(path),
        branch: status.branch !== "HEAD" ? status.branch : record.branch || "HEAD",
        head: record.head,
        isPrimary: path === primaryPath,
        managedRelease,
        detached,
        locked: record.locked,
        prunable: record.prunable,
        ahead: status.ahead,
        behind: status.behind,
        changedFiles,
        updaterArtifacts,
        shortSha: managedRelease ? basename(path).slice(0, 7) : undefined,
        dirty: changedFiles > 0,
        lastActivity: Number(lastActivityOutput.trim()) || 0,
        pullRequest: null,
        sessions: [],
        state: { label: "No session", tone: "ready" },
      };
      targets.set(id, { ...worktree, repoName: basename(primaryPath), repositoryPath: primaryPath });
      return worktree;
    } catch {
      return null;
    }
  }

  // One bounded `gh` process per refreshed repository, and one only. It asks
  // for every state, because the goal board needs CLOSED and MERGED as much as
  // the worktree badges need OPEN. Splitting that into a second goal-specific
  // command would double the GitHub work each Refresh costs.
  async loadPullRequests(repo, { refresh = false, cacheKey = repo.id } = {}) {
    const cached = this.pullRequestCache.get(cacheKey);
    // Local dashboard polling must never turn into hidden GitHub polling. An
    // explicit refresh replaces this cache; every other snapshot reuses it
    // indefinitely, including the first snapshot after a server restart.
    if (!refresh) return cached?.value || emptyPullRequests();
    // A local Git repository without a GitHub remote has no pull requests to
    // query. Treat that as a successful empty result: spawning `gh` would fail,
    // retry, and incorrectly make the whole dashboard look partially broken.
    if (repo.githubRepository === null) {
      const value = { ...emptyPullRequests(), available: true, notApplicable: true };
      this.pullRequestCache.set(cacheKey, { at: Date.now(), value });
      return value;
    }
    // Repeated dashboard refreshes used to retry inaccessible repositories
    // twice every time. Keep the last explicit failure briefly; one unrelated
    // repository must not create an endless process storm.
    if (cached?.value?.error && Date.now() - cached.at < this.githubFailureBackoffMs) return cached.value;
    if (this.pullRequestPending.has(cacheKey)) return this.pullRequestPending.get(cacheKey);
    const pending = (async () => {
      let value;
      try {
        value = await this.#readPullRequests(repo, { checks: true });
      } catch (cause) {
        // `statusCheckRollup` makes GitHub walk every check of every pull
        // request. On a busy repository that costs seconds, and GitHub itself
        // answers 504 on the worst of them, whatever timeout is allowed. The
        // check counts are a badge; the states are what the goal board needs to
        // stop reporting a merged goal as waiting. So drop the badge data and
        // ask again rather than losing the states with it.
        this.log?.warn?.({ err: cause, repository: repo.name }, "reading pull requests with checks failed, retrying without them");
        try {
          value = await this.#readPullRequests(repo, { checks: false });
        } catch (retryCause) {
          // A swallowed failure told the user "GitHub checked just now" when
          // nothing had been fetched at all. `available: false` already says the
          // read failed; this makes it say so out loud as well.
          const detail = String(retryCause?.stderr || retryCause?.message || "").split("\n")[0].slice(0, 200);
          this.log?.warn?.({ err: retryCause, repository: repo.name }, "reading pull requests failed");
          value = { ...emptyPullRequests(), error: detail || "GitHub could not be read" };
        }
      }
      this.pullRequestCache.set(cacheKey, { at: Date.now(), value });
      return value;
    })();
    this.pullRequestPending.set(cacheKey, pending);
    try { return await pending; }
    finally { this.pullRequestPending.delete(cacheKey); }
  }

  // One `gh` read. `checks: false` drops `statusCheckRollup`, which is the field
  // that makes the query slow enough to time out or to be refused outright.
  async #readPullRequests(repo, { checks }) {
    const fields = [
      "number", "title", "url", "state", "isDraft", "reviewDecision",
      ...(checks ? ["statusCheckRollup"] : []),
      "headRefName", "baseRefName", "mergeStateStatus", "updatedAt", "author", "createdAt", "closedAt", "mergedAt",
    ].join(",");
    const { stdout = "" } = await this.repoCatalog.execute("gh", [
      "pr", "list", "--state", "all", "--limit", "100", "--json", fields,
      ...(repo.githubRepository ? ["--repo", repo.githubRepository] : []),
    ], { cwd: repo.path, encoding: "utf8", timeout: checks ? 20_000 : 15_000, maxBuffer: 8 * 1024 * 1024, env: process.env });
    const pullRequests = JSON.parse(stdout);
    const built = buildPullRequests(Array.isArray(pullRequests) ? pullRequests : []);
    // Saying so matters: a badge showing "0/0 checks" would otherwise read as a
    // pull request with no CI rather than one whose checks were not read.
    return checks ? built : { ...built, checksAvailable: false };
  }

  // What the last successful refresh saw for one repository, with no GitHub
  // call of its own. The goal merge watcher reads observations through this,
  // so reconciliation can never add a process to a Refresh.
  pullRequestObservations(repositoryId) {
    const cached = this.pullRequestCache.get(String(repositoryId || ""));
    if (!cached?.value) return { available: false, observations: [], error: null };
    return { available: cached.value.available === true, observations: cached.value.observations || [], error: cached.value.error || null };
  }

  async resolve(id) {
    if (typeof id !== "string" || !/^[A-Za-z0-9_-]{18}$/.test(id)) throw new TypeError("Invalid worktree");
    await this.snapshot({ refresh: true });
    const target = this.targets.get(id);
    if (!target) throw new TypeError("Unknown worktree");
    return { ...target };
  }

  async remove(id, { workspaces = [], discardChanges = false } = {}) {
    if (typeof id !== "string" || !/^[A-Za-z0-9_-]{18}$/.test(id)) throw new TypeError("Invalid worktree");
    const dashboard = await this.snapshot({ workspaces, refresh: true });
    const worktree = dashboard.repositories.flatMap((repository) => [...repository.worktrees, ...repository.releases]).find((item) => item.id === id);
    const target = this.targets.get(id);
    if (!worktree || !target) throw new TypeError("Unknown worktree");
    assertRemovable(worktree, { discardChanges: discardChanges === true });
    if (discardChanges !== true) await this.assertStillClean(worktree, target);
    await this.runWorktreeRemoval(target);
    this.repoCatalog.cache = null;
    this.invalidate();
    return {
      removed: true,
      worktree: { id: worktree.id, branch: worktree.branch, path: worktree.path },
      branchPreserved: true,
      discardedChanges: discardChanges === true && worktree.dirty,
    };
  }

  // Bulk cleanup keeps the same guards as a single removal. It is deliberately
  // tolerant: one worktree Git refuses must not stop the others.
  async removeCleanWorktrees(repositoryId, { workspaces = [] } = {}) {
    if (typeof repositoryId !== "string" || !/^[A-Za-z0-9_-]{18}$/.test(repositoryId)) throw new TypeError("Invalid repository");
    const dashboard = await this.snapshot({ workspaces, refresh: true });
    const repository = dashboard.repositories.find((item) => item.id === repositoryId);
    if (!repository) throw new TypeError("Unknown repository");
    const candidates = repository.worktrees.filter(isBulkRemovable);
    const results = [];
    for (const worktree of candidates) {
      const target = this.targets.get(worktree.id);
      const entry = { id: worktree.id, branch: worktree.branch, path: worktree.path, removed: false, error: "" };
      try {
        if (!target) throw new TypeError("Unknown worktree");
        await this.assertStillClean(worktree, target);
        await this.runWorktreeRemoval(target);
        entry.removed = true;
      } catch (cause) {
        entry.error = cause instanceof Error ? cause.message : "Could not remove this worktree";
      }
      results.push(entry);
    }
    if (results.some((entry) => entry.removed)) {
      this.repoCatalog.cache = null;
      this.invalidate();
    }
    return {
      repository: { id: repository.id, name: repository.name },
      requested: results.length,
      removed: results.filter((entry) => entry.removed).length,
      failed: results.filter((entry) => !entry.removed).length,
      results,
      branchPreserved: true,
    };
  }

  // A worktree can change between the snapshot and the removal, so re-read its
  // status. Untracked files count here, minus the updater's own artifacts.
  async assertStillClean(worktree, target) {
    const output = await this.repoCatalog.git(target.path, ["status", "--porcelain=v2", "--branch", "--untracked-files=all"]);
    const latest = parsePorcelainV2(output);
    const artifacts = worktree.detached ? countUpdaterArtifacts(output) : 0;
    if (latest.changedFiles - artifacts > 0) throw new TypeError("This worktree changed. Commit or stash its changes before removing it");
  }

  async runWorktreeRemoval(target) {
    try {
      // --force is needed for ignored build output (node_modules, dist, etc.)
      // and for the explicitly confirmed detached removal.
      await this.repoCatalog.git(target.repositoryPath, ["worktree", "remove", "--force", target.path], { timeout: 120_000 });
    } catch (cause) {
      const detail = gitErrorDetail(cause);
      throw new TypeError(detail ? `Git could not remove this worktree: ${detail}` : "Git could not remove this worktree");
    }
  }

  // Discards one task's worktree and its branch so the task can start again
  // from its base. This is the deliberate opposite of `remove`: that method
  // protects work, and this one is called only when a person asked for a clean
  // restart of a task whose work they have decided to throw away.
  //
  // The branch goes with the worktree. Left behind, it would still point at the
  // discarded commits, and `create` checks out an existing branch, so the next
  // agent would land back on the work the restart was asked to remove.
  //
  // A missing worktree is success, not an error: the restart wants the path
  // gone, and a task that never created one is already in that state.
  async removeBranchWorktree(repositoryId, branch) {
    if (typeof repositoryId !== "string" || !/^[A-Za-z0-9_-]{18}$/.test(repositoryId)) throw new TypeError("Invalid repository");
    const name = normalizedGitInput(branch, "A branch name is required");
    const dashboard = await this.snapshot({ refresh: true });
    // Plans store the dashboard repository id, which is derived from Git's
    // common directory so every linked worktree shares one identity. The raw
    // catalog uses a different, path-derived id. Looking this id up through the
    // catalog therefore rejected every clean restart as "Unknown repository".
    const repository = dashboard.repositories.find((item) => item.id === repositoryId);
    if (!repository) throw new TypeError("Unknown repository");
    const worktree = repository.worktrees.find((item) => item.branch === name && !item.isPrimary);
    if (worktree) {
      // A managed release checkout is never a task worktree, and removing one
      // would break the updater. The name match alone must not reach it.
      if (worktree.managedRelease) throw new TypeError("That branch belongs to a companion release");
      const target = this.targets.get(worktree.id);
      if (!target) throw new TypeError("That worktree could not be inspected");
      await this.runWorktreeRemoval(target);
    }
    // `-D`, not `-d`: the whole point is to drop commits no base contains.
    // A branch that is already gone is not a failure.
    await this.repoCatalog.git(repository.path, ["branch", "-D", name]).catch(() => {});
    this.repoCatalog.cache = null;
    this.invalidate();
    return { removed: Boolean(worktree), branch: name, path: worktree?.path || null };
  }

  async create(repositoryId, { branch, base, reuseIfAtBase = false, workspaces = [] } = {}) {
    if (typeof repositoryId !== "string" || !/^[A-Za-z0-9_-]{18}$/.test(repositoryId)) throw new TypeError("Invalid repository");
    const branchName = normalizedGitInput(branch, "Enter a branch name");
    const dashboard = await this.snapshot({ workspaces, refresh: true });
    const repository = dashboard.repositories.find((item) => item.id === repositoryId);
    if (!repository) throw new TypeError("Unknown repository");

    try {
      await this.repoCatalog.git(repository.path, ["check-ref-format", "--branch", branchName]);
    } catch {
      throw new TypeError("Choose a valid Git branch name");
    }

    const primary = repository.worktrees.find((item) => item.isPrimary) || repository.worktrees[0];
    const baseRef = normalizedGitInput(base || primary?.branch || "HEAD", "Enter a base revision");
    const existing = repository.worktrees.find((item) => item.branch === branchName);
    if (existing) {
      if (reuseIfAtBase !== true) throw new TypeError("That branch already has a worktree");
      const reused = await this.reuseWorktree(existing, repository, baseRef);
      // A null result means the leftover was behind the base and held nothing
      // of its own, so reuseWorktree removed it. Fall through and build it
      // again from the current base.
      if (reused) return reused;
    }

    const branchExists = await this.repoCatalog.git(repository.path, ["show-ref", "--verify", "--quiet", `refs/heads/${branchName}`])
      .then(() => true, () => false);
    if (!branchExists) {
      try {
        await this.repoCatalog.git(repository.path, ["rev-parse", "--verify", "--quiet", `${baseRef}^{commit}`]);
      } catch {
        throw new TypeError("The base revision does not exist");
      }
    }

    const targetPath = worktreePath(repository.path, branchName);
    const args = branchExists
      ? ["worktree", "add", targetPath, branchName]
      : ["worktree", "add", "-b", branchName, targetPath, baseRef];
    try {
      await this.repoCatalog.git(repository.path, args, { timeout: 120_000 });
    } catch (cause) {
      const detail = gitErrorDetail(cause);
      throw new TypeError(detail ? `Git could not create this worktree: ${detail}` : "Git could not create this worktree");
    }

    this.repoCatalog.cache = null;
    this.invalidate();
    const refreshed = await this.snapshot({ refresh: true });
    const created = refreshed.repositories.flatMap((item) => item.worktrees).find((item) => item.path === targetPath);
    if (!created) throw new TypeError("The worktree was created but could not be loaded");
    return { created: true, reused: false, worktree: created, branchCreated: !branchExists };
  }

  // A launch makes a worktree and then opens a session in it. When the session
  // step fails, the worktree stays behind and every retry hit the "already has
  // a worktree" guard, so the plan could never restart.
  //
  // Recover that leftover, and only that leftover. It qualifies when it holds
  // nothing of its own: no session, no uncommitted file, and no commit the base
  // does not already contain. Then either
  //   - it already sits on the base commit, so reuse it where it is, or
  //   - it fell behind while the base moved, so delete it and return null. The
  //     caller builds it again from the current base.
  // Anything with work in it still fails, because recycling one under a new
  // agent would bury changes the user cannot see.
  async reuseWorktree(worktree, repository, baseRef) {
    const refuse = (reason) => { throw new TypeError(`That branch already has a worktree ${reason}`); };
    if (worktree.isPrimary) refuse("that is the main checkout");
    if (worktree.managedRelease) refuse("that belongs to a companion release");
    if (worktree.locked) refuse("that Git has locked");
    if (worktree.detached) refuse("with a detached HEAD");
    if (worktree.sessions.length > 0) refuse("with a running session");
    if (worktree.changedFiles > 0) refuse("with uncommitted changes");

    const target = this.targets.get(worktree.id);
    if (!target) refuse("that could not be inspected");
    // The snapshot is a moment old. Read the working tree again, so a file
    // written since then still blocks the recovery.
    try {
      await this.assertStillClean(worktree, target);
    } catch {
      refuse("with uncommitted changes");
    }

    const [baseSha, headSha] = await Promise.all([
      this.repoCatalog.git(repository.path, ["rev-parse", `${baseRef}^{commit}`]).then((output) => String(output).trim(), () => ""),
      this.repoCatalog.git(worktree.path, ["rev-parse", "HEAD"]).then((output) => String(output).trim(), () => ""),
    ]);
    if (!baseSha) throw new TypeError("The base revision does not exist");
    if (!headSha) refuse("whose commit could not be read");
    if (headSha === baseSha) return { created: false, reused: true, worktree, branchCreated: false };

    // The base moved on, most often because the branch this plan waited for
    // merged. Rebuilding is safe only when the branch carries no commit of its
    // own, which `--is-ancestor` proves.
    const contained = await this.repoCatalog.git(repository.path, ["merge-base", "--is-ancestor", headSha, baseSha])
      .then(() => true, () => false);
    if (!contained) refuse(`holding commits that ${baseRef} does not contain`);

    await this.runWorktreeRemoval(target);
    // The branch still points at the old commit. Left in place, `worktree add`
    // would check it out again and the task would start behind the base once
    // more. Deleting it loses nothing: every commit on it is already in the
    // base. `-D` is needed because the branch has no upstream to compare with.
    await this.repoCatalog.git(repository.path, ["branch", "-D", worktree.branch]).catch(() => {});
    this.repoCatalog.cache = null;
    this.invalidate();
    return null;
  }

  async setRepositoryArchived(id, archived, { workspaces = [] } = {}) {
    if (typeof id !== "string" || !/^[A-Za-z0-9_-]{18}$/.test(id)) throw new TypeError("Invalid repository");
    if (typeof archived !== "boolean") throw new TypeError("Archived must be true or false");
    const dashboard = await this.snapshot({ workspaces, refresh: true });
    const repository = dashboard.repositories.find((item) => item.id === id);
    if (!repository) throw new TypeError("Unknown repository");
    const saved = this.repositoryArchive.set(id, archived);
    this.invalidate();
    return { repository: { id: repository.id, name: repository.name, archived: saved } };
  }

  async setRepositoryFavorite(id, favorite, { workspaces = [] } = {}) {
    if (typeof id !== "string" || !/^[A-Za-z0-9_-]{18}$/.test(id)) throw new TypeError("Invalid repository");
    if (typeof favorite !== "boolean") throw new TypeError("Favorite must be true or false");
    const dashboard = await this.snapshot({ workspaces, refresh: true });
    const repository = dashboard.repositories.find((item) => item.id === id);
    if (!repository) throw new TypeError("Unknown repository");
    const saved = this.repositoryFavorites.set(id, favorite);
    this.invalidate();
    return { repository: { id: repository.id, name: repository.name, favorite: saved } };
  }

  invalidate() {
    this.cache = null;
  }
}

async function mapWithConcurrency(items, concurrency, operation) {
  if (!items.length) return [];
  const results = new Array(items.length);
  let next = 0;
  async function worker() {
    while (next < items.length) {
      const index = next++;
      results[index] = await operation(items[index], index);
    }
  }
  await Promise.all(Array.from({ length: Math.min(concurrency, items.length) }, () => worker()));
  return results;
}

function emptyPullRequests() {
  return { available: false, byBranch: new Map(), observations: [] };
}

// Two shapes from one command. `byBranch` keeps only OPEN pull requests, which
// is what a worktree badge and the dashboard counts have always meant, and it
// keeps the newest per branch. `observations` keeps every state, because one
// branch can carry a closed pull request and a merged one, and the goal watcher
// has to tell them apart.
function buildPullRequests(items) {
  const byBranch = new Map();
  const observations = [];
  for (const item of items) {
    const normalized = normalizePullRequest(item);
    const observation = {
      ...normalized,
      state: String(item?.state || normalized.state || "").toUpperCase(),
      createdAt: item?.createdAt || null,
      closedAt: item?.closedAt || null,
      mergedAt: item?.mergedAt || null,
    };
    observations.push(observation);
    if (observation.state !== "OPEN") continue;
    const current = byBranch.get(normalized.headBranch);
    if (!current || String(observation.updatedAt || "") > String(current.updatedAt || "")) byBranch.set(normalized.headBranch, normalized);
  }
  return { available: true, byBranch, observations };
}

export function parseWorktreeList(output) {
  const records = [];
  let current = null;
  for (const field of String(output).split("\0")) {
    if (!field) {
      if (current?.path) records.push(current);
      current = null;
      continue;
    }
    const space = field.indexOf(" ");
    const key = space === -1 ? field : field.slice(0, space);
    const value = space === -1 ? true : field.slice(space + 1);
    if (key === "worktree") current = { path: String(value), head: null, branch: null, detached: false, locked: null, prunable: null };
    else if (current && key === "HEAD") current.head = String(value);
    else if (current && key === "branch") current.branch = String(value).replace(/^refs\/heads\//, "");
    else if (current && key === "detached") current.detached = true;
    else if (current && key === "locked") current.locked = value === true ? "Locked" : String(value);
    else if (current && key === "prunable") current.prunable = value === true ? "Prunable" : String(value);
  }
  if (current?.path) records.push(current);
  return records;
}

// The primary worktree, an active session, and a Git lock block every removal
// path. Only a dirty *detached* worktree can be forced, and only when the
// client explicitly asked for it after its own second confirmation.
export function assertRemovable(worktree, { discardChanges = false } = {}) {
  if (worktree.managedRelease) throw new TypeError("Managed deployment releases cannot be removed");
  if (worktree.isPrimary) throw new TypeError("The primary worktree cannot be removed");
  if (worktree.sessions.length) throw new TypeError("Close this worktree\u2019s sessions before removing it");
  if (worktree.locked) throw new TypeError("Unlock this Git worktree before removing it");
  if (!worktree.dirty) return;
  if (!discardChanges) throw new TypeError("Commit or stash this worktree\u2019s changes before removing it");
  if (!worktree.detached) throw new TypeError("Only a detached worktree can be removed with its changes discarded");
}

export function isBulkRemovable(worktree) {
  return !worktree.managedRelease && !worktree.isPrimary && worktree.changedFiles === 0 && !worktree.locked && worktree.sessions.length === 0;
}

function normalizedGitInput(value, missingMessage) {
  if (typeof value !== "string") throw new TypeError(missingMessage);
  const normalized = value.trim();
  if (!normalized || normalized.length > 200 || normalized.startsWith("-") || /[\0\r\n]/.test(normalized)) throw new TypeError(missingMessage);
  return normalized;
}

export function worktreePath(repositoryPath, branch) {
  const slug = String(branch).toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 72) || "worktree";
  return resolve(dirname(repositoryPath), `${basename(repositoryPath)}-${slug}`);
}

function gitErrorDetail(cause) {
  return typeof cause?.stderr === "string" ? cause.stderr.trim().split("\n").at(-1)?.slice(0, 180) : "";
}

function worktreeId(repoId, path) {
  return createHash("sha256").update(`${repoId}\0${path}`).digest("base64url").slice(0, 18);
}

function repositoryKey(commonDir) {
  return createHash("sha256").update(commonDir).digest("base64url").slice(0, 18);
}

function workspaceDirectory(workspace) {
  return workspace?.current_directory || workspace?.terminals?.find((terminal) => terminal.is_focused)?.current_directory || workspace?.terminals?.[0]?.current_directory || null;
}

function normalizeSession(workspace) {
  const state = sessionState(workspace);
  const terminal = workspace.terminals?.find((item) => item.is_focused) || workspace.terminals?.[0];
  const agentText = [workspace.title, workspace.preview, ...(workspace.terminals || []).map((item) => item.title)].join(" ").toLowerCase();
  const provider = agentText.includes("claude") ? "Claude" : agentText.includes("codex") ? "Codex" : "Terminal";
  return {
    id: workspace.id,
    title: workspace.title || "Untitled workspace",
    preview: workspace.preview || terminal?.title || "Terminal ready",
    directory: workspaceDirectory(workspace),
    terminalCount: workspace.terminals?.length || 0,
    lastActivityAt: workspace.last_activity_at || 0,
    provider,
    state,
  };
}

function sessionState(workspace) {
  if (workspace.has_unread || workspace.status?.signals?.any_agent_needs_input) return { label: "Needs you", tone: "attention" };
  if (workspace.status?.effective === "working" || workspace.status?.signals?.any_agent_running) return { label: "Working", tone: "working" };
  if (workspace.status?.effective === "done") return { label: "Done", tone: "done" };
  return { label: "Ready", tone: "ready" };
}

function finalizeWorktree(worktree) {
  worktree.sessions.sort((left, right) => right.lastActivityAt - left.lastActivityAt);
  worktree.state = worktree.sessions.reduce((best, session) => (
    STATUS_PRIORITY[session.state.tone] > STATUS_PRIORITY[best.tone] ? session.state : best
  ), { label: "No session", tone: "ready" });
  worktree.lastActivity = Math.max(worktree.lastActivity, ...worktree.sessions.map((session) => session.lastActivityAt || 0));
}

function summarizeWorktrees(worktrees) {
  const sessions = worktrees.flatMap((worktree) => worktree.sessions);
  return {
    worktrees: worktrees.length,
    sessions: sessions.length,
    needsYou: sessions.filter((session) => session.state.tone === "attention").length,
    working: sessions.filter((session) => session.state.tone === "working").length,
    dirty: worktrees.filter((worktree) => worktree.dirty).length,
  };
}

function dedupeRepositories(repositories) {
  const grouped = new Map();
  for (const repository of repositories) {
    const current = grouped.get(repository.id);
    if (!current) {
      grouped.set(repository.id, { ...repository, worktrees: [...repository.worktrees], releases: [...repository.releases] });
      continue;
    }
    appendUniqueByPath(current.worktrees, repository.worktrees);
    appendUniqueByPath(current.releases, repository.releases);
    current.releases.sort((left, right) => right.lastActivity - left.lastActivity);
    current.pullRequestsAvailable ||= repository.pullRequestsAvailable;
  }
  return [...grouped.values()].filter((repository) => repository.worktrees.length > 0);
}

function appendUniqueByPath(target, entries) {
  const seen = new Set(target.map((entry) => entry.path));
  for (const entry of entries) {
    if (seen.has(entry.path)) continue;
    seen.add(entry.path);
    target.push(entry);
  }
}

function isInside(root, path) {
  const value = relative(resolve(root), resolve(path));
  return value === "" || (!value.startsWith("..") && !value.startsWith("/"));
}
