import { ModelSettings } from "./model-settings.mjs";
import { DEFAULT_MODEL_ROLES, normalizeModelId, roleEngine } from "./model-options.mjs";
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { createInterface } from "node:readline";
import {
  completionReportInstruction,
  formatDesignArtifacts,
  formatOptionEvidence,
  normalizeContractTask,
  normalizeDeliveryContract,
  taskWave,
  validateDeliveryContract,
} from "./delivery-contract.mjs";
import { normalizeSpecOptions, specOptionsBriefLines, specOptionsPromptLines } from "./spec-options.mjs";
import { normalizeReviewOptions, safeReviewOptions } from "./review-options.mjs";
import { AgentBriefs } from "./agent-brief.mjs";
import { resolveDefaultBaseRef } from "./default-base-ref.mjs";
import { PlannerRuns } from "./planner-runs.mjs";
import { LaunchRuns } from "./launch-runs.mjs";
import { goalBoardState } from "./goal-board.mjs";
import { sessionEnv, sessionTitle } from "./session-name.mjs";
import { acquireTaskWorktree, effectiveTaskBranch, launchReason } from "./task-branch.mjs";
import { PLANNER_ENGINES, reviewerEngine } from "./worktree-planner-options.mjs";

export { PLANNER_ENGINES, reviewerEngine } from "./worktree-planner-options.mjs";

// promisify(execFile) buffers to completion, so nothing can be reported while
// the model is still thinking. spawn resolves the same shape and rejects with
// the same fields, plus it calls onLine for each stdout line, so every injected
// `execute` fake stays valid.
//
// Two limits, not one. `timeout` is an absolute ceiling on the run, and
// `idleTimeout` measures silence: every stdout line restarts it. A round that
// reads a large repository works steadily and is legitimately slow, so only the
// silence says it is stuck. A single wall-clock limit killed those rounds every
// time and could never be raised high enough. `reason` says which limit fired,
// so the caller can name the real cause instead of guessing.
export function streamExecFile(bin, args, { cwd, timeout = 0, idleTimeout = 0, maxBuffer = 4 * 1024 * 1024, env, onLine, signal = null } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(bin, args, { cwd, env, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    let killed = false;
    let reason = "";
    const stop = (why) => { killed = true; reason = why; child.kill("SIGTERM"); };
    const ceiling = timeout ? setTimeout(() => stop("ceiling"), timeout) : null;
    ceiling?.unref?.();
    let idle = null;
    // Abort is a third way this round can end, next to the ceiling and the
    // idle limit. It kills the same child through the same path, so the close
    // handler reports it exactly like a timeout does, with its own reason.
    const onAbort = () => stop("aborted");
    // The idle timer is armed once and rearmed on every line, so a silent
    // startup is bounded by the same limit as a mid-round stall.
    const restartIdle = () => {
      if (!idleTimeout || killed) return;
      clearTimeout(idle);
      idle = setTimeout(() => stop("idle"), idleTimeout);
      idle.unref?.();
    };
    // Every exit path runs this once: no timer is left armed, and the abort
    // listener is removed, so an AbortController that outlives the round holds
    // no reference to it.
    const cleanup = () => {
      clearTimeout(ceiling);
      clearTimeout(idle);
      signal?.removeEventListener?.("abort", onAbort);
    };
    if (signal?.aborted) stop("aborted");
    else signal?.addEventListener?.("abort", onAbort, { once: true });
    restartIdle();
    const lines = createInterface({ input: child.stdout });
    lines.on("line", (line) => {
      restartIdle();
      // Only the final result line is needed later, so an over-long run drops
      // old lines instead of failing the round the way execFile does.
      if (stdout.length + line.length + 1 <= maxBuffer) stdout += `${line}\n`;
      // A progress consumer must never fail a planner round.
      try { onLine?.(line); } catch { /* the round outlives its audience */ }
    });
    // stderr is progress too. ccs writes its startup and its warnings there, so
    // a round that only complains is still alive and must not be called idle.
    child.stderr.on("data", (chunk) => { restartIdle(); if (stderr.length < 64 * 1024) stderr += chunk; });
    child.once("error", (cause) => { cleanup(); lines.close(); reject(cause); });
    child.once("close", (code, closeSignal) => {
      cleanup();
      lines.close();
      if (killed || closeSignal) return reject(Object.assign(new Error("Command failed"), { killed, reason, signal: closeSignal || "SIGTERM", stderr, code }));
      if (code !== 0) return reject(Object.assign(new Error("Command failed"), { code, stderr, killed: false }));
      return resolve({ stdout, stderr });
    });
  });
}

// The non-streaming envelope and the stream-json result line hold the same two
// fields, so parsePlannerReply is reused as it is and only the line choice is
// new. Falling back to raw stdout keeps every plain-envelope fixture working.
export function finalEnvelope(stdout) {
  const lines = String(stdout).split("\n");
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    const line = lines[index].trim();
    if (!line.startsWith("{") || !line.includes('"result"')) continue;
    try { if (JSON.parse(line)?.type === "result") return line; } catch { /* a partial or unrelated line */ }
  }
  return stdout;
}

const TOOL_DETAIL = {
  Read: (input) => shortPath(input?.file_path),
  Grep: (input) => quoted(input?.pattern),
  Glob: (input) => quoted(input?.pattern),
};

// Only the model's own turn is legible progress. The system, hook and user lines
// are transport noise. The input is never spread: one whitelisted key per tool
// is read and truncated, so no path list or file body can leak into the UI.
export function progressEvent(line) {
  let value;
  try { value = JSON.parse(line); } catch { return null; }
  if (value?.type !== "assistant") return null;
  for (const block of value.message?.content || []) {
    if (block?.type === "tool_use") {
      const detail = TOOL_DETAIL[block.name]?.(block.input) || "";
      return { k: "tool", t: `${String(block.name || "Tool").slice(0, 20)}${detail ? ` ${detail}` : ""}` };
    }
    // Prose between tool calls is reasoning. It runs long and it quotes the
    // repository, so only its presence is reported, never its content.
    if (block?.type === "text" && String(block.text || "").trim()) return { k: "text", t: "Thinking…" };
  }
  return null;
}

function shortPath(value) {
  const path = String(value || "");
  return path ? path.split("/").slice(-2).join("/").slice(0, 60) : "";
}

function quoted(value) {
  const text = String(value || "").replace(/\s+/g, " ").trim().slice(0, 40);
  return text ? `"${text}"` : "";
}

// A subprocess failure, not an unusable reply. It is still a TypeError, so the
// Fastify error handler answers 400 with its message, but #round never retries
// it: a second launch cannot fix a missing binary or a timeout.
class PlannerRunError extends TypeError {}

const UNUSABLE = "The planner returned an unusable answer. Try again";
const BUSY = "This goal is planning right now. Wait for the round to finish";
// A launch creates worktrees and cmux sessions. A second one would create them
// twice, so it is refused in the same voice as a second planner round.
const LAUNCHING = "This goal is launching right now. Wait for the launch to finish";
const ABORTED_ROUND = "This goal was aborted, so its planner round stopped";
// A terminal goal is finished. Every mutation says so in the sentence the sheet
// shows, rather than failing with a generic message the user cannot act on.
const ABORTED_PLAN = "This goal was aborted. Start a new goal";
const MERGED_PLAN = "This goal is already merged. Start a new goal";
// A discussion questions a contract that already exists, so it refuses the same
// plans a rejection refuses, in its own voice. The cap stops a sheet becoming a
// chat window: past it, the honest move is to reject the plan and re-plan.
const DISCUSSION_CAP = 12;
const NO_CONTRACT_TO_QUESTION = "This goal has no plan to question yet. Answer its questions first";
const EMPTY_QUESTION = "Ask a question about this plan";
const LONG_QUESTION = "That question is too long";
const DISCUSSION_EXHAUSTED = `This plan has been questioned ${DISCUSSION_CAP} times. Reject it and re-plan instead`;

export function parsePlannerReply(stdout, specOptions = undefined) {
  const envelope = extractJson(String(stdout));
  if (!envelope) throw new TypeError(UNUSABLE);
  const sessionId = typeof envelope.session_id === "string" ? envelope.session_id : null;
  const payload = extractJson(String(envelope.result || ""));
  if (!payload) throw new TypeError(UNUSABLE);

  const hasQuestions = Array.isArray(payload.questions) && payload.questions.length > 0;
  const hasTasks = Array.isArray(payload.tasks) && payload.tasks.length > 0;
  if (hasQuestions === hasTasks) throw new TypeError(UNUSABLE);

  if (hasQuestions) {
    const questions = payload.questions
      .map((item, index) => ({
        id: `q${index + 1}`,
        text: cleanText(item?.text || item?.question),
        options: Array.isArray(item?.options) ? item.options.map(cleanText).filter(Boolean).slice(0, 6) : [],
      }))
      .filter((item) => item.text);
    if (!questions.length) throw new TypeError(UNUSABLE);
    return { sessionId, status: "questions", questions, spec: null, tasks: [], readiness: null };
  }

  let tasks = payload.tasks
    .map((item, index) => normalizeContractTask(item, index))
    .filter((item) => item.title && item.branch && item.prompt);
  if (!tasks.length) throw new TypeError(UNUSABLE);
  const legacy = !payload.spec || typeof payload.spec !== "object";
  const spec = legacy
    ? normalizeDeliveryContract({
      outcome: "Complete the requested goal",
      assumptions: ["The planner returned a legacy task-only answer"],
      acceptanceCriteria: tasks.map((task, index) => ({ id: `AC-${index + 1}`, text: `Complete ${task.title}`, verification: "Run the repository verification appropriate for this task" })),
    })
    : normalizeDeliveryContract(payload.spec);
  if (legacy) tasks = tasks.map((task, index) => ({
    ...task,
    criterionIds: [`AC-${index + 1}`],
    ownedAreas: ["**/*"],
    verification: ["Run the repository verification appropriate for this task"],
  }));
  // The requested options are part of what makes a reply usable, so they are
  // validated here rather than after the retry decision. An oversized brief
  // caused by the extra option text then follows the same retry path as any
  // other unusable answer.
  const readiness = validateDeliveryContract(spec, tasks, specOptions);
  if (!readiness.ready) throw new TypeError(`${UNUSABLE}: ${readiness.errors[0]}`);
  return { sessionId, status: "ready", questions: [], spec, tasks, readiness, legacy };
}

// The only three keys a discussion answer may hold. A reply that also carries
// `questions` or `tasks` is a planning answer, not an explanation, so it is
// refused here rather than allowed to look like a contract the user can accept.
const DISCUSSION_KEYS = new Set(["answer", "contractImpact", "suggestion"]);
const MAX_DISCUSSION_ANSWER = 4_000;
const MAX_DISCUSSION_SUGGESTION = 2_000;

// A discussion reply is parsed strictly and separately from a planning reply.
// It shares only the envelope and JSON extraction: the round it belongs to
// writes no spec and no task, so nothing here may normalize a half-usable
// answer into one.
export function parseDiscussionReply(stdout) {
  const envelope = extractJson(String(stdout));
  if (!envelope) throw new TypeError(UNUSABLE);
  const payload = extractJson(String(envelope.result || ""));
  if (!payload) throw new TypeError(UNUSABLE);
  for (const key of Object.keys(payload)) if (!DISCUSSION_KEYS.has(key)) throw new TypeError(UNUSABLE);

  const answer = typeof payload.answer === "string" ? payload.answer.trim() : "";
  if (!answer || answer.length > MAX_DISCUSSION_ANSWER) throw new TypeError(UNUSABLE);
  if (payload.contractImpact !== "none" && payload.contractImpact !== "revision_suggested") throw new TypeError(UNUSABLE);

  const raw = payload.suggestion;
  if (raw !== undefined && raw !== null && typeof raw !== "string") throw new TypeError(UNUSABLE);
  const suggestion = typeof raw === "string" ? raw.trim() : "";
  // A verdict of `none` that still carries a revision is contradictory. The
  // sheet offers a handoff control on the suggestion alone, so an accepted
  // contradiction would put that control on an answer that asked for nothing.
  if (payload.contractImpact === "none") {
    if (suggestion) throw new TypeError(UNUSABLE);
    return { answer, contractImpact: "none", suggestion: "" };
  }
  if (!suggestion || suggestion.length > MAX_DISCUSSION_SUGGESTION) throw new TypeError(UNUSABLE);
  return { answer, contractImpact: "revision_suggested", suggestion };
}

const MAX_SCAN_BYTES = 256 * 1024;
const MAX_CANDIDATES = 20;

