import { SPEC_OPTIONS } from "./worktree-planner-options.mjs";

const OPTION_IDS = SPEC_OPTIONS.options.map((option) => option.id);

// The planner sheet sends a plain object of booleans. Normalization is strict
// on purpose: a silently dropped unknown key would let the UI promise rigor
// that the contract never records.
export function normalizeSpecOptions(value) {
  if (value === undefined || value === null) return { ...SPEC_OPTIONS.defaults };
  if (typeof value !== "object" || Array.isArray(value)) throw new TypeError("Specification options must be an object");
  const normalized = { ...SPEC_OPTIONS.defaults };
  for (const [key, entry] of Object.entries(value)) {
    if (!OPTION_IDS.includes(key)) throw new TypeError(`Unknown specification option ${key}`);
    if (typeof entry !== "boolean") throw new TypeError(`Specification option ${key} must be true or false`);
    normalized[key] = entry;
  }
  return normalized;
}

function enabledSpecOptions(options) {
  const normalized = normalizeSpecOptions(options);
  return SPEC_OPTIONS.options.filter((option) => normalized[option.id]);
}

// These lines go to the planner. They ask for evidence that a later validator
// can check by reference, rather than prose a keyword search would have to
// guess at.
export function specOptionsPromptLines(options) {
  const enabled = enabledSpecOptions(options);
  if (!enabled.length) return [];
  const lines = [
    "The user requested explicit specification rigor for this goal:",
    ...enabled.map((option) => `- ${option.label}: ${option.hint}`),
    'Record how you covered each request in spec.optionEvidence: {"unitTests":{"status":"planned|not_applicable","rationale":"...","taskIds":["T1"],"criterionIds":["AC-1"]}}.',
    "A planned entry must name at least one real task id and at least one real acceptance criterion id from this same contract.",
    "A not_applicable entry must give a rationale that states why the request does not apply to this goal.",
  ];
  if (enabled.some((option) => option.id === "refactorPass")) {
    lines.push('A planned refactorPass entry must also name a task whose type is "refactor". Use not_applicable with a rationale when no refactor is warranted.');
  }
  if (enabled.some((option) => option.id === "screenMocks" || option.id === "flowcharts")) {
    lines.push('Return the requested design artifacts in spec.designArtifacts: [{"id":"F1","kind":"flow","title":"...","summary":"...","nodes":[{"id":"n1","label":"...","kind":"start|step|decision|end"}],"edges":[{"from":"n1","to":"n2","label":"..."}]}] for a flowchart, and [{"id":"S1","kind":"screen","title":"...","summary":"...","screen":{"name":"...","elements":[{"id":"e1","label":"...","kind":"header|text|input|button|list|image|note","change":"added|changed|removed|unchanged","note":"..."}]}}] for a screen wireframe.');
    lines.push("Use a not_applicable optionEvidence entry with a rationale when the goal has no screen or no flow to draw.");
  }
  return lines;
}

// The same requests reach each task brief, so an agent that never sees the
// planner sheet still knows what the user asked for.
export function specOptionsBriefLines(options) {
  const enabled = enabledSpecOptions(options);
  if (!enabled.length) return [];
  return [
    "Requested specification rigor for this goal:",
    ...enabled.map((option) => `- ${option.label}: ${option.hint}`),
    "Honour every request that applies to your owned areas. State in your completion limitations any request you could not meet.",
  ];
}
