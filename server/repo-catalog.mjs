import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { lstat, readFile, readdir, realpath } from "node:fs/promises";
import { basename, extname, join, relative, resolve, sep } from "node:path";
import { promisify } from "node:util";
import { runGit } from "./worktree-operations.mjs";

const execFileAsync = promisify(execFile);
const DEFAULT_ROOTS = [
  "/Users/aorfevre/Developers/karven",
  "/Users/aorfevre/Developers/rekord",
];

export class RepoCatalog {
  constructor({
    roots = parseRoots(process.env.CMUX_COMPANION_REPO_ROOTS) || DEFAULT_ROOTS,
    execute = execFileAsync,
    cacheMs = 10_000,
    inspectConcurrency = 8,
    gitConcurrency = 12,
    // Null by default, which is fully live behaviour. Only server/index.mjs
    // opts in, so a test that builds an app never opens the real database.
    identityStore = null,
  } = {}) {
    this.roots = roots.map((root) => resolve(root));
    this.execute = execute;
    this.cacheMs = cacheMs;
    this.inspectConcurrency = Math.max(1, Number(inspectConcurrency) || 8);
    this.identityStore = identityStore;
    this.gitConcurrency = Math.max(1, Number(gitConcurrency) || 12);
    this.gitActive = 0;
    this.gitQueue = [];
    this.pendingList = null;
    this.generation = 0;
    this.cache = null;
    this.prCache = new Map();
  }

  async list({ refresh = false } = {}) {
    if (!refresh && this.cache && Date.now() - this.cache.at < this.cacheMs) {
      return this.cache.repos;
    }

    if (this.pendingList) {
      const generation = this.generation;
      const repos = await this.pendingList;
      if (generation === this.generation && this.cache) return repos;
      return this.list({ refresh });
    }
    const scan = this.scan(this.generation);
    this.pendingList = scan;
    try { return await scan; }
    finally { if (this.pendingList === scan) this.pendingList = null; }
  }

  async scan(generation) {
    const candidates = [];
    for (const root of this.roots) {
      let entries = [];
      try {
        entries = await readdir(root, { withFileTypes: true });
      } catch {
        continue;
      }
      for (const entry of entries) {
        if (!entry.isDirectory() || entry.name.startsWith(".")) continue;
        candidates.push({ root, path: join(root, entry.name) });
      }
    }

    // A root can contain dozens of linked goal worktrees. Inspecting every
    // directory at once used to create hundreds of simultaneous git children,
    // which could make even /api/health unresponsive during a manual refresh.
    const settled = await mapSettledWithConcurrency(candidates, this.inspectConcurrency, (candidate) => this.inspect(candidate));
    const repos = settled
      .filter((result) => result.status === "fulfilled" && result.value)
      .map((result) => result.value)
      .sort((left, right) => {
        if (right.lastActivity !== left.lastActivity) return right.lastActivity - left.lastActivity;
        return left.name.localeCompare(right.name);
      });
    if (generation === this.generation) this.cache = { at: Date.now(), repos };
    // Bounded here rather than on a timer: a scan is the only thing that adds
    // rows, so it is the only thing that can make the file grow.
    this.identityStore?.prune();
    return repos;
  }

  async inspect({ root, path }) {
    const canonicalRoot = await realpath(root);
    const canonicalPath = await realpath(path);
    assertInside(canonicalRoot, canonicalPath);

    // One rev-parse answers both questions. Asking them separately spawned a
    // second process per candidate directory for no extra information.
    let topLevel;
    let commonDir;
    try {
      const [topLevelLine, commonDirLine] = (await this.git(canonicalPath, ["rev-parse", "--show-toplevel", "--git-common-dir"])).split("\n");
      topLevel = String(topLevelLine || "").trim();
      if (!topLevel) return null;
      commonDir = resolve(canonicalPath, String(commonDirLine || ".git").trim());
    } catch {
      return null;
    }
    const canonicalTop = await realpath(topLevel);
    if (canonicalTop !== canonicalPath) return null;

    const [read, scripts, remotes] = await Promise.all([
      this.statusAndActivity(canonicalPath),
      readScripts(canonicalPath),
      this.git(canonicalPath, ["config", "--get-regexp", "^remote\\..*\\.url$"]).catch(() => ""),
    ]);
    const status = parsePorcelainV2(read.output);
    const lastActivity = read.lastActivity;
    return {
      id: repoId(canonicalPath),
      name: basename(canonicalPath),
      root: basename(canonicalRoot),
      rootPath: canonicalRoot,
      path: canonicalPath,
      // The dashboard groups aliases of one repository by this directory. It
      // costs nothing here, and it saves the dashboard a process per candidate.
      commonDir,
      relativePath: relative(canonicalRoot, canonicalPath),
      branch: status.branch,
      ahead: status.ahead,
      behind: status.behind,
      changedFiles: status.changedFiles,
      dirty: status.changedFiles > 0,
      lastActivity,
      githubRepository: parseGitHubRepository(remotes),
      scripts,
    };
  }

