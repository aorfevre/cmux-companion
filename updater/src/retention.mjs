import { lstat, open, readdir, readlink, realpath } from "node:fs/promises";
import { basename, join, resolve, sep } from "node:path";
import { randomUUID } from "node:crypto";
import { readJson, writeJson } from "./fs-safe.mjs";
import { run } from "./process.mjs";
import { acquireLock } from "./lock.mjs";
import { validateManifest } from "./manifest.mjs";
import { lockWorktree, removeWorktree } from "./git.mjs";

export const RETENTION_DEFAULTS = Object.freeze({ enabled: false, intervalHours: 24 });
const SHA = /^[a-f0-9]{40}$/;
const REASON = "cmux-companion managed deployment";
const artifacts = new Set(["release-manifest.json", "transaction.json", "bootstrap.next"]);
const buildOutput = new Set(["node_modules", "dist", "build", ".next", "coverage", ".turbo"]);
const file = (paths) => join(paths.stateRoot, "retention.json");
async function stateFor(paths) {
  const state = await readJson(file(paths), {});
  return { releases: {}, history: [], ...state, policy: { ...RETENTION_DEFAULTS, ...state.policy } };
}
const keyFor = (target, sha) => `${target.name}:${sha}`;
export async function recordRelease(paths, target, sha, outcome) {
  const state = await stateFor(paths);
  const key = keyFor(target, sha);
  const previous = state.releases[key] || {};
  if (outcome === "failed" && !previous.path) return;
  state.releases[key] = { ...previous, target: target.name, sha, path: join(target.releaseRoot, "releases", sha), outcome, at: new Date().toISOString() };
  await writeJson(file(paths), state);
}
async function plain(path) {
  const absolute = resolve(path);
  let cursor = sep;
  for (const part of absolute.split(sep).filter(Boolean)) {
    cursor = join(cursor, part);
    if ((await lstat(cursor)).isSymbolicLink()) throw new Error("Release cleanup refuses symlink traversal");
  }
  return lstat(path);
}
async function git(target, args, options = {}) {
  return run("/usr/bin/git", ["-C", target.repositoryPath, ...args], { timeoutMs: 30_000, ...options });
}
function registrations(output) {
  return output.split("\0\0").filter(Boolean).map((block, index) => {
    const fields = block.split("\0");
    const get = (name) => fields.find((field) => field === name || field.startsWith(`${name} `))?.slice(name.length).trimStart();
    return { path: get("worktree"), sha: get("HEAD"), locked: get("locked"), detached: get("detached") !== undefined, primary: index === 0 };
  });
}
async function link(target, name) {
  try {
    const path = join(target.releaseRoot, name);
    if (!(await lstat(path)).isSymbolicLink()) throw new Error(`${name} is not a release symlink`);
    const destination = resolve(target.releaseRoot, await readlink(path));
    if (destination !== join(target.releaseRoot, "releases", basename(destination)) || !SHA.test(basename(destination))) throw new Error(`Invalid ${name} release link`);
    await plain(destination);
    return basename(destination);
  } catch (error) { if (error.code === "ENOENT" && name === "previous") return null; throw error; }
}
export function retainedReleases(records, { current, previous, pending, running }) {
  const keep = new Map();
  for (const [sha, reason] of [[current, "Current release"], [previous, "Rollback target"], [pending, "Pending deployment"], [running, "Running updater engine"]]) if (sha) keep.set(sha, reason);
  const sorted = [...records].sort((a, b) => Date.parse(b.at) - Date.parse(a.at));
  for (const entry of sorted.filter((item) => item.outcome === "success" && !keep.has(item.sha)).slice(0, 2)) keep.set(entry.sha, "Two previous successful releases retained");
  const failed = sorted.find((item) => item.outcome === "failed");
  if (failed) keep.set(failed.sha, "Latest failed candidate retained");
  return keep;
}
async function activityPaths() {
  try {
    const result = await run("/usr/sbin/lsof", ["-n", "-a", "-u", String(process.getuid()), "-d", "cwd,txt", "-F", "pn"], { timeoutMs: 15_000 });
    if (result.stderr.trim()) throw new Error("Incomplete process inventory");
    return { available: true, paths: result.stdout.split("\n").filter((line) => line.startsWith("n")).map((line) => line.slice(1)) };
  } catch { return { available: false, paths: [] }; }
}
async function inspect(target, row, record, keep, activity) {
  const entry = { target: target.name, sha: row.sha, path: row.path, eligible: false, reasons: [], estimatedBytes: null };
  try {
    await plain(target.releaseRoot);
    const info = await plain(row.path);
    entry.identity = `${info.dev}:${info.ino}`;
    if (!info.isDirectory() || row.primary || !row.detached || !SHA.test(row.sha) || row.path !== join(target.releaseRoot, "releases", row.sha)) throw new Error("Not a detached updater release with an exact SHA directory");
    await plain(join(row.path, ".git"));
    const common = (await git(target, ["rev-parse", "--path-format=absolute", "--git-common-dir"])).stdout.trim();
    const actualCommon = (await run("/usr/bin/git", ["-C", row.path, "rev-parse", "--path-format=absolute", "--git-common-dir"])).stdout.trim();
    if (await realpath(common) !== await realpath(actualCommon)) throw new Error("Release belongs to a different repository");
    const head = (await run("/usr/bin/git", ["-C", row.path, "rev-parse", "HEAD"])).stdout.trim();
    if (head !== row.sha) throw new Error("Release HEAD changed");
    if (row.locked !== undefined && row.locked !== REASON) throw new Error("Worktree has a foreign lock");
    // Legacy manifests establish ownership, but not whether activation succeeded.
    // Unknown outcomes stay protected instead of inventing successful history.
    if (!record || record.path !== row.path || !["success", "failed"].includes(record.outcome)) throw new Error("No verified deployment outcome; preserve legacy or unfinished release");
    if (record.outcome === "success") await validateManifest(target, row.path, row.sha);
    if (keep.has(row.sha)) entry.reasons.push(keep.get(row.sha));
    if (!activity.available) entry.reasons.push("Process inventory unavailable");
    else if (activity.paths.some((path) => path === row.path || path.startsWith(`${row.path}/`))) entry.reasons.push("A process is using this release");
    const status = (await run("/usr/bin/git", ["-C", row.path, "status", "--porcelain=v1", "-z", "--untracked-files=all", "--ignore-submodules=none"])).stdout.split("\0").filter(Boolean);
    if (status.some((line) => !line.startsWith("?? ") || !artifacts.has(line.slice(3)))) entry.reasons.push("Tracked changes or unknown untracked files");
    const files = (await run("/usr/bin/git", ["-C", row.path, "ls-files", "--stage", "-z"])).stdout;
    if (files.split("\0").some((line) => line.startsWith("160000 "))) entry.reasons.push("Submodules require manual cleanup");
    const ignored = (await run("/usr/bin/git", ["-C", row.path, "ls-files", "--others", "--ignored", "--exclude-standard", "--directory", "-z"])).stdout.split("\0").filter(Boolean);
    if (ignored.includes(".wrangler/")) {
      const generated = (await run("/usr/bin/git", ["-C", row.path, "ls-files", "--others", "--ignored", "--exclude-standard", "-z", "--", ".wrangler"])).stdout.split("\0").filter(Boolean);
      if (generated.every((path) => path === ".wrangler/deploy/config.json" || path === ".wrangler/wrangler.log" || path.startsWith(".wrangler/logs/"))) ignored.splice(ignored.indexOf(".wrangler/"), 1);
    }
    if (ignored.some((path) => !buildOutput.has(path.split("/")[0]))) entry.reasons.push("Ignored files outside known build output");
    if (!entry.reasons.length && await hasNestedRepository(row.path)) entry.reasons.push("Nested repository inside release output");
    entry.eligible = !entry.reasons.length;
    if (entry.eligible) {
      entry.reasons.push("Verified updater-owned release exceeds retention");
      try { entry.estimatedBytes = Number((await run("du", ["-sk", row.path], { timeoutMs: 10_000 })).stdout.split(/\s+/)[0]) * 1024; } catch { /* Best effort size. */ }
    }
  } catch (error) { entry.reasons.push(error.message); }
  return entry;
}
// Adopt historical outcomes only when a structured updater event and the
// release manifest agree. A manifest alone proves a build, not activation.
async function historicalEvidence(paths, config, state) {
  if (!paths.logs) return;
  let events = [];
  try {
    const path = join(paths.logs, "cmux-companion-updater.log");
    await plain(path);
    const handle = await open(path, "r");
    try {
      const size = (await handle.stat()).size;
      const buffer = Buffer.alloc(Math.min(size, 16 * 1024 * 1024));
      await handle.read(buffer, 0, buffer.length, Math.max(0, size - buffer.length));
      events = buffer.toString().split("\n").flatMap((line) => { try { return [JSON.parse(line)]; } catch { return []; } });
    } finally { await handle.close(); }
  } catch { return; }
  for (const event of events) {
    if (!["success", "failed"].includes(event.result) || !SHA.test(event.candidateSha) || !Number.isFinite(Date.parse(event.timestamp))) continue;
    if (event.result === "success" && !["activating", "health-checking"].includes(event.phase)) continue;
    const target = config.targets.find((item) => item.name === event.target);
    if (!target) continue;
    const key = keyFor(target, event.candidateSha);
    if (state.releases[key] && (!state.releases[key].evidence || Date.parse(state.releases[key].at) >= Date.parse(event.timestamp))) continue;
    const path = join(target.releaseRoot, "releases", event.candidateSha);
    try {
      await plain(path);
      await validateManifest(target, path, event.candidateSha);
      state.releases[key] = { target: target.name, sha: event.candidateSha, path, outcome: event.result, at: event.timestamp, evidence: "Structured updater event and verified release manifest" };
    } catch { /* Unverifiable legacy releases remain protected. */ }
  }
}
async function inventory(paths, config, state, activity) {
  const entries = [];
  const errors = [];
  const transaction = await readJson(paths.transaction);
  for (const target of config.targets) {
    try {
      await plain(target.releaseRoot);
      const current = await link(target, "current");
      const previous = await link(target, "previous");
      const records = Object.values(state.releases).filter((record) => record.target === target.name);
      const running = process.argv[1]?.startsWith(join(target.releaseRoot, "releases") + sep) ? process.argv[1].split(sep).find((part) => SHA.test(part)) : null;
      const keep = retainedReleases(records, { current, previous, running, pending: transaction?.target === target.name ? transaction.candidateSha : null });
      const rows = registrations((await git(target, ["worktree", "list", "--porcelain", "-z"])).stdout).filter((row) => row.path?.startsWith(join(target.releaseRoot, "releases") + sep));
      for (const row of rows) entries.push(await inspect(target, row, state.releases[keyFor(target, row.sha)], keep, activity));
      const registered = new Set(rows.map((row) => row.path));
      for (const dir of await readdir(join(target.releaseRoot, "releases"))) {
        const path = join(target.releaseRoot, "releases", dir);
        if (!registered.has(path)) entries.push({ target: target.name, path, sha: dir, eligible: false, reasons: ["Unregistered path; never recursively removed"], estimatedBytes: null });
      }
    } catch (error) { errors.push({ target: target.name, error: error.message }); }
  }
  return { previewId: randomUUID(), generatedAt: new Date().toISOString(), policy: state.policy, entries, errors };
}
// The updater bootstrap already holds paths.lock for the engine. CLI callers
// take that same lock, so activation and retention can never overlap.
export async function retention(paths, config, { command = "preview", patch, previewId, ids, locked = false, activity = activityPaths } = {}) {
  let release;
  if (!locked) {
    release = await acquireLock(paths.lock);
    if (!release) throw new Error("Updater transaction is running; retry retention later");
  }
  try {
    const state = await stateFor(paths);
    if (command === "status") return { policy: state.policy, history: state.history, lastRunAt: state.lastRunAt || null };
    if (command === "configure") {
      if (Object.keys(patch || {}).some((key) => !["enabled", "intervalHours"].includes(key))) throw new Error("Unknown retention setting");
      if (patch.enabled !== undefined && typeof patch.enabled !== "boolean") throw new Error("enabled must be boolean");
      if (patch.intervalHours !== undefined && (!Number.isFinite(patch.intervalHours) || patch.intervalHours < 1 || patch.intervalHours > 365)) throw new Error("intervalHours must be between 1 and 365");
      state.policy = { ...state.policy, ...patch };
      delete state.preview;
      await writeJson(file(paths), state);
      return { policy: state.policy };
    }
    if (command === "scheduled" && (!state.policy.enabled || (state.lastRunAt && Date.now() - Date.parse(state.lastRunAt) < state.policy.intervalHours * 3_600_000))) return { disabledOrNotDue: true };
    if (command === "preview" || command === "scheduled") {
      await historicalEvidence(paths, config, state);
      state.preview = await inventory(paths, config, state, await activity());
      await writeJson(file(paths), state);
      if (command === "preview") return state.preview;
    }
    const preview = state.preview;
    if (!preview || (command !== "scheduled" && preview.previewId !== previewId) || Date.now() - Date.parse(preview.generatedAt) > 30 * 60_000) throw new Error("Review a fresh retention preview first");
    const selected = command === "scheduled" ? preview.entries.filter((entry) => entry.eligible).map((entry) => entry.path) : ids;
    if (!Array.isArray(selected) || selected.some((path) => !preview.entries.some((entry) => entry.path === path && entry.eligible))) throw new Error("Select only reviewed eligible releases");
    const results = command === "scheduled" ? preview.entries.filter((entry) => !entry.eligible).map((entry) => ({ path: entry.path, outcome: "skipped", reason: entry.reasons.join("; ") })) : [];
    for (const entry of preview.entries.filter((item) => selected.includes(item.path))) {
      const target = config.targets.find((item) => item.name === entry.target);
      let unlocked = false;
      try {
        // Refresh the retention set and this candidate, without rescanning
        // every other release's dependency tree for each deletion.
        const latest = await stateFor(paths);
        const current = await link(target, "current");
        const previous = await link(target, "previous");
        const transaction = await readJson(paths.transaction);
        const records = Object.values(latest.releases).filter((record) => record.target === target.name);
        const running = process.argv[1]?.startsWith(join(target.releaseRoot, "releases") + sep) ? process.argv[1].split(sep).find((part) => SHA.test(part)) : null;
        const keep = retainedReleases(records, { current, previous, running, pending: transaction?.target === target.name ? transaction.candidateSha : null });
        const registered = registrations((await git(target, ["worktree", "list", "--porcelain", "-z"])).stdout).find((item) => item.path === entry.path);
        const checked = registered ? await inspect(target, registered, latest.releases[keyFor(target, entry.sha)], keep, await activity()) : null;
        if (!checked?.eligible || checked.identity !== entry.identity) throw new Error(checked?.reasons.join("; ") || "Release identity changed");
        const info = await plain(entry.path);
        if (`${info.dev}:${info.ino}` !== entry.identity) throw new Error("Release path changed");
        const row = registrations((await git(target, ["worktree", "list", "--porcelain", "-z"])).stdout).find((item) => item.path === entry.path);
        if (row?.locked !== undefined) {
          if (row.locked !== REASON) throw new Error("Foreign lock appeared");
          await git(target, ["worktree", "unlock", entry.path]);
          unlocked = true;
        }
        await removeWorktree(target, entry.path, { force: true });
        results.push({ path: entry.path, outcome: "removed", estimatedBytes: entry.estimatedBytes || 0 });
        delete state.releases[keyFor(target, entry.sha)];
      } catch (error) {
        if (unlocked) await lockWorktree(target, entry.path).catch(() => {});
        results.push({ path: entry.path, outcome: "failed", reason: error.message });
      }
      // Persist each outcome before continuing, so a later failure loses no history.
      state.history = [{ id: preview.previewId, at: new Date().toISOString(), results: [...results] }, ...state.history.filter((item) => item.id !== preview.previewId)].slice(0, 30);
      await writeJson(file(paths), state);
    }
    const outcome = { id: preview.previewId, at: new Date().toISOString(), results, estimatedReclaimedBytes: results.filter((entry) => entry.outcome === "removed").reduce((sum, entry) => sum + entry.estimatedBytes, 0) };
    state.lastRunAt = outcome.at;
    state.history = [outcome, ...state.history.filter((item) => item.id !== preview.previewId)].slice(0, 30);
    delete state.preview;
    await writeJson(file(paths), state);
    return outcome;
  } finally { await release?.(); }
}

async function hasNestedRepository(root) {
  const queue = [root];
  let visited = 0;
  while (queue.length) {
    if (++visited > 200_000) throw new Error("Nested repository inspection incomplete");
    const path = queue.pop();
    for (const entry of await readdir(path, { withFileTypes: true })) {
      if (entry.name === ".git") { if (path !== root) return true; continue; }
      if (entry.isDirectory()) queue.push(join(path, entry.name));
    }
  }
  return false;
}
