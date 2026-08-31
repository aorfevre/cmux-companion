import { createHash } from "node:crypto";
import { realpath } from "node:fs/promises";
import { basename, relative, resolve } from "node:path";
import { normalizePullRequest, parsePorcelainV2 } from "./repo-catalog.mjs";
import { RepositoryArchive } from "./repository-archive.mjs";

const STATUS_PRIORITY = { ready: 0, done: 1, working: 2, attention: 3 };

export class WorktreeDashboard {
  constructor({ repoCatalog, cacheMs = 5_000, pullRequestCacheMs = 30_000, canonicalize = realpath, repositoryArchive = new RepositoryArchive() } = {}) {
    if (!repoCatalog) throw new TypeError("A repository catalog is required");
    this.repoCatalog = repoCatalog;
    this.cacheMs = cacheMs;
    this.pullRequestCacheMs = pullRequestCacheMs;
    this.canonicalize = canonicalize;
    this.repositoryArchive = repositoryArchive;
    this.cache = null;
    this.pullRequestCache = new Map();
    this.targets = new Map();
  }

  async snapshot({ workspaces = [], refresh = false } = {}) {
    const workspaceSignature = (workspaces || []).map((workspace) => [
      workspace.id,
      workspace.current_directory,
      workspace.last_activity_at,
      workspace.has_unread,
      workspace.status?.effective,
      workspace.status?.signals?.any_agent_needs_input,
      workspace.status?.signals?.any_agent_running,
    ].join(":")) .join("|");
    if (!refresh && this.cache && Date.now() - this.cache.at < this.cacheMs && this.cache.workspaceSignature === workspaceSignature) {
      return this.cache.value;
    }

    const repos = await this.repoCatalog.list({ refresh });
    const targets = new Map();
    const inspected = await Promise.all(repos.map((repo) => this.inspectRepository(repo, { refresh, targets })));
    const repositories = dedupeRepositories(inspected.filter(Boolean));
    const worktreeIndex = repositories.flatMap((repo) => repo.worktrees)
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
      repository.summary = summarizeWorktrees(repository.worktrees);
      repository.archived = this.repositoryArchive.has(repository.id);
    }