  // The status a person reads on a card. A working tree changes with no signal,
  // so this is a real cache with a real window, and it is display only. Nothing
  // that deletes anything may call it: WorktreeDashboard.assertStillClean reads
  // git directly, with its own arguments, for exactly that reason.
  //
  // The activity time is stored with the status rather than derived from it.
  // That output also carries `# branch.oid`, and keying the commit-time memo on
  // a sha the checkout has moved past would report a repository as untouched
  // while a person commits to it. A served row therefore carries both halves
  // from one instant, so a card never mixes a status from now with a timestamp
  // from a minute ago. The staleness test in tests/repo-catalog.test.mjs is
  // what caught this.
  async statusAndActivity(path) {
    const stored = this.identityStore?.status(path);
    if (stored) return stored;
    const output = await this.git(path, ["status", "--porcelain=v2", "--branch"]).catch(() => "");
    const lastActivity = await this.#commitTime(path, parsePorcelainV2(output).oid);
    if (output) this.identityStore?.rememberStatuses([{ path, output, lastActivity }]);
    return { output, lastActivity };
  }

  // A commit's time is part of what its sha hashes, so a stored answer for a
  // known sha cannot be wrong. Without a usable sha — an unborn branch, or a
  // status read that failed — this is exactly the previous behaviour.
  async #commitTime(path, sha) {
    const stored = sha ? this.identityStore?.commitTime(sha) : null;
    if (stored) return stored;
    const output = await this.git(path, ["log", "-1", "--format=%ct"]).catch(() => "0");
    const commitTime = Number(String(output).trim()) || 0;
    if (sha && commitTime > 0) this.identityStore?.rememberCommitTimes([{ sha, commitTime }]);
    return commitTime;
  }

  // Every caller that changes a working tree — a worktree created, removed, or
  // handed to an agent — must reach this. Six of them used to assign
  // `catalog.cache = null` directly, which now leaves a stored status behind.
  invalidate() {
    this.generation += 1;
    this.cache = null;
    this.identityStore?.forgetStatuses();
  }

  async get(id) {
    const repos = await this.list();
    const repo = repos.find((item) => item.id === id);
    if (!repo) throw new TypeError("Unknown repository");
    return repo;
  }

  async changes(id) {
    const repo = await this.get(id);
    const [unstaged, staged, untracked, diffStat, stagedStat, recentCommit] = await Promise.all([
      this.git(repo.path, ["diff", "--name-status", "-z"]),
      this.git(repo.path, ["diff", "--cached", "--name-status", "-z"]),
      this.git(repo.path, ["ls-files", "--others", "--exclude-standard", "-z"]),
      this.git(repo.path, ["diff", "--stat", "--compact-summary"]),
      this.git(repo.path, ["diff", "--cached", "--stat", "--compact-summary"]),
      this.git(repo.path, ["log", "-1", "--format=%h%x00%s%x00%ct"]).catch(() => ""),
    ]);
    const files = mergeChangeSets(
      parseNameStatus(unstaged, "unstaged"),
      parseNameStatus(staged, "staged"),
      untracked.split("\0").filter(Boolean).map((path) => ({ path, status: "?", area: "untracked" })),
    );
    const commitParts = recentCommit.trimEnd().split("\0");
    return {
      repo,
      files,
      summary: {
        unstaged: diffStat.trim(),
        staged: stagedStat.trim(),
      },
      recentCommit: commitParts[0]
        ? { hash: commitParts[0], subject: commitParts[1] || "", timestamp: Number(commitParts[2]) || 0 }
        : null,
    };
  }

  async diff(id, file, { staged = false } = {}) {
    const changes = await this.changes(id);
    const record = changes.files.find((item) => item.path === file);
    if (!record) throw new TypeError("File is not part of the current changes");
    const repo = changes.repo;
    const absolute = resolve(repo.path, file);
    assertInside(repo.path, absolute);
    const args = ["diff", "--no-ext-diff", "--unified=3"];
    if (staged) args.push("--cached");
    args.push("--", file);
    let patch = await this.git(repo.path, args, { maxBuffer: 2 * 1024 * 1024 });
    if (!patch && record.area === "untracked") {
      const stat = await lstat(absolute).catch(() => null);
      if (stat?.isSymbolicLink()) {
        return { file, staged, patch: "Untracked symbolic link (content hidden)", truncated: false };
      }
      const content = await readFile(absolute, "utf8").catch(() => "");
      patch = content
        ? `--- /dev/null\n+++ b/${file}\n${content.split("\n").slice(0, 800).map((line) => `+${line}`).join("\n")}`
        : "Binary or unreadable untracked file";
    }
    const truncated = patch.length > 350_000;
    return {
      file,
      staged,
      patch: truncated ? patch.slice(0, 350_000) + "\n\n… diff truncated …" : patch,
      truncated,
    };
  }

  async markdown(id, file) {
    const resolved = await this.safeFile(id, file, { extensions: new Set([".md", ".markdown"]), maxBytes: 768 * 1024 });
    return {
      repo: resolved.repo,
      path: resolved.path,
      name: basename(resolved.path),
      content: await readFile(resolved.absolute, "utf8"),
    };
  }

  async asset(id, file) {
    const mime = {
      ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg",
      ".gif": "image/gif", ".webp": "image/webp",
    }[extname(String(file || "")).toLowerCase()];
    if (!mime) throw new TypeError("That Markdown asset type is not supported");
    const resolved = await this.safeFile(id, file, { extensions: new Set(Object.keys({ ".png": 1, ".jpg": 1, ".jpeg": 1, ".gif": 1, ".webp": 1 })), maxBytes: 8 * 1024 * 1024 });
    const content = await readFile(resolved.absolute);
    if (detectImageMime(content) !== mime) throw new TypeError("Markdown asset content does not match its image type");
    return { path: resolved.path, mime, content };
  }

  async safeFile(id, file, { extensions, maxBytes }) {
    if (typeof file !== "string" || !file.trim() || file.includes("\0") || file.length > 1_024) throw new TypeError("Invalid repository file");
    const repo = await this.get(id);
    const candidate = resolve(repo.path, file.trim());
    assertInside(repo.path, candidate);
    const canonicalRepo = await realpath(repo.path);
    const absolute = await realpath(candidate).catch(() => { throw new TypeError("Repository file does not exist"); });
    assertInside(canonicalRepo, absolute);
    const extension = extname(absolute).toLowerCase();
    if (!extensions.has(extension)) throw new TypeError("That repository file type is not supported");
    const info = await lstat(absolute);
    if (!info.isFile()) throw new TypeError("Repository file is not a regular file");
    if (info.size > maxBytes) throw new TypeError("Repository file is too large");
    return { repo, absolute, path: relative(canonicalRepo, absolute).split(sep).join("/") };
  }

  async pullRequest(id, { refresh = false } = {}) {
    const repo = await this.get(id);
    const cached = this.prCache.get(id);
    if (!refresh && cached && Date.now() - cached.at < 30_000) return cached.value;
    let value;
    try {
      const { stdout = "" } = await this.execute("gh", [
        "pr", "view",
        "--json", "number,title,url,state,isDraft,reviewDecision,statusCheckRollup,headRefName,baseRefName,mergeStateStatus,updatedAt,author",
      ], {
        cwd: repo.path,
        encoding: "utf8",
        timeout: 10_000,
        maxBuffer: 1024 * 1024,
        env: process.env,
      });
      value = { available: true, pullRequest: normalizePullRequest(JSON.parse(stdout)) };
    } catch (error) {
      const message = String(error.stderr || error.message || "");
      value = /no pull requests found|could not find pull request/i.test(message)
        ? { available: true, pullRequest: null }
        : { available: false, pullRequest: null };
    }
    this.prCache.set(id, { at: Date.now(), value });
    return value;
  }

  async git(cwd, args, options = {}) {
    if (this.gitActive >= this.gitConcurrency) await new Promise((resolve) => this.gitQueue.push(resolve));
    else this.gitActive += 1;
    try {
      const { stdout = "" } = await runGit(cwd, args, {
        encoding: "utf8",
        timeout: options.timeout || 8_000,
        maxBuffer: options.maxBuffer || 1024 * 1024,
        env: process.env,
      }, this.execute);
      return stdout;
    } finally {
      const next = this.gitQueue.shift();
      if (next) next();
      else this.gitActive -= 1;
    }
  }
}