// Model text may hold prose, several fenced blocks, and stray braces. Try each
// fenced block first, then the raw text, and take the first candidate that
// parses into the shape we need.
function jsonCandidates(text) {
  const source = text.length > MAX_SCAN_BYTES ? text.slice(0, MAX_SCAN_BYTES) : text;
  const fences = [...source.matchAll(/```(?:json)?\s*([\s\S]*?)```/g)].map((match) => match[1]);
  return [...fences.reverse(), source];
}

function extractJson(text) {
  for (const candidate of jsonCandidates(String(text))) {
    const value = firstBalancedObject(candidate);
    if (value) return value;
  }
  return null;
}

// Walks forward from each `{`, tracks depth, and respects strings and escapes,
// so one pass finds the end of each object instead of guessing at every `}`.
function firstBalancedObject(text) {
  let attempts = 0;
  for (let start = text.indexOf("{"); start !== -1 && attempts < MAX_CANDIDATES; start = text.indexOf("{", start + 1)) {
    attempts += 1;
    const end = balancedEnd(text, start);
    if (end === -1) continue;
    try {
      return JSON.parse(text.slice(start, end + 1));
    } catch {
      // This brace opened prose, not an object. Try the next one.
    }
  }
  return null;
}

function balancedEnd(text, start) {
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let index = start; index < text.length; index += 1) {
    const character = text[index];
    if (escaped) { escaped = false; continue; }
    if (character === "\\" && inString) { escaped = true; continue; }
    if (character === '"') { inString = !inString; continue; }
    if (inString) continue;
    if (character === "{") depth += 1;
    else if (character === "}") {
      depth -= 1;
      if (depth === 0) return index;
    }
  }
  return -1;
}

function cleanText(value) {
  return typeof value === "string" ? value.trim().slice(0, 4_000) : "";
}

const USABLE_STATUS = new Set(["ready", "low"]);
const MIN_HEADROOM = 5;
const CLOSE_ENOUGH = 10;
const LABELS = { claude: "Claude", codex: "Codex" };

export function assignAgents(tasks, usage) {
  const claude = providerHeadroom(usage, "claude");
  const codex = providerHeadroom(usage, "codex");
  const list = Array.isArray(tasks) ? tasks : [];

  if (claude === null && codex === null) {
    return list.map((task) => ({ ...task, agent: "claude", agentReason: "Account usage is unavailable" }));
  }
  if (claude === null) return list.map((task) => ({ ...task, ...describe("codex", codex) }));
  if (codex === null) return list.map((task) => ({ ...task, ...describe("claude", claude) }));

  const roomier = codex > claude ? "codex" : "claude";
  const other = roomier === "codex" ? "claude" : "codex";
  const headroom = { claude, codex };
  if (Math.abs(codex - claude) > CLOSE_ENOUGH) {
    return list.map((task) => ({ ...task, ...describe(roomier, headroom[roomier]) }));
  }
  return list.map((task, index) => {
    const agent = index % 2 === 0 ? roomier : other;
    return { ...task, ...describe(agent, headroom[agent]) };
  });
}

// The percentage is the provider's best usable account, not a promise about the
// account that runs the task: assignAgents chooses a provider, never an account.
function describe(agent, percent) {
  return { agent, agentReason: `${LABELS[agent]} · best account ${Math.round(percent)}% left` };
}

// Returns the best headroom across a provider's usable accounts, or null when
// the provider cannot take work right now.
function providerHeadroom(usage, id) {
  const provider = (usage?.providers || []).find((item) => item?.id === id);
  if (!provider) return null;
  const scores = (provider.accounts || [])
    .filter((account) => USABLE_STATUS.has(account?.status))
    .map(accountHeadroom)
    .filter((value) => value !== null);
  if (!scores.length) return null;
  const best = Math.max(...scores);
  return best > MIN_HEADROOM ? best : null;
}

function accountHeadroom(account) {
  const percents = (account?.windows || [])
    .filter((window) => window?.category === "usage" && (window.cadence === "5h" || window.cadence === "weekly"))
    .map((window) => window.remainingPercent)
    .filter((value) => Number.isFinite(value));
  return percents.length ? Math.min(...percents) : null;
}

const DRAFT_TTL_MS = 30 * 60_000;
// A planner round is not slow because it is stuck. It reads the repository, and
// a long goal against a large repository legitimately takes many minutes, while
// printing a tool line every few seconds. Measured: three rounds on one goal all
// died at 361s under the old wall-clock limit and could never have finished.
// So silence is the failure signal, and the ceiling only bounds a true hang.
const ROUND_IDLE_TIMEOUT_MS = Number(process.env.CMUX_PLANNER_IDLE_TIMEOUT_MS) || 240_000;
const ROUND_CEILING_MS = Number(process.env.CMUX_PLANNER_CEILING_MS) || 1_800_000;
// --allowed-tools only AUTO-APPROVES; it does not restrict. Verified against the
// real CLI: with Bash absent from the allow list it still ran. Only
// --disallowed-tools enforces, and the planner runs unsandboxed in the user's
// own repository, so every writing and executing tool must be denied by name.
const ALLOWED_TOOLS = "Read,Grep,Glob";
const DENIED_TOOLS = "Bash,Write,Edit,MultiEdit,NotebookEdit,Task,WebFetch,WebSearch";
// The planner reads a repository and answers with JSON. It wants no plugin, no
// skill and no MCP server: its own prompt already spends words fighting them.
// Measured on a real round, three times: these three flags cut the context from
// 52k tokens to 30k and the cost by 42%. They also drop the tool surface from 43
// to 19, so the planner can no longer reach a browser or a web search. The
// project CLAUDE.md still loads, which is the context it actually needs, and ccs
// still chooses the model, so nothing the planner depends on is lost.
const ISOLATION = ["--setting-sources", "", "--strict-mcp-config", "--disable-slash-commands"];
const MAX_TASKS = 8;
const MAX_IMAGES = 4;
const MAX_DRAFTS = 50;

export function normalizePlannerEngine(engine, roles = DEFAULT_MODEL_ROLES) {
  if (engine === undefined) engine = {};
  if (!engine || typeof engine !== "object" || Array.isArray(engine)) {
    throw new TypeError("Planner engine configuration must be an object");
  }
  const provider = engine.provider ?? roles.planner.provider;
  if (typeof provider !== "string" || !Object.hasOwn(PLANNER_ENGINES.providers, provider)) {
    throw new TypeError("Unknown planner provider. Choose Claude or Codex");
  }
  const model = normalizeModelId(engine.model ?? roleEngine(roles, "planner", provider).model);
  const effort = engine.effort ?? PLANNER_ENGINES.defaultEffort;
  if (!PLANNER_ENGINES.efforts.some((option) => option.id === effort)) {
    throw new TypeError("Unknown planner effort. Choose Default, Low, Medium, High, or Xhigh");
  }
  if (engine.reviewer !== undefined && typeof engine.reviewer !== "boolean") {
    throw new TypeError("The reviewer setting must be on or off");
  }
  return { provider, model, effort, reviewer: engine.reviewer === true };
}

