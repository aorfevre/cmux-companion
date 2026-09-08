import { randomUUID } from "node:crypto";
import { agentCapacity } from "./agent-capacity.mjs";
import { assignAgents } from "./worktree-planner.mjs";
import { REPOSITORY_ID } from "./burst-contract.mjs";

export const BURST_NO_FAVORITES = "No starred repositories. Star a repository first; Burst scans starred repositories only.";
export const BURST_RESTARTED = "The companion restarted during the scan. Rescan to try again";
const UNSTARRED = "This repository is no longer starred";

// Owns one burst at a time. Scans run after the request returns; `settled`
// exists so a test, or a route that wants to wait, can join the running scan.
export class BurstService {
  constructor({ store, worktrees, scanner, goalSessions, accountUsage = null, concurrency = 3, log = null } = {}) {
    if (!store || !worktrees || !scanner || !goalSessions) throw new TypeError("Burst needs a store, worktrees, a scanner and goal sessions");
    this.store = store;
    this.worktrees = worktrees;
    this.scanner = scanner;
    this.goalSessions = goalSessions;
    this.accountUsage = accountUsage;
    this.concurrency = Math.max(1, Number(concurrency) || 3);
    this.log = log;
    // burstId -> Promise. One entry per burst whose scan is in flight.
    this.pending = new Map();
    // The create in flight, if any. A second caller joins it instead of
    // inserting a second burst between the "running" check and the insert.
    this.creating = null;
    // "burstId/repositoryId" -> Promise. Two approves of one candidate must
    // start one goal session, not two.
    this.approving = new Map();
    this.recover();
  }

  // A scanning row that no scan is working on was interrupted by a restart.
  // Left alone it would block every future create, so it fails with a reason.
  recover() {
    for (const { burstId, repositoryId } of this.store.strandedScanning()) {
      if (this.pending.has(burstId)) continue;
      try { this.store.recordFailure(burstId, repositoryId, BURST_RESTARTED); } catch { /* settled meanwhile */ }
    }
  }

  create() {
    if (this.creating) return this.creating;
    this.creating = this.#create().finally(() => { this.creating = null; });
    return this.creating;
  }

