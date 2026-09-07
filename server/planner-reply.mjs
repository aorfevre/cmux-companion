import { normalizeContractTask, normalizeDeliveryContract, validateDeliveryContract } from "./delivery-contract.mjs";

const UNUSABLE = "The planner returned an unusable answer. Try again";

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