// ccs draws its errors as a box: ANSI colour, border glyphs, a blank padded
// line between every sentence, and a bare docs URL last. Taking the last stderr
// line therefore reported only the URL. Strip the frame, then keep the words.
const BOX_GLYPHS = /[\u2500-\u257f]/gu;
// eslint-disable-next-line no-control-regex -- stripping ANSI needs the escape byte.
const ANSI = /\u001b\[[0-9;]*m/gu;

export function describeRunFailure(stderr) {
  const lines = String(stderr || "")
    .replace(ANSI, "")
    .replace(BOX_GLYPHS, " ")
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);
  const text = lines.join(" ");
  // E301 is the one failure an operator can fix without reading the docs, and
  // the launchd PATH omits ~/.local/bin, where the installer puts claude.
  if (/E301|Claude CLI not found/i.test(text)) {
    return "The planner could not run: ccs cannot find the claude CLI on PATH. Add its directory to the companion PATH, or set CCS_CLAUDE_PATH to the binary";
  }
  const detail = lines.filter((line) => !/^https?:\/\//.test(line) && line !== "ERROR").at(-1);
  return detail ? `The planner could not run: ${detail.slice(0, 160)}` : "The planner could not run. Try again";
}

// A killed round has two very different causes, and the user acts on each one
// differently: silence means try again, while the ceiling means the goal is too
// large for one round. An unlabelled kill keeps the old wording, because a fake
// `execute` in a test rejects without a reason.
export function describeTimeout(reason, idleTimeoutMs, ceilingMs) {
  if (reason === "aborted") return ABORTED_ROUND;
  if (reason === "idle") return `The planner stopped answering: no output for ${minutes(idleTimeoutMs)}. Try again`;
  if (reason === "ceiling") return `The planner ran for ${minutes(ceilingMs)} without finishing. Start again with a narrower goal`;
  return "The planner did not answer in time. Try again";
}

function minutes(ms) {
  const value = Math.max(1, Math.round(Number(ms) / 60_000));
  return `${value} minute${value === 1 ? "" : "s"}`;
}

export class WorktreePlanner {
  constructor({ worktrees, cmux, accountUsage, modelSettings = new ModelSettings(), log = null, execute = streamExecFile, git = null, maxRounds = 6, idleTimeoutMs = ROUND_IDLE_TIMEOUT_MS, ceilingMs = ROUND_CEILING_MS, usageTimeoutMs = 10_000, ttlMs = DRAFT_TTL_MS, store = null, runs = null, launches = null, progress = null, pushService = null, briefs = new AgentBriefs(), onLaunchSettled = null } = {}) {
    if (!worktrees) throw new TypeError("A worktree dashboard is required");
    if (!cmux) throw new TypeError("A cmux client is required");
    this.worktrees = worktrees;
    // The dashboard owns the repo catalog, which owns the injected git runner.
    this.git = git || ((cwd, args, options) => worktrees.repoCatalog.git(cwd, args, options));
    this.cmux = cmux;
    this.modelSettings = modelSettings;
    this.accountUsage = accountUsage;
    // The full brief goes to a file. cmux caps a prompt at 8,000 characters, so
    // the session gets a short pointer to that file instead of the brief text.
    this.briefs = briefs;
    this.log = log;
    this.execute = execute;
    this.maxRounds = maxRounds;
    this.idleTimeoutMs = idleTimeoutMs;
    this.ceilingMs = ceilingMs;
    this.usageTimeoutMs = usageTimeoutMs;
    this.ttlMs = ttlMs;
    // The database owns every plan. The map is only a hot cache in front of it,
    // so a companion restart loses no goal, no session and no task list.
    this.store = store;
    // A background round outlives its request, so the registry, not the request
    // cycle, is what says whether a plan is busy.
    this.runs = runs || new PlannerRuns();
    // A launch is not a specification round, so it gets its own registry. One
    // shared map would put a launching goal in the "Writing Spec" column.
    this.launches = launches || new LaunchRuns();
    // The dashboard caches describe worktrees a background launch creates, so
    // they can only be invalidated once that launch has settled.
    this.onLaunchSettled = onLaunchSettled;
    // The same hub the synchronous rounds publish to. A background round keys
    // its stream on the plan id, which exists before the round starts.
    this.progress = progress;
    this.pushService = pushService;
    this.drafts = new Map();
    // One controller per active round, keyed by plan id. Abort reaches the ccs
    // child through it, and every exit path deletes its own entry, so a
    // finished round leaves nothing behind for a later abort to kill.
    this.controllers = new Map();
    this.taskOperations = new Set();
  }

  async start({ repositoryId, goal, images, engine, specOptions, reviewOptions, issueNumbers = [], issueUrls = [], deliveryPolicy = "auto", onEvent = null }) {
    const draft = await this.#createDraft({ repositoryId, goal, images, engine, specOptions, reviewOptions, issueNumbers, issueUrls, deliveryPolicy });
    return this.#round(draft, openingPrompt(draft), onEvent);
  }

  // The row is written before the round runs, so a plan id exists the moment a
  // goal is submitted. That id is what the progress stream, the goal card and
  // the notification all key on.
  async #createDraft({ repositoryId, goal, images, engine, specOptions, reviewOptions, issueNumbers = [], issueUrls = [], deliveryPolicy = "auto" }) {
    const text = String(goal || "").trim();
    if (!text) throw new TypeError("Describe the goal for this repository");
    if (text.length > 4_000) throw new TypeError("That goal is too long");
    const attachments = normalizeImages(images);
    const linkedIssues = normalizeIssueNumbers(issueNumbers);
    const linkedIssueUrls = normalizeIssueUrls(issueUrls);
    const normalizedDeliveryPolicy = deliveryPolicy === "combined" ? "combined" : "auto";
    const normalizedEngine = normalizePlannerEngine(engine, this.modelSettings.roles);
    // Normalized before the repository scan, so an unknown option id refuses
    // the goal instead of leaving an unusable plan row behind.
    const normalizedSpecOptions = normalizeSpecOptions(specOptions);
    // The review request never reaches the planner prompt or a task brief. It
    // describes what happens after the pull request exists, which is nothing
    // the planner can plan for or evidence.
    const normalizedReviewOptions = normalizeReviewOptions(reviewOptions, this.modelSettings.roles);
    const repository = await this.#repository(repositoryId);
    const draft = {
      planId: randomUUID(),
      repositoryId: repository.id,
      repositoryName: repository.name,
      cwd: repository.primaryPath,
      goal: text,
      images: attachments,
      sourceType: linkedIssues.length ? "github_issues" : null,
      issueNumbers: linkedIssues,
      issueUrls: linkedIssueUrls,
      deliveryPolicy: normalizedDeliveryPolicy,
      engine: normalizedEngine,
      specOptions: normalizedSpecOptions,
      reviewOptions: normalizedReviewOptions,
      sessionId: null,
      round: 0,
      at: Date.now(),
      status: "questions",
      questions: [],
      spec: null,
      readiness: null,
      tasks: [],
    };
    this.#sweep();
    if (this.drafts.size >= MAX_DRAFTS) {
      const oldest = [...this.drafts.entries()].sort((left, right) => left[1].at - right[1].at)[0];
      if (oldest) this.drafts.delete(oldest[0]);
    }
    const conflicting = [...this.drafts.values()].find((other) => other.repositoryId === repositoryId && (other.issueNumbers || []).some((number) => linkedIssues.includes(number)));
    if (conflicting) throw Object.assign(new TypeError("An issue already belongs to a saved goal"), { code: "ISSUE_ALREADY_PLANNED", planId: conflicting.planId });
    // No model work has been paid for yet. A failed reservation must stop here,
    // unlike a history write after a completed round.
    this.store?.createPlan({
      planId: draft.planId,
      repositoryId: draft.repositoryId,
      repositoryName: draft.repositoryName,
      cwd: draft.cwd,
      goal: draft.goal,
      images: draft.images,
      sourceType: draft.sourceType,
      issueNumbers: draft.issueNumbers,
      issueUrls: draft.issueUrls,
      deliveryPolicy: draft.deliveryPolicy,
      engine: draft.engine,
      specOptions: draft.specOptions,
      reviewOptions: draft.reviewOptions,
    });
    this.drafts.set(draft.planId, draft);
    return draft;
  }

  // The background entry point. It answers as soon as the row exists, and the
  // round runs on after the request has ended. The caller gets a plan id it can
  // watch, resume and delete, so the sheet is free to close.
  async startBackground({ repositoryId, goal, images, engine, specOptions, reviewOptions, issueNumbers = [], issueUrls = [], deliveryPolicy = "auto" }) {
    const draft = await this.#createDraft({ repositoryId, goal, images, engine, specOptions, reviewOptions, issueNumbers, issueUrls, deliveryPolicy });
    this.#detach(draft, openingPrompt(draft), "plan");
    return { ...publicDraft(draft), running: true };
  }

  // A background answer round. The plan already exists, so this only starts the
  // round and returns the draft as it stands.
  async answerBackground(planId, { answers = [], skip = false } = {}) {
    const draft = await this.#draft(planId);
    this.#assertIdle(draft.planId);
    if (draft.round >= this.maxRounds) {
      throw new TypeError("The planner could not produce a plan. Start again with a narrower goal");
    }
    const { prompt, pairs } = answerRound(draft, answers, skip);
    this.#detach(draft, prompt, "answer", { answers: pairs, skipped: skip });
    return { ...publicDraft(draft), running: true };
  }

  // The reviewer read the split and rejected it. This is a new round on the same
  // plan, not an edit: the planner has to think again, so it goes through
  // #round exactly like an answer round does.
  async feedback(planId, { text, onEvent = null } = {}) {
    const { draft, note } = await this.#rejection(planId, text);
    return this.#round(draft, feedbackRound(draft, note), onEvent, { feedback: note });
  }

  // The background twin. It answers as soon as the round is registered, so the
  // sheet can close while the planner reconsiders the split.
  async feedbackBackground(planId, { text } = {}) {
    const { draft, note } = await this.#rejection(planId, text);
    this.#detach(draft, feedbackRound(draft, note), "feedback", { feedback: note });
    return { ...publicDraft(draft), running: true };
  }

  // Both feedback paths refuse the same four things, and they must refuse them
  // identically: the sheet shows whichever sentence comes back.
  async #rejection(planId, text) {
    const draft = await this.#draft(planId);
    this.#assertIdle(draft.planId);
    // A rejection costs a round, so it obeys the same cap as an answer round.
    if (draft.round >= this.maxRounds) {
      throw new TypeError("The planner could not produce a plan. Start again with a narrower goal");
    }
    return { draft, note: feedbackNote(draft, text) };
  }

  // A question about the Delivery Contract that is on screen right now. It is
  // not a round: it writes no spec, no task and no session id, and it does not
  // consume maxRounds. The planner reads the repository and explains the
  // contract, so the user can decide whether to launch it or reject it.
  async discuss(planId, { text, onEvent = null } = {}) {
    const { draft, question, round } = await this.#discussable(planId, text);
    return this.#controlled(draft.planId, null, (signal) => this.#discussionWork(draft, question, round, onEvent, signal));
  }

  // The background twin. It answers as soon as the discussion is registered, so
  // the sheet is free to close while the planner reads the repository.
  async discussBackground(planId, { text } = {}) {
    const { draft, question, round } = await this.#discussable(planId, text);
    this.#detached(draft, "discuss", "discussing", (controller, onEvent) => (
      this.#controlled(draft.planId, controller, (signal) => this.#discussionWork(draft, question, round, onEvent, signal))
    ), {
      done: () => this.#notifyDiscussion(draft),
      failed: (message) => this.#notifyFailure(draft, message),
    });
    return { ...publicDraft(draft), running: true, runStage: "discussing" };
  }

  // Both discussion paths refuse the same things, and they must refuse them
  // identically: the sheet shows whichever sentence comes back.
  async #discussable(planId, text) {
    // #draft carries the durable unknown, terminal and launched guards, so a
    // discussion refuses those plans in the sentences they already use.
    const draft = await this.#draft(planId);
    this.#assertIdle(draft.planId);
    if (draft.status !== "ready" || !draft.tasks.length) throw new TypeError(NO_CONTRACT_TO_QUESTION);
    const question = String(text || "").trim();
    if (!question) throw new TypeError(EMPTY_QUESTION);
    if (question.length > 2_000) throw new TypeError(LONG_QUESTION);
    // Only answered questions count. A failed or aborted attempt wrote nothing,
    // so it must not spend one of the twelve.
    const asked = this.#read(() => this.store?.discussions(draft.planId))?.length || 0;
    if (asked >= DISCUSSION_CAP) throw new TypeError(DISCUSSION_EXHAUSTED);
    // The round is captured before the answer, so the stored discussion names
    // the contract round it examined rather than a later one.
    return { draft, question, round: draft.round };
  }

  async #discussionWork(draft, question, round, onEvent, signal) {
    const reply = await this.#discussionReply(draft, question, onEvent, signal);
    this.#persist(() => this.store?.recordDiscussion(draft.planId, { question, ...reply, round }), draft.planId, "discussion");
    return { planId: draft.planId, round, question, ...reply };
  }

  // One retry, exactly like a planning round: a second sample often parses. The
  // reply is never allowed to change the draft, so the session id it carries is
  // read and discarded.
  async #discussionReply(draft, question, onEvent, signal) {
    const read = async () => parseDiscussionReply(
      await this.#spawn(draft, discussionPrompt(draft, question), draft.engine, draft.sessionId, onEvent, signal),
    );
    try {
      return await read();
    } catch (cause) {
      if (cause instanceof PlannerRunError || !(cause instanceof TypeError)) throw cause;
      emit(onEvent, { k: "text", t: "Retrying…" });
      return read();
    }
  }

  // Neutral by design. The answer may say the contract is wrong, so a
  // notification that claimed a plan was ready would be a lie, and the answer
  // text itself belongs in the sheet rather than on a lock screen.
  #notifyDiscussion(draft) {
    void this.#push({
      title: "A goal answered your question",
      body: `An answer about “${shortGoal(draft.goal)}” is ready to read`,
      kind: "attention",
      planId: draft.planId,
    });
  }

  // A companion restart kills the ccs child, so a plan can be left at round 0
  // with no questions and no tasks. This runs its opening prompt again.
  async run(planId) {
    const draft = await this.#draft(planId);
    this.#assertIdle(draft.planId);
    if (draft.round > 0) throw new TypeError("This goal already has a plan round. Answer it instead");
    this.#detach(draft, openingPrompt(draft), "plan");
    return { ...publicDraft(draft), running: true };
  }

  // Nothing awaits the round, so every outcome must be handled here: the
  // registry records it, the progress stream closes, and one notification goes
  // out. An unhandled rejection would take the whole companion down.
  #detach(draft, prompt, kind, submitted = null) {
    const planId = draft.planId;
    // The previous failure is answered by this attempt, so it stops being the
    // plan's state the moment the new round starts.
    draft.lastError = null;
    draft.lastErrorAt = null;
    this.#detached(draft, kind, "writing_spec", (controller, onEvent) => this.#round(draft, prompt, onEvent, submitted, controller), {
      done: (result) => this.#notifyRound(draft, result),
      failed: (message) => {
        // The stream is closed and the run registry expires within a minute, so
        // a sheet reopened later has no other way to learn what went wrong.
        draft.lastError = message;
        draft.lastErrorAt = new Date().toISOString();
        this.#persist(() => this.store?.recordRoundFailure(planId, message), planId, "round-failed");
        this.#notifyFailure(draft, message);
      },
    });
  }

  // Everything every detached round shares: the run registry entry, the
  // progress stream, the log line and the abort race. What one kind of round
  // records on top of that is the caller's, so a discussion never reaches the
  // task-plan notification or the task-plan failure write.
  #detached(draft, kind, stage, work, { done = null, failed = null } = {}) {
    const planId = draft.planId;
    const controller = new AbortController();
    // Registered before the work starts. An abort in the same tick would
    // otherwise find no controller and leave the child running.
    this.controllers.set(planId, controller);
    this.runs.begin(planId, kind, { stage });
    const onEvent = (event) => {
      this.progress?.publish(planId, event);
      if (event?.t) this.runs.step(planId, event.t);
    };
    Promise.resolve()
      .then(() => work(controller, onEvent))
      .then((result) => {
        // Abort already published the outcome and finished the run as aborted.
        // The settlement below arrives after it, so it must add nothing: a
        // second publish would overwrite a phase the user asked for.
        if (controller.signal.aborted) return;
        this.progress?.publish(planId, { k: "done" });
        this.runs.finish(planId, { phase: "done" });
        done?.(result);
      })
      .catch((cause) => {
        const message = cause?.message || "The planner round failed";
        this.log?.warn?.({ err: cause, planId }, "background planner round failed");
        if (controller.signal.aborted) return;
        this.progress?.publish(planId, { k: "error", t: message });
        this.runs.finish(planId, { phase: "failed", error: message });
        failed?.(message);
      });
  }

  #notifyRound(draft, result) {
    const questions = result?.status === "questions";
    void this.#push({
      title: questions ? "A goal needs your answers" : "A goal plan is ready",
      body: questions
        ? `Round ${result.round}: ${result.questions.length} question${result.questions.length === 1 ? "" : "s"} about “${shortGoal(draft.goal)}”`
        : `${result.tasks.length} task${result.tasks.length === 1 ? "" : "s"} ready to launch for “${shortGoal(draft.goal)}”`,
      kind: questions ? "attention" : "completion",
      planId: draft.planId,
    });
  }

  #notifyFailure(draft, message) {
    void this.#push({
      title: "A goal plan failed",
      body: `“${shortGoal(draft.goal)}”: ${message}`,
      kind: "failure",
      planId: draft.planId,
    });
  }

  // One notification per background launch, and only one. It names the count,
  // because "the launch finished" does not say whether anything started.
  #notifyLaunch(draft, result) {
    const launched = Number(result?.launched) || 0;
    // A launch that started nothing is a failure the user has to act on, even
    // though no exception was thrown. It must not report as a success.
    if (launched === 0) {
      const reason = result?.results?.find((item) => item?.status === "failed")?.error || "No task could start";
      this.#notifyLaunchFailure(draft, reason);
      return;
    }
    void this.#push({
      title: "A goal is running",
      body: `${launched} session${launched === 1 ? "" : "s"} started for “${shortGoal(draft.goal)}”`,
      kind: "completion",
      planId: draft.planId,
    });
  }

  #notifyLaunchFailure(draft, message) {
    void this.#push({
      title: "A goal launch failed",
      body: `“${shortGoal(draft.goal)}”: ${message}`,
      kind: "failure",
      planId: draft.planId,
    });
  }

  // A launch that threw wrote nothing, so the plan would show a goal that is
  // still "ready to launch" and no reason why the launch never happened. The
  // per-task rows carry the failure and the plan row carries the sentence, so
  // a sheet reopened later can explain it.
  #recordLaunchFailure(draft, message) {
    const results = (draft.tasks || []).map((task) => ({
      id: task.id,
      title: task.title,
      branch: task.branch,
      agent: task.agent,
      status: "failed",
      error: message,
    }));
    this.#persist(() => this.store?.recordLaunch(draft.planId, { base: null, baseSha: null, results }), draft.planId, "launch-failed");
    draft.lastError = message;
    draft.lastErrorAt = new Date().toISOString();
    this.#persist(() => this.store?.recordRoundFailure(draft.planId, message), draft.planId, "launch-failed");
  }

  // The dashboard caches describe the worktrees this launch created, so they
  // are only stale once it has settled. A hook that throws must never turn a
  // finished launch into a failed one.
  #launchSettled(planId) {
    try {
      this.onLaunchSettled?.(planId);
    } catch (cause) {
      this.log?.warn?.({ err: cause, planId }, "launch settled hook failed");
    }
  }

  // A notification is the least important part of a round. It must never turn a
  // finished plan into a failed one.
  async #push(payload) {
    try {
      await this.pushService?.send({ ...payload, tag: `cmux-plan-${payload.planId}` });
    } catch (cause) {
      this.log?.warn?.({ err: cause, planId: payload.planId }, "planner notification failed");
    }
  }

  // One ccs session id belongs to one plan, so two rounds at once on the same
  // plan would corrupt it. Different plans are free to run together.
  #assertIdle(planId) {
    if (this.runs.isRunning(planId)) throw new TypeError(BUSY);
  }

  // A terminal goal takes no more work. It stays readable and deletable, so
  // only the mutating paths call this.
  #assertNotTerminal(planId) {
    const status = this.#read(() => this.store?.get(String(planId || ""))?.boardStatus) || null;
    if (status === "aborted") throw new TypeError(ABORTED_PLAN);
    if (status === "merged") throw new TypeError(MERGED_PLAN);
  }

  // Stop a goal for good. It closes every cmux session the goal is known to
  // own, and it deliberately leaves the worktrees, the branches and the plan
  // row alone: the work stays on disk for the user to read or reuse.
  //
  // The whole call is idempotent. A second abort records no second event and
  // retries only the closures that failed the first time.
  async abort(planId) {
    const id = String(planId || "");
    const plan = this.#read(() => this.store?.get(id));
    if (!plan) throw new TypeError("Unknown plan. Start a new goal");
    if (plan.boardStatus === "merged") throw new TypeError("This goal is already merged, so it cannot be aborted");
    const alreadyAborted = plan.boardStatus === "aborted";

    // Cancel the live specification round first. Its child dies, its run and
    // its progress stream finish as aborted, and no later round can start.
    const controller = this.controllers.get(id);
    if (controller) {
      controller.abort();
      this.controllers.delete(id);
    }
    if (this.runs.isRunning(id)) {
      this.progress?.publish(id, { k: "error", t: ABORTED_ROUND });
      this.runs.finish(id, { phase: "aborted", error: ABORTED_ROUND });
    }
    this.drafts.delete(id);
    if (!alreadyAborted) this.#persist(() => this.store?.recordGoalAborted(id), id, "abort");

    const closedSessionIds = [];
    const failedSessionIds = [];
    for (const workspaceId of goalWorkspaceIds(plan)) {
      try {
        await this.cmux?.workspaceClose?.(workspaceId);
        closedSessionIds.push(workspaceId);
      } catch (cause) {
        this.log?.warn?.({ err: cause, planId: id, workspaceId }, "closing an aborted goal session failed");
        failedSessionIds.push(workspaceId);
      }
    }
    return { planId: id, aborted: true, alreadyAborted, closedSessionIds, failedSessionIds };
  }

  // One task starts again on a plan that is already launched.
  //
  // `launch()` cannot do this. It goes through `#draft`, which refuses every
  // launched plan, so a task whose agent died had no route back and the goal
  // was locked for good. This reads the stored plan directly, exactly as the
  // integrator does for a wave, and touches one task only.
  //
  // Three modes, because a dead agent, a wrong turn and a branch ownership
  // collision need different things:
  //   - `continue` keeps the worktree and whatever the agent already wrote,
  //     and opens a fresh session on it. This is the common case.
  //   - `restart` throws the working tree away and rebuilds from the base.
  //   - `rebranch` preserves it and starts in a newly derived branch.
  async relaunchTask(planId, taskId, options = {}) {
    const key = `${planId}/${taskId}`;
    if (this.taskOperations.has(key)) throw new TypeError("This task already has a recovery operation in progress");
    this.taskOperations.add(key);
    try { return await this.#relaunchTask(planId, taskId, options); }
    finally { this.taskOperations.delete(key); }
  }

  async #relaunchTask(planId, taskId, { mode = "continue", closeLive = false } = {}) {
    if (!new Set(["continue", "restart", "rebranch"]).has(mode)) throw new TypeError("Relaunch mode must be continue, restart, or rebranch");
    const { plan, task } = this.#launchedTask(planId, taskId);
    if (task.deliveryStatus === "integrated") throw new TypeError("This task is already merged into the goal branch");
    if (!this.cmux) throw new TypeError("Relaunching a task needs a cmux connection");

    // Two agents in one worktree would fight over the same files, so a live
    // session must go before a new one starts.
    //
    // A crashed agent usually leaves its workspace open at a shell prompt, and
    // that is the commonest way a task dies. Refusing outright sent the user to
    // cmux to close it by hand and come back, which is the round trip this
    // whole path exists to remove. `closeLive` closes it here instead — but
    // only when asked, because a session that is genuinely working must never
    // be killed by a button labelled Continue.
    const inventory = await this.#workspaces();
    if (task.workspaceId && !inventory.available) {
      throw new TypeError("This task's cmux session could not be checked. Reconnect cmux before relaunching it");
    }
    const live = task.workspaceId
      ? inventory.workspaces.find((workspace) => workspace?.id === task.workspaceId) || null
      : null;
    if (live && !closeLive) throw new TypeError("This task's cmux session is still open. Close it first, or answer it, before relaunching");
    if (live) {
      let closeError;
      try { await this.cmux.workspaceClose(task.workspaceId); }
      catch (cause) { closeError = cause; }
      // Even an acknowledged close must become visible in a fresh inventory.
      // A transport failure is recoverable only when that inventory proves
      // the old workspace is gone; it is never permission for another writer.
      const fresh = await this.#workspaces();
      if (!fresh.available || fresh.workspaces.some((workspace) => workspace?.id === task.workspaceId)) {
        throw new TypeError(`The previous session could not be confirmed closed. Retry before relaunching${closeError?.message ? `: ${closeError.message}` : ""}`);
      }
    }

    const base = plan.deliveryMode === "combined" && plan.integrationBranch ? plan.integrationBranch : plan.baseRef || "origin/main";
    const result = mode === "restart"
      ? await this.#relaunchClean(plan, task, base, inventory)
      : mode === "rebranch"
        ? await this.#relaunchRebranch(plan, task, base, inventory)
        : await this.#relaunchContinue(plan, task);
    // The dead session is recorded as closed before the new id is written, or
    // the old workspace id would vanish with nothing saying it was retired.
    if (task.workspaceId) this.#persist(() => this.store?.recordSessionsRetired(plan.planId, [{ workspaceId: task.workspaceId, taskId: task.id }]), plan.planId, "relaunch-retire");
    this.#persist(() => this.store?.recordTaskRelaunch(plan.planId, task.id, result), plan.planId, "relaunch");
    if (result.status === "failed") throw new TypeError(result.error || "Could not relaunch this task");
    return { planId: plan.planId, taskId: task.id, mode, ...result };
  }

  // Drop a task the goal no longer needs, so one dead task stops blocking the
  // merge for every other task that finished.
  async skipTask(planId, taskId, { reason = null } = {}) {
    const { plan, task } = this.#launchedTask(planId, taskId);
    if (task.deliveryStatus === "integrated") throw new TypeError("This task is already merged, so it cannot be skipped");
    let closedSession = null;
    if (task.workspaceId && await this.#liveSession(task.workspaceId)) {
      closedSession = await this.cmux?.workspaceClose?.(task.workspaceId).then(() => task.workspaceId, (cause) => {
        this.log?.warn?.({ err: cause, planId: plan.planId, taskId: task.id }, "closing a skipped task session failed");
        return null;
      });
    }
    this.#persist(() => this.store?.recordTaskSkipped(plan.planId, task.id, reason), plan.planId, "skip");
    return { planId: plan.planId, taskId: task.id, skipped: true, closedSession };
  }

  // Reuse the existing worktree with its work in it. `worktrees.create` refuses
  // a dirty worktree by design, which is right for a launch and wrong here:
  // half-finished work is exactly what this mode continues. So the path is
  // checked directly and no worktree call is made.
  async #relaunchContinue(plan, task) {
    const summary = { id: task.id, title: task.title, branch: task.branch, agent: task.agent };
    const path = String(task.worktreePath || "");
    if (!path || !existsSync(path)) {
      throw new TypeError("This task has no worktree left to continue. Relaunch it with restart instead");
    }
    try {
      const head = String(await this.git(path, ["rev-parse", "HEAD"]).catch(() => "")).trim() || null;
      const brief = await this.briefs.write({
        planId: plan.planId,
        taskId: task.id,
        markdown: taskPrompt(task, plan.spec, plan.images, task.branch, plan.deliveryMode, `${plan.planId}/${task.id}`, plan.issueNumbers, plan.specOptions),
      });
      const workspace = await this.cmux.workspaceCreate({
        cwd: path,
        title: sessionTitle(plan, task),
        ...this.modelSettings.workspace("coder", task.agent),
        env: sessionEnv(plan, task),
        prompt: this.briefs.pointerPrompt({
          title: task.title,
          outcome: plan.spec?.outcome || plan.goal,
          path: brief.path,
          resume: "A previous agent worked in this worktree and stopped. Read the brief, then run `git status` and `git log` to see what is already done. Continue from there. Do not start again from nothing.",
        }),
      });
      return { ...summary, status: "launched", launchReason: null, path, workspace, startSha: task.startSha || head };
    } catch (cause) {
      this.log?.warn?.({ err: cause, planId: plan.planId, taskId: task.id }, "task relaunch failed");
      return { ...summary, status: "failed", launchReason: launchReason(cause), path, error: cause?.message || "Could not relaunch this task" };
    }
  }

  // Throw the working tree away and start the task again from its base. The
  // branch is deleted first, because `create` checks out an existing branch and
  // would put the agent back on the work this mode was asked to discard.
  async #relaunchClean(plan, task, base, inventory) {
    const summary = { id: task.id, title: task.title, branch: task.branch, agent: task.agent };
    let branch = task.branch;
    let path = null;
    try {
      await this.worktrees.removeBranchWorktree(plan.repositoryId, task.branch, {
        workspaces: inventory.workspaces,
        workspacesAvailable: inventory.available,
        allowedWorkspaceIds: task.workspaceId ? [task.workspaceId] : [],
      });
      const created = await acquireTaskWorktree({
        worktrees: this.worktrees,
        repositoryId: plan.repositoryId,
        repositoryPath: plan.cwd,
        branch: task.branch,
        base,
        inventory,
        git: this.git,
        planId: plan.planId,
        taskId: task.id,
        log: this.log,
      });
      branch = created.branch;
      const effectiveTask = { ...task, branch: created.branch };
      path = created.worktree.path;
      const startSha = String(await this.git(path, ["rev-parse", "HEAD"]).catch(() => "")).trim() || null;
      const brief = await this.briefs.write({
        planId: plan.planId,
        taskId: task.id,
        markdown: taskPrompt(effectiveTask, plan.spec, plan.images, base, plan.deliveryMode, `${plan.planId}/${task.id}`, plan.issueNumbers, plan.specOptions),
      });
      const workspace = await this.cmux.workspaceCreate({
        cwd: path,
        title: sessionTitle(plan, effectiveTask),
        ...this.modelSettings.workspace("coder", effectiveTask.agent),
        env: sessionEnv(plan, effectiveTask),
        prompt: this.briefs.pointerPrompt({ title: task.title, outcome: plan.spec?.outcome || plan.goal, path: brief.path }),
      });
      return { ...summary, branch: effectiveTask.branch, status: "launched", launchReason: null, path, workspace, startSha };
    } catch (cause) {
      branch = effectiveTaskBranch(cause, branch);
      this.log?.warn?.({ err: cause, branch, planId: plan.planId, taskId: task.id }, "task restart failed");
      return { ...summary, branch, status: "failed", launchReason: launchReason(cause), path, error: cause?.message || "Could not restart this task" };
    }
  }

  // A branch collision is not permission to delete the occupied branch. This
  // mode derives the next bounded candidate and creates exactly one new
  // worktree from the same base a clean restart would use.
  async #relaunchRebranch(plan, task, base, inventory) {
    const summary = { id: task.id, title: task.title, branch: task.branch, agent: task.agent };
    let branch = task.branch;
    let path = null;
    try {
      const created = await acquireTaskWorktree({
        worktrees: this.worktrees,
        repositoryId: plan.repositoryId,
        repositoryPath: plan.cwd,
        branch: task.branch,
        base,
        inventory,
        git: this.git,
        planId: plan.planId,
        taskId: task.id,
        log: this.log,
        forceFresh: true,
        fallbackReason: task.launchReason,
      });
      branch = created.branch;
      const effectiveTask = { ...task, branch: created.branch };
      path = created.worktree.path;
      const startSha = String(await this.git(path, ["rev-parse", "HEAD"]).catch(() => "")).trim() || null;
      const brief = await this.briefs.write({
        planId: plan.planId,
        taskId: task.id,
        markdown: taskPrompt(effectiveTask, plan.spec, plan.images, base, plan.deliveryMode, `${plan.planId}/${task.id}`, plan.issueNumbers, plan.specOptions),
      });
      const workspace = await this.cmux.workspaceCreate({
        cwd: path,
        title: sessionTitle(plan, effectiveTask),
        ...this.modelSettings.workspace("coder", effectiveTask.agent),
        env: sessionEnv(plan, effectiveTask),
        prompt: this.briefs.pointerPrompt({ title: effectiveTask.title, outcome: plan.spec?.outcome || plan.goal, path: brief.path }),
      });
      return { ...summary, branch: effectiveTask.branch, status: "launched", launchReason: null, path, workspace, startSha };
    } catch (cause) {
      branch = effectiveTaskBranch(cause, branch);
      this.log?.warn?.({ err: cause, branch, planId: plan.planId, taskId: task.id }, "task rebranch failed");
      return { ...summary, branch, status: "failed", launchReason: launchReason(cause), path, error: cause?.message || "Could not rebranch this task" };
    }
  }

  // Reads a task from the durable row, never the draft cache. Both recovery
  // actions are for launched plans, which the draft cache refuses by design.
  #launchedTask(planId, taskId) {
    const id = String(planId || "");
    this.#assertNotTerminal(id);
    const plan = this.#read(() => this.store?.get(id));
    if (!plan) throw new TypeError("Unknown plan. Start a new goal");
    if (plan.status !== "launched") throw new TypeError("This goal has not launched yet, so it has no task to recover");
    const task = (plan.tasks || []).find((item) => item.id === String(taskId || ""));
    if (!task) throw new TypeError("Unknown task in this goal");
    return { plan, task };
  }

  // Returns the live workspace when cmux still holds it. Callers that can
  // create a competing task session use #workspaces directly so unavailable
  // inventory remains distinct from a confirmed empty list.
  async #liveSession(workspaceIdValue) {
    const id = String(workspaceIdValue || "").trim();
    if (!id) return null;
    const inventory = await this.#workspaces();
    if (!inventory.available) return null;
    return inventory.workspaces.find((workspace) => workspace?.id === id) || null;
  }

  isRunning(planId) {
    return this.runs.isRunning(planId);
  }

  // A launch is not a planner round, so it answers a question of its own.
  isLaunching(planId) {
    return this.launches.isLaunching(planId);
  }

  activeRuns() {
    return { runs: this.runs.list() };
  }

  async answer(planId, { answers = [], skip = false, onEvent = null } = {}) {
    const draft = await this.#draft(planId);
    this.#assertIdle(draft.planId);
    if (draft.round >= this.maxRounds) {
      throw new TypeError("The planner could not produce a plan. Start again with a narrower goal");
    }
    const { prompt, pairs } = answerRound(draft, answers, skip);
    return this.#round(draft, prompt, onEvent, { answers: pairs, skipped: skip });
  }

  async update(planId, { tasks } = {}) {
    const draft = await this.#draft(planId);
    this.#assertIdle(draft.planId);
    if (!Array.isArray(tasks) || !tasks.length) throw new TypeError("Keep at least one task");
    if (tasks.length > MAX_TASKS) throw new TypeError(`A plan can hold at most ${MAX_TASKS} tasks`);
    const next = tasks.map((task, index) => {
      const previous = draft.tasks.find((item) => item.id === task?.id) || draft.tasks[index] || {};
      const branch = String(task?.branch || "").trim();
      if (!/^[A-Za-z0-9][A-Za-z0-9._/-]{0,80}$/.test(branch) || branch.includes("..")) {
        throw new TypeError(`Task ${index + 1} needs a valid Git branch name`);
      }
      const title = String(task?.title || "").trim();
      const prompt = String(task?.prompt || "").trim();
      if (!title || !prompt) throw new TypeError(`Task ${index + 1} needs a title and a prompt`);
      const agent = task?.agent === "codex" ? "codex" : "claude";
      const contract = normalizeContractTask({
        criterionIds: draft.spec?.acceptanceCriteria?.map((criterion) => criterion.id) || [],
        ownedAreas: ["**/*"],
        verification: ["Run the repository verification appropriate for this task"],
        ...previous,
        ...task,
        title, branch, prompt,
      }, index);
      return { ...contract, agent, agentReason: String(task?.agentReason || "") };
    });
    const branches = new Set(next.map((task) => task.branch));
    if (branches.size !== next.length) throw new TypeError("Two tasks share a branch name");
    const readiness = validateDeliveryContract(draft.spec, next, draft.specOptions);
    if (!readiness.ready) throw new TypeError(readiness.errors[0]);
    draft.tasks = next.map((task) => ({ ...task, wave: taskWave(task.id, readiness) }));
    draft.readiness = readiness;
    draft.at = Date.now();
    this.#persist(() => this.store?.recordEdit(draft.planId, draft.tasks, readiness), draft.planId, "edit");
    return publicDraft(draft);
  }

  async launch(planId) {
    const draft = await this.#launchable(planId);
    if (!this.launches.begin(draft.planId)) throw new TypeError(LAUNCHING);
    try { return await this.#launchWork(draft); }
    finally { this.launches.finish(draft.planId); this.#launchSettled(draft.planId); }
  }

  // The background entry point. It answers as soon as the launch is registered,
  // and the worktrees and the sessions are created after the request has ended.
  //
  // Every validation that can fail cheaply already ran in #launchable, so the
  // caller still learns about an unusable plan in its own hand. Nothing awaits
  // the work below, so both outcomes are handled here: an unhandled rejection
  // would take the whole companion down.
  async launchBackground(planId) {
    const draft = await this.#launchable(planId);
    // The registry, not the check above, is the real gate. Two requests can
    // both pass an async validation before either of them registers.
    if (!this.launches.begin(draft.planId)) throw new TypeError(LAUNCHING);
    Promise.resolve()
      .then(() => this.#launchWork(draft))
      .then((result) => {
        this.launches.finish(draft.planId);
        this.#notifyLaunch(draft, result);
        this.#launchSettled(draft.planId);
      })
      .catch((cause) => {
        this.launches.finish(draft.planId);
        const message = cause?.message || "The launch failed";
        this.log?.warn?.({ err: cause, planId: draft.planId }, "background launch failed");
        this.#recordLaunchFailure(draft, message);
        this.#notifyLaunchFailure(draft, message);
        this.#launchSettled(draft.planId);
      });
    return { planId: draft.planId, launching: true };
  }

  // The validation both launch paths share. It is cheap and it touches nothing
  // outside this process, so a background launch can run it before it answers.
  async #launchable(planId) {
    const draft = await this.#draft(planId);
    this.#assertIdle(draft.planId);
    if (this.launches.isLaunching(draft.planId)) throw new TypeError(LAUNCHING);
    if (draft.status !== "ready" || !draft.tasks.length) throw new TypeError("This plan is not ready to launch yet");
    const readiness = validateDeliveryContract(draft.spec, draft.tasks, draft.specOptions);
    if (!readiness.ready) throw new TypeError(`This delivery contract is not ready: ${readiness.errors[0]}`);
    draft.readiness = readiness;
    return draft;
  }

  // Everything a launch does after the plan is known to be launchable. The
  // synchronous path awaits it; the background path detaches it. Neither one
  // has its own copy, so the two can never drift apart.
  async #launchWork(draft) {
    const base = await this.#baseRef(draft);
    const repositoryPath = await this.#repositoryPath(draft);
    const baseSha = String(await this.git(repositoryPath, ["rev-parse", `${base}^{commit}`]).catch(() => "")).trim() || null;
    const deliveryMode = planDeliveryMode(draft);
    const firstWave = Math.min(...draft.tasks.map((task) => Number(task.wave) || 0));
    // A retry may find worktrees a failed launch left behind. Reuse needs the
    // live session list to tell a stranded worktree from one an agent owns.
    // An unreachable cmux only makes the check stricter, never looser.
    const inventory = await this.#workspaces();
    const results = [];
    for (const task of draft.tasks) {
      if ((Number(task.wave) || 0) !== firstWave) {
        results.push({ id: task.id, title: task.title, branch: task.branch, agent: task.agent, status: "queued", launchReason: null, wave: task.wave });
        continue;
      }
      results.push(await this.#launchTask(draft, task, base, deliveryMode, baseSha, inventory, repositoryPath));
    }
    const launched = results.filter((item) => item.status === "launched").length;
    const effectiveBranches = new Map(results.map((result) => [result.id, result.branch]));
    draft.tasks = draft.tasks.map((task) => ({ ...task, branch: effectiveBranches.get(task.id) || task.branch }));
    this.#persist(() => this.store?.recordLaunch(draft.planId, { base, baseSha, results }), draft.planId, "launch");
    // Deleting stops a plan running twice. That risk does not exist when nothing
    // was created, and keeping the draft saves the user a fresh planner round
    // after a transient failure such as cmux being down.
    if (launched > 0) this.drafts.delete(draft.planId);
    return { planId: draft.planId, base, baseSha, deliveryMode, launched, results };
  }

  // One task never rolls back another: a half-made plan the user can see and
  // finish by hand beats a silent undo of work that already started.
  async #launchTask(draft, task, base, deliveryMode, startSha = null, inventory = { available: false, workspaces: [] }, repositoryPath = draft.cwd) {
    const summary = { id: task.id, title: task.title, branch: task.branch, agent: task.agent };
    let branch = task.branch;
    let path = null;
    try {
      const created = await acquireTaskWorktree({
        worktrees: this.worktrees,
        repositoryId: draft.repositoryId,
        repositoryPath,
        branch: task.branch,
        base,
        inventory,
        git: this.git,
        planId: draft.planId,
        taskId: task.id,
        log: this.log,
      });
      branch = created.branch;
      const effectiveTask = { ...task, branch: created.branch };
      path = created.worktree.path;
      // create() checks out an existing branch and ignores `base`, so the task
      // would start on old work instead of the fetched commit. Refuse it: an
      // agent committing on top of someone's in-progress branch is worse than
      // a failed row the user can act on. A reused worktree is exempt: it
      // already proved its HEAD equals `base`.
      if (created.branchCreated === false && !created.reused) {
        throw new TypeError(`Branch ${effectiveTask.branch} already exists, so this task would not start from ${base}. Rename it in the plan, or delete the branch first`);
      }
      // Each worktree agent is isolated, so every task brief carries its images
      // and the delivery contract selected for the whole goal. The brief is
      // written to disk; the session receives only a pointer to it.
      const brief = await this.briefs.write({
        planId: draft.planId,
        taskId: task.id,
        markdown: taskPrompt(effectiveTask, draft.spec, draft.images, base, deliveryMode, `${draft.planId}/${task.id}`, draft.issueNumbers, draft.specOptions),
      });
      const workspace = await this.cmux.workspaceCreate({
        cwd: path,
        title: sessionTitle(draft, effectiveTask),
        ...this.modelSettings.workspace("coder", effectiveTask.agent),
        env: sessionEnv(draft, effectiveTask),
        prompt: this.briefs.pointerPrompt({ title: effectiveTask.title, outcome: draft.spec?.outcome || draft.goal, path: brief.path }),
      });
      return { ...summary, branch: effectiveTask.branch, status: "launched", launchReason: null, path, workspace, startSha };
    } catch (cause) {
      branch = effectiveTaskBranch(cause, branch);
      this.log?.warn?.({ err: cause, branch, planId: draft.planId, taskId: task.id }, "planner task launch failed");
      return { ...summary, branch, status: "failed", launchReason: launchReason(cause), path, error: cause?.message || "Could not launch this task" };
    }
  }

  // Branch every task from the up-to-date default remote branch, so no task
  // inherits another task's work or a stale local commit.
  async #baseRef(draft) {
    return resolveDefaultBaseRef(this.git, await this.#repositoryPath(draft));
  }

  async #repositoryPath(draft) {
    const dashboard = await this.worktrees.snapshot({ refresh: false });
    const repository = dashboard.repositories.find((item) => item.id === draft.repositoryId);
    if (!repository) throw new TypeError("Unknown repository");
    return repository.path;
  }

  // Inventory availability is part of the answer. A genuinely new branch may
  // launch while cmux is unreachable, but an existing worktree may not be
  // reused or removed on the fiction that an exception meant "no sessions".
  async #workspaces() {
    try {
      const payload = await (this.cmux.loadWorkspaceListDetailed ? this.cmux.loadWorkspaceListDetailed() : this.cmux.workspaceListDetailed());
      return { available: Array.isArray(payload?.workspaces), workspaces: Array.isArray(payload?.workspaces) ? payload.workspaces : [] };
    } catch (cause) {
      this.log?.warn?.({ err: cause }, "planner could not read the workspace list");
      return { available: false, workspaces: [] };
    }
  }

  async #round(draft, prompt, onEvent = null, submitted = null, controller = null) {
    return this.#controlled(draft.planId, controller, (signal) => this.#roundWork(draft, prompt, onEvent, submitted, signal));
  }

  // Every kind of round reaches its ccs child through the same map, so abort
  // has one owner to look up rather than one per round type. A detached round
  // supplies its own controller, because it must be abortable from the moment
  // it is registered, before its first microtask runs.
  async #controlled(planId, controller, work) {
    const owned = controller || new AbortController();
    this.controllers.set(planId, owned);
    try {
      return await work(owned.signal);
    } finally {
      // Success, failure, timeout and cancellation all land here, so the map
      // never holds a controller for a round that is over.
      if (this.controllers.get(planId) === owned) this.controllers.delete(planId);
    }
  }

  async #roundWork(draft, prompt, onEvent, submitted, signal) {
    const reply = await this.#reply(draft, prompt, draft.engine, draft.sessionId, onEvent, false, signal);
    draft.round += 1;
    draft.at = Date.now();
    if (reply.sessionId) draft.sessionId = reply.sessionId;
    else if (draft.sessionId) {
      draft.sessionId = null;
      throw new TypeError("The planner lost its session. Start again with this goal");
    }
    draft.status = reply.status;
    draft.questions = reply.questions;
    let spec = reply.legacy ? { ...reply.spec, outcome: draft.goal } : reply.spec;
    let tasks = reply.tasks;
    if (reply.status === "ready" && draft.engine.reviewer) {
      const reviewer = reviewerEngine(draft.engine.provider, this.modelSettings.roles);
      // The structured stage is what the board reads. The line below it is
      // display text only, and no lifecycle rule may parse it.
      this.runs.setStage(draft.planId, "review_spec");
      emit(onEvent, { k: "text", t: `Reviewing with ${PLANNER_ENGINES.providers[reviewer.provider].label}…` });
      const reviewed = await this.#reply(draft, reviewerPrompt(draft, spec, tasks), reviewer, null, onEvent, true, signal);
      spec = reviewed.legacy ? spec : reviewed.spec;
      tasks = reviewed.tasks;
      if (reviewed.legacy && spec?.acceptanceCriteria?.length === tasks.length) {
        tasks = tasks.map((task, index) => ({ ...task, criterionIds: [spec.acceptanceCriteria[index].id] }));
      }
    }
    draft.spec = reply.status === "ready" ? spec : null;
    draft.readiness = reply.status === "ready" ? validateDeliveryContract(spec, tasks, draft.specOptions) : null;
    draft.tasks = reply.status === "ready"
      ? assignAgents(tasks.map((task) => ({ ...task, wave: taskWave(task.id, draft.readiness) })), await this.#usage())
      : [];
    this.#persist(() => this.store?.recordRound(draft.planId, {
      round: draft.round,
      stage: draft.status,
      sessionId: draft.sessionId,
      questions: draft.questions,
      spec: draft.spec,
      readiness: draft.readiness,
      tasks: draft.tasks,
      answers: submitted?.answers ?? null,
      skipped: submitted?.skipped === true,
      feedback: submitted?.feedback ?? null,
    }), draft.planId, "round");
    return publicDraft(draft);
  }

  async #reply(draft, prompt, engine, sessionId, onEvent, tasksOnly = false, signal = null) {
    const read = async () => {
      const reply = parsePlannerReply(await this.#spawn(draft, prompt, engine, sessionId, onEvent, signal), draft.specOptions);
      if (tasksOnly && reply.status !== "ready") throw new TypeError("The reviewer did not return an improved plan");
      return reply;
    };
    try {
      return await read();
    } catch (cause) {
      // Retry an unusable reply once: a second sample often parses. Never retry
      // a subprocess failure, because a second launch cannot fix it.
      if (cause instanceof PlannerRunError || !(cause instanceof TypeError)) throw cause;
      emit(onEvent, { k: "text", t: "Retrying…" });
      return read();
    }
  }

  async #spawn(draft, prompt, engine, sessionId, onEvent = null, signal = null) {
    const args = [
      // stream-json is what makes live progress possible, and the CLI refuses
      // it under --print without --verbose.
      engine.provider, "--print", "--output-format", "stream-json", "--verbose",
      ...ISOLATION,
      "--allowed-tools", ALLOWED_TOOLS,
      "--disallowed-tools", DENIED_TOOLS,
    ];
    if (engine.model !== PLANNER_ENGINES.passthroughModel) args.push("--model", engine.model);
    if (engine.effort !== PLANNER_ENGINES.defaultEffort) args.push("--effort", engine.effort);
    if (sessionId) args.push("--resume", sessionId);
    // `--` is required, not cosmetic: --allowed-tools is variadic, so without a
    // terminator the CLI swallows the prompt as another tool name.
    args.push("--", prompt);
    try {
      const { stdout = "" } = await this.execute("ccs", args, {
        cwd: draft.cwd,
        encoding: "utf8",
        // Round 1 starts a fresh session and reads the whole repository, so it
        // is the slowest — but so is any round on a long goal. Its length is not
        // the problem, so both rounds get the same pair of limits: silence ends
        // a stuck round, and the ceiling bounds one that never returns at all.
        timeout: this.ceilingMs,
        idleTimeout: this.idleTimeoutMs,
        maxBuffer: 4 * 1024 * 1024,
        env: process.env,
        signal,
        onLine: onEvent ? (line) => { const event = progressEvent(line); if (event) emit(onEvent, event); } : undefined,
      });
      return finalEnvelope(stdout);
    } catch (cause) {
      if (cause?.code === "ENOENT") throw new PlannerRunError("The planner needs the ccs CLI. Install it, then try again");
      if (cause?.killed || cause?.signal === "SIGTERM") throw new PlannerRunError(describeTimeout(cause?.reason, this.idleTimeoutMs, this.ceilingMs));
      throw new PlannerRunError(describeRunFailure(cause?.stderr));
    }
  }

  async #usage() {
    const timedOut = Symbol("usage-timeout");
    let timer = null;
    try {
      const snapshot = Promise.resolve().then(() => this.accountUsage?.snapshot()).catch((cause) => {
        this.log?.warn?.({ err: cause }, "planner usage snapshot failed");
        return null;
      });
      const timeout = new Promise((resolve) => {
        timer = setTimeout(() => resolve(timedOut), this.usageTimeoutMs);
      });
      const result = await Promise.race([snapshot, timeout]);
      if (result === timedOut) {
        this.log?.warn?.({ timeoutMs: this.usageTimeoutMs }, "planner usage snapshot timed out");
        return null;
      }
      return result;
    } catch (cause) {
      this.log?.warn?.({ err: cause }, "planner usage snapshot failed");
      return null;
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  // A person waits on this: it runs inside the submit that creates the plan row.
  // The dashboard resolver answers it from its repository directory in
  // milliseconds. The snapshot below is the fallback for an injected dashboard
  // that has no resolver.
  async #repository(repositoryId) {
    if (typeof repositoryId !== "string" || !/^[A-Za-z0-9_-]{18}$/.test(repositoryId)) throw new TypeError("Invalid repository");
    if (this.worktrees.resolveRepository) return this.worktrees.resolveRepository(repositoryId);
    const dashboard = await this.worktrees.snapshot({ refresh: true });
    const repository = dashboard.repositories.find((item) => item.id === repositoryId);
    if (!repository) throw new TypeError("Unknown repository");
    const primary = repository.worktrees.find((item) => item.isPrimary) || repository.worktrees[0];
    return { id: repository.id, name: repository.name, primaryPath: primary?.path || repository.path };
  }

  // A plan the cache dropped — through the TTL sweep, the size cap, or a
  // companion restart — is rebuilt from the database instead of being refused.
  async #draft(planId) {
    this.#sweep();
    const id = String(planId || "");
    // The durable row is the authority on a terminal outcome, so the guard runs
    // before the cache: an aborted goal whose draft is still hot must refuse
    // exactly like one that was reloaded from the database.
    this.#assertNotTerminal(id);
    const stored = this.#read(() => this.store?.get(id));
    const cached = this.drafts.get(id);
    // A few supported adapters intentionally keep only an in-memory draft.
    // A persisted row, when present, still wins for the managed-session guard.
    if (!stored && cached) return cached;
    if (!stored) throw new TypeError("Unknown plan. Start a new goal");
    // A managed goal owns one visible conversation and revision-bound decision
    // records. Legacy planner mutations must not create a second provider turn
    // or turn terminal/inbox text into an implementation approval.
    if (stored.workflow === "goal_session") throw new TypeError("This goal is managed in its cmux session. Use its proposal controls there");
    if (cached) return cached;
    if (stored.status === "launched") throw new TypeError("This plan is already launched. Start a new goal");
    const draft = draftFromStore(stored);
    this.drafts.set(draft.planId, draft);
    return draft;
  }

  // Reload a plan into memory and return it, so a reopened sheet continues the
  // same ccs session rather than starting a new one.
  async resume(planId) {
    const draft = await this.#draft(planId);
    return { ...publicDraft(draft), running: this.runs.isRunning(draft.planId), launching: this.launches.isLaunching(draft.planId) };
  }

  // The stored view of a plan, including a launched one, with its event log.
  async detail(planId) {
    const stored = this.#read(() => this.store?.get(String(planId || "")));
    if (!stored) throw new TypeError("Unknown plan. Start a new goal");
    const run = this.runs.get(stored.planId);
    // The live run fields are attached first, and only then is the board state
    // derived. Computing it on the stored row alone would put a plan that is
    // planning right now into the wrong column.
    const detail = {
      ...stored,
      events: this.#read(() => this.store?.events(stored.planId)) || [],
      // Its own query, not a filter over `events`: that reader is capped, so a
      // busy plan would lose its older discussions from the sheet.
      discussion: this.#read(() => this.store?.discussions(stored.planId)) || [],
      running: this.runs.isRunning(stored.planId),
      // A launching goal is neither planning nor launched yet. The marker is
      // its own field, so the board reads it without mistaking it for a
      // specification round.
      launching: this.launches.isLaunching(stored.planId),
      runPhase: run?.phase || null,
      runStage: run?.stage || null,
      runStep: run?.step || "",
      runError: run?.error || "",
    };
    return { ...detail, boardState: goalBoardState(detail) };
  }

  // A card needs to know that a plan is planning right now, and the run state
  // lives only in this process, so the list carries it rather than the store.
  //
  // `health` is optional and read-only. With it, a goal whose agents all died
  // lands in Blocked instead of reporting "Dev in progress"; without it the
  // list behaves exactly as it always did, so a cmux that cannot answer never
  // costs the board its goals.
  async list(options = {}, { health = null } = {}) {
    const plans = this.#read(() => this.store?.list(options)) || [];
    const verdicts = await this.#healthVerdicts(health, plans);
    return {
      plans: plans.map((plan) => {
        const run = this.runs.get(plan.planId);
        const verdict = verdicts.get(plan.planId) || null;
        const summary = {
          ...plan,
          running: this.runs.isRunning(plan.planId),
          launching: this.launches.isLaunching(plan.planId),
          runPhase: run?.phase || null,
          runStage: run?.stage || null,
          runStep: run?.step || "",
          runError: run?.error || "",
          health: verdict?.health || null,
          healthReason: verdict?.reason || null,
          stuckCount: verdict?.stuckCount ?? null,
        };
        return { ...summary, boardState: goalBoardState(summary) };
      }),
    };
  }

  // The sweep is best-effort. A failure returns no verdicts, so every goal
  // keeps its derived column: a supervision tool that hides the work when it
  // cannot reach cmux is worse than one that says nothing.
  async #healthVerdicts(health, plans) {
    const verdicts = new Map();
    if (!health?.sweep || !plans.some((plan) => plan.status === "launched")) return verdicts;
    try {
      const swept = await health.sweep();
      for (const goal of swept?.goals || []) {
        verdicts.set(goal.planId, {
          health: goal.health,
          stuckCount: goal.stuckCount,
          reason: firstStuckReason(goal),
        });
      }
    } catch (cause) {
      this.log?.warn?.({ err: cause }, "goal list could not read agent health");
    }
    return verdicts;
  }

  async remove(planId) {
    const id = String(planId || "");
    const plan = this.#read(() => this.store?.get(id));
    if (plan?.workflow === "goal_session") throw new TypeError("Managed goal sessions are retained for their workspace and approval record. Abort it instead");
    this.#assertIdle(id);
    this.drafts.delete(id);
    const deleted = this.#read(() => this.store?.delete(id)) === true;
    if (!deleted) throw new TypeError("Unknown plan. Start a new goal");
    return { planId: id, deleted: true };
  }

  // A storage failure must never lose a round the planner already paid for, so
  // a write that throws is logged and the answer still reaches the user.
  #persist(write, planId, step) {
    try {
      write();
    } catch (cause) {
      this.log?.warn?.({ err: cause, planId, step }, "planner plan store write failed");
    }
  }

  #read(read) {
    try {
      return read();
    } catch (cause) {
      this.log?.warn?.({ err: cause }, "planner plan store read failed");
      return null;
    }
  }

  #sweep() {
    const cutoff = Date.now() - this.ttlMs;
    for (const [id, draft] of this.drafts) if (draft.at < cutoff) this.drafts.delete(id);
  }
}

