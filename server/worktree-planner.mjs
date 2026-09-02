import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { createInterface } from "node:readline";
import {
  completionReportInstruction,
  normalizeContractTask,
  normalizeDeliveryContract,
  taskWave,
  validateDeliveryContract,
} from "./delivery-contract.mjs";
import { AgentBriefs } from "./agent-brief.mjs";
import { PlannerRuns } from "./planner-runs.mjs";
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
export function streamExecFile(bin, args, { cwd, timeout = 0, idleTimeout = 0, maxBuffer = 4 * 1024 * 1024, env, onLine } = {}) {
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
    // The idle timer is armed once and rearmed on every line, so a silent
    // startup is bounded by the same limit as a mid-round stall.
    const restartIdle = () => {
      if (!idleTimeout || killed) return;
      clearTimeout(idle);
      idle = setTimeout(() => stop("idle"), idleTimeout);
      idle.unref?.();
    };
    const clearTimers = () => { clearTimeout(ceiling); clearTimeout(idle); };
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
    child.once("error", (cause) => { clearTimers(); lines.close(); reject(cause); });
    child.once("close", (code, signal) => {
      clearTimers();
      lines.close();
      if (killed || signal) return reject(Object.assign(new Error("Command failed"), { killed, reason, signal: signal || "SIGTERM", stderr, code }));
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

export function parsePlannerReply(stdout) {
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
  const readiness = validateDeliveryContract(spec, tasks);
  if (!readiness.ready) throw new TypeError(`${UNUSABLE}: ${readiness.errors[0]}`);
  return { sessionId, status: "ready", questions: [], spec, tasks, readiness, legacy };
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

export function normalizePlannerEngine(engine) {
  if (engine === undefined) return {
    provider: PLANNER_ENGINES.defaultProvider,
    model: PLANNER_ENGINES.defaultModel,
    effort: PLANNER_ENGINES.defaultEffort,
    reviewer: false,
  };
  if (!engine || typeof engine !== "object" || Array.isArray(engine)) {
    throw new TypeError("Planner engine configuration must be an object");
  }
  const provider = engine.provider ?? PLANNER_ENGINES.defaultProvider;
  if (typeof provider !== "string" || !Object.hasOwn(PLANNER_ENGINES.providers, provider)) {
    throw new TypeError("Unknown planner provider. Choose Claude or Codex");
  }
  const providerOptions = PLANNER_ENGINES.providers[provider];
  const model = engine.model ?? PLANNER_ENGINES.defaultModel;
  if (!providerOptions.models.some((option) => option.id === model)) {
    throw new TypeError(`Unknown ${providerOptions.label} planner model`);
  }
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
  if (reason === "idle") return `The planner stopped answering: no output for ${minutes(idleTimeoutMs)}. Try again`;
  if (reason === "ceiling") return `The planner ran for ${minutes(ceilingMs)} without finishing. Start again with a narrower goal`;
  return "The planner did not answer in time. Try again";
}

function minutes(ms) {
  const value = Math.max(1, Math.round(Number(ms) / 60_000));
  return `${value} minute${value === 1 ? "" : "s"}`;
}

export class WorktreePlanner {
  constructor({ worktrees, cmux, accountUsage, log = null, execute = streamExecFile, git = null, maxRounds = 6, idleTimeoutMs = ROUND_IDLE_TIMEOUT_MS, ceilingMs = ROUND_CEILING_MS, ttlMs = DRAFT_TTL_MS, store = null, runs = null, progress = null, pushService = null, briefs = new AgentBriefs() } = {}) {
    if (!worktrees) throw new TypeError("A worktree dashboard is required");
    if (!cmux) throw new TypeError("A cmux client is required");
    this.worktrees = worktrees;
    // The dashboard owns the repo catalog, which owns the injected git runner.
    this.git = git || ((cwd, args, options) => worktrees.repoCatalog.git(cwd, args, options));
    this.cmux = cmux;
    this.accountUsage = accountUsage;
    // The full brief goes to a file. cmux caps a prompt at 8,000 characters, so
    // the session gets a short pointer to that file instead of the brief text.
    this.briefs = briefs;
    this.log = log;
    this.execute = execute;
    this.maxRounds = maxRounds;
    this.idleTimeoutMs = idleTimeoutMs;
    this.ceilingMs = ceilingMs;
    this.ttlMs = ttlMs;
    // The database owns every plan. The map is only a hot cache in front of it,
    // so a companion restart loses no goal, no session and no task list.
    this.store = store;
    // A background round outlives its request, so the registry, not the request
    // cycle, is what says whether a plan is busy.
    this.runs = runs || new PlannerRuns();
    // The same hub the synchronous rounds publish to. A background round keys
    // its stream on the plan id, which exists before the round starts.
    this.progress = progress;
    this.pushService = pushService;
    this.drafts = new Map();
  }

  async start({ repositoryId, goal, images, engine, issueNumbers = [], issueUrls = [], deliveryPolicy = "auto", onEvent = null }) {
    const draft = await this.#createDraft({ repositoryId, goal, images, engine, issueNumbers, issueUrls, deliveryPolicy });
    return this.#round(draft, openingPrompt(draft), onEvent);
  }

  // The row is written before the round runs, so a plan id exists the moment a
  // goal is submitted. That id is what the progress stream, the goal card and
  // the notification all key on.
  async #createDraft({ repositoryId, goal, images, engine, issueNumbers = [], issueUrls = [], deliveryPolicy = "auto" }) {
    const text = String(goal || "").trim();
    if (!text) throw new TypeError("Describe the goal for this repository");
    if (text.length > 4_000) throw new TypeError("That goal is too long");
    const attachments = normalizeImages(images);
    const linkedIssues = normalizeIssueNumbers(issueNumbers);
    const linkedIssueUrls = normalizeIssueUrls(issueUrls);
    const normalizedDeliveryPolicy = deliveryPolicy === "combined" ? "combined" : "auto";
    const normalizedEngine = normalizePlannerEngine(engine);
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
    this.drafts.set(draft.planId, draft);
    this.#persist(() => this.store?.createPlan({
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
    }), draft.planId, "create");
    return draft;
  }

  // The background entry point. It answers as soon as the row exists, and the
  // round runs on after the request has ended. The caller gets a plan id it can
  // watch, resume and delete, so the sheet is free to close.
  async startBackground({ repositoryId, goal, images, engine, issueNumbers = [], issueUrls = [], deliveryPolicy = "auto" }) {
    const draft = await this.#createDraft({ repositoryId, goal, images, engine, issueNumbers, issueUrls, deliveryPolicy });
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
    this.runs.begin(planId, kind);
    const onEvent = (event) => {
      this.progress?.publish(planId, event);
      if (event?.t) this.runs.step(planId, event.t);
    };
    Promise.resolve()
      .then(() => this.#round(draft, prompt, onEvent, submitted))
      .then((result) => {
        this.progress?.publish(planId, { k: "done" });
        this.runs.finish(planId, { phase: "done" });
        this.#notifyRound(draft, result);
      })
      .catch((cause) => {
        const message = cause?.message || "The planner round failed";
        this.log?.warn?.({ err: cause, planId }, "background planner round failed");
        this.progress?.publish(planId, { k: "error", t: message });
        this.runs.finish(planId, { phase: "failed", error: message });
        this.#notifyFailure(draft, message);
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

  isRunning(planId) {
    return this.runs.isRunning(planId);
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
    const readiness = validateDeliveryContract(draft.spec, next);
    if (!readiness.ready) throw new TypeError(readiness.errors[0]);
    draft.tasks = next.map((task) => ({ ...task, wave: taskWave(task.id, readiness) }));
    draft.readiness = readiness;
    draft.at = Date.now();
    this.#persist(() => this.store?.recordEdit(draft.planId, draft.tasks, readiness), draft.planId, "edit");
    return publicDraft(draft);
  }

  async launch(planId) {
    const draft = await this.#draft(planId);
    this.#assertIdle(draft.planId);
    if (draft.status !== "ready" || !draft.tasks.length) throw new TypeError("This plan is not ready to launch yet");
    const readiness = validateDeliveryContract(draft.spec, draft.tasks);
    if (!readiness.ready) throw new TypeError(`This delivery contract is not ready: ${readiness.errors[0]}`);
    draft.readiness = readiness;
    const base = await this.#baseRef(draft);
    const repositoryPath = await this.#repositoryPath(draft);
    const baseSha = String(await this.git(repositoryPath, ["rev-parse", `${base}^{commit}`]).catch(() => "")).trim() || null;
    const deliveryMode = planDeliveryMode(draft);
    const firstWave = Math.min(...draft.tasks.map((task) => Number(task.wave) || 0));
    // A retry may find worktrees a failed launch left behind. Reuse needs the
    // live session list to tell a stranded worktree from one an agent owns.
    // An unreachable cmux only makes the check stricter, never looser.
    const workspaces = await this.#workspaces();
    const results = [];
    for (const task of draft.tasks) {
      if ((Number(task.wave) || 0) !== firstWave) {
        results.push({ id: task.id, title: task.title, branch: task.branch, agent: task.agent, status: "queued", wave: task.wave });
        continue;
      }
      results.push(await this.#launchTask(draft, task, base, deliveryMode, baseSha, workspaces));
    }
    const launched = results.filter((item) => item.status === "launched").length;
    this.#persist(() => this.store?.recordLaunch(draft.planId, { base, baseSha, results }), draft.planId, "launch");
    // Deleting stops a plan running twice. That risk does not exist when nothing
    // was created, and keeping the draft saves the user a fresh planner round
    // after a transient failure such as cmux being down.
    if (launched > 0) this.drafts.delete(draft.planId);
    return { planId: draft.planId, base, baseSha, deliveryMode, launched, results };
  }

  // One task never rolls back another: a half-made plan the user can see and
  // finish by hand beats a silent undo of work that already started.
  async #launchTask(draft, task, base, deliveryMode, startSha = null, workspaces = []) {
    const summary = { id: task.id, title: task.title, branch: task.branch, agent: task.agent };
    let path = null;
    try {
      const created = await this.worktrees.create(draft.repositoryId, { branch: task.branch, base, reuseIfAtBase: true, workspaces });
      path = created.worktree.path;
      // create() checks out an existing branch and ignores `base`, so the task
      // would start on old work instead of the fetched commit. Refuse it: an
      // agent committing on top of someone's in-progress branch is worse than
      // a failed row the user can act on. A reused worktree is exempt: it
      // already proved its HEAD equals `base`.
      if (created.branchCreated === false && !created.reused) {
        throw new TypeError(`Branch ${task.branch} already exists, so this task would not start from ${base}. Rename it in the plan, or delete the branch first`);
      }
      // Each worktree agent is isolated, so every task brief carries its images
      // and the delivery contract selected for the whole goal. The brief is
      // written to disk; the session receives only a pointer to it.
      const brief = await this.briefs.write({
        planId: draft.planId,
        taskId: task.id,
        markdown: taskPrompt(task, draft.spec, draft.images, base, deliveryMode, `${draft.planId}/${task.id}`, draft.issueNumbers),
      });
      const workspace = await this.cmux.workspaceCreate({
        cwd: path,
        title: task.title,
        agent: task.agent,
        prompt: this.briefs.pointerPrompt({ title: task.title, outcome: draft.spec?.outcome || draft.goal, path: brief.path }),
      });
      return { ...summary, status: "launched", path, workspace, startSha };
    } catch (cause) {
      this.log?.warn?.({ err: cause, branch: task.branch }, "planner task launch failed");
      return { ...summary, status: "failed", path, error: cause?.message || "Could not launch this task" };
    }
  }

  // Branch every task from the up-to-date default remote branch, so no task
  // inherits another task's work or a stale local commit.
  async #baseRef(draft) {
    const repositoryPath = await this.#repositoryPath(draft);
    let branch = "main";
    try {
      const output = await this.git(repositoryPath, ["symbolic-ref", "--short", "refs/remotes/origin/HEAD"]);
      branch = String(output).trim().replace(/^refs\/remotes\/origin\//, "").replace(/^origin\//, "") || "main";
    } catch {
      // No local origin/HEAD ref. Ask the remote rather than guessing "main",
      // which aborts the whole launch on a healthy master-default repository.
      const head = await this.git(repositoryPath, ["ls-remote", "--symref", "origin", "HEAD"]).catch(() => "");
      branch = String(head).match(/^ref: refs\/heads\/(\S+)\s+HEAD/m)?.[1] || "main";
    }
    try {
      await this.git(repositoryPath, ["fetch", "origin", branch], { timeout: 120_000 });
    } catch (cause) {
      const lines = String(cause?.stderr || cause?.message || "").trim().split("\n").map((line) => line.trim()).filter(Boolean);
      // Git prints the diagnosis first and boilerplate advice last, so prefer
      // the first fatal or error line over the tail.
      const detail = (lines.find((line) => /^(fatal|error):/.test(line)) || lines.at(-1) || "").slice(0, 160);
      throw new TypeError(detail ? `Git could not fetch origin/${branch}: ${detail}` : `Git could not fetch origin/${branch}`);
    }
    return `origin/${branch}`;
  }

  async #repositoryPath(draft) {
    const dashboard = await this.worktrees.snapshot({ refresh: false });
    const repository = dashboard.repositories.find((item) => item.id === draft.repositoryId);
    if (!repository) throw new TypeError("Unknown repository");
    return repository.path;
  }

  // The list feeds the worktree reuse check only. An empty list makes that
  // check stricter, so a cmux that cannot answer must not fail the launch.
  async #workspaces() {
    try {
      const payload = await this.cmux.workspaceListDetailed();
      return payload?.workspaces || [];
    } catch (cause) {
      this.log?.warn?.({ err: cause }, "planner could not read the workspace list");
      return [];
    }
  }

  async #round(draft, prompt, onEvent = null, submitted = null) {
    const reply = await this.#reply(draft, prompt, draft.engine, draft.sessionId, onEvent);
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
      const reviewer = reviewerEngine(draft.engine.provider);
      emit(onEvent, { k: "text", t: `Reviewing with ${PLANNER_ENGINES.providers[reviewer.provider].label}…` });
      const reviewed = await this.#reply(draft, reviewerPrompt(draft, spec, tasks), reviewer, null, onEvent, true);
      spec = reviewed.legacy ? spec : reviewed.spec;
      tasks = reviewed.tasks;
      if (reviewed.legacy && spec?.acceptanceCriteria?.length === tasks.length) {
        tasks = tasks.map((task, index) => ({ ...task, criterionIds: [spec.acceptanceCriteria[index].id] }));
      }
    }
    draft.spec = reply.status === "ready" ? spec : null;
    draft.readiness = reply.status === "ready" ? validateDeliveryContract(spec, tasks) : null;
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

  async #reply(draft, prompt, engine, sessionId, onEvent, tasksOnly = false) {
    const read = async () => {
      const reply = parsePlannerReply(await this.#spawn(draft, prompt, engine, sessionId, onEvent));
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

  async #spawn(draft, prompt, engine, sessionId, onEvent = null) {
    const args = [
      // stream-json is what makes live progress possible, and the CLI refuses
      // it under --print without --verbose.
      engine.provider, "--print", "--output-format", "stream-json", "--verbose",
      ...ISOLATION,
      "--allowed-tools", ALLOWED_TOOLS,
      "--disallowed-tools", DENIED_TOOLS,
    ];
    if (engine.model !== PLANNER_ENGINES.defaultModel) args.push("--model", engine.model);
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
    try {
      return await this.accountUsage?.snapshot();
    } catch (cause) {
      this.log?.warn?.({ err: cause }, "planner usage snapshot failed");
      return null;
    }
  }

  async #repository(repositoryId) {
    if (typeof repositoryId !== "string" || !/^[A-Za-z0-9_-]{18}$/.test(repositoryId)) throw new TypeError("Invalid repository");
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
    const cached = this.drafts.get(id);
    if (cached) return cached;
    const stored = this.#read(() => this.store?.get(id));
    if (!stored) throw new TypeError("Unknown plan. Start a new goal");
    if (stored.status === "launched") throw new TypeError("This plan is already launched. Start a new goal");
    const draft = draftFromStore(stored);
    this.drafts.set(draft.planId, draft);
    return draft;
  }

  // Reload a plan into memory and return it, so a reopened sheet continues the
  // same ccs session rather than starting a new one.
  async resume(planId) {
    const draft = await this.#draft(planId);
    return { ...publicDraft(draft), running: this.runs.isRunning(draft.planId) };
  }

  // The stored view of a plan, including a launched one, with its event log.
  async detail(planId) {
    const stored = this.#read(() => this.store?.get(String(planId || "")));
    if (!stored) throw new TypeError("Unknown plan. Start a new goal");
    const run = this.runs.get(stored.planId);
    return {
      ...stored,
      events: this.#read(() => this.store?.events(stored.planId)) || [],
      running: this.runs.isRunning(stored.planId),
      runPhase: run?.phase || null,
      runStep: run?.step || "",
      runError: run?.error || "",
    };
  }

  // A card needs to know that a plan is planning right now, and the run state
  // lives only in this process, so the list carries it rather than the store.
  async list(options = {}) {
    const plans = this.#read(() => this.store?.list(options)) || [];
    return {
      plans: plans.map((plan) => {
        const run = this.runs.get(plan.planId);
        return { ...plan, running: this.runs.isRunning(plan.planId), runPhase: run?.phase || null, runStep: run?.step || "", runError: run?.error || "" };
      }),
    };
  }

  async remove(planId) {
    const id = String(planId || "");
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
    round: draft.round,
    status: draft.status,
    questions: draft.questions,
    spec: draft.spec,
    readiness: draft.readiness,
    tasks: draft.tasks,
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
    sessionId: stored.sessionId || null,
    round: Number(stored.round) || 0,
    at: Date.now(),
    status: stored.stage === "ready" ? "ready" : "questions",
    questions: Array.isArray(stored.questions) ? stored.questions : [],
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
  if (stored.spec?.acceptanceCriteria?.length) {
    const spec = normalizeDeliveryContract(stored.spec, stored.goal);
    const tasks = rawTasks.map((task, index) => ({ ...normalizeContractTask(task, index), ...task }));
    return { spec, tasks, readiness: stored.readiness || validateDeliveryContract(spec, tasks) };
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
  return { spec, tasks, readiness: validateDeliveryContract(spec, tasks) };
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

const CONTRACT = [
  "Reply with exactly one JSON object and no other prose.",
  'It holds either {"questions":[{"text":"...","options":["..."]}]} or the Delivery Contract shape below.',
  '{"spec":{"outcome":"...","inScope":["..."],"nonGoals":["..."],"constraints":["..."],"assumptions":["..."],"acceptanceCriteria":[{"id":"AC-1","text":"observable result","verification":"specific check"}],"risks":[{"text":"...","mitigation":"...","level":"low|medium|high"}]},"tasks":[{"id":"T1","title":"...","branch":"feature/...","prompt":"...","type":"feature|bugfix|ui|backend|docs|test|migration|investigation|refactor","criterionIds":["AC-1"],"dependsOn":[],"ownedAreas":["path/or/glob/**"],"verification":["specific command or manual check"]}]}',
  "It never holds both keys.",
  "Ask questions only while a real ambiguity would change the split. Otherwise return the tasks.",
  "The spec states the user-visible outcome, explicit scope boundaries, constraints, visible assumptions, observable acceptance criteria, and material risks.",
  "Every acceptance criterion has at least one task. Every task names the criteria it delivers, its owned files or areas, and concrete verification.",
  "Use dependsOn only when ordering is real. Tasks in the same dependency wave must be safe to run in separate worktrees and should not claim the same files.",
  "Each task branch starts with feature/ and uses only letters, digits, dots, dashes and slashes.",
  "Each task prompt is self-contained: it states the outcome, the files or areas to touch, and how to verify the work.",
  "Return one task when the goal is a single unit of work. That is a valid answer.",
  "Do not include an agent field. The server assigns the agent.",
  "Do not tell a task to commit, push, or open a pull request. The server appends the correct single-task or combined-delivery finish step.",
].join("\n");

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

export function taskPrompt(task, spec, images, base, deliveryMode = "single", readyToken = "", issueNumbers = []) {
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
  return [withImages(task.prompt, images), contract, completionReportInstruction(task), finish].join("\n\n");
}

function normalizeImages(images) {
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
    CONTRACT,
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
    CONTRACT,
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
  const prompt = draft.sessionId ? (skip ? SKIP_PROMPT : answerPrompt(draft, answers)) : restartPrompt(draft, pairs, skip);
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

const FEEDBACK_HEADER = "The reviewer read your task split and rejected it. Analyse the goal again and return a better split.";

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
  if (draft.sessionId) return [rejection, "", CONTRACT].join("\n");
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

function answerPrompt(draft, answers) {
  const list = Array.isArray(answers) ? answers : [];
  const lines = list.map((answer) => {
    const text = String(answer?.text || "").trim().slice(0, 2_000);
    if (!text) return "";
    const question = draft.questions.find((item) => item.id === answer?.id);
    if (!question) throw new TypeError("That answer no longer matches the question. Reload the plan");
    return `Q: ${question.text}\nA: ${text}`;
  }).filter(Boolean);
  return [lines.length ? lines.join("\n\n") : "No answers were given.", "", CONTRACT].join("\n");
}
