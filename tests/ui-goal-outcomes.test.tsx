import assert from "node:assert/strict";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, test, vi } from "vitest";
import { GoalOutcomes, type GoalReview } from "../app/goal-outcomes";
import type { PlanDraft } from "../app/worktree-planner";

const report = { planId: "analysis", version: 1, approvalRevision: 1, title: "Repository boundaries", markdown: "## Evidence\nSaved evidence.\n\n![do not fetch](https://example.test/track.png)\n<script>alert('no')</script>\n[unsafe](javascript:alert(1))", baseSha: "a".repeat(40), createdAt: "2026-09-08T00:00:00Z", codingGoalId: null };
const draft: PlanDraft = { planId: "analysis", repositoryId: "repo", goal: "Analyze", goalType: "analysis", workflow: "goal_session", goalSessionState: "analysis_ready", status: "ready", round: 1, questions: [], tasks: [], analysisReports: [report], reviews: [] };
const failed: GoalReview = { id: "a".repeat(64), kind: "analysis", target: "1", status: "failed", result: null, error: "Provider timed out", acknowledgedAt: null };
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
afterEach(() => vi.unstubAllGlobals());

test("report history is readable and downloads the selected immutable version without unsafe HTML or images", async () => {
  const second = { ...report, version: 2, markdown: "Latest evidence" };
  const { container } = render(<GoalOutcomes draft={{ ...draft, analysisReports: [second, report] }} onReceive={vi.fn()} onLinked={vi.fn()} />);
  assert.ok(screen.getByText("Latest evidence"));
  await userEvent.selectOptions(screen.getByRole("combobox", { name: "Analysis report version" }), "1");
  assert.ok(screen.getByText("Saved evidence."));
  assert.equal(screen.getByRole("link", { name: "Download Markdown" }).getAttribute("href"), "/api/goal-sessions/analysis/analysis/1/download");
  assert.equal(container.querySelector("img, script, a[href^='javascript:']"), null);
});

test("challenge uses the selected version and exposes a retry without rewriting the report", async () => {
  const receive = vi.fn();
  const fetch = vi.fn(async () => json({ ...draft, reviews: [failed] })); vi.stubGlobal("fetch", fetch);
  const view = render(<GoalOutcomes draft={draft} onReceive={receive} onLinked={vi.fn()} />);
  await userEvent.click(screen.getByRole("button", { name: "Challenge the analysis" }));
  await waitFor(() => assert.equal(receive.mock.calls.length, 1));
  assert.equal(fetch.mock.calls.length, 1);
  view.rerender(<GoalOutcomes draft={{ ...draft, reviews: [failed], analysisReports: [{ ...report, version: 2, markdown: "New report" }, report] }} onReceive={receive} onLinked={vi.fn()} />);
  assert.ok(screen.getByText("Provider timed out"));
  assert.ok(screen.getByText(/historical target/));
  await userEvent.click(screen.getByRole("button", { name: "Retry analysis review" }));
  await waitFor(() => assert.equal(fetch.mock.calls.length, 2));
  assert.equal(report.markdown.includes("Saved evidence"), true);
});

test("read-only mode retains history and download but never sends a mutation", async () => {
  const fetch = vi.fn(); vi.stubGlobal("fetch", fetch);
  render(<GoalOutcomes readOnly draft={{ ...draft, reviews: [failed] }} onReceive={vi.fn()} onLinked={vi.fn()} />);
  for (const button of screen.getAllByRole("button")) { assert.equal((button as HTMLButtonElement).disabled, true); await userEvent.click(button); }
  assert.ok(screen.getByRole("link", { name: "Download Markdown" })); assert.equal(fetch.mock.calls.length, 0);
});

test("linked coding opens the returned discovery and reports startup failures instead of fabricating success", async () => {
  const linked = vi.fn();
  const child = { ...draft, planId: "coding", goalType: "coding", goalSessionState: "planning", goalSessionWorkspaceId: "child-workspace", sourceAnalysis: { planId: "analysis", version: 1 }, analysisReports: [] };
  const fetch = vi.fn(async () => json(child)); vi.stubGlobal("fetch", fetch);
  render(<GoalOutcomes draft={draft} onReceive={vi.fn()} onLinked={linked} />);
  await userEvent.click(screen.getByRole("button", { name: "Launch coding goal" }));
  await waitFor(() => assert.deepEqual(linked.mock.calls[0], [child]));
  fetch.mockImplementation(async () => json({ ...child, goalSessionError: "cmux unavailable" }));
  await userEvent.click(screen.getByRole("button", { name: "Launch coding goal" }));
  assert.match((await screen.findByRole("alert")).textContent || "", /cmux unavailable/);
  assert.equal(linked.mock.calls.length, 1);
});

