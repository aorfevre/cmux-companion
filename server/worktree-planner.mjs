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

function describe(agent, percent) {
  return { agent, agentReason: `${LABELS[agent]} · ${Math.round(percent)}% left` };
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
