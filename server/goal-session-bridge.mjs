// A local stdio MCP surface, bound to one goal/generation/conversation. It can
// publish a validated proposal and read decisions, but can never approve one.
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";
import { WorktreePlanStore } from "./worktree-plan-store.mjs";
import { goalDiscoveryPrompt } from "./goal-session-interactive.mjs";
import { parsePlannerReply } from "./planner-reply.mjs";

const READ_TOOLS = new Set(["Read", "Grep", "Glob", "AskUserQuestion", "mcp__companion_goal__get_status", "mcp__companion_goal__publish_proposal"]);
const WRITE_TOOLS = new Set(["Edit", "Write", "Bash"]);
const MAX_INPUT = 256 * 1024;
const ANALYSIS_TOOL = { name: "publish_analysis", description: "Save an immutable Markdown analysis report after approval of its scope. Never changes repository files. Include populated Evidence, Assumptions, Limitations and Recommendations level-two headings; Companion appends the next-step actions.", inputSchema: { type: "object", required: ["revision", "expectedVersion", "title", "markdown"], additionalProperties: false, properties: { revision: { type: "integer", minimum: 1 }, expectedVersion: { type: "integer", minimum: 0 }, title: { type: "string", minLength: 1, maxLength: 200 }, markdown: { type: "string", minLength: 1, maxLength: 98304 } } } };

const TOOL_DEFINITIONS = [
  { name: "get_status", description: "Read this goal's current proposal revision, pending feedback and immutable approval. Call before publishing or implementation.", inputSchema: { type: "object", properties: {}, additionalProperties: false } },
  { name: "publish_proposal", description: "Save a validated delivery contract for user review. Never approves implementation. On validation failure, keep discussing and correct the contract.", inputSchema: { type: "object", required: ["basedOnRevision", "addressedFeedback", "spec", "tasks"], properties: {
    basedOnRevision: { type: "integer", minimum: 0 }, addressedFeedback: { type: "string" },
    spec: { type: "object", description: "Delivery contract: outcome, inScope, nonGoals, constraints, assumptions, acceptanceCriteria [{id,text,verification}], risks, optionEvidence." },
    tasks: { type: "array", minItems: 1, maxItems: 8, items: { type: "object", description: "id, title, branch, prompt, type, criterionIds, dependsOn, ownedAreas, verification" } },
  }, additionalProperties: false } },
];

export function boundGoal(store, { planId, generation, sessionId }) {
  const plan = store.get(planId);
  if (!plan || plan.workflow !== "goal_session" || plan.boardStatus || plan.goalSessionGeneration !== generation || plan.goalSessionProviderSessionId !== sessionId) throw new Error("This goal conversation is no longer current");
  return plan;
}

export function goalStatus(plan) {
  return { goal: plan.goal, goalType: plan.goalType || "coding", state: plan.goalSessionState, basedOnRevision: plan.proposalRevision,
    analysisVersion: plan.analysisReports?.[0]?.version || 0,
    latestAnalysis: plan.analysisReports?.[0] || null,
    analysisVersions: (plan.analysisReports || []).map(({ version, title, approvalRevision }) => ({ version, title, approvalRevision })),
    reviews: (plan.reviews || []).filter((review) => review.kind === "planner" ? (review.target === String(plan.proposalRevision) || review.assessment?.finalRevision === plan.proposalRevision) : review.kind === "analysis" ? review.target === String(plan.analysisReports?.[0]?.version) : true).slice(0, 4),
    addressedFeedback: plan.goalSessionPendingInput || plan.goalSessionActiveInput || "",
    approved: (plan.goalType === "analysis" ? ["analyzing", "analysis_ready"].includes(plan.goalSessionState) : plan.goalSessionState === "implementing") && plan.approvalRevision === plan.proposalRevision && Boolean(plan.approvalAt) && !plan.goalSessionError && ["pending", "delivered"].includes(plan.transitionStatus),
    proposal: plan.proposal, branch: plan.goalSessionBranch, baseRef: plan.baseRef, issueNumbers: plan.issueNumbers };
}

export function callGoalTool(store, binding, name, args = {}) {
  const plan = boundGoal(store, binding);
  if (name === "get_status") return goalStatus(plan);
  if (name === "publish_analysis") {
    if (plan.goalType !== "analysis" || !goalStatus(plan).approved) throw new Error("Analysis publication requires approval of the analysis scope");
    const report = store.outcomes.publishReport(binding.planId, { ...args, generation: binding.generation, sessionId: binding.sessionId });
    return { ...goalStatus(store.get(binding.planId)), report, message: "Analysis saved in Companion. The user can challenge it or launch a linked coding discovery." };
  }
  if (name !== "publish_proposal") throw new Error("Unknown goal tool");
  if (!args.spec || typeof args.spec !== "object" || Array.isArray(args.spec) || !Array.isArray(args.tasks) || !args.tasks.length || args.tasks.length > 8) throw new Error("Provide a spec and one to eight implementation tasks");
  if (args.basedOnRevision !== plan.proposalRevision || args.addressedFeedback !== goalStatus(plan).addressedFeedback) throw new Error("The proposal or feedback changed. Read get_status and incorporate the latest feedback before publishing");
  const reply = parsePlannerReply(JSON.stringify({ result: JSON.stringify({ spec: args.spec, tasks: args.tasks }) }), plan.specOptions);
  const proposal = { intendedBehavior: reply.spec.outcome, scope: reply.spec.inScope, exclusions: reply.spec.nonGoals,
    assumptions: reply.spec.assumptions, acceptanceCriteria: reply.spec.acceptanceCriteria.map(({ text, verification }) => ({ text, verification })),
    verification: [...new Set(reply.tasks.flatMap((task) => task.verification))], spec: reply.spec, tasks: reply.tasks };
  const saved = store.publishProposal(binding.planId, { generation: binding.generation, providerSessionId: binding.sessionId, proposal,
    expectedRevision: args.basedOnRevision, expectedFeedback: args.addressedFeedback });
  return { ...goalStatus(saved), message: "Proposal saved and ready for review in Companion. Keep this conversation open for feedback. After approval, the user can tell you to continue here." };
}