// Every cmux session one goal is known to own: one per launched task, the live
// merge session, and every merge session a retry superseded. The ids are
// deduplicated, because a merge session that was later superseded appears in
// both lists and must not be closed twice.
function goalWorkspaceIds(plan) {
  const ids = (Array.isArray(plan?.tasks) ? plan.tasks : []).map((task) => task?.workspaceId);
  ids.push(plan?.mergeWorkspaceId, plan?.goalSessionWorkspaceId);
  for (const entry of Array.isArray(plan?.supersededMergeWorkspaces) ? plan.supersededMergeWorkspaces : []) {
    ids.push(typeof entry === "string" ? entry : entry?.workspaceId);
  }
  return [...new Set(ids.map((value) => (typeof value === "string" ? value.trim() : "")).filter(Boolean))];
}

// A listener that throws must not fail the round it is only watching.
function emit(onEvent, event) {
  try { onEvent?.(event); } catch { /* the round outlives its audience */ }
}

// A notification body has room for a phrase, not a four-thousand-character goal.
function shortGoal(goal) {
  const text = String(goal || "").replace(/\s+/g, " ").trim();
  return text.length > 70 ? `${text.slice(0, 69)}…` : text;
}

function publicDraft(draft) {
  return {
    planId: draft.planId,
    repositoryId: draft.repositoryId,
    goal: draft.goal,
    images: draft.images || [],
    sourceType: draft.sourceType || null,
    issueNumbers: draft.issueNumbers || [],
    issueUrls: draft.issueUrls || [],
    deliveryPolicy: draft.deliveryPolicy || "auto",
    engine: draft.engine || normalizePlannerEngine(),
    specOptions: safeSpecOptions(draft.specOptions),
    reviewOptions: safeReviewOptions(draft.reviewOptions),
    round: draft.round,
    status: draft.status,
    questions: draft.questions,
    spec: draft.spec,
    readiness: draft.readiness,
    tasks: draft.tasks,
    lastError: draft.lastError || null,
    lastErrorAt: draft.lastErrorAt || null,
    deliveryMode: planDeliveryMode(draft),
  };
}

