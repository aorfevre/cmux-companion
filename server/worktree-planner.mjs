import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

const UNUSABLE = "The planner returned an unusable answer. Try again";

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
    return { sessionId, status: "questions", questions, tasks: [] };
  }

  const tasks = payload.tasks
    .map((item, index) => ({
      id: `t${index + 1}`,
      title: cleanText(item?.title),
      branch: cleanText(item?.branch),
      prompt: cleanText(item?.prompt),
    }))
    .filter((item) => item.title && item.branch && item.prompt);
  if (!tasks.length) throw new TypeError(UNUSABLE);
  return { sessionId, status: "ready", questions: [], tasks };
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
const ROUND_TIMEOUT_MS = 180_000;
const ALLOWED_TOOLS = "Read,Grep,Glob,Skill";
const MAX_TASKS = 8;

export class WorktreePlanner {
  constructor({ worktrees, cmux, accountUsage, execute = execFileAsync, maxRounds = 6, timeoutMs = ROUND_TIMEOUT_MS, ttlMs = DRAFT_TTL_MS } = {}) {
    if (!worktrees) throw new TypeError("A worktree dashboard is required");
    if (!cmux) throw new TypeError("A cmux client is required");
    this.worktrees = worktrees;
    this.cmux = cmux;
    this.accountUsage = accountUsage;
    this.execute = execute;
    this.maxRounds = maxRounds;
    this.timeoutMs = timeoutMs;
    this.ttlMs = ttlMs;
    this.drafts = new Map();
  }

  async start({ repositoryId, goal }) {
    const text = String(goal || "").trim();
    if (!text) throw new TypeError("Describe the goal for this repository");
    if (text.length > 4_000) throw new TypeError("That goal is too long");
    const repository = await this.#repository(repositoryId);
    const draft = {
      planId: randomUUID(),
      repositoryId: repository.id,
      repositoryName: repository.name,
      cwd: repository.primaryPath,
      goal: text,
      sessionId: null,
      round: 0,
      at: Date.now(),
      status: "questions",
      questions: [],
      tasks: [],
    };
    this.drafts.set(draft.planId, draft);
    return this.#round(draft, openingPrompt(draft));
  }

  async answer(planId, { answers = [], skip = false } = {}) {
    const draft = this.#draft(planId);
    if (draft.round >= this.maxRounds) {
      throw new TypeError("The planner could not produce a plan. Start again with a narrower goal");
    }
    return this.#round(draft, skip ? SKIP_PROMPT : answerPrompt(draft, answers));
  }

  async update(planId, { tasks } = {}) {
    const draft = this.#draft(planId);
    if (!Array.isArray(tasks) || !tasks.length) throw new TypeError("Keep at least one task");
    if (tasks.length > MAX_TASKS) throw new TypeError(`A plan can hold at most ${MAX_TASKS} tasks`);
    const next = tasks.map((task, index) => {
      const branch = String(task?.branch || "").trim();
      if (!/^[A-Za-z0-9][A-Za-z0-9._/-]{0,80}$/.test(branch) || branch.includes("..")) {
        throw new TypeError(`Task ${index + 1} needs a valid Git branch name`);
      }
      const title = String(task?.title || "").trim();
      const prompt = String(task?.prompt || "").trim();
      if (!title || !prompt) throw new TypeError(`Task ${index + 1} needs a title and a prompt`);
      const agent = task?.agent === "codex" ? "codex" : "claude";
      return { id: task?.id || `t${index + 1}`, title, branch, prompt, agent, agentReason: String(task?.agentReason || "") };
    });
    const branches = new Set(next.map((task) => task.branch));
    if (branches.size !== next.length) throw new TypeError("Two tasks share a branch name");
    draft.tasks = next;
    draft.at = Date.now();
    return publicDraft(draft);
  }

