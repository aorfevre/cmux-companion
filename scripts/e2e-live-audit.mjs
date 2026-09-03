import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { CmuxClient } from "../server/cmux-client.mjs";

const baseUrl = process.env.CMUX_COMPANION_E2E_URL || "http://127.0.0.1:3210";
const tokenFile = process.env.CMUX_COMPANION_TOKEN_FILE || join(homedir(), ".config", "cmux-companion", "token");
const token = (process.env.CMUX_COMPANION_E2E_TOKEN || await readFile(tokenFile, "utf8")).trim();

if (process.env.CI) throw new Error("The live cmux audit is local-only and refuses to run in CI.");
if (!token) throw new Error("A local companion pairing token is required.");

async function api(path) {
  const response = await fetch(new URL(path, baseUrl), { headers: { Authorization: `Bearer ${token}` } });
  const body = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(body.error || `${path} failed with ${response.status}`);
  return body;
}

const [{ plans = [] }, health, dashboard, cmux] = await Promise.all([
  api("/api/worktree-plans?status=all&limit=200&health=1"),
  api("/api/goals/health"),
  api("/api/worktree-dashboard"),
  new CmuxClient().workspaceListDetailed(),
]);

const liveWorkspaces = Array.isArray(cmux.workspaces) ? cmux.workspaces : [];
const liveById = new Map(liveWorkspaces.map((workspace) => [workspace.id, workspace]));
const liveIds = new Set(liveById.keys());
const healthByPlan = new Map((health.goals || []).map((goal) => [goal.planId, goal]));
const problems = [];

if (Number(dashboard?.summary?.sessions) !== liveIds.size) {
  problems.push({ planId: null, goal: null, problem: `Dashboard counts ${dashboard?.summary?.sessions ?? "unknown"} sessions while cmux lists ${liveIds.size}` });
}

for (const plan of plans) {
  if (plan.status !== "launched" || plan.boardStatus) continue;
  const report = healthByPlan.get(plan.planId);
  if (!report) {
    problems.push({ planId: plan.planId, goal: oneLine(plan.goal), problem: "Launched goal is absent from the health sweep" });
    continue;
  }
  if (plan.boardState === "blocked" && !["dead", "idle", "failed"].includes(report.health)) {
    problems.push({ planId: plan.planId, goal: oneLine(plan.goal), problem: `Board says blocked while health says ${report.health}` });
  }
  if (plan.deliveryStatus === "blocked" && (plan.mergeStatus === "blocked" || plan.mergeWorkspaceId) && !report.merge) {
    problems.push({ planId: plan.planId, goal: oneLine(plan.goal), problem: "Blocked delivery has no merge evidence" });
  }
  const reportedSessionIds = new Set();
  for (const item of [...(report.tasks || []), ...(report.merge ? [report.merge] : [])]) {
    const sessionId = item.session?.id;
    if (sessionId) reportedSessionIds.add(sessionId);
    if (sessionId && !liveIds.has(sessionId)) {
      problems.push({ planId: plan.planId, goal: oneLine(plan.goal), problem: `API claims live cmux session ${sessionId}, but cmux does not list it` });
    }
    const direct = sessionId ? liveById.get(sessionId) : null;
    const signals = direct?.status?.signals || {};
    if (direct && item.health === "needs_you" && signals.any_agent_needs_input !== true && item.session?.inputEvidence !== "terminal_screen") {
      problems.push({ planId: plan.planId, goal: oneLine(plan.goal), problem: `Health says ${sessionId} needs input while cmux does not` });
    }
    if (direct && item.health === "working" && signals.any_agent_running !== true && direct.status?.effective !== "working" && item.session?.workingEvidence !== "terminal_screen") {
      problems.push({ planId: plan.planId, goal: oneLine(plan.goal), problem: `Health infers ${sessionId} is working while cmux reports ${direct.status?.effective || "no effective state"}` });
    }
  }
  for (const sessionId of Array.isArray(plan.workspaceIds) ? plan.workspaceIds : []) {
    if (liveIds.has(sessionId) && !reportedSessionIds.has(sessionId)) {
      problems.push({ planId: plan.planId, goal: oneLine(plan.goal), problem: `Persisted cmux session ${sessionId} is live but omitted from health evidence` });
    }
  }
}

console.log(JSON.stringify({
  checkedAt: health.checkedAt,
  sessionsAvailable: health.sessionsAvailable,
  activeGoals: (health.goals || []).length,
  cmuxWorkspaces: liveIds.size,
  dashboardSessions: dashboard?.summary?.sessions ?? null,
  problems,
}, null, 2));
if (problems.length) process.exitCode = 1;

function oneLine(value) {
  return String(value || "").replace(/\s+/g, " ").trim().slice(0, 100);
}