// The stored row holds every field a round needs, so a rebuilt draft resumes
// the same ccs session with the same goal, questions and tasks.
function draftFromStore(stored) {
  const contract = storedContract(stored);
  return {
    planId: stored.planId,
    repositoryId: stored.repositoryId,
    repositoryName: stored.repositoryName || "",
    cwd: stored.cwd || "",
    goal: stored.goal,
    images: Array.isArray(stored.images) ? stored.images : [],
    sourceType: stored.sourceType || null,
    issueNumbers: Array.isArray(stored.issueNumbers) ? stored.issueNumbers : [],
    issueUrls: Array.isArray(stored.issueUrls) ? stored.issueUrls : [],
    deliveryPolicy: stored.deliveryPolicy === "combined" ? "combined" : "auto",
    engine: normalizePlannerEngine(stored.engine),
    specOptions: safeSpecOptions(stored.specOptions),
    reviewOptions: safeReviewOptions(stored.reviewOptions),
    sessionId: stored.sessionId || null,
    round: Number(stored.round) || 0,
    at: Date.now(),
    status: stored.stage === "ready" ? "ready" : "questions",
    questions: Array.isArray(stored.questions) ? stored.questions : [],
    lastError: stored.lastError || null,
    lastErrorAt: stored.lastErrorAt || null,
    spec: contract.spec,
    readiness: contract.readiness,
    tasks: contract.tasks.map((task) => ({
      ...task,
      agent: task.agent || "claude",
      agentReason: task.agentReason || "",
    })),
  };
}