async function mapSettledWithConcurrency(items, concurrency, operation) {
  const results = new Array(items.length);
  let next = 0;
  async function worker() {
    while (next < items.length) {
      const index = next++;
      try { results[index] = { status: "fulfilled", value: await operation(items[index], index) }; }
      catch (reason) { results[index] = { status: "rejected", reason }; }
    }
  }
  await Promise.all(Array.from({ length: Math.min(concurrency, items.length) }, () => worker()));
  return results;
}

export function parsePorcelainV2(output) {
  let branch = "HEAD";
  let ahead = 0;
  let behind = 0;
  let changedFiles = 0;
  // The commit this checkout points at. Porcelain v2 prints it for free, and a
  // commit's time is part of what its sha hashes, so it is a key that cannot go
  // stale. On an unborn branch git prints "(initial)", which is not a sha.
  let oid = null;
  for (const line of String(output).split("\n")) {
    if (line.startsWith("# branch.oid ")) {
      const value = line.slice(13).trim();
      oid = /^[0-9a-f]{40}$/.test(value) ? value : null;
    } else if (line.startsWith("# branch.head ")) branch = line.slice(14).trim();
    else if (line.startsWith("# branch.ab ")) {
      const match = line.match(/\+(\d+) -(\d+)/);
      if (match) {
        ahead = Number(match[1]);
        behind = Number(match[2]);
      }
    } else if (line && !line.startsWith("#")) changedFiles += 1;
  }
  return { branch, ahead, behind, changedFiles, oid };
}