    const orphanSessions = (workspaces || []).filter((workspace) => !assigned.has(workspace.id)).map(normalizeSession);
    const allWorktrees = repositories.flatMap((repository) => repository.worktrees);
    const allSessions = [...allWorktrees.flatMap((worktree) => worktree.sessions), ...orphanSessions];
    const value = {
      generatedAt: new Date().toISOString(),
      summary: {
        repositories: repositories.length,
        worktrees: allWorktrees.length,
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

  async inspectRepository(repo, { refresh = false, targets = this.targets } = {}) {
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
    const [worktrees, pullRequests] = await Promise.all([
      Promise.all(records.map((record) => this.inspectWorktree(repo, record, { primaryPath, repositoryId, targets }))),
      this.loadPullRequests(repo, { refresh, cacheKey: repositoryId }),
    ]);
    const valid = worktrees.filter(Boolean);
    for (const worktree of valid) worktree.pullRequest = pullRequests.byBranch.get(worktree.branch) || null;
    return {
      id: repositoryId,
      name: basename(primaryPath),
      root: repo.root,
      path: primaryPath,
      commonDir,
      pullRequestsAvailable: pullRequests.available,
      worktrees: valid.sort((left, right) => Number(right.isPrimary) - Number(left.isPrimary) || right.lastActivity - left.lastActivity),
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
      const id = worktreeId(repositoryId, path);
      const worktree = {
        id,
        repoId: repositoryId,
        path,
        name: basename(path),
        branch: status.branch !== "HEAD" ? status.branch : record.branch || "HEAD",
        head: record.head,
        isPrimary: path === primaryPath,
        detached: record.detached || status.branch === "HEAD",
        locked: record.locked,
        prunable: record.prunable,
        ahead: status.ahead,
        behind: status.behind,
        changedFiles: status.changedFiles,
        dirty: status.changedFiles > 0,
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

  async loadPullRequests(repo, { refresh = false, cacheKey = repo.id } = {}) {
    const cached = this.pullRequestCache.get(cacheKey);
    if (!refresh && cached && Date.now() - cached.at < this.pullRequestCacheMs) return cached.value;
    let value;
    try {
      const { stdout = "" } = await this.repoCatalog.execute("gh", [
        "pr", "list", "--state", "open", "--limit", "100",
        "--json", "number,title,url,state,isDraft,reviewDecision,statusCheckRollup,headRefName,baseRefName,mergeStateStatus,updatedAt,author",
      ], { cwd: repo.path, encoding: "utf8", timeout: 2_500, maxBuffer: 2 * 1024 * 1024, env: process.env });
      const pullRequests = JSON.parse(stdout);
      value = { available: true, byBranch: new Map((Array.isArray(pullRequests) ? pullRequests : []).map((item) => {
        const normalized = normalizePullRequest(item);
        return [normalized.headBranch, normalized];
      })) };
    } catch {
      value = { available: false, byBranch: new Map() };
    }
    this.pullRequestCache.set(cacheKey, { at: Date.now(), value });
    return value;
  }

  async resolve(id) {
    if (typeof id !== "string" || !/^[A-Za-z0-9_-]{18}$/.test(id)) throw new TypeError("Invalid worktree");
    await this.snapshot({ refresh: true });
    const target = this.targets.get(id);
    if (!target) throw new TypeError("Unknown worktree");
    return { ...target };
  }

  async remove(id, { workspaces = [] } = {}) {
    if (typeof id !== "string" || !/^[A-Za-z0-9_-]{18}$/.test(id)) throw new TypeError("Invalid worktree");
    const dashboard = await this.snapshot({ workspaces, refresh: true });
    const worktree = dashboard.repositories.flatMap((repository) => repository.worktrees).find((item) => item.id === id);
    const target = this.targets.get(id);
    if (!worktree || !target) throw new TypeError("Unknown worktree");
    if (worktree.isPrimary) throw new TypeError("The primary worktree cannot be removed");
    if (worktree.sessions.length) throw new TypeError("Close this worktree’s sessions before removing it");
    if (worktree.dirty) throw new TypeError("Commit or stash this worktree’s changes before removing it");
    if (worktree.locked) throw new TypeError("Unlock this Git worktree before removing it");
    const latestStatus = parsePorcelainV2(await this.repoCatalog.git(target.path, ["status", "--porcelain=v2", "--branch", "--untracked-files=all"]));
    if (latestStatus.changedFiles > 0) throw new TypeError("This worktree changed. Commit or stash its changes before removing it");
    try {
      // --force is needed for ignored build output (node_modules, dist, etc.).
      // The fresh status check above still protects tracked and untracked work.
      await this.repoCatalog.git(target.repositoryPath, ["worktree", "remove", "--force", target.path], { timeout: 120_000 });
    } catch (cause) {
      const detail = typeof cause?.stderr === "string" ? cause.stderr.trim().split("\n").at(-1)?.slice(0, 180) : "";
      throw new TypeError(detail ? `Git could not remove this worktree: ${detail}` : "Git could not remove this worktree");
    }
    this.repoCatalog.cache = null;
    this.invalidate();
    return { removed: true, worktree: { id: worktree.id, branch: worktree.branch, path: worktree.path }, branchPreserved: true };
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

  invalidate() {
    this.cache = null;
  }
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
      grouped.set(repository.id, { ...repository, worktrees: [...repository.worktrees] });
      continue;
    }
    const seen = new Set(current.worktrees.map((worktree) => worktree.path));
    current.worktrees.push(...repository.worktrees.filter((worktree) => !seen.has(worktree.path)));
    current.pullRequestsAvailable ||= repository.pullRequestsAvailable;
  }
  return [...grouped.values()].filter((repository) => repository.worktrees.length > 0);
}

function isInside(root, path) {
  const value = relative(resolve(root), resolve(path));
  return value === "" || (!value.startsWith("..") && !value.startsWith("/"));
}