// Plans created before Delivery Contract v2 remain launchable. Their fallback
// is deliberately explicit and visible in the passport; new model replies must
// provide the full structured contract and never pass through this path.
function storedContract(stored) {
  const rawTasks = Array.isArray(stored.tasks) ? stored.tasks : [];
  const specOptions = safeSpecOptions(stored.specOptions);
  if (stored.spec?.acceptanceCriteria?.length) {
    const spec = normalizeDeliveryContract(stored.spec, stored.goal);
    const tasks = rawTasks.map((task, index) => ({ ...normalizeContractTask(task, index), ...task }));
    return { spec, tasks, readiness: stored.readiness || validateDeliveryContract(spec, tasks, specOptions) };
  }
  const spec = normalizeDeliveryContract({
    outcome: stored.goal,
    assumptions: ["Imported from a plan created before Delivery Contract v2"],
    acceptanceCriteria: rawTasks.map((task, index) => ({
      id: `AC-${index + 1}`,
      text: `Complete ${task.title || `task ${index + 1}`} as described in its saved prompt`,
      verification: "Run the repository verification appropriate for the task",
    })),
  }, stored.goal);
  const tasks = rawTasks.map((task, index) => ({
    ...normalizeContractTask({
      ...task,
      id: task.id || `T${index + 1}`,
      criterionIds: [`AC-${index + 1}`],
      ownedAreas: ["**/*"],
      verification: ["Run the repository verification appropriate for the task"],
    }, index),
    agent: task.agent,
    agentReason: task.agentReason,
  }));
  return { spec, tasks, readiness: validateDeliveryContract(spec, tasks, specOptions) };
}

