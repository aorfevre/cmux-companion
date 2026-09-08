import { randomUUID } from "node:crypto";
import { agentCapacity } from "./agent-capacity.mjs";
import { assignAgents } from "./worktree-planner.mjs";

export const BURST_NO_FAVORITES = "No starred repositories. Star a repository first; Burst scans starred repositories only.";
const REPOSITORY_ID = /^[A-Za-z0-9_-]{18}$/;

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
  }

  async create() {
    const running = this.list().find((burst) => burst.status === "scanning");
    if (running) return running;
    const repositories = await this.#favorites();
    if (!repositories.length) return { status: "no_starred_repositories", message: BURST_NO_FAVORITES, burstId: null };
    const usage = await this.#usage();
    const burst = this.store.create({ burstId: `burst-${randomUUID()}`, capacitySnapshot: usage ? agentCapacity(usage) : null, repositories });
    this.#scan(burst.burstId, burst.candidates.map((c) => c.repositoryId), usage);
    return burst;
  }

  get(burstId) { return this.store.get(burstId); }

  list() { return this.store.list(); }

  async approve(burstId, repositoryId, { goal = undefined } = {}) {
    const burst = this.#require(burstId);
    const candidate = burst.candidates.find((c) => c.repositoryId === repositoryId);
    if (!candidate) throw new TypeError("Unknown burst candidate");
    // Idempotent: the plan already exists, so hand it back rather than start a second session.
    if (candidate.status === "approved") return candidate;
    if (candidate.status !== "proposed") throw new TypeError("Only a proposed candidate can be approved");
    const text = String(goal ?? candidate.goal ?? "").trim();
    if (!text) throw new TypeError("An approved candidate needs a goal");
    const plan = await this.goalSessions.start({ repositoryId, goal: text, burst: true });
    return this.store.recordApproval(burstId, repositoryId, { planId: plan.planId, goal: text });
  }

  decline(burstId, repositoryId) {
    this.#require(burstId);
    return this.store.recordDecline(burstId, repositoryId);
  }

  async rescan(burstId, repositoryId) {
    this.#require(burstId);
    const candidate = this.store.resetForScan(burstId, repositoryId);
    this.#scan(burstId, [repositoryId], await this.#usage());
    return candidate;
  }

  settled(burstId) { return this.pending.get(String(burstId)) || Promise.resolve(); }

  #require(burstId) {
    const burst = this.store.get(burstId);
    if (!burst) throw new TypeError("Unknown burst");
    return burst;
  }

  // Bounded parallel scan. The chain joins any scan already in flight for this
  // burst so a rescan never runs beside the original scan of the same row.
  #scan(burstId, repositoryIds, usage) {
    const previous = this.pending.get(burstId) || Promise.resolve();
    const run = previous.then(async () => {
      const repositories = await this.#favorites();
      const targets = repositoryIds.map((id) => repositories.find((r) => r.id === id)).filter(Boolean);
      let next = 0;
      const worker = async () => {
        for (let index = next++; index < targets.length; index = next++) await this.#scanOne(burstId, targets[index], usage);
      };
      await Promise.all(Array.from({ length: Math.min(this.concurrency, targets.length) }, worker));
      // A repository that left the starred set mid-scan still has a scanning row.
      for (const id of repositoryIds.filter((id) => !targets.some((t) => t.id === id))) {
        try { this.store.recordFailure(burstId, id, "This repository is no longer starred"); } catch { /* already settled */ }
      }
    }).catch((cause) => this.log?.warn?.({ err: cause, burstId }, "burst scan failed"));
    this.pending.set(burstId, run);
    run.finally(() => { if (this.pending.get(burstId) === run) this.pending.delete(burstId); });
  }

  async #scanOne(burstId, repository, usage) {
    let provider = "claude";
    try { provider = assignAgents([{ id: repository.id }], usage)[0].agent; }
    catch (cause) { this.store.recordFailure(burstId, repository.id, cause.message); return; }
    try {
      const proposal = await this.scanner.scan({ repository, provider });
      this.store.recordProposal(burstId, repository.id, proposal);
    } catch (cause) {
      try { this.store.recordFailure(burstId, repository.id, cause?.message || "The scan failed"); }
      catch (recordError) { this.log?.warn?.({ err: recordError, burstId, repositoryId: repository.id }, "burst failure could not be recorded"); }
    }
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
