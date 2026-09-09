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

test("planner failures can be acknowledged while uncertain code posting offers reconciliation", async () => {
  const fetch = vi.fn(async () => json(draft)); vi.stubGlobal("fetch", fetch);
  const reviews: GoalReview[] = [{ ...failed, kind: "planner" }, { ...failed, id: "b".repeat(64), kind: "code", target: "c".repeat(40), status: "uncertain", result: "Saved advisory findings" }];
  render(<GoalOutcomes draft={{ ...draft, proposalRevision: 1, reviews }} onReceive={vi.fn()} onLinked={vi.fn()} />);
  await userEvent.click(screen.getByRole("button", { name: "Acknowledge failed review" }));
  await userEvent.click(screen.getByRole("button", { name: "Reconcile review" }));
  assert.equal(fetch.mock.calls.length, 2); assert.ok(screen.getByText("Saved advisory findings"));
});

const findings = [
  { id: "F1", severity: "high" as const, title: "Missing rollback", evidence: "No down step", suggestion: "Add one" },
  { id: "F2", severity: "low" as const, title: "Naming", evidence: "Mixed case", suggestion: "" },
];
const plannerDraft: PlanDraft = { ...draft, planId: "coding", goalType: "coding", goalSessionState: "awaiting_approval", goalSessionGeneration: 1, proposalRevision: 2, analysisReports: [] };
const completed: GoalReview = { id: "c".repeat(64), kind: "planner", target: "2", status: "completed", result: "```json\n{}\n```\n\nFull prose", error: null, acknowledgedAt: null, findings, decisions: [], decisionsSentAt: null };

test("each planner finding is a card whose decision saves at once and gates the send button", async () => {
  const receive = vi.fn();
  let decisions: { findingId: string; verdict: "agree" | "disagree"; comment: string }[] = [];
  const fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const match = url.match(/\/decisions\/([^/]+)$/);
    if (match) { const body = JSON.parse(String(init?.body)); decisions = [...decisions.filter((d) => d.findingId !== match[1]), { findingId: match[1], ...body }]; return json({ ...plannerDraft, reviews: [{ ...completed, decisions }] }); }
    if (url.endsWith("/send-decisions")) return json({ ...plannerDraft, goalSessionState: "planning", reviews: [{ ...completed, decisions, decisionsSentAt: "2026-09-09T10:00:00.000Z" }] });
    throw new Error(`unexpected ${url}`);
  });
  vi.stubGlobal("fetch", fetch);
  const view = render(<GoalOutcomes draft={{ ...plannerDraft, reviews: [completed] }} onReceive={receive} onLinked={vi.fn()} />);
  assert.equal(screen.getAllByRole("article").length, 3, "one review article plus two finding cards");
  assert.ok(screen.getByText("Missing rollback"));
  assert.ok(screen.getByText("high"));
  assert.equal(screen.getByRole("button", { name: "Send decisions to planner" }).hasAttribute("disabled"), true);
  assert.ok(screen.getByText("0 of 2 decided"));
  await userEvent.click(screen.getByRole("radio", { name: "Agree with Missing rollback" }));
  await waitFor(() => assert.equal(receive.mock.calls.length, 1));
  assert.equal(String(fetch.mock.calls[0][0]), "/api/goal-sessions/coding/reviews/" + "c".repeat(64) + "/decisions/F1");
  assert.equal((fetch.mock.calls[0][1] as RequestInit).method, "PUT");
  view.rerender(<GoalOutcomes draft={receive.mock.calls[0][0] as PlanDraft} onReceive={receive} onLinked={vi.fn()} />);
  assert.ok(screen.getByText("1 of 2 decided"));
  await userEvent.type(screen.getByRole("textbox", { name: "Comment on Naming" }), "Repo convention");
  await userEvent.click(screen.getByRole("radio", { name: "Disagree with Naming" }));
  await waitFor(() => assert.equal(receive.mock.calls.length, 2));
  assert.deepEqual(JSON.parse(String((fetch.mock.calls[1][1] as RequestInit).body)), { verdict: "disagree", comment: "Repo convention" });
  view.rerender(<GoalOutcomes draft={receive.mock.calls[1][0] as PlanDraft} onReceive={receive} onLinked={vi.fn()} />);
  assert.equal(screen.getByRole("button", { name: "Send decisions to planner" }).hasAttribute("disabled"), false);
  await userEvent.click(screen.getByRole("button", { name: "Send decisions to planner" }));
  await waitFor(() => assert.equal(receive.mock.calls.length, 3));
  assert.deepEqual(JSON.parse(String((fetch.mock.calls[2][1] as RequestInit).body)), { generation: 1, revision: 2 });
  view.rerender(<GoalOutcomes draft={receive.mock.calls[2][0] as PlanDraft} onReceive={receive} onLinked={vi.fn()} />);
  assert.ok(screen.getByText(/Decisions sent/));
  assert.equal(screen.queryByRole("button", { name: "Send decisions to planner" }), null);
  assert.equal(screen.queryByRole("radio"), null);
  assert.ok(screen.getByText("Disagreed · Repo convention"));
});

test("send stays disabled when every finding is disagreed, and read-only mode never mutates", async () => {
  const allDisagreed: GoalReview = { ...completed, decisions: findings.map((finding) => ({ findingId: finding.id, verdict: "disagree" as const, comment: "", updatedAt: "2026-09-09T10:00:00.000Z" })) };
  const view = render(<GoalOutcomes draft={{ ...plannerDraft, reviews: [allDisagreed] }} onReceive={vi.fn()} onLinked={vi.fn()} />);
  assert.equal(screen.getByRole("button", { name: "Send decisions to planner" }).hasAttribute("disabled"), true);
  assert.ok(screen.getByText("Agree with at least one finding to send, or approve the proposal."));
  view.unmount();
  const fetch = vi.fn(); vi.stubGlobal("fetch", fetch);
  render(<GoalOutcomes draft={{ ...plannerDraft, planId: "ro", reviews: [completed] }} onReceive={vi.fn()} onLinked={vi.fn()} readOnly />);
  assert.equal(screen.queryByRole("radio"), null, "read-only shows no decision controls");
  assert.equal(screen.getByRole("button", { name: "Send decisions to planner" }).hasAttribute("disabled"), true);
  assert.equal(fetch.mock.calls.length, 0);
});

test("a historical planner review shows its findings and decisions without controls", () => {
  const historical: GoalReview = { ...completed, target: "1", decisions: [{ findingId: "F1", verdict: "agree", comment: "Yes", updatedAt: "2026-09-09T10:00:00.000Z" }], decisionsSentAt: "2026-09-09T10:01:00.000Z" };
  render(<GoalOutcomes draft={{ ...plannerDraft, reviews: [historical] }} onReceive={vi.fn()} onLinked={vi.fn()} />);
  assert.ok(screen.getByText(/historical target/));
  assert.ok(screen.getByText("Agreed · Yes"));
  assert.equal(screen.queryByRole("radio"), null);
  assert.equal(screen.queryByRole("button", { name: "Send decisions to planner" }), null);
});