test("planner failures can be retried while uncertain code posting offers reconciliation", async () => {
  const fetch = vi.fn(async () => json(draft)); vi.stubGlobal("fetch", fetch);
  const reviews: GoalReview[] = [{ ...failed, kind: "planner" }, { ...failed, id: "b".repeat(64), kind: "code", target: "c".repeat(40), status: "uncertain", result: "Saved advisory findings" }];
  render(<GoalOutcomes draft={{ ...draft, proposalRevision: 1, reviews }} onReceive={vi.fn()} onLinked={vi.fn()} />);
  await userEvent.click(screen.getByRole("button", { name: "Retry planner review" }));
  await userEvent.click(screen.getByRole("button", { name: "Reconcile review" }));
  assert.equal(fetch.mock.calls.length, 2); assert.ok(screen.getByText("Saved advisory findings"));
});

const findings = [
  { id: "F1", severity: "high" as const, title: "Missing rollback", evidence: "No down step", suggestion: "Add one" },
  { id: "F2", severity: "low" as const, title: "Naming", evidence: "Mixed case", suggestion: "" },
];
const plannerDraft: PlanDraft = { ...draft, planId: "coding", goalType: "coding", goalSessionState: "awaiting_approval", goalSessionGeneration: 1, proposalRevision: 2, analysisReports: [] };
const completed: GoalReview = { id: "c".repeat(64), kind: "planner", target: "2", status: "completed", result: "```json\n{}\n```\n\nFull prose", error: null, acknowledgedAt: null, findings, decisions: [], decisionsSentAt: null };

test("the planner assesses automatically and only its final summary is prominent", async () => {
  const fetch = vi.fn(); vi.stubGlobal("fetch", fetch);
  const view = render(<GoalOutcomes draft={{ ...plannerDraft, reviews: [completed] }} onReceive={vi.fn()} onLinked={vi.fn()} />);
  assert.ok(screen.getByText("Planner is assessing the review"));
  assert.equal(screen.queryByRole("radio"), null);
  assert.equal(screen.queryByRole("button", { name: "Send decisions to planner" }), null);
  const assessed: GoalReview = { ...completed, assessment: { status: "completed", sourceRevision: 2, finalRevision: 3, summary: "Added rollback coverage.", dispositions: [{ findingId: "F1", disposition: "accept", rationale: "Protect existing data" }] } };
  view.rerender(<GoalOutcomes draft={{ ...plannerDraft, proposalRevision: 3, reviews: [assessed] }} onReceive={vi.fn()} onLinked={vi.fn()} />);
  assert.ok(screen.getByText("Reviewed plan ready"));
  assert.ok(screen.getByRole("region", { name: "What changed after review" }));
  assert.ok(screen.getByText("Added rollback coverage."));
  assert.equal(screen.getByText("Review details").closest("details")?.open, false);
  await userEvent.click(screen.getByText("Review details"));
  assert.equal(screen.getByText("Review details").closest("details")?.open, true);
  assert.ok(screen.getByText("Planner: accept · Protect existing data"));
  assert.equal(fetch.mock.calls.length, 0);
});

test("failed assessments retry explicitly, respect read-only and report failures", async () => {
  const fetch = vi.fn(async () => json({ error: "Still unavailable" }, 400)); vi.stubGlobal("fetch", fetch);
  const review: GoalReview = { ...completed, assessment: { status: "failed", sourceRevision: 2, finalRevision: null, error: "Provider unavailable" } };
  const view = render(<GoalOutcomes draft={{ ...plannerDraft, reviews: [review] }} onReceive={vi.fn()} onLinked={vi.fn()} readOnly />);
  assert.equal((screen.getByRole("button", { name: "Retry planner assessment" }) as HTMLButtonElement).disabled, true);
  view.rerender(<GoalOutcomes draft={{ ...plannerDraft, reviews: [review] }} onReceive={vi.fn()} onLinked={vi.fn()} />);
  await userEvent.click(screen.getByRole("button", { name: "Retry planner assessment" }));
  assert.ok(await screen.findByRole("alert"));
  assert.equal(fetch.mock.calls.length, 1);
});

test("historical human decisions remain readable without active controls", async () => {
  const historical: GoalReview = { ...completed, target: "1", decisions: [{ findingId: "F1", verdict: "agree", comment: "Yes" }] };
  render(<GoalOutcomes draft={{ ...plannerDraft, reviews: [historical] }} onReceive={vi.fn()} onLinked={vi.fn()} />);
  assert.ok(screen.getByText(/historical target/));
  await userEvent.click(screen.getByText("Review details"));
  assert.ok(screen.getByText("Previous user decision: agree · Yes"));
  assert.equal(screen.queryByRole("radio"), null);
});
