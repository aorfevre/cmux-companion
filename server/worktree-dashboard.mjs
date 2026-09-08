import { readCommitTime } from "./commit-time.mjs";
import { sessionState } from "./session-state.mjs";
import { createHash } from "node:crypto";
import { lstat, readdir, realpath, rmdir } from "node:fs/promises";
import { basename, dirname, join, relative, resolve, sep } from "node:path";
import { normalizePullRequest, parsePorcelainV2 } from "./repo-catalog.mjs";
import { RepositoryArchive } from "./repository-archive.mjs";
import { RepositoryFavorites } from "./repository-favorites.mjs";
import { resolveDefaultBaseRef } from "./default-base-ref.mjs";
import { WORKTREE_REASONS, worktreeStateError } from "./worktree-errors.mjs";
import { parseWorktreePorcelain, withWorkspaceLaunch } from "./worktree-operations.mjs";

const STATUS_PRIORITY = { ready: 0, done: 1, working: 2, attention: 3 };

// The local updater writes these files into a finalized release checkout after
// it checks the commit out. Git reports them as untracked, so every release
// worktree looked permanently dirty and could never be removed. They are build
// bookkeeping, not user work, so they do not count as changes. Only detached
// checkouts get this treatment, and only for untracked entries, so a real edit
// in a branch worktree still blocks removal.
const UPDATER_ARTIFACTS = new Set(["release-manifest.json", "transaction.json", "bootstrap.next"]);

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
  constructor({ repoCatalog, loadWorkspaces = null, operationLock = (path, work) => withWorkspaceLaunch(path, work, { requireRepository: true }), cacheMs = 5_000, canonicalize = realpath, repositoryArchive = new RepositoryArchive(), repositoryFavorites = new RepositoryFavorites(), managedReleaseRoots = defaultManagedReleaseRoots(), repositoryConcurrency = 6, githubFailureBackoffMs = 60_000, log = null } = {}) {
    if (!repoCatalog) throw new TypeError("A repository catalog is required");
    this.repoCatalog = repoCatalog;
    this.loadWorkspaces = loadWorkspaces;
    this.operationLock = operationLock;
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
    // One scan per distinct set of inputs, shared by every caller that arrives
    // while it runs. Entries are deleted the moment their scan settles.
    this.pendingSnapshots = new Map();
    this.scanChain = Promise.resolve();
    this.githubCheckedAt = null;
    this.targets = new Map();
    // A directory of repository id to name and primary path, written by every
    // snapshot. It is not a state cache: nothing here goes stale except the
    // path itself, and resolveRepository() re-derives the id from disk before
    // it trusts an entry. `invalidate()` therefore leaves it alone.
    this.repositoriesById = new Map();
  }

  async snapshot(options = {}) {
    const { workspaces = [], refresh = false, refreshGitHub = false } = options;
    // `last_activity_at` is deliberately absent. A running agent rewrites that
    // stamp every few seconds, so including it made the signature differ on
    // every poll, the cache never hit, and each ten-second poll ran a full scan
    // that took longer than the interval. The scans then piled up and saturated
    // the machine. Every other field here still changes a rendered state — the
    // pill, the orb, the attention count — so a session that actually changes
    // still busts the cache at once. The cost is that a relative time may be up
    // to `cacheMs` old, which is below the granularity this dashboard renders.
    const workspaceSignature = (workspaces || []).map((workspace) => [
      workspace.id,
      workspace.current_directory,
      workspace.has_unread,
      workspace.status?.effective,
      workspace.status?.signals?.any_agent_needs_input,
      workspace.status?.signals?.any_agent_running,
    ].join(":")) .join("|");
    if (!refresh && !refreshGitHub && this.cache && Date.now() - this.cache.at < this.cacheMs && this.cache.workspaceSignature === workspaceSignature) {
      return this.cache.value;
    }
    // A scan takes seconds and the dashboard polls on a fixed clock, so a second
    // caller arrives while the first is still running. Without this, each one
    // spawned its own git child per repository and the machine saturated. They
    // now share one scan. The key holds every input that changes the result, so
    // two callers never share a scan that answers only one of them.
    const pendingKey = JSON.stringify([workspaceSignature, refresh, refreshGitHub, options.refreshGitHubRepositoryId ?? null, options.refreshGitHubRepositoryIds ?? null]);
    const inFlight = this.pendingSnapshots.get(pendingKey);
    if (inFlight) return inFlight;
    const scan = this.scanChain.then(() => this.#scan(options, workspaceSignature));
    this.scanChain = scan.catch(() => {});
    this.pendingSnapshots.set(pendingKey, scan);
    try { return await scan; }
    finally { this.pendingSnapshots.delete(pendingKey); }
  }

  async #scan({ workspaces = [], refresh = false, refreshGitHub = false, refreshGitHubRepositoryId = null, refreshGitHubRepositoryIds = null } = {}, workspaceSignature = "") {
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
    // The catalog proved every path it returned is a repository toplevel, and
    // #uniqueRepositoryCandidates already resolved each common directory. Both
    // facts are passed down rather than asked of git a second time. The set
    // holds every catalogued path, not just this repository's own, because the
    // alias collapse above means one repository inspects worktrees that the
    // catalog listed under a different alias.
    const knownToplevels = new Set(repos.map((repo) => repo.path));
    const inspected = await mapWithConcurrency(uniqueRepos, this.repositoryConcurrency, ({ repo, commonDir }) => this.inspectRepository(repo, {
      refreshGitHub,
      refreshGitHubRepositoryIds: scopedRepositoryIds,
      targets,
      commonDir,
      knownToplevels,
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
    for (const repository of repositories) {
      const primary = repository.worktrees.find((item) => item.isPrimary) || repository.worktrees[0];
      this.repositoriesById.set(repository.id, { id: repository.id, name: repository.name, primaryPath: primary?.path || repository.path });
    }
    this.cache = { at: Date.now(), workspaceSignature, value };
    return value;
  }

  // The planner and the issue planner need three fields about one repository:
  // its id, its name, and its primary path. A full snapshot to read them costs
  // ten seconds on a machine with many worktrees, and it blocks the submit that
  // a person is waiting on. This answers from the directory instead, and only
  // scans when the directory cannot be trusted.
  async resolveRepository(repositoryId) {
    if (typeof repositoryId !== "string" || !/^[A-Za-z0-9_-]{18}$/.test(repositoryId)) throw new TypeError("Invalid repository");
    const known = this.repositoriesById.get(repositoryId);
    // A repository that moved, was deleted, or was replaced by another checkout
    // must not answer from the directory. Re-deriving the id from disk is one
    // git call, and it is the same derivation the snapshot itself uses.
    if (known && await this.#stillTheSameRepository(known)) return { ...known };
    // The entry failed its check, so it is wrong until a scan says otherwise.
    // Dropping it first is what makes a moved repository refuse: the scan below
    // writes the entry again only if the id still derives from a path on disk.
    if (known) this.repositoriesById.delete(repositoryId);
    await this.snapshot({ refresh: true });
    const found = this.repositoriesById.get(repositoryId);
    if (!found) throw new TypeError("Unknown repository");
    return { ...found };
  }

  async #stillTheSameRepository({ id, primaryPath }) {
    try {
      const output = await this.repoCatalog.git(primaryPath, ["rev-parse", "--git-common-dir"]);
      return repositoryKey(resolve(primaryPath, output.trim())) === id;
    } catch {
      return false;
    }
  }

  // The same memo the catalog uses, reached through the catalog rather than
  // injected separately, so one store serves both and a catalog without one is
  // fully live on both sides.
  #commitTime(path, sha) { return readCommitTime(this.repoCatalog, path, sha); }

  async #uniqueRepositoryCandidates(repos) {
    const identified = await mapWithConcurrency(repos, this.repositoryConcurrency, async (repo) => {
      // The catalog resolves this while it inspects each candidate. The git
      // call below is the fallback for a catalog that does not report it,
      // which every injected test double is.
      const commonDir = repo.commonDir || await this.repoCatalog.git(repo.path, ["rev-parse", "--git-common-dir"])
        .then((output) => resolve(repo.path, output.trim()))
        .catch(() => resolve(repo.path, ".git"));
      return { repo, commonDir };
    });
    const unique = new Map();
    for (const candidate of identified) {
      const current = unique.get(candidate.commonDir);
      const primaryPath = dirname(candidate.commonDir);
      // The common directory is kept with the repository it identifies, so
      // inspectRepository never has to resolve the same path again.
      if (!current || candidate.repo.path === primaryPath) unique.set(candidate.commonDir, candidate);
    }
    return [...unique.values()];
  }

  // `commonDir` and `knownToplevels` are what the caller already learned. Both
  // default to nothing, so a direct caller and the tests still work: the values
  // are resolved from git exactly as before when they are absent.
  async inspectRepository(repo, { refreshGitHub = false, refreshGitHubRepositoryIds = null, targets = this.targets, commonDir: knownCommonDir = null, knownToplevels = null } = {}) {
    let records;
    try {
      records = parseWorktreeList(await this.repoCatalog.git(repo.path, ["worktree", "list", "--porcelain", "-z"]));
    } catch {
      records = [{ path: repo.path, head: null, branch: repo.branch, detached: false, locked: null, prunable: null }];
    }
    const primaryPath = await this.canonicalize(records[0]?.path || repo.path).catch(() => resolve(records[0]?.path || repo.path));
    const commonDir = knownCommonDir || await this.repoCatalog.git(repo.path, ["rev-parse", "--git-common-dir"])
      .then((output) => resolve(repo.path, output.trim()))
      .catch(() => resolve(primaryPath, ".git"));
    const repositoryId = repositoryKey(commonDir);
    const shouldRefreshGitHub = refreshGitHub && (!refreshGitHubRepositoryIds || refreshGitHubRepositoryIds.has(repositoryId));
    const [worktrees, pullRequests] = await Promise.all([
      mapWithConcurrency(records, this.repositoryConcurrency, (record) => this.inspectWorktree(repo, record, { primaryPath, repositoryId, targets, knownToplevels })),
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

  async inspectWorktree(repo, record, { primaryPath = resolve(repo.path), repositoryId = repo.id, targets = this.targets, knownToplevels = null } = {}) {
    try {
      const path = await this.canonicalize(record.path);
      // The check is that this path is its own repository toplevel, which is
      // how a directory inside a repository is rejected. The catalog already
      // proved that for the paths it returned, so asking git again spawns a
      // process to learn something the caller handed us.
      if (!knownToplevels?.has(path)) {
        const topLevel = resolve((await this.repoCatalog.git(path, ["rev-parse", "--show-toplevel"])).trim());
        if (topLevel !== path) return null;
      }
      // The display read, which the catalog may serve from its short-lived
      // cache. assertStillClean does not come through here.
      const read = this.repoCatalog.statusAndActivity
        ? await this.repoCatalog.statusAndActivity(path)
        : { output: await this.repoCatalog.git(path, ["status", "--porcelain=v2", "--branch"]).catch(() => ""), lastActivity: null };
      const statusOutput = read.output;
      const status = parsePorcelainV2(statusOutput);
      // `worktree list` is always read live and reports this checkout's commit,
      // so it takes precedence: it is the one sha that cannot have moved on.
      // The catalog's paired activity time is the fallback for a record without
      // one, and the live git read is the fallback for a catalog without either.
      const lastActivity = record.head
        ? await this.#commitTime(path, record.head)
        : read.lastActivity ?? await this.#commitTime(path, status.oid);
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
        lastActivity,
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

  async remove(id, { workspaces = [], workspacesAvailable, discardChanges = false } = {}) {
    if (workspacesAvailable === false) throw worktreeStateError("Sessions could not be checked. Retry before removing this worktree", WORKTREE_REASONS.SESSIONS_UNAVAILABLE);
    if (typeof id !== "string" || !/^[A-Za-z0-9_-]{18}$/.test(id)) throw new TypeError("Invalid worktree");
    const dashboard = await this.snapshot({ workspaces, refresh: true });
    const worktree = dashboard.repositories.flatMap((repository) => [...repository.worktrees, ...repository.releases]).find((item) => item.id === id);
    const target = this.targets.get(id);
    if (!worktree || !target) throw new TypeError("Unknown worktree");
    assertRemovable(worktree, { discardChanges: discardChanges === true });
    let live;
    await this.operationLock(target.path, async () => {
      // This observation must be made after acquiring the same lock as launch.
      const inventory = await Promise.resolve().then(() => this.loadWorkspaces?.()).catch(() => null);
      if (!inventory || inventory.available !== true || !Array.isArray(inventory.workspaces)) {
        throw worktreeStateError("Sessions could not be checked. Retry before removing this worktree", WORKTREE_REASONS.SESSIONS_UNAVAILABLE);
      }
      const current = await this.snapshot({ workspaces: inventory.workspaces, refresh: true });
      const row = current.repositories.flatMap((repository) => [...repository.worktrees, ...repository.releases]).find((item) => item.id === id);
      const currentTarget = this.targets.get(id);
      if (!row || !currentTarget || currentTarget.path !== target.path) throw new TypeError("This worktree changed. Refresh before removing it");
      assertRemovable(row, { discardChanges: discardChanges === true });
      live = await this.readLiveWorktreeState(row, currentTarget);
      if (discardChanges !== true && live.changedFiles > 0) throw new TypeError("This worktree changed. Commit or stash its changes before removing it");
      if (discardChanges === true) assertRemovable({ ...row, ...live }, { discardChanges: true });
      await this.runWorktreeRemoval(currentTarget);
    });
    if (this.repoCatalog.invalidate) this.repoCatalog.invalidate(); else this.repoCatalog.cache = null;
    this.invalidate();
    return {
      removed: true,
      worktree: { id: worktree.id, branch: worktree.branch, path: worktree.path },
      branchPreserved: true,
      discardedChanges: discardChanges === true && live.dirty,
    };
  }

  // Bulk cleanup keeps the same guards as a single removal. It is deliberately
  // tolerant: one worktree Git refuses must not stop the others.
  async removeCleanWorktrees(repositoryId, { workspaces = [], workspacesAvailable } = {}) {
    if (workspacesAvailable === false) throw worktreeStateError("Sessions could not be checked. Retry before removing worktrees", WORKTREE_REASONS.SESSIONS_UNAVAILABLE);
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
        await this.remove(worktree.id, { workspaces });
        entry.removed = true;
      } catch (cause) {
        entry.error = cause instanceof Error ? cause.message : "Could not remove this worktree";
      }
      results.push(entry);
    }
    if (results.some((entry) => entry.removed)) {
      if (this.repoCatalog.invalidate) this.repoCatalog.invalidate(); else this.repoCatalog.cache = null;
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
  // One live read of a working tree, for the paths that are about to change or
  // destroy it. It never consults the status cache: the argv differs, and it
  // goes straight to git rather than through the catalog's display read.
  async readLiveWorktreeState(worktree, target) {
    const output = await this.repoCatalog.git(target.path, ["status", "--porcelain=v2", "--branch", "--untracked-files=all"]).catch(() => {
      throw worktreeStateError("Git status could not be checked. Retry before removing this worktree", WORKTREE_REASONS.UNINSPECTABLE_WORKTREE);
    });
    if (typeof output !== "string") throw worktreeStateError("Git status could not be checked", WORKTREE_REASONS.UNINSPECTABLE_WORKTREE);
    const latest = parsePorcelainV2(output);
    const artifacts = worktree.detached ? countUpdaterArtifacts(output) : 0;
    const changedFiles = Math.max(0, latest.changedFiles - artifacts);
    return { changedFiles, dirty: changedFiles > 0 };
  }

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
      throw worktreeStateError(
        detail ? `Git could not remove this worktree: ${detail}` : "Git could not remove this worktree",
        WORKTREE_REASONS.REMOVE_FAILURE,
      );
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
  async removeBranchWorktree(repositoryId, branch, options) {
    if (typeof repositoryId !== "string" || !/^[A-Za-z0-9_-]{18}$/.test(repositoryId)) throw new TypeError("Invalid repository");
    const name = normalizedGitInput(branch, "A branch name is required");
    // Keep the historical two-argument call working until every planner caller
    // supplies inventory metadata. Once an options object is present, absence
    // of an explicit successful inventory is unknown and therefore unsafe.
    const legacyCall = options === undefined;
    const workspaces = Array.isArray(options?.workspaces) ? options.workspaces : [];
    const workspacesAvailable = legacyCall ? true : workspaceInventoryIsAvailable(options);
    const allowedWorkspaceIds = new Set(options?.allowedWorkspaceIds || options?.allowedWorkspaces || []);
    const dashboard = await this.snapshot({ workspaces, refresh: true });
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
      if (worktree.managedRelease) throw worktreeStateError("That branch belongs to a companion release", WORKTREE_REASONS.MANAGED_RELEASE);
      const target = this.targets.get(worktree.id);
      if (!target) throw worktreeStateError("That worktree could not be inspected", WORKTREE_REASONS.UNINSPECTABLE_WORKTREE);
      if (!workspacesAvailable) {
        throw worktreeStateError("That worktree cannot be removed while cmux sessions are unavailable", WORKTREE_REASONS.SESSIONS_UNAVAILABLE);
      }
      const blocking = workspaces.find((workspace) => {
        const directory = workspaceDirectory(workspace);
        return directory && isInside(worktree.path, directory) && !allowedWorkspaceIds.has(workspace.id);
      });
      if (blocking) {
        const title = typeof blocking.title === "string" && blocking.title.trim() ? blocking.title.trim() : "Untitled workspace";
        throw worktreeStateError(
          `Close workspace ${blocking.id} (${title}) before removing this task worktree`,
          WORKTREE_REASONS.RUNNING_SESSION,
        );
      }
      await this.runWorktreeRemoval(target);
    }
    // `-D`, not `-d`: the whole point is to drop commits no base contains.
    // A branch that is already gone is not a failure.
    await this.repoCatalog.git(repository.path, ["branch", "-D", name]).catch(() => {});
    if (this.repoCatalog.invalidate) this.repoCatalog.invalidate(); else this.repoCatalog.cache = null;
    this.invalidate();
    return { removed: Boolean(worktree), branch: name, path: worktree?.path || null };
  }

  async create(repositoryId, options = {}) {
    const {
      branch,
      base,
      reuseIfAtBase = false,
      workspaces = [],
    } = options;
    const workspacesAvailable = workspaceInventoryIsAvailable(options, true);
    const requireFreshAtBase = options.requireFreshAtBase === true
      || options.requireFreshBranch === true
      || options.requireFreshBranchAtBase === true
      || options.requireBranchAtBase === true;
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

    // `useDefaultBase` is the board's one-click path: it fetches the default
    // remote branch and branches from that tip, so the caller never sends a
    // base and a stale local branch can never become the base by accident.
    const primary = repository.worktrees.find((item) => item.isPrimary) || repository.worktrees[0];
    const baseRef = options.useDefaultBase === true
      ? await resolveDefaultBaseRef((cwd, args, gitOptions) => this.repoCatalog.git(cwd, args, gitOptions), repository.path)
      : normalizedGitInput(base || primary?.branch || "HEAD", "Enter a base revision");
    const existing = repository.worktrees.find((item) => item.branch === branchName);
    let retiredExisting = null;
    if (existing) {
      if (reuseIfAtBase !== true) throw worktreeStateError("That branch already has a worktree", WORKTREE_REASONS.REGISTERED_WORKTREE);
      const reused = await this.reuseWorktree(existing, repository, baseRef, { workspacesAvailable });
      // A null result means the leftover was behind the base and held nothing
      // of its own, so reuseWorktree removed it. Fall through and build it
      // again from the current base.
      if (reused) return { ...reused, baseRef };
      retiredExisting = existing;
    }

    const branchExists = await this.repoCatalog.git(repository.path, ["show-ref", "--verify", "--quiet", `refs/heads/${branchName}`])
      .then(() => true, () => false);
    if (branchExists && requireFreshAtBase) {
      throw worktreeStateError("That branch already exists locally", WORKTREE_REASONS.BRANCH_EXISTS);
    }
    if (!branchExists) {
      try {
        await this.repoCatalog.git(repository.path, ["rev-parse", "--verify", "--quiet", `${baseRef}^{commit}`]);
      } catch {
        throw new TypeError("The base revision does not exist");
      }
    }

    const targetPath = await resolveWorktreeAcquisitionPath(repository.path, branchName, [
      ...repository.worktrees,
      ...repository.releases,
    ].filter((item) => item !== retiredExisting));
    const args = branchExists
      ? ["worktree", "add", targetPath, branchName]
      : ["worktree", "add", "-b", branchName, targetPath, baseRef];
    try {
      await this.repoCatalog.git(repository.path, args, { timeout: 120_000 });
    } catch (cause) {
      if (!isAlreadyExistsForTarget(cause, targetPath)) throw worktreeAddError(cause, targetPath);
      const recovered = await this.recoverAlreadyExistsRace({
        repository,
        branchName,
        baseRef,
        args,
        targetPath,
        reuseIfAtBase,
        workspaces,
        workspacesAvailable,
        originalError: cause,
      });
      if (recovered) return recovered;
    }

    if (this.repoCatalog.invalidate) this.repoCatalog.invalidate(); else this.repoCatalog.cache = null;
    this.invalidate();
    const refreshed = await this.snapshot({ refresh: true });
    const created = refreshed.repositories.flatMap((item) => item.worktrees).find((item) => item.path === targetPath);
    if (!created) throw worktreeStateError("The worktree was created but could not be loaded", WORKTREE_REASONS.CREATED_NOT_LOADABLE);
    return { created: true, reused: false, worktree: created, branchCreated: !branchExists, baseRef };
  }

  async recoverAlreadyExistsRace({ repository, branchName, baseRef, args, targetPath, reuseIfAtBase, workspaces, workspacesAvailable, originalError }) {
    try {
      await this.repoCatalog.git(repository.path, ["worktree", "prune"]);
    } catch {
      throw worktreeAddError(originalError, targetPath);
    }

    let records;
    try {
      records = parseWorktreeList(await this.repoCatalog.git(repository.path, ["worktree", "list", "--porcelain", "-z"]));
    } catch {
      // Without a trustworthy repository inventory, neither the path nor the
      // branch can be classified safely. Preserve the original refusal.
      throw worktreeAddError(originalError, targetPath);
    }

    const registeredBranch = records.find((record) => record.branch === branchName);
    if (registeredBranch) {
      this.invalidate();
      const refreshed = await this.snapshot({ workspaces, refresh: true });
      const refreshedRepository = refreshed.repositories.find((item) => item.id === repository.id);
      const existing = refreshedRepository?.worktrees.find((item) => item.branch === branchName);
      if (!existing) {
        throw worktreeStateError("That worktree could not be inspected", WORKTREE_REASONS.UNINSPECTABLE_WORKTREE);
      }
      if (reuseIfAtBase !== true) {
        throw worktreeStateError("That branch already has a worktree", WORKTREE_REASONS.REGISTERED_WORKTREE);
      }
      const reused = await this.reuseWorktree(existing, refreshedRepository, baseRef, { workspacesAvailable });
      if (reused) return reused;
    } else if (records.some((record) => resolve(record.path) === resolve(targetPath))) {
      throw worktreeAddError(originalError, targetPath);
    } else if (!await removeEmptyUnownedDirectory(targetPath, { workspaces, workspacesAvailable })) {
      throw worktreeAddError(originalError, targetPath);
    }

    try {
      await this.repoCatalog.git(repository.path, args, { timeout: 120_000 });
    } catch (cause) {
      throw worktreeAddError(cause, targetPath);
    }
    return null;
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
  async reuseWorktree(worktree, repository, baseRef, { workspacesAvailable = true } = {}) {
    const refuse = (message, reason) => { throw worktreeStateError(`That branch already has a worktree ${message}`, reason); };
    if (worktree.isPrimary) refuse("that is the main checkout", WORKTREE_REASONS.PRIMARY);
    if (worktree.managedRelease) refuse("that belongs to a companion release", WORKTREE_REASONS.MANAGED_RELEASE);
    if (worktree.locked) refuse("that Git has locked", WORKTREE_REASONS.LOCKED);
    if (worktree.detached) refuse("with a detached HEAD", WORKTREE_REASONS.DETACHED);
    if (!workspacesAvailable) refuse("whose sessions could not be checked", WORKTREE_REASONS.SESSIONS_UNAVAILABLE);
    if (worktree.sessions.length > 0) refuse("with a running session", WORKTREE_REASONS.RUNNING_SESSION);
    if (worktree.changedFiles > 0) refuse("with uncommitted changes", WORKTREE_REASONS.UNCOMMITTED_CHANGES);

    const target = this.targets.get(worktree.id);
    if (!target) refuse("that could not be inspected", WORKTREE_REASONS.UNINSPECTABLE_WORKTREE);
    // The snapshot is a moment old. Read the working tree again, so a file
    // written since then still blocks the recovery.
    try {
      await this.assertStillClean(worktree, target);
    } catch {
      refuse("with uncommitted changes", WORKTREE_REASONS.UNCOMMITTED_CHANGES);
    }

    const [baseSha, headSha] = await Promise.all([
      this.repoCatalog.git(repository.path, ["rev-parse", `${baseRef}^{commit}`]).then((output) => String(output).trim(), () => ""),
      this.repoCatalog.git(worktree.path, ["rev-parse", "HEAD"]).then((output) => String(output).trim(), () => ""),
    ]);
    if (!baseSha) throw new TypeError("The base revision does not exist");
    if (!headSha) refuse("whose commit could not be read", WORKTREE_REASONS.UNREADABLE_COMMIT);
    if (headSha === baseSha) return { created: false, reused: true, worktree, branchCreated: false };

    // The base moved on, most often because the branch this plan waited for
    // merged. Rebuilding is safe only when the branch carries no commit of its
    // own, which `--is-ancestor` proves.
    const contained = await this.repoCatalog.git(repository.path, ["merge-base", "--is-ancestor", headSha, baseSha])
      .then(() => true, () => false);
    if (!contained) refuse(`holding commits that ${baseRef} does not contain`, WORKTREE_REASONS.FOREIGN_COMMITS);

    await this.runWorktreeRemoval(target);
    // The branch still points at the old commit. Left in place, `worktree add`
    // would check it out again and the task would start behind the base once
    // more. Deleting it loses nothing: every commit on it is already in the
    // base. `-D` is needed because the branch has no upstream to compare with.
    await this.repoCatalog.git(repository.path, ["branch", "-D", worktree.branch]).catch(() => {});
    if (this.repoCatalog.invalidate) this.repoCatalog.invalidate(); else this.repoCatalog.cache = null;
    this.invalidate();
    return null;
  }

  setRepositoryArchived(id, archived, options) {
    return this.#setRepositoryFlag(id, "archived", archived, this.repositoryArchive, options);
  }

  setRepositoryFavorite(id, favorite, options) {
    return this.#setRepositoryFlag(id, "favorite", favorite, this.repositoryFavorites, options);
  }

  async #setRepositoryFlag(id, key, value, store, { workspaces = [] } = {}) {
    if (typeof id !== "string" || !/^[A-Za-z0-9_-]{18}$/.test(id)) throw new TypeError("Invalid repository");
    if (typeof value !== "boolean") throw new TypeError(`${key === "archived" ? "Archived" : "Favorite"} must be true or false`);
    const dashboard = await this.snapshot({ workspaces, refresh: true });
    const repository = dashboard.repositories.find((item) => item.id === id);
    if (!repository) throw new TypeError("Unknown repository");
    const saved = store.set(id, value);
    this.invalidate();
    return { repository: { id: repository.id, name: repository.name, [key]: saved } };
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
  return parseWorktreePorcelain(output).filter((record) => record.path).map((record) => ({
    path: record.path,
    head: record.head,
    branch: record.branch,
    detached: record.detached,
    locked: record.locked ? record.lockReason ?? "Locked" : null,
    prunable: record.prunable ? record.pruneReason ?? "Prunable" : null,
  }));
}

// The primary worktree, an active session, and a Git lock block every removal
// path. Only a dirty *detached* worktree can be forced, and only when the
// client explicitly asked for it after its own second confirmation.
function assertRemovable(worktree, { discardChanges = false } = {}) {
  if (worktree.managedRelease) throw new TypeError("Managed deployment releases cannot be removed");
  if (worktree.isPrimary) throw new TypeError("The primary worktree cannot be removed");
  if (worktree.sessions.length) throw new TypeError("Close this worktree\u2019s sessions before removing it");
  if (worktree.locked) throw new TypeError("Unlock this Git worktree before removing it");
  if (!worktree.dirty) return;
  if (!discardChanges) throw new TypeError("Commit or stash this worktree\u2019s changes before removing it");
  if (!worktree.detached) throw new TypeError("Only a detached worktree can be removed with its changes discarded");
}

function isBulkRemovable(worktree) {
  return !worktree.managedRelease && !worktree.isPrimary && worktree.changedFiles === 0 && !worktree.locked && worktree.sessions.length === 0;
}

function normalizedGitInput(value, missingMessage) {
  if (typeof value !== "string") throw new TypeError(missingMessage);
  const normalized = value.trim();
  if (!normalized || normalized.length > 200 || normalized.startsWith("-") || /[\0\r\n]/.test(normalized)) throw new TypeError(missingMessage);
  return normalized;
}

export function worktreePath(repositoryPath, branch) {
  const slug = worktreeSlug(branch);
  return resolve(dirname(repositoryPath), `${basename(repositoryPath)}-${slug}`);
}

// Resolve before invoking Git so ordinary branch-name normalization collisions
// and unrelated filesystem occupants never become destructive cleanup cases.
// The natural legacy path remains first for every non-colliding branch.
export async function resolveWorktreeAcquisitionPath(repositoryPath, branch, registeredWorktrees = []) {
  const naturalPath = worktreePath(repositoryPath, branch);
  const existing = (registeredWorktrees || []).find((item) => item?.path && item.branch === branch);
  if (existing) return resolve(existing.path);
  const registered = (registeredWorktrees || []).filter((item) => item?.path);
  const naturalCollision = registered.some((item) => (
    item.branch
    && item.branch !== branch
    && worktreePath(repositoryPath, item.branch) === naturalPath
  ));
  if (!naturalCollision && await pathIsAvailable(naturalPath, registered)) return naturalPath;

  const suffix = createHash("sha256").update(String(branch)).digest("hex").slice(0, 10);
  for (let attempt = 0; attempt < 32; attempt += 1) {
    const candidate = `${naturalPath}-${suffix}${attempt === 0 ? "" : `-${attempt + 1}`}`;
    if (await pathIsAvailable(candidate, registered)) return candidate;
  }
  throw worktreeStateError(
    "Git could not create this worktree: every deterministic target path is occupied",
    WORKTREE_REASONS.PATH_OCCUPIED,
  );
}

function worktreeSlug(branch) {
  return String(branch).toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 72) || "worktree";
}

async function pathIsAvailable(path, registeredWorktrees) {
  if (registeredWorktrees.some((item) => resolve(item.path) === resolve(path))) return false;
  return lstat(path).then(() => false, (cause) => cause?.code === "ENOENT" ? true : false);
}

function workspaceInventoryIsAvailable(options, legacyDefault = false) {
  for (const key of ["workspacesAvailable", "workspaceInventoryAvailable", "sessionsAvailable"]) {
    if (options && Object.hasOwn(options, key)) return options[key] === true;
  }
  return legacyDefault;
}

async function removeEmptyUnownedDirectory(path, { workspaces, workspacesAvailable }) {
  if (!workspacesAvailable) return false;
  const first = await lstat(path).catch(() => null);
  if (!first?.isDirectory() || first.isSymbolicLink()) return false;
  if ((await readdir(path).catch(() => null))?.length !== 0) return false;
  if ((workspaces || []).some((workspace) => {
    const directory = workspaceDirectory(workspace);
    return directory && isInside(path, directory);
  })) return false;

  // Repeat both identity and emptiness checks immediately before rmdir. If an
  // actor replaced or populated the directory in between, leave it untouched.
  const second = await lstat(path).catch(() => null);
  if (!second?.isDirectory() || second.isSymbolicLink() || second.dev !== first.dev || second.ino !== first.ino) return false;
  if ((await readdir(path).catch(() => null))?.length !== 0) return false;
  try {
    await rmdir(path);
    return true;
  } catch {
    return false;
  }
}

function isAlreadyExistsForTarget(cause, targetPath) {
  const stderr = typeof cause?.stderr === "string" ? cause.stderr : "";
  return stderr.includes(`fatal: '${targetPath}' already exists`)
    || stderr.includes(`fatal: "${targetPath}" already exists`);
}

function worktreeAddError(cause, targetPath) {
  const detail = gitErrorDetail(cause);
  return worktreeStateError(
    detail ? `Git could not create this worktree: ${detail}` : "Git could not create this worktree",
    isAlreadyExistsForTarget(cause, targetPath) ? WORKTREE_REASONS.PATH_OCCUPIED : WORKTREE_REASONS.ADD_FAILURE,
  );
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