  // Retries a single time, and only when the reply itself was unreadable. Any
  // other failure is already a plain message the caller can show as it is.
  async #round(draft, prompt) {
    let reply;
    try {
      reply = parsePlannerReply(await this.#spawn(draft, prompt));
    } catch (cause) {
      if (!(cause instanceof TypeError)) throw cause;
      reply = parsePlannerReply(await this.#spawn(draft, prompt));
    }
    draft.round += 1;
    draft.at = Date.now();
    if (reply.sessionId) draft.sessionId = reply.sessionId;
    draft.status = reply.status;
    draft.questions = reply.questions;
    draft.tasks = reply.status === "ready" ? assignAgents(reply.tasks, await this.#usage()) : [];
    return publicDraft(draft);
  }

  async #spawn(draft, prompt) {
    const args = ["claude", "--print", "--output-format", "json", "--allowed-tools", ALLOWED_TOOLS];
    if (draft.sessionId) args.push("--resume", draft.sessionId);
    args.push(prompt);
    try {
      const { stdout = "" } = await this.execute("ccs", args, {
        cwd: draft.cwd,
        encoding: "utf8",
        timeout: this.timeoutMs,
        maxBuffer: 4 * 1024 * 1024,
        env: process.env,
      });
      return stdout;
    } catch (cause) {
      if (cause?.code === "ENOENT") throw new TypeError("The planner needs the ccs CLI. Install it, then try again");
      if (cause?.killed || cause?.signal === "SIGTERM") throw new TypeError("The planner did not answer in time. Try again");
      throw new TypeError("The planner could not run. Try again");
    }
  }

  async #usage() {
    try {
      return await this.accountUsage?.snapshot();
    } catch {
      return null;
    }
  }

  async #repository(repositoryId) {
    if (typeof repositoryId !== "string" || !/^[A-Za-z0-9_-]{18}$/.test(repositoryId)) throw new TypeError("Invalid repository");
    const dashboard = await this.worktrees.snapshot({ refresh: true });
    const repository = dashboard.repositories.find((item) => item.id === repositoryId);
    if (!repository) throw new TypeError("Unknown repository");
    const primary = repository.worktrees.find((item) => item.isPrimary) || repository.worktrees[0];
    return { id: repository.id, name: repository.name, path: repository.path, primaryPath: primary?.path || repository.path };
  }

  #draft(planId) {
    this.#sweep();
    const draft = this.drafts.get(String(planId || ""));
    if (!draft) throw new TypeError("Unknown plan. Start a new goal");
    return draft;
  }

  #sweep() {
    const cutoff = Date.now() - this.ttlMs;
    for (const [id, draft] of this.drafts) if (draft.at < cutoff) this.drafts.delete(id);
  }
}

function publicDraft(draft) {
  return {
    planId: draft.planId,
    repositoryId: draft.repositoryId,
    goal: draft.goal,
    round: draft.round,
    status: draft.status,
    questions: draft.questions,
    tasks: draft.tasks,
  };
}

const SKIP_PROMPT = "Stop asking questions. Decide the remaining details yourself and reply now with the tasks JSON object.";

const CONTRACT = [
  "Reply with exactly one JSON object and no other prose.",
  'It holds either {"questions": [{"text": "...", "options": ["..."]}]} or {"tasks": [{"title": "...", "branch": "feature/...", "prompt": "..."}]}.',
  "It never holds both keys.",
  "Ask questions only while a real ambiguity would change the split. Otherwise return the tasks.",
  "Each task must be independent of every other task, because the agents run in separate worktrees and never see each other.",
  "Each task branch starts with feature/ and uses only letters, digits, dots, dashes and slashes.",
  "Each task prompt is self-contained: it states the outcome, the files or areas to touch, and how to verify the work.",
  "Return one task when the goal is a single unit of work. That is a valid answer.",
  "Do not include an agent field. The server assigns the agent.",
].join("\n");

const OVERRIDES = [
  "Overrides for this run, which take priority over any skill instruction:",
  "Write no file. Create no design document. Create no plan document. Ask for no approval gate.",
  "Your only output is the JSON object described above.",
].join("\n");

function openingPrompt(draft) {
  return [
    `Repository: ${draft.repositoryName} at ${draft.cwd}`,
    `Goal: ${draft.goal}`,
    "",
    "Use /brainstorming for the question rounds. Use /dispatching-parallel-agents to decide whether this goal splits into independent tasks.",
    "",
    OVERRIDES,
    "",
    CONTRACT,
  ].join("\n");
}

function answerPrompt(draft, answers) {
  const lines = (Array.isArray(answers) ? answers : [])
    .map((answer) => {
      const question = draft.questions.find((item) => item.id === answer?.id);
      const text = String(answer?.text || "").trim().slice(0, 2_000);
      return question && text ? `Q: ${question.text}\nA: ${text}` : "";
    })
    .filter(Boolean);
  return [lines.length ? lines.join("\n\n") : "No answers were given.", "", CONTRACT].join("\n");
}