// Hooks run in a separate process for each native tool and user turn. Every
// mutation checks the durable approval; switching the CLI permission mode
// cannot enable implementation before the revision-bound Companion decision.
export function goalHook(store, binding, event) {
  if (event.session_id !== binding.sessionId) throw new Error("Unexpected provider conversation identity");
  let plan = boundGoal(store, binding);
  if (event.hook_event_name === "UserPromptSubmit") {
    if (plan.goalSessionState === "awaiting_approval" && typeof event.prompt === "string" && event.prompt.trim()) {
      plan = store.requestProposalChanges(binding.planId, { generation: binding.generation, revision: plan.proposalRevision, feedback: event.prompt.trim().slice(0, 4_000) });
    }
    return { hookSpecificOutput: { hookEventName: "UserPromptSubmit", additionalContext: `${goalDiscoveryPrompt(plan)}\nCurrent Companion goal state: ${JSON.stringify(goalStatus(plan))}` } };
  }
  if (event.hook_event_name !== "PreToolUse") throw new Error("Unexpected goal hook event");
  const allowRead = READ_TOOLS.has(event.tool_name);
  const allowArtifact = event.tool_name === "mcp__companion_goal__publish_analysis" && plan.goalType === "analysis" && goalStatus(plan).approved;
  const allowWrite = plan.goalType !== "analysis" && WRITE_TOOLS.has(event.tool_name) && goalStatus(plan).approved;
  if (!allowRead && !allowWrite && !allowArtifact) return { hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "deny", permissionDecisionReason: "Implementation requires approval of the current saved proposal in Companion. Keep discovery interactive with Read, Grep, Glob, AskUserQuestion and companion_goal tools." } };
  // This records authorization reaching the native session, not completion.
  // No output envelope or exit code is interpreted as delivery success.
  if (allowWrite && plan.transitionStatus === "pending") {
    const claimed = store.claimGoalSessionTransition(binding.planId, { generation: binding.generation, revision: plan.approvalRevision });
    if (!claimed) throw new Error("The approval changed before this tool could run");
    store.recordGoalSessionTransition(binding.planId, { generation: binding.generation, revision: plan.approvalRevision });
  }
  return {}; // Preserve native permission prompts; never auto-approve writes.
}

export function handleGoalRpc(store, binding, request) {
  if (request.id === undefined) return null;
  const respond = (result) => ({ jsonrpc: "2.0", id: request.id, result });
  if (request.method === "initialize") return respond({ protocolVersion: "2024-11-05", capabilities: { tools: {} }, serverInfo: { name: "companion-goal", version: "1.0.0" } });
  if (request.method === "ping") return respond({});
  if (request.method === "tools/list") return respond({ tools: boundGoal(store, binding).goalType === "analysis" ? [...TOOL_DEFINITIONS, ANALYSIS_TOOL] : TOOL_DEFINITIONS });
  if (request.method === "tools/call") {
    try { return respond({ content: [{ type: "text", text: JSON.stringify(callGoalTool(store, binding, request.params?.name, request.params?.arguments)) }] }); }
    catch (cause) { return respond({ isError: true, content: [{ type: "text", text: String(cause?.message || cause) }] }); }
  }
  return { jsonrpc: "2.0", id: request.id, error: { code: -32601, message: "Method not found" } };
}

async function main() {
  const [mode, planId, databasePath, generationArg, sessionId] = process.argv.slice(2);
  const binding = { planId, generation: Number(generationArg), sessionId };
  const store = new WorktreePlanStore({ path: databasePath });
  try {
    if (mode === "hook") {
      let input = "";
      for await (const chunk of process.stdin) { input += chunk; if (input.length > MAX_INPUT) throw new Error("Goal hook input is too large"); }
      process.stdout.write(JSON.stringify(goalHook(store, binding, JSON.parse(input))));
    } else if (mode === "mcp") {
      const lines = createInterface({ input: process.stdin, crlfDelay: Infinity });
      for await (const line of lines) {
        if (line.length > MAX_INPUT) throw new Error("Goal tool input is too large");
        let response;
        try { response = handleGoalRpc(store, binding, JSON.parse(line)); }
        catch { response = { jsonrpc: "2.0", id: null, error: { code: -32700, message: "Invalid JSON request" } }; }
        if (response) process.stdout.write(`${JSON.stringify(response)}\n`);
      }
    } else throw new Error("Unknown goal bridge mode");
  } finally { store.close(); }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) main().catch((cause) => { console.error(cause?.message || cause); process.exitCode = 2; });
