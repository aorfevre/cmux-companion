import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { lstat, readFile, readdir, realpath } from "node:fs/promises";
import { basename, join, relative, resolve, sep } from "node:path";
import { promisify } from "node:util";

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
  } = {}) {
    this.roots = roots.map((root) => resolve(root));
    this.execute = execute;
    this.cacheMs = cacheMs;
    this.cache = null;
  }

  async list({ refresh = false } = {}) {
    if (!refresh && this.cache && Date.now() - this.cache.at < this.cacheMs) {
      return this.cache.repos;
    }

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

    const settled = await Promise.allSettled(candidates.map((candidate) => this.inspect(candidate)));
    const repos = settled
      .filter((result) => result.status === "fulfilled" && result.value)
      .map((result) => result.value)
      .sort((left, right) => {
        if (right.lastActivity !== left.lastActivity) return right.lastActivity - left.lastActivity;
        return left.name.localeCompare(right.name);
      });
    this.cache = { at: Date.now(), repos };
    return repos;
  }

  async inspect({ root, path }) {
    const canonicalRoot = await realpath(root);
    const canonicalPath = await realpath(path);
    assertInside(canonicalRoot, canonicalPath);

    let topLevel;
    try {
      topLevel = (await this.git(canonicalPath, ["rev-parse", "--show-toplevel"])).trim();
    } catch {
      return null;
    }
    const canonicalTop = await realpath(topLevel);
    if (canonicalTop !== canonicalPath) return null;

    const [statusResult, lastActivityResult, scripts] = await Promise.all([
      this.git(canonicalPath, ["status", "--porcelain=v2", "--branch"]).catch(() => ""),
      this.git(canonicalPath, ["log", "-1", "--format=%ct"]).catch(() => "0"),
      readScripts(canonicalPath),
    ]);
    const status = parsePorcelainV2(statusResult);
    return {
      id: repoId(canonicalPath),
      name: basename(canonicalPath),
      root: basename(canonicalRoot),
      rootPath: canonicalRoot,
      path: canonicalPath,
      relativePath: relative(canonicalRoot, canonicalPath),
      branch: status.branch,
      ahead: status.ahead,
      behind: status.behind,
      changedFiles: status.changedFiles,
      dirty: status.changedFiles > 0,
      lastActivity: Number(lastActivityResult.trim()) || 0,
      scripts,
    };
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

  async git(cwd, args, options = {}) {
    const { stdout = "" } = await this.execute("git", ["-C", cwd, ...args], {
      encoding: "utf8",
      timeout: 8_000,
      maxBuffer: options.maxBuffer || 1024 * 1024,
      env: process.env,
    });
    return stdout;
  }
}

export function parsePorcelainV2(output) {
  let branch = "HEAD";
  let ahead = 0;
  let behind = 0;
  let changedFiles = 0;
  for (const line of String(output).split("\n")) {
    if (line.startsWith("# branch.head ")) branch = line.slice(14).trim();
    else if (line.startsWith("# branch.ab ")) {
      const match = line.match(/\+(\d+) -(\d+)/);
      if (match) {
        ahead = Number(match[1]);
        behind = Number(match[2]);
      }
    } else if (line && !line.startsWith("#")) changedFiles += 1;
  }
  return { branch, ahead, behind, changedFiles };
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

function parseRoots(value) {
  if (!value) return null;
  const roots = value.split(":").map((item) => item.trim()).filter(Boolean);
  return roots.length ? roots : null;
}

export { DEFAULT_ROOTS };