function planDeliveryMode(draft) {
  return draft.deliveryPolicy === "combined" || draft.tasks.length > 1 ? "combined" : "single";
}

// The event log stores the question next to its answer, because a later round
// replaces the question list and the answer alone would then read as orphaned.
function answeredPairs(draft, answers) {
  return (Array.isArray(answers) ? answers : []).map((answer) => ({
    id: String(answer?.id || ""),
    question: draft.questions.find((item) => item.id === answer?.id)?.text || "",
    text: String(answer?.text || "").trim().slice(0, 2_000),
  })).filter((item) => item.text);
}

const SKIP_PROMPT = "Stop asking questions. Decide the remaining details yourself and reply now with the delivery-contract JSON object.";

const SPEC_HEAD = '{"spec":{"outcome":"...","inScope":["..."],"nonGoals":["..."],"constraints":["..."],"assumptions":["..."],"acceptanceCriteria":[{"id":"AC-1","text":"observable result","verification":"specific check"}],"risks":[{"text":"...","mitigation":"...","level":"low|medium|high"}],"approvalSummary":{"overview":"...","userFlow":["..."],"decisions":[{"choice":"...","consequence":"..."}],"successCriteria":["..."]}';
const SPEC_TAIL = '},"tasks":[{"id":"T1","title":"...","branch":"feature/...","prompt":"...","type":"feature|bugfix|ui|backend|docs|test|migration|investigation|refactor","criterionIds":["AC-1"],"dependsOn":[],"ownedAreas":["path/or/glob/**"],"verification":["specific command or manual check"]}]}';
const EVIDENCE_SHAPE = ',"optionEvidence":{"unitTests":{"status":"planned|not_applicable","rationale":"...","taskIds":["T1"],"criterionIds":["AC-1"]}}';
const ARTIFACT_SHAPE = ',"designArtifacts":[{"id":"F1","kind":"flow|screen","title":"...","summary":"...","nodes":[],"edges":[],"screen":{"name":"...","elements":[]}}]';

// The schema line grows only for the options the user actually asked for, so
// a goal with no requests reads exactly the contract it always read.
function specShape(options) {
  const requested = Object.values(options).some(Boolean);
  const artifacts = options.screenMocks || options.flowcharts;
  return `${SPEC_HEAD}${requested ? EVIDENCE_SHAPE : ""}${artifacts ? ARTIFACT_SHAPE : ""}${SPEC_TAIL}`;
}

const CONTRACT_LINES = [
  "Reply with exactly one JSON object and no other prose.",
  'It holds either {"questions":[{"text":"...","options":["..."]}]} or the Delivery Contract shape below.',
  "It never holds both keys.",
  "Ask questions only while a real ambiguity would change the split. Otherwise return the tasks.",
  "The spec states the user-visible outcome, explicit scope boundaries, constraints, visible assumptions, observable acceptance criteria, and material risks.",
  "Include approvalSummary for every new or revised contract. It is concise plain-language approval copy faithful to the detailed spec: overview is at most 600 characters; userFlow, decisions, and successCriteria each have at most five entries; each entry or decision field is at most 240 characters.",
  "State consequential choices and their effects in decisions. Do not add requirements, conceal assumptions or blockers, or treat the summary as authoritative: the detailed contract and readiness remain authoritative.",
  "Every acceptance criterion has at least one task. Every task names the criteria it delivers, its owned files or areas, and concrete verification.",
  "Use dependsOn only when ordering is real. Tasks in the same dependency wave must be safe to run in separate worktrees and should not claim the same files.",
  "Each task branch starts with feature/ and uses only letters, digits, dots, dashes and slashes.",
  "Each task prompt is self-contained: it states the outcome, the files or areas to touch, and how to verify the work.",
  "Return one task when the goal is a single unit of work. That is a valid answer.",
  "Do not include an agent field. The server assigns the agent.",
  "Do not tell a task to commit, push, or open a pull request. The server appends the correct single-task or combined-delivery finish step.",
];

// Every prompt path shares this builder, so a round can never demand less than
// the round before it. With no option requested it returns exactly the text
// the planner used before specification options existed.
function contractText(specOptions) {
  const options = safeSpecOptions(specOptions);
  const demands = specOptionsPromptLines(options);
  const lines = [...CONTRACT_LINES];
  lines.splice(2, 0, specShape(options));
  return [...lines, ...demands].join("\n");
}

// A prompt builder must never throw: the option value on a rebuilt draft comes
// from storage, and a corrupted row must still plan.
function safeSpecOptions(value) {
  try {
    return normalizeSpecOptions(value ?? undefined);
  } catch {
    return normalizeSpecOptions();
  }
}

// A skipped round on a live session must still restate the current contract
// shape. A session can predate a schema addition, so one sentence alone would
// let it return a task split without the required approval summary.
function skipPrompt(specOptions) {
  return [SKIP_PROMPT, "", contractText(specOptions)].join("\n");
}

const OVERRIDES = [
  "Overrides for this run, which take priority over any skill instruction:",
  "Write no file. Create no design document. Create no plan document. Ask for no approval gate.",
  "Your only output is the JSON object described above.",
].join("\n");

// The planner runs with Read allowed, so it can open each file itself.
function imageBlock(images) {
  const list = Array.isArray(images) ? images : [];
  if (!list.length) return "";
  return [`Attached image${list.length > 1 ? "s" : ""}:`, ...list.map((image) => `- ${image.path}`)].join("\n");
}

function withImages(prompt, images) {
  const block = imageBlock(images);
  return block ? `${prompt}\n\n${block}` : prompt;
}

