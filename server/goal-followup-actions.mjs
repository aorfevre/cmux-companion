// Goal follow-up choices and their submission rules live here so the server
// and browser dashboard always offer and validate the same actions. The
// module has no storage, no network, and no Node built-ins because both
// runtimes import it directly.

export const GOAL_FOLLOWUP_COLUMN_STATE = "waiting_for_merge";

export const GOAL_FOLLOWUP_ACTIONS = Object.freeze([
  Object.freeze({
    id: "question",
    label: "Ask a question",
    description: "Ask a question about the branch and get the answer in the follow-up session.",
    requiresText: true,
    textKey: "question",
  }),
  Object.freeze({
    id: "tests",
    label: "More unit and e2e tests",
    description: "Add more unit and end-to-end test coverage for the branch.",
    requiresText: false,
    textKey: null,
  }),
  Object.freeze({
    id: "review",
    label: "Complete code review",
    description: "Run a complete code review of the branch with the selected agent.",
    requiresText: false,
    textKey: null,
  }),
  Object.freeze({
    id: "custom",
    label: "Something else",
    description: "Give the follow-up agent a free-form instruction for the branch.",
    requiresText: true,
    textKey: "custom",
  }),
]);

export const GOAL_FOLLOWUP_AGENTS = Object.freeze(["claude", "codex"]);
export const DEFAULT_FOLLOWUP_AGENT = "claude";
export const MAX_FOLLOWUP_TEXT = 2000;

// Returns the shared catalogue entry for an id. Untrusted and malformed ids
// simply have no matching action.
export function followupAction(id) {
  return GOAL_FOLLOWUP_ACTIONS.find((action) => action.id === id) ?? null;
}

// Labels always follow catalogue order, regardless of submission order.
// Unknown ids and malformed list values are ignored.
export function followupActionLabels(actions) {
  const ids = Array.isArray(actions) ? actions : [];
  return GOAL_FOLLOWUP_ACTIONS.filter((action) => ids.includes(action.id)).map((action) => action.label);
}

// Validates and normalizes one untrusted follow-up submission. Every failure
// is deliberate and stable so both the API and popup can show the same text.
export function normalizeFollowupRequest(body) {
  const source = record(body);
  const submittedActions = Array.isArray(source.actions) ? source.actions : [];
  if (submittedActions.length === 0) throw new TypeError("Pick at least one follow-up action");
  if (submittedActions.some((id) => followupAction(id) === null)) throw new TypeError("Unknown follow-up action");

  const actions = GOAL_FOLLOWUP_ACTIONS
    .filter((action) => submittedActions.includes(action.id))
    .map((action) => action.id);
  if (actions.length === 0) throw new TypeError("Pick at least one follow-up action");

  const question = actions.includes("question") ? followupText(source.question) : "";
  const custom = actions.includes("custom") ? followupText(source.custom) : "";
  if (actions.includes("question") && question === "") throw new TypeError("Write the question you want answered");
  if (actions.includes("custom") && custom === "") throw new TypeError("Write what you want done");

  const agent = source.agent === undefined ? DEFAULT_FOLLOWUP_AGENT : text(source.agent);
  if (!GOAL_FOLLOWUP_AGENTS.includes(agent)) throw new TypeError("Follow-up agent must be claude or codex");

  return { actions, question, custom, agent };
}

function record(value) {
  return value && typeof value === "object" && !Array.isArray(value) ? value : {};
}

function text(value) {
  return typeof value === "string" ? value.trim() : "";
}

function followupText(value) {
  return text(value).slice(0, MAX_FOLLOWUP_TEXT);
}
