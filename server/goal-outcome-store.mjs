import { createHash } from "node:crypto";
import { parseReviewFindings, reviewDecisionFeedback } from "./review-findings.mjs";

export const MAX_REPORT_BYTES = 96 * 1024;
export const MAX_REVIEW_BYTES = 64 * 1024;
const NEXT_STEPS = "\n\n## Next steps\n\n- Challenge the analysis — request an independent critique in Companion.\n- Launch coding goal — start linked discovery; implementation requires fresh approval.\n";

export function linkedCodingId(planId, version) {
  const hash = createHash("sha256").update(`analysis-coding:${planId}:${version}`).digest("hex");
  return `${hash.slice(0, 8)}-${hash.slice(8, 12)}-${hash.slice(12, 16)}-${hash.slice(16, 20)}-${hash.slice(20, 32)}`;
}

// Shares the plan store's connection, so proposal/review and report/state writes
// participate in the same transaction. Large artifacts stay out of list payloads.
export class GoalOutcomeStore {
  constructor(store) { this.store = store; this.db = store.db; }
  stamp() { return this.store.now().toISOString(); }

  reports(planId) {
    return this.db.prepare("SELECT * FROM goal_reports WHERE plan_id = ? ORDER BY version DESC").all(planId).map(reportRow);
  }
  report(planId, version) {
    if (!Number.isInteger(version) || version < 1) throw new TypeError("Select an analysis report version");
    const row = this.db.prepare("SELECT * FROM goal_reports WHERE plan_id = ? AND version = ?").get(planId, version);
    if (!row) throw new TypeError("This analysis report is unavailable");
    return reportRow(row);
  }
  publishReport(planId, { generation, sessionId, revision, expectedVersion, title, markdown } = {}) {
    if (!Number.isInteger(expectedVersion) || expectedVersion < 0 || !Number.isInteger(revision)) throw new TypeError("Invalid analysis revision");
    if (typeof title !== "string" || !title.trim() || title.length > 200 || typeof markdown !== "string" || !markdown.trim() || Buffer.byteLength(markdown) > MAX_REPORT_BYTES) throw new TypeError("Provide a title and a Markdown report of at most 96 KiB");
    for (const section of ["Evidence", "Assumptions", "Limitations", "Recommendations"]) {
      const body = markdown.match(new RegExp(`^## ${section}[^\\S\\n]*\\r?\\n([\\s\\S]*?)(?=^#{1,2} |$(?![\\s\\S]))`, "im"))?.[1];
      if (!body?.trim() || !body.split("\n").some((line) => line.trim() && !/^\s*#/.test(line))) throw new TypeError(`Analysis needs a populated ## ${section} section`);
    }
    const content = markdown.trim() + NEXT_STEPS;
    if (Buffer.byteLength(content) > MAX_REPORT_BYTES) throw new TypeError("Analysis including next steps must be at most 96 KiB");
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const plan = this.store.get(planId);
      if (!plan || plan.goalType !== "analysis" || plan.workflow !== "goal_session" || plan.boardStatus || plan.goalSessionGeneration !== generation || plan.goalSessionProviderSessionId !== sessionId || plan.approvalRevision !== revision || plan.proposalRevision !== revision || !plan.approvalAt || plan.goalSessionError || !["analyzing", "analysis_ready"].includes(plan.goalSessionState)) throw new TypeError("Analysis publication requires the current approved scope and conversation");
      const latest = plan.analysisReports[0];
      // An identical lost-response retry returns its immutable version.
      if (latest?.version === expectedVersion + 1 && latest.approvalRevision === revision && latest.title === title.trim() && latest.markdown === content) {
        this.db.exec("COMMIT"); return latest;
      }
      if ((latest?.version || 0) !== expectedVersion) throw new TypeError("The analysis report changed; read its current version before publishing");
      const version = expectedVersion + 1;
      this.db.prepare("INSERT INTO goal_reports (plan_id, version, approval_revision, title, markdown, base_sha, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)").run(planId, version, revision, title.trim(), content, plan.baseSha, this.stamp());
      this.db.prepare("UPDATE plans SET goal_session_state = 'analysis_ready', delivery_status = 'analysis_ready', updated_at = ? WHERE plan_id = ?").run(this.stamp(), planId);
      this.db.exec("COMMIT");
      return this.report(planId, version);
    } catch (cause) { this.db.exec("ROLLBACK"); throw cause; }
  }

  linkCoding(planId, version) {
    const report = this.report(planId, version);
    const id = report.codingGoalId || linkedCodingId(planId, version);
    this.db.prepare("UPDATE goal_reports SET coding_goal_id = ? WHERE plan_id = ? AND version = ? AND coding_goal_id IS NULL").run(id, planId, version);
    return id;
  }

  #decisions(reviewId) {
    return this.db.prepare("SELECT finding_id, verdict, comment, updated_at FROM goal_review_decisions WHERE review_id = ? ORDER BY updated_at, finding_id").all(reviewId)
      .map((row) => ({ findingId: row.finding_id, verdict: row.verdict, comment: row.comment, updatedAt: row.updated_at }));
  }
  reviews(planId) {
    return this.db.prepare("SELECT * FROM goal_reviews WHERE plan_id = ? ORDER BY created_at DESC, id").all(planId).map((row) => reviewRow(row, this.#decisions(row.id)));
  }
  review(id) {
    const row = this.db.prepare("SELECT * FROM goal_reviews WHERE id = ?").get(id);
    return row ? { ...reviewRow(row, this.#decisions(row.id)), snapshot: JSON.parse(row.snapshot), runnerOwner: row.runner_owner, postOwner: row.post_owner, postPid: row.post_pid } : null;
  }
  queue(plan, kind, target, snapshot) {
    if (!["planner", "code", "analysis"].includes(kind)) throw new TypeError("Unknown review kind");
    const id = createHash("sha256").update(`${plan.planId}:${kind}:${target}`).digest("hex");
    this.db.prepare("INSERT OR IGNORE INTO goal_reviews (id, plan_id, kind, target, generation, snapshot, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)")
      .run(id, plan.planId, kind, String(target), plan.goalSessionGeneration, JSON.stringify(snapshot), this.stamp(), this.stamp());
    return this.review(id);
  }
  current(review) {
    const plan = this.store.get(review.planId);
    if (!plan || plan.boardStatus || plan.goalSessionGeneration !== review.generation) return false;
    if (review.kind === "planner") return String(plan.proposalRevision) === review.target && plan.goalSessionState === "awaiting_approval";
    if (review.kind === "analysis") return plan.goalType === "analysis" && plan.analysisReports.some((report) => report.version === Number(review.target));
    return plan.goalType === "coding" && plan.boardPrState === "OPEN";
  }
  claim(id) {
    const changed = this.db.prepare("UPDATE goal_reviews SET status = 'running', attempt = attempt + 1, pid = NULL, runner_owner = ?, error = NULL, updated_at = ? WHERE id = ? AND status = 'queued'").run(process.pid, this.stamp(), id).changes;
    return changed ? this.review(id) : null;
  }
  recordPid(id, attempt, pid) {
    if (!Number.isInteger(pid) || pid < 1) throw new TypeError("Missing reviewer process identity");
    this.db.prepare("UPDATE goal_reviews SET pid = ? WHERE id = ? AND attempt = ? AND status = 'running'").run(pid, id, attempt);
  }
  finish(id, attempt, { status, result = null, error = null }) {
    if (!["completed", "failed", "stale", "posting", "uncertain"].includes(status)) throw new TypeError("Invalid review result state");
    if (result !== null && (typeof result !== "string" || !result.trim() || Buffer.byteLength(result) > MAX_REVIEW_BYTES)) throw new TypeError("Reviewer returned an empty or oversized result");
    // Only a completed planner review is split into findings; the user decides
    // on those one by one. Other kinds keep the Markdown alone.
    const before = this.review(id);
    const findings = status === "completed" && before?.kind === "planner" && typeof result === "string" ? JSON.stringify(parseReviewFindings(result).findings) : null;
    this.db.prepare("UPDATE goal_reviews SET status = ?, result = COALESCE(?, result), findings = COALESCE(?, findings), error = ?, updated_at = ? WHERE id = ? AND attempt = ? AND status IN ('running', 'posting', 'uncertain')")
      .run(status, result, findings, error ? String(error).slice(0, 2000) : null, this.stamp(), id, attempt);
    return this.review(id);
  }
  claimPost(id, attempt) {
    return Boolean(this.db.prepare("UPDATE goal_reviews SET post_owner = ?, post_pid = NULL WHERE id = ? AND attempt = ? AND status IN ('posting', 'uncertain') AND post_owner IS NULL").run(process.pid, id, attempt).changes);
  }
  recordPostPid(id, attempt, pid) {
    if (!Number.isInteger(pid) || pid < 1) throw new TypeError("Missing posting process identity");
    this.db.prepare("UPDATE goal_reviews SET post_pid = ? WHERE id = ? AND attempt = ? AND post_owner = ?").run(pid, id, attempt, process.pid);
  }
  releasePost(id, attempt) {
    this.db.prepare("UPDATE goal_reviews SET post_owner = NULL, post_pid = NULL WHERE id = ? AND attempt = ? AND post_owner = ?").run(id, attempt, process.pid);
  }
  acknowledge(planId, id) {
    const review = this.review(id);
    if (!review || review.planId !== planId || review.kind !== "planner" || review.status !== "failed" || !this.current(review)) throw new TypeError("This failed planner review is no longer current");
    this.db.prepare("UPDATE goal_reviews SET acknowledged_at = ? WHERE id = ? AND status = 'failed'").run(this.stamp(), id);
    return this.store.get(planId);
  }
  retry(planId, id) {
    const review = this.review(id);
    if (!review || review.planId !== planId || !this.current(review) || review.status !== "failed") throw new TypeError("This review cannot be retried; reconcile uncertain runs first");
    this.db.prepare("UPDATE goal_reviews SET status = 'queued', acknowledged_at = NULL, updated_at = ? WHERE id = ? AND status = 'failed'").run(this.stamp(), id);
    return this.review(id);
  }
  #decidable(planId, id) {
    const review = this.review(id);
    if (!review || review.planId !== planId || review.kind !== "planner" || review.status !== "completed" || !this.current(review)) throw new TypeError("This planner review is no longer current");
    if (review.decisionsSentAt) throw new TypeError("These review decisions were already sent to the planner");
    return review;
  }
  decide(planId, id, findingId, { verdict, comment } = {}) {
    const review = this.#decidable(planId, id);
    if (!review.findings.some((finding) => finding.id === findingId)) throw new TypeError("Unknown finding for this review");
    if (!["agree", "disagree"].includes(verdict)) throw new TypeError("Verdict must be agree or disagree");
    const note = typeof comment === "string" ? comment.trim() : "";
    if (Buffer.byteLength(note) > 1_000) throw new TypeError("Keep the comment under 1,000 bytes");
    this.db.prepare("INSERT INTO goal_review_decisions (review_id, finding_id, verdict, comment, updated_at) VALUES (?, ?, ?, ?, ?) ON CONFLICT(review_id, finding_id) DO UPDATE SET verdict = excluded.verdict, comment = excluded.comment, updated_at = excluded.updated_at")
      .run(id, findingId, verdict, note, this.stamp());
    return this.store.get(planId);
  }
  // requestProposalChanges runs its own transaction and moves the goal out of
  // awaiting_approval, so a crash before the stamp cannot double-send: the
  // review is no longer current and the next attempt is refused.
  sendDecisions(planId, id, { generation, revision } = {}) {
    const review = this.#decidable(planId, id);
    const decided = new Map(review.decisions.map((decision) => [decision.findingId, decision.verdict]));
    if (review.findings.some((finding) => !decided.has(finding.id))) throw new TypeError("Decide on every finding before sending");
    if (![...decided.values()].includes("agree")) throw new TypeError("Agree with at least one finding, or approve the proposal instead");
    this.store.requestProposalChanges(planId, { generation, revision, feedback: reviewDecisionFeedback(review) });
    this.db.prepare("UPDATE goal_reviews SET decisions_sent_at = ? WHERE id = ? AND decisions_sent_at IS NULL").run(this.stamp(), id);
    return this.store.get(planId);
  }
  pending() { return this.db.prepare("SELECT id FROM goal_reviews WHERE status IN ('queued', 'running', 'posting', 'uncertain') ORDER BY created_at").all().map(({ id }) => this.review(id)); }
}

function reportRow(row) {
  return { planId: row.plan_id, version: row.version, approvalRevision: row.approval_revision, title: row.title, markdown: row.markdown, baseSha: row.base_sha, createdAt: row.created_at, codingGoalId: row.coding_goal_id };
}
function reviewRow(row, decisions = []) {
  return { id: row.id, planId: row.plan_id, kind: row.kind, target: row.target, generation: row.generation, status: row.status, attempt: row.attempt, pid: row.pid, result: row.result, error: row.error, acknowledgedAt: row.acknowledged_at, createdAt: row.created_at, updatedAt: row.updated_at,
    findings: row.findings ? JSON.parse(row.findings) : [], decisions, decisionsSentAt: row.decisions_sent_at || null };
}