// The plan ends at a pull request, not at a finished worktree. The agent opens
// it, because the branch has no commit at launch time and gh would refuse an
// empty one. Each agent is isolated, so every task prompt carries this itself.
function pullRequestStep(base, issueNumbers = []) {
  const branch = String(base || "").replace(/^origin\//, "") || "main";
  return [
    "Finish with a pull request:",
    "1. Commit your work.",
    "2. Push the branch to origin.",
    `3. Open a pull request against ${branch} with \`gh pr create\`. Do not mark it a draft.`,
    ...(issueNumbers.length ? [`4. Put these closing references in the pull request body, one per line: ${issueNumbers.map((number) => `Closes #${number}`).join("; ")}. These exact keywords ensure GitHub closes the linked issues only when this final PR merges.`] : []),
    "Open the pull request even when your own checks fail. State what failed at the top of its body, so the work stays visible instead of stopping on this machine.",
  ].join("\n");
}

function combinedBranchStep(readyToken) {
  return [
    "Finish your task branch for combined delivery:",
    "1. Run the verification appropriate for this task.",
    `2. Commit all of your work. The final commit message must end with the trailer \`Cmux-Goal-Ready: ${readyToken}\`.`,
    "3. Push this task branch to origin.",
    "4. Do not open a pull request. Companion will pin this commit and assemble every task into one goal pull request.",
  ].join("\n");
}

// The card shows one line, so it shows the reason for the worst task rather
// than every reason. A healthy goal has nothing to say.
function firstStuckReason(goal) {
  const tasks = [...(goal?.tasks || []), ...(goal?.merge ? [goal.merge] : [])];
  return tasks.find((task) => task.health === goal?.health)?.reason || null;
}

export function taskPrompt(task, spec, images, base, deliveryMode = "single", readyToken = "", issueNumbers = [], specOptions = undefined) {
  const criteria = (spec?.acceptanceCriteria || []).filter((criterion) => task.criterionIds?.includes(criterion.id));
  const contract = [
    "Delivery contract for this task:",
    `Outcome: ${spec?.outcome || "Complete the requested goal"}`,
    `Task: ${task.id} · ${task.title} · type ${task.type}`,
    `Owned areas: ${(task.ownedAreas || []).join(", ")}`,
    ...(task.dependsOn?.length ? [`Workflow dependencies: ${task.dependsOn.join(", ")}. Do not duplicate their owned work.`] : []),
    "Acceptance criteria:",
    ...criteria.map((criterion) => `- ${criterion.id}: ${criterion.text}\n  Verify: ${criterion.verification}`),
    "Expected task verification:",
    ...(task.verification || []).map((check) => `- ${check}`),
    "Keep changes inside the owned areas unless a necessary adjacent change is required. Report every such exception in the completion limitations.",
  ].join("\n");
  const finish = deliveryMode === "combined" ? combinedBranchStep(readyToken) : pullRequestStep(base, issueNumbers);
  // The requested rigor, the evidence that answers it and the artifacts the
  // planner drew sit between the contract and the finish steps, so an agent
  // reads what was asked for before it reads how to close the branch.
  const rigor = [
    specOptionsBriefLines(safeSpecOptions(specOptions)).join("\n"),
    formatOptionEvidence(spec?.optionEvidence),
    formatDesignArtifacts(spec?.designArtifacts),
  ].filter(Boolean);
  return [withImages(task.prompt, images), contract, ...rigor, completionReportInstruction(task), finish].join("\n\n");
}

export function normalizeImages(images) {
  if (images === undefined || images === null) return [];
  if (!Array.isArray(images)) throw new TypeError("Attached images must be a list");
  if (images.length > MAX_IMAGES) throw new TypeError(`Attach at most ${MAX_IMAGES} images`);
  return images.map((image) => {
    const path = image?.path;
    if (typeof path !== "string" || !path.trim()) throw new TypeError("Each attached image needs a file path");
    const name = typeof image?.name === "string" && image.name.trim() ? image.name.trim().slice(0, 200) : "attached image";
    return { path: path.trim().slice(0, 1_000), name };
  });
}

function normalizeIssueNumbers(values) {
  if (values === undefined || values === null) return [];
  if (!Array.isArray(values)) throw new TypeError("GitHub issue numbers must be a list");
  const numbers = [...new Set(values.map(Number))];
  if (numbers.length > 100 || numbers.some((number) => !Number.isInteger(number) || number < 1)) throw new TypeError("GitHub issue numbers are invalid");
  return numbers;
}

function normalizeIssueUrls(values) {
  if (values === undefined || values === null) return [];
  if (!Array.isArray(values)) throw new TypeError("GitHub issue links must be a list");
  return values.map((value) => String(value || "").trim()).filter((value) => /^https:\/\/github\.com\//.test(value)).slice(0, 100);
}

function openingPrompt(draft) {
  const images = imageBlock(draft.images);
  return [
    `Repository: ${draft.repositoryName} at ${draft.cwd}`,
    `Goal: ${draft.goal}`,
    ...(images ? ["", images, "Read each image with the Read tool. It shows what the user means.", "Do not repeat these paths in the task prompts. The server adds them to every task."] : []),
    "",
    "Read the repository to understand the goal. Ask a question only when a real ambiguity would change scope, acceptance criteria, risk, or execution order. Build a delivery contract, then split it into the smallest coherent workflow. Parallel tasks must have disjoint ownership; dependent work uses explicit dependsOn edges.",
    "",
    OVERRIDES,
    "",
    contractText(draft.specOptions),
  ].join("\n");
}

function reviewerPrompt(draft, spec, tasks) {
  return [
    `Repository: ${draft.repositoryName} at ${draft.cwd}`,
    `Goal: ${draft.goal}`,
    "",
    "Critique the proposed delivery contract against the repository and the goal. Fix missing or unobservable acceptance criteria, hidden assumptions, scope gaps, overlap, dependencies, unsafe branch names, and prompts that are not self-contained. Return the improved full contract, even when the proposal was already sound.",
    "",
    "Proposed delivery contract:",
    JSON.stringify({ spec, tasks }),
    "",
    OVERRIDES,
    "",
    contractText(draft.specOptions),
    "",
    "Return a spec and tasks, not questions.",
  ].join("\n");
}

// A plan whose session is gone must carry its own context again: the goal, the
// images, the questions already asked and the answers given. answerPrompt sends
// the answers alone, which only works while the session still holds the goal.
function restartPrompt(draft, pairs, skip) {
  const history = pairs.map((pair) => `Q: ${pair.question}\nA: ${pair.text}`).filter(Boolean);
  return [
    openingPrompt(draft),
    "",
    history.length ? ["Answers already given for this goal:", "", ...history].join("\n") : "No answers were given yet.",
    ...(skip ? ["", SKIP_PROMPT] : []),
  ].join("\n");
}

// Both answer paths, the awaited one and the background one, choose the prompt
// here. Without a session the next spawn starts a fresh conversation, which has
// never seen the goal. An answer-only prompt then reads as a goal-less request,
// and the planner invents work from the working tree. Restate the whole opening
// context, so a resumed plan answers the real goal.
function answerRound(draft, answers, skip) {
  const pairs = skip ? [] : answeredPairs(draft, answers);
  const prompt = draft.sessionId ? (skip ? skipPrompt(draft.specOptions) : answerPrompt(draft, answers)) : restartPrompt(draft, pairs, skip);
  return { prompt, pairs };
}

// The reviewer's own words. They are validated the way a goal and an answer
// are, so an empty box or a pasted document is refused with a sentence the
// sheet can show rather than with a wasted planner round.
function feedbackNote(draft, text) {
  if (draft.status !== "ready" || !draft.tasks.length) {
    throw new TypeError("This goal has no task split to reject yet. Answer its questions first");
  }
  const note = String(text || "").trim();
  if (!note) throw new TypeError("Say what is wrong with this plan");
  if (note.length > 2_000) throw new TypeError("That feedback is too long");
  return note;
}

// The rejected split has to travel with the feedback. Without it the planner
// revises a plan it cannot see, and it returns the same tasks again.
function rejectedTasks(draft) {
  return draft.tasks.map((task, index) => [
    `${index + 1}. ${task.title}`,
    `   branch: ${task.branch}`,
    `   criteria: ${(task.criterionIds || []).join(", ")}`,
    `   depends on: ${(task.dependsOn || []).join(", ") || "none"}`,
    `   owns: ${(task.ownedAreas || []).join(", ")}`,
    `   prompt: ${task.prompt}`,
  ].join("\n"));
}

const FEEDBACK_HEADER = "The reviewer read your task split and rejected it. Analyse the goal again and return a better split. Regenerate approvalSummary so it faithfully reflects the revised detailed contract without adding requirements; keep real blockers visible in readiness.";

// With a live session the planner still holds the goal and the tasks, so the
// feedback alone is enough. Without one the next spawn is a fresh conversation,
// so restate the whole opening context and the split being rejected, the same
// way restartPrompt does for an answer round.
function feedbackRound(draft, note) {
  const rejection = [
    FEEDBACK_HEADER,
    "",
    "Reviewer feedback:",
    note,
    "",
    "Do not defend the previous split. Change it to answer this feedback: merge, split, drop or reword tasks as the feedback requires.",
  ].join("\n");
  if (draft.sessionId) return [rejection, "", contractText(draft.specOptions)].join("\n");
  return [
    openingPrompt(draft),
    "",
    "The delivery contract you returned before, which the reviewer rejected:",
    "",
    JSON.stringify({ spec: draft.spec }),
    ...rejectedTasks(draft),
    "",
    rejection,
  ].join("\n");
}

// The contract exactly as the sheet shows it, field by field. It is rebuilt for
// every discussion rather than trusted to the live ccs session: a task edit and
// a reviewer-produced task never entered that session, so a resumed
// conversation holds a contract the user is no longer looking at.
function contractSnapshot(draft) {
  return [
    "Current specification:",
    JSON.stringify(draft.spec),
    "",
    "Current readiness:",
    JSON.stringify(draft.readiness),
    "",
    "Current tasks:",
    ...draft.tasks.map((task) => [
      `- ${task.id} · ${task.title}`,
      `  branch: ${task.branch}`,
      `  agent: ${task.agent || "unassigned"}`,
      `  criteria: ${(task.criterionIds || []).join(", ") || "none"}`,
      `  depends on: ${(task.dependsOn || []).join(", ") || "none"}`,
      `  owns: ${(task.ownedAreas || []).join(", ") || "none"}`,
      `  verification: ${(task.verification || []).join("; ") || "none"}`,
      `  wave: ${Number(task.wave) || 0}`,
      `  prompt: ${task.prompt}`,
    ].join("\n")),
  ].join("\n");
}

const DISCUSSION_SHAPE = '{"answer":"...","contractImpact":"none|revision_suggested","suggestion":"..."}';

const DISCUSSION_RULES = [
  "You are explaining this delivery contract, not changing it.",
  "Read the repository to answer accurately. Answer only the question asked.",
  "Do not return questions. Do not return tasks. Do not rewrite the specification, the tasks, or any part of the contract.",
  `Reply with exactly one JSON object and no other prose: ${DISCUSSION_SHAPE}`,
  "`answer` explains the contract in plain language and is at most 4000 characters.",
  '`contractImpact` is "none" when the contract needs no change, and "revision_suggested" when your answer identifies a change the contract needs.',
  'With "none", leave `suggestion` empty. With "revision_suggested", `suggestion` states the one revision to request, in at most 2000 characters.',
  "Add no other key.",
].join("\n");

// A discussion prompt is always self-contained, session or no session. The
// contract in the session may be older than the contract on screen, and an
// answer about the wrong contract is worse than no answer at all.
function discussionPrompt(draft, question) {
  return [
    `Repository: ${draft.repositoryName} at ${draft.cwd}`,
    `Goal: ${draft.goal}`,
    ...(imageBlock(draft.images) ? ["", imageBlock(draft.images), "Read each image with the Read tool. It shows what the user means."] : []),
    "",
    contractSnapshot(draft),
    "",
    "The user is looking at exactly this contract and asks:",
    question,
    "",
    DISCUSSION_RULES,
    "",
    OVERRIDES,
  ].join("\n");
}

function answerPrompt(draft, answers) {
  const list = Array.isArray(answers) ? answers : [];
  const lines = list.map((answer) => {
    const text = String(answer?.text || "").trim().slice(0, 2_000);
    if (!text) return "";
    const question = draft.questions.find((item) => item.id === answer?.id);
    if (!question) throw new TypeError("That answer no longer matches the question. Reload the plan");
    return `Q: ${question.text}\nA: ${text}`;
  }).filter(Boolean);
  return [lines.length ? lines.join("\n\n") : "No answers were given.", "", contractText(draft.specOptions)].join("\n");
}
