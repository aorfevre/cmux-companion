import { randomUUID } from "node:crypto";
import { dirname, join } from "node:path";
import { readdir, readFile } from "node:fs/promises";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { WorktreeInventory, git, parseWorktrees } from "./worktree-inventory.mjs";
import { cleanupHome, plainPath, readJson, withOperationLock, writeJson } from "./worktree-operations.mjs";

const DAY = 86_400_000;
const DEFAULT_POLICY = Object.freeze({ enabled: false, intervalHours: 24, graceDays: 7, pruneEnabled: false, pruneGraceDays: 30 });
export class WorktreeCleanup {
  constructor({ inventory, directory = cleanupHome(), now = () => Date.now(), log = null, onRemoved = async () => {} } = {}) {
    if (!(inventory instanceof WorktreeInventory) && !inventory?.snapshot) throw new Error("Worktree inventory required");
    this.inventory = inventory;
    this.directory = directory;
    this.now = now;
    this.log = log;
    this.onRemoved = onRemoved;
    this.timer = null;
    this.stopped = false;
  }
  async state() {
    const data = await readJson(join(this.directory, "state.json"), {});
    return { observations: {}, history: [], ...data, policy: { ...DEFAULT_POLICY, ...data.policy } };
  }
  lock(work) { return withOperationLock("cleanup-state", work, join(this.directory, "locks")); }
  save(state) { return writeJson(join(this.directory, "state.json"), state); }
  async status() {
    const state = await this.state();
    return { policy: state.policy, lastRunAt: state.lastRunAt || null, history: state.history };
  }
  async configure(patch) {
    return this.lock(async () => {
      for (const [key, value] of Object.entries(patch || {})) {
        if (["enabled", "pruneEnabled"].includes(key)) { if (typeof value !== "boolean") throw new TypeError(`${key} must be a boolean`); }
        else if (["intervalHours", "graceDays", "pruneGraceDays"].includes(key)) {
          const minimum = key === "graceDays" ? 0 : 1;
          if (!Number.isFinite(value) || value < minimum || value > 365) throw new TypeError(`${key} is outside the supported range`);
        } else throw new TypeError("Unknown cleanup setting");
      }
      const state = await this.state();
      state.policy = { ...state.policy, ...patch };
      // Previously reviewed candidates were evaluated under a different policy.
      delete state.preview;
      await this.save(state);
      return { policy: state.policy };
    });
  }
  async preview() { return this.lock(async () => this.#preview(await this.state())); }
  async #preview(state) {
    const report = await this.inventory.snapshot();
    const observations = {};
    for (const row of report.entries) {
      if (!row.eligible) continue;
      const fingerprint = `${row.head}:${row.identity}`;
      const previous = state.observations[row.id];
      const seenAt = previous?.fingerprint === fingerprint ? previous.seenAt : this.now();
      observations[row.id] = { fingerprint, seenAt };
      row.eligibleAt = new Date(seenAt + (row.completion.immediate ? 0 : state.policy.graceDays * DAY)).toISOString();
      if (this.now() < Date.parse(row.eligibleAt)) { row.eligible = false; row.reasons.push(`Grace period ends ${row.eligibleAt}`); }
      else row.reasons.push(row.completion.reason);
    }
    // Only git prune may remove administrative entries; never rm .git/worktrees.
    report.prune = [];
    const groups = Map.groupBy(report.entries, (entry) => entry.common);
    for (const [common, rows] of groups) {
      if (!rows.some((entry) => entry.classification === "missing")) continue;
      const entry = { common, repositoryPath: rows[0].repositoryPath, paths: rows.filter((row) => row.classification === "missing").map((row) => row.path), eligible: false, reason: "Stale registration cleanup is disabled" };
      try {
        if (report.errors.some((error) => error.classification === "broken")) throw new Error("Broken discovered Git references require repair before automatic pruning");
        if (rows.some((row) => row.classification === "broken")) throw new Error("Broken references need repair before pruning this repository");
        if (!report.activityAvailable) throw new Error("Session/process inventory unavailable");
        if (rows.some((row) => row.classification === "missing" && (row.locked || row.active || this.inventory.managedReleaseRoots?.some((root) => row.path.startsWith(`${root}/`))))) throw new Error("Locked or managed missing worktree is protected");
        await verifyPruneRegistrations(common, rows);
        entry.output = await pruneOutput(entry.repositoryPath, state.policy.pruneGraceDays, true);
        entry.eligible = state.policy.pruneEnabled && Boolean(entry.output.trim());
        entry.reason = entry.output.trim() ? (state.policy.pruneEnabled ? "Git reports expired stale registrations" : "Git reports expired registrations; pruning is disabled") : "No registrations have expired according to Git";
      } catch (error) { entry.reason = error.message; }
      report.prune.push(entry);
    }
    report.previewId = randomUUID();
    report.policy = state.policy;
    report.summary = {
      worktrees: report.entries.length,
      candidates: report.entries.filter((entry) => entry.eligible).length,
      protected: report.entries.filter((entry) => !entry.eligible).length,
      estimatedBytes: report.entries.filter((entry) => entry.eligible).reduce((total, entry) => total + (entry.estimatedBytes || 0), 0),
    };
    state.observations = observations;
    state.preview = report;
    await this.save(state);
    return report;
  }
  async run({ previewId, ids, prune = [], automatic = false } = {}) {
    return this.lock(async () => {
      const state = await this.state();
      if (automatic && !state.policy.enabled) return { disabled: true, results: [] };
      const report = automatic ? await this.#preview(state) : state.preview;
      if (!report || (!automatic && report.previewId !== previewId) || this.now() - Date.parse(report.generatedAt) > 30 * 60_000) throw new TypeError("Refresh the cleanup preview before running cleanup");
      const selected = automatic ? report.entries.filter((entry) => entry.eligible).map((entry) => entry.id) : ids;
      if (!Array.isArray(selected) || !Array.isArray(prune)) throw new TypeError("Select reviewed cleanup candidates");
      if (selected.some((id) => !report.entries.some((row) => row.id === id && row.eligible))) throw new TypeError("Only eligible reviewed candidates can be removed");
      const results = [];
      // Retain concise reasons for every automatic skip without stopping on failures.
      if (automatic) for (const row of report.entries.filter((entry) => !entry.eligible)) results.push({ path: row.path, outcome: "skipped", reason: row.reasons.join("; ") });
      for (const row of report.entries.filter((entry) => selected.includes(entry.id))) {
        let deleting = false;
        try {
          await withOperationLock(`repository:${row.common}`, async () => {
            const registration = parseWorktrees(await git(row.repositoryPath, ["worktree", "list", "--porcelain", "-z"])).find((entry) => entry.path === row.path);
            if (!registration) throw new Error("Worktree registration disappeared");
            const repo = { common: row.common, path: row.repositoryPath, name: row.repository };
            const fresh = await this.inventory.inspect(repo, registration, { activity: await this.inventory.activity(), markers: [], estimate: false });
            if (!fresh.eligible || fresh.head !== row.head || fresh.identity !== row.identity) throw new Error(fresh.reasons.join("; ") || "Worktree identity or HEAD changed");
            const info = await plainPath(row.path);
            if (`${info.dev}:${info.ino}` !== row.identity) throw new Error("Worktree path changed immediately before removal");
            // No --force: Git is the last independent dirty/untracked/lock guard.
            // Ignored build output is deleted by git along with the checkout.
            deleting = true;
            await git(row.repositoryPath, ["worktree", "remove", row.path]);
          });
          await Promise.resolve().then(() => this.onRemoved(row.path)).catch((err) => this.log?.warn?.({ err, path: row.path }, "worktree removed but goal metadata update failed"));
          results.push({ path: row.path, outcome: "removed", estimatedBytes: row.estimatedBytes || 0, branchPreserved: true });
        } catch (error) { results.push({ path: row.path, outcome: deleting ? "failed" : "skipped", reason: error.message }); }
        state.history = [{ at: new Date(this.now()).toISOString(), automatic, results: [...results] }, ...state.history.filter((item) => item.id !== report.previewId)].slice(0, 30);
        state.history[0].id = report.previewId;
        await this.save(state);
      }
      const pruneTargets = automatic ? report.prune.filter((entry) => entry.eligible) : report.prune.filter((entry) => prune.includes(entry.common));
      for (const entry of pruneTargets) {
        try {
          if (!state.policy.pruneEnabled || !entry.eligible) throw new Error("Pruning is disabled or unreviewed");
          await withOperationLock(`repository:${entry.common}`, async () => {
            const fresh = await this.inventory.snapshot({ estimate: false });
            const rows = fresh.entries.filter((row) => row.common === entry.common);
            if (fresh.errors.some((error) => error.classification === "broken")) throw new Error("Broken discovered Git references require repair before automatic pruning");
            if (!fresh.activityAvailable || rows.some((row) => row.classification === "broken" || (row.classification === "missing" && (row.locked || row.active || this.inventory.managedReleaseRoots?.some((root) => row.path.startsWith(`${root}/`)))))) throw new Error("Pruning guards changed");
            await verifyPruneRegistrations(entry.common, rows);
            const output = await pruneOutput(entry.repositoryPath, state.policy.pruneGraceDays, true);
            if (output !== entry.output) throw new Error("Git prune candidates changed; review again");
            await pruneOutput(entry.repositoryPath, state.policy.pruneGraceDays, false);
          });
          results.push({ path: entry.repositoryPath, outcome: "pruned", estimatedBytes: 0 });
        } catch (error) { results.push({ path: entry.repositoryPath, outcome: "failed", reason: error.message }); }
      }
      const outcome = { id: report.previewId, at: new Date(this.now()).toISOString(), automatic, results, estimatedReclaimedBytes: results.filter((entry) => entry.outcome === "removed").reduce((sum, entry) => sum + entry.estimatedBytes, 0) };
      state.history = [outcome, ...state.history.filter((item) => item.id !== report.previewId)].slice(0, 30);
      state.lastRunAt = outcome.at;
      delete state.preview;
      await this.save(state);
      return outcome;
    });
  }
  schedule() {
    if (this.requested) return;
    this.requested = setTimeout(() => {
      this.requested = null;
      this.run({ automatic: true }).catch((err) => this.log?.warn?.({ err }, "goal worktree cleanup failed"));
    }, 1_000);
    this.requested.unref?.();
  }
  start() {
    this.stopped = false;
    const tick = async () => {
      try {
        const state = await this.state();
        if (state.policy.enabled && (!state.lastRunAt || this.now() - Date.parse(state.lastRunAt) >= state.policy.intervalHours * 3_600_000)) await this.run({ automatic: true });
      } catch (err) { this.log?.warn?.({ err }, "worktree cleanup failed"); }
      if (!this.stopped) { this.timer = setTimeout(tick, 60_000); this.timer.unref?.(); }
    };
    this.timer = setTimeout(tick, 60_000);
    this.timer.unref?.();
    return () => { this.stopped = true; clearTimeout(this.timer); clearTimeout(this.requested); };
  }
}
async function pruneOutput(path, days, dryRun) {
  const result = await promisify(execFile)("git", ["-C", path, "worktree", "prune", "--verbose", "--expire", `${days}.days.ago`, ...(dryRun ? ["--dry-run"] : [])], { timeout: 30_000 });
  return result.stdout + result.stderr;
}

async function verifyPruneRegistrations(common, rows) {
  const root = join(common, "worktrees");
  await plainPath(root);
  for (const name of await readdir(root)) {
    const metadata = join(root, name, "gitdir");
    await plainPath(metadata);
    const gitdir = (await readFile(metadata, "utf8")).trim();
    if (!gitdir.endsWith("/.git") || !rows.some((row) => row.path === dirname(gitdir))) throw new Error("Unrecognized worktree registration requires repair before pruning");
  }
}