  async #create() {
    this.recover();
    const running = this.#running();
    if (running) return running;
    const repositories = await this.#favorites();
    if (!repositories.length) return { status: "no_starred_repositories", message: BURST_NO_FAVORITES, burstId: null };
    const usage = await this.#usage();
    const late = this.#running();
    if (late) return late;
    const burst = this.store.create({ burstId: `burst-${randomUUID()}`, capacitySnapshot: usage ? agentCapacity(usage) : null, repositories });
    this.#scan(burst.burstId, burst.candidates.map((c) => c.repositoryId), usage);
    return burst;
  }

  get(burstId) { return this.store.get(burstId); }

  list() { return this.store.list(); }

  approve(burstId, repositoryId, options = {}) {
    const key = `${burstId}/${repositoryId}`;
    const inFlight = this.approving.get(key);
    if (inFlight) return inFlight;
    const run = this.#approve(burstId, repositoryId, options).finally(() => { this.approving.delete(key); });
    this.approving.set(key, run);
    return run;
  }

  async #approve(burstId, repositoryId, { goal = undefined } = {}) {
    const burst = this.#require(burstId);
    const candidate = burst.candidates.find((c) => c.repositoryId === repositoryId);
    if (!candidate) throw new TypeError("Unknown burst candidate");
    // Idempotent: the plan already exists, so hand it back rather than start a second session.
    if (candidate.status === "approved") return candidate;
    if (candidate.status !== "proposed") throw new TypeError("Only a proposed candidate can be approved");
    const text = String(goal ?? candidate.goal ?? "").trim();
    if (!text) throw new TypeError("An approved candidate needs a goal");
    const plan = await this.goalSessions.start({ repositoryId, goal: text, burst: true });
    try {
      return this.store.recordApproval(burstId, repositoryId, { planId: plan.planId, goal: text });
    } catch (cause) {
      // The session exists; only the bookkeeping failed. Say so rather than hide it.
      this.log?.warn?.({ err: cause, burstId, repositoryId, planId: plan.planId }, "burst approval started a goal session but could not be recorded");
      throw cause;
    }
  }

  decline(burstId, repositoryId) {
    this.#require(burstId);
    return this.store.recordDecline(burstId, repositoryId);
  }

  rescan(burstId, repositoryId) {
    this.#require(burstId);
    const candidate = this.store.resetForScan(burstId, repositoryId);
    this.#scan(burstId, [repositoryId]);
    return candidate;
  }

  settled(burstId) { return this.pending.get(String(burstId)) || Promise.resolve(); }

  #running() {
    const [burstId] = this.store.running();
    return burstId ? this.store.get(burstId) : null;
  }

  #require(burstId) {
    const burst = this.store.get(burstId);
    if (!burst) throw new TypeError("Unknown burst");
    return burst;
  }

  // Bounded parallel scan. The chain joins any scan already in flight for this
  // burst so a rescan never runs beside the original scan of the same row.
  // Whatever throws inside, every row this call owns leaves `scanning`.
  #scan(burstId, repositoryIds, usage = null) {
    const previous = this.pending.get(burstId) || Promise.resolve();
    const run = previous.then(async () => {
      const [repositories, snapshot] = await Promise.all([this.#favorites(), usage ?? this.#usage()]);
      const targets = repositoryIds.map((id) => repositories.find((r) => r.id === id)).filter(Boolean);
      // A repository that left the starred set mid-scan still has a scanning row.
      for (const id of repositoryIds.filter((id) => !targets.some((t) => t.id === id))) this.#fail(burstId, id, UNSTARRED);
      // One assignment for the batch, so a roomy pair of providers shares the
      // scans instead of every row landing on the same one.
      let assigned;
      try { assigned = assignAgents(targets, snapshot); }
      catch (cause) { for (const target of targets) this.#fail(burstId, target.id, cause.message); return; }
      let next = 0;
      const worker = async () => {
        for (let index = next++; index < assigned.length; index = next++) await this.#scanOne(burstId, assigned[index]);
      };
      await Promise.all(Array.from({ length: Math.min(this.concurrency, assigned.length) }, worker));
    }).catch((cause) => {
      this.log?.warn?.({ err: cause, burstId }, "burst scan failed");
      for (const id of repositoryIds) this.#fail(burstId, id, cause?.message || "The scan failed");
    });
    this.pending.set(burstId, run);
    run.finally(() => { if (this.pending.get(burstId) === run) this.pending.delete(burstId); });
  }

  async #scanOne(burstId, repository) {
    try {
      const proposal = await this.scanner.scan({ repository: { id: repository.id, name: repository.name, path: repository.path }, provider: repository.agent });
      this.store.recordProposal(burstId, repository.id, proposal);
    } catch (cause) {
      this.#fail(burstId, repository.id, cause?.message || "The scan failed");
    }
  }

  // A row that already left `scanning` keeps its state; failing it again is not an error.
  #fail(burstId, repositoryId, reason) {
    try { this.store.recordFailure(burstId, repositoryId, reason); }
    catch (cause) { this.log?.debug?.({ err: cause, burstId, repositoryId }, "burst failure not recorded: the candidate already settled"); }
  }

  async #usage() {
    try { return await this.accountUsage?.snapshot?.({ refresh: true }) || null; }
    catch (cause) { this.log?.warn?.({ err: cause }, "burst usage snapshot failed"); return null; }
  }

  // The same starred set GitHubIssueSync reads.
  async #favorites() {
    const dashboard = await this.worktrees.snapshot({ refresh: true });
    return (Array.isArray(dashboard?.repositories) ? dashboard.repositories : [])
      .filter((r) => r?.favorite === true && r?.archived !== true && REPOSITORY_ID.test(String(r.id || "")) && typeof r.path === "string" && r.path)
      .map((r) => ({ id: r.id, name: String(r.name || r.id).slice(0, 200), path: r.path }));
  }
}