export function normalizePullRequest(value) {
  const checks = Array.isArray(value.statusCheckRollup) ? value.statusCheckRollup : [];
  const result = { passed: 0, failed: 0, pending: 0, total: checks.length };
  for (const check of checks) {
    const conclusion = String(check.conclusion || check.state || "").toUpperCase();
    if (["SUCCESS", "NEUTRAL", "SKIPPED"].includes(conclusion)) result.passed += 1;
    else if (["FAILURE", "ERROR", "CANCELLED", "TIMED_OUT", "ACTION_REQUIRED", "STARTUP_FAILURE", "STALE"].includes(conclusion)) result.failed += 1;
    else result.pending += 1;
  }
  return {
    number: Number(value.number),
    title: String(value.title || "Untitled pull request"),
    url: String(value.url || ""),
    state: String(value.state || "OPEN"),
    isDraft: Boolean(value.isDraft),
    reviewDecision: String(value.reviewDecision || "REVIEW_REQUIRED"),
    mergeState: String(value.mergeStateStatus || "UNKNOWN"),
    headBranch: String(value.headRefName || ""),
    baseBranch: String(value.baseRefName || ""),
    updatedAt: value.updatedAt || null,
    author: value.author?.login || null,
    checks: result,
  };
}

export function repoId(path) {
  return createHash("sha256").update(path).digest("base64url").slice(0, 18);
}

export function parseNameStatus(output, area) {
  const parts = String(output).split("\0").filter(Boolean);
  const files = [];
  for (let index = 0; index < parts.length;) {
    const status = parts[index++];
    if (!status) continue;
    const firstPath = parts[index++] || "";
    const path = /^[RC]/.test(status) ? (parts[index++] || firstPath) : firstPath;
    if (path) files.push({ path, status: status[0], area });
  }
  return files;
}

export function parseGitHubRepository(output) {
  for (const line of String(output || "").split("\n")) {
    const url = line.trim().split(/\s+/).at(-1) || "";
    const match = url.match(/^(?:https?:\/\/github\.com\/|git@github\.com:|ssh:\/\/git@github\.com\/)([^/\s]+)\/([^/\s]+?)(?:\.git)?$/i);
    if (match) return `${match[1]}/${match[2]}`;
  }
  return null;
}

function mergeChangeSets(...sets) {
  const merged = new Map();
  for (const item of sets.flat()) {
    const current = merged.get(item.path);
    if (!current) merged.set(item.path, { ...item, areas: [item.area] });
    else {
      current.areas.push(item.area);
      current.area = current.areas.includes("staged") ? "staged" : current.area;
      current.status = current.status === "?" ? item.status : current.status;
    }
  }
  return [...merged.values()].sort((left, right) => left.path.localeCompare(right.path));
}

async function readScripts(path) {
  try {
    const packageJson = JSON.parse(await readFile(join(path, "package.json"), "utf8"));
    return Object.keys(packageJson.scripts || {}).filter((name) => /^[a-zA-Z0-9:_-]{1,64}$/.test(name)).slice(0, 30);
  } catch {
    return [];
  }
}

function assertInside(root, path) {
  const rel = relative(resolve(root), resolve(path));
  if (rel === ".." || rel.startsWith(`..${sep}`) || rel.split(sep).includes("..")) {
    throw new TypeError("Repository path is outside the approved roots");
  }
}

function detectImageMime(buffer) {
  if (buffer.length >= 8 && buffer.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return "image/png";
  if (buffer.length >= 3 && buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff) return "image/jpeg";
  if (buffer.length >= 6 && ["GIF87a", "GIF89a"].includes(buffer.subarray(0, 6).toString("ascii"))) return "image/gif";
  if (buffer.length >= 12 && buffer.subarray(0, 4).toString("ascii") === "RIFF" && buffer.subarray(8, 12).toString("ascii") === "WEBP") return "image/webp";
  return null;
}

function parseRoots(value) {
  if (!value) return null;
  const roots = value.split(":").map((item) => item.trim()).filter(Boolean);
  return roots.length ? roots : null;
}

export { DEFAULT_ROOTS };
