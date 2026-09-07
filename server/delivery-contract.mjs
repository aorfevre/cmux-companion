import { SPEC_OPTIONS } from "./worktree-planner-options.mjs";
import { normalizeSpecOptions, specOptionsBriefLines } from "./spec-options.mjs";

const MAX_LIST = 20;
const MAX_TEXT = 1_000;
// The brief is written to a Markdown file that the agent reads from disk.
// The cap is no longer a prompt limit. It only guards against one runaway task.
const MAX_TASK_BRIEF = 20_000;
const CRITERION_ID = /^[A-Z][A-Z0-9_-]{0,31}$/;
const TASK_ID = /^[A-Za-z][A-Za-z0-9_-]{0,31}$/;
const BRANCH = /^[A-Za-z0-9][A-Za-z0-9._/-]{0,80}$/;

// Design artifacts arrive from a model, so every list, every identifier and
// the total retained text is capped. The caps are deliberately small: the
// artifacts exist to make a plan reviewable, not to carry a whole design.
const MAX_ARTIFACTS = 6;
const MAX_NODES = 24;
const MAX_EDGES = 40;
const MAX_ELEMENTS = 24;
const MAX_TITLE = 200;
const MAX_SUMMARY = 600;
const MAX_LABEL = 120;
const MAX_NOTE = 240;
const MAX_RATIONALE = 500;
const MAX_APPROVAL_OVERVIEW = 600;
const MAX_APPROVAL_ITEMS = 5;
const MAX_APPROVAL_ITEM_TEXT = 240;
const MAX_ARTIFACT_TEXT = 16_000;
const NODE_KINDS = ["start", "step", "decision", "end"];
const ELEMENT_KINDS = ["header", "text", "input", "button", "list", "image", "note"];
const ELEMENT_CHANGES = ["added", "changed", "removed", "unchanged"];
// A plan written before the marker was renamed still reads correctly.
const ELEMENT_CHANGE_ALIASES = { new: "added" };
const EVIDENCE_STATUSES = ["planned", "not_applicable"];
const SPEC_OPTION_IDS = SPEC_OPTIONS.options.map((option) => option.id);

const DELIVERY_CONTRACT_VERSION = 2;

export function normalizeDeliveryContract(raw, goal = "") {
  const source = raw && typeof raw === "object" && !Array.isArray(raw) ? raw : {};
  const acceptanceCriteria = list(source.acceptanceCriteria, MAX_LIST)
    .map((item, index) => normalizeCriterion(item, index))
    .filter((item) => item.text);
  const approvalSummary = normalizeApprovalSummary(source.approvalSummary);
  return {
    version: DELIVERY_CONTRACT_VERSION,
    outcome: clean(source.outcome || goal, 2_000),
    inScope: strings(source.inScope, MAX_LIST, MAX_TEXT),
    nonGoals: strings(source.nonGoals, MAX_LIST, MAX_TEXT),
    constraints: strings(source.constraints, MAX_LIST, MAX_TEXT),
    assumptions: strings(source.assumptions, MAX_LIST, MAX_TEXT),
    acceptanceCriteria,
    risks: list(source.risks, 12).map(normalizeRisk).filter((item) => item.text),
    optionEvidence: normalizeOptionEvidence(source.optionEvidence),
    designArtifacts: normalizeDesignArtifacts(source.designArtifacts),
    // Approval copy is intentionally optional. Older saved contracts did not
    // have it, and inventing a summary while reading them would misrepresent
    // what their planner actually returned.
    ...(approvalSummary ? { approvalSummary } : {}),
  };
}

function normalizeApprovalSummary(raw) {
  const source = raw && typeof raw === "object" && !Array.isArray(raw) ? raw : null;
  if (!source) return null;
  const overview = clean(source.overview, MAX_APPROVAL_OVERVIEW);
  // A summary without an overview is not useful approval copy. Drop it rather
  // than leaving a blank field that can obscure the authoritative outcome.
  if (!overview) return null;
  return {
    overview,
    userFlow: strings(source.userFlow, MAX_APPROVAL_ITEMS, MAX_APPROVAL_ITEM_TEXT),
    decisions: list(source.decisions, MAX_APPROVAL_ITEMS).map((item) => ({
      choice: clean(item?.choice, MAX_APPROVAL_ITEM_TEXT),
      consequence: clean(item?.consequence, MAX_APPROVAL_ITEM_TEXT),
    })).filter((item) => item.choice && item.consequence),
    successCriteria: strings(source.successCriteria, MAX_APPROVAL_ITEMS, MAX_APPROVAL_ITEM_TEXT),
  };
}

// Evidence is keyed by option id and ordered by the catalog, so two equal
// contracts always serialize the same way.
function normalizeOptionEvidence(raw) {
  const source = raw && typeof raw === "object" && !Array.isArray(raw) ? raw : {};
  const evidence = {};
  for (const id of SPEC_OPTION_IDS) {
    const entry = source[id];
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) continue;
    const status = EVIDENCE_STATUSES.includes(entry.status) ? entry.status : "";
    if (!status) continue;
    evidence[id] = {
      status,
      rationale: clean(entry.rationale, MAX_RATIONALE),
      taskIds: ids(entry.taskIds, TASK_ID, MAX_LIST),
      criterionIds: ids(entry.criterionIds, CRITERION_ID, MAX_LIST),
    };
  }
  return evidence;
}

// Ids that a model invented can collide or be unusable. Repairing them with
// their own position keeps the result stable across identical inputs, and an
// edge that pointed at a repaired duplicate simply becomes dangling and is
// dropped rather than silently re-targeted.
function normalizeDesignArtifacts(raw) {
  const budget = { left: MAX_ARTIFACT_TEXT };
  const seen = new Set();
  const artifacts = [];
  for (const [index, item] of list(raw, MAX_ARTIFACTS).entries()) {
    const source = item && typeof item === "object" && !Array.isArray(item) ? item : {};
    const kind = source.kind === "flow" || source.kind === "screen" ? source.kind : "";
    if (!kind) continue;
    const candidate = normalizedId(source.id, `a${index + 1}`, TASK_ID);
    const id = seen.has(candidate) ? `a${index + 1}` : candidate;
    if (seen.has(id)) continue;
    seen.add(id);
    const title = spend(budget, clean(source.title, MAX_TITLE));
    const summary = spend(budget, clean(source.summary, MAX_SUMMARY));
    const artifact = kind === "flow"
      ? { id, kind, title, summary, ...normalizeFlow(source, budget) }
      : { id, kind, title, summary, screen: normalizeScreen(source.screen, budget) };
    if (kind === "flow" && !artifact.nodes.length) continue;
    if (kind === "screen" && !artifact.screen) continue;
    artifacts.push(artifact);
  }
  return artifacts;
}

function normalizeFlow(source, budget) {
  const seen = new Set();
  const nodes = [];
  for (const [index, item] of list(source.nodes, MAX_NODES).entries()) {
    const node = item && typeof item === "object" && !Array.isArray(item) ? item : {};
    const label = spend(budget, clean(node.label, MAX_LABEL));
    if (!label) continue;
    const candidate = normalizedId(node.id, `n${index + 1}`, TASK_ID);
    const id = seen.has(candidate) ? `n${index + 1}` : candidate;
    if (seen.has(id)) continue;
    seen.add(id);
    nodes.push({ id, label, kind: NODE_KINDS.includes(node.kind) ? node.kind : "step" });
  }
  const edges = [];
  const pairs = new Set();
  for (const item of list(source.edges, MAX_EDGES)) {
    const edge = item && typeof item === "object" && !Array.isArray(item) ? item : {};
    const from = clean(edge.from, 40);
    const to = clean(edge.to, 40);
    if (!seen.has(from) || !seen.has(to)) continue;
    const label = spend(budget, clean(edge.label, MAX_LABEL));
    const pair = `${from}\u0000${to}\u0000${label}`;
    if (pairs.has(pair)) continue;
    pairs.add(pair);
    edges.push({ from, to, label });
  }
  return { nodes, edges };
}

// A screen carries its own name. A screen with no name, or with no surviving
// element, is not a wireframe at all, so it is dropped rather than repaired.
function normalizeScreen(raw, budget) {
  const source = raw && typeof raw === "object" && !Array.isArray(raw) ? raw : {};
  const name = spend(budget, clean(source.name, MAX_LABEL));
  if (!name) return null;
  const elements = normalizeElements(source.elements, budget);
  return elements.length ? { name, elements } : null;
}

function normalizeElements(raw, budget) {
  const seen = new Set();
  const elements = [];
  for (const [index, item] of list(raw, MAX_ELEMENTS).entries()) {
    const element = item && typeof item === "object" && !Array.isArray(item) ? item : {};
    const label = spend(budget, clean(element.label, MAX_LABEL));
    if (!label) continue;
    const candidate = normalizedId(element.id, `e${index + 1}`, TASK_ID);
    const id = seen.has(candidate) ? `e${index + 1}` : candidate;
    if (seen.has(id)) continue;
    seen.add(id);
    elements.push({
      id,
      label,
      kind: ELEMENT_KINDS.includes(element.kind) ? element.kind : "text",
      change: elementChange(element.change),
      note: spend(budget, clean(element.note, MAX_NOTE)),
    });
  }
  return elements;
}

function elementChange(value) {
  const alias = typeof value === "string" ? ELEMENT_CHANGE_ALIASES[value] : undefined;
  const change = alias || value;
  return ELEMENT_CHANGES.includes(change) ? change : "added";
}

// The aggregate budget truncates instead of throwing. A model that returns one
// enormous diagram still leaves a readable plan behind.
function spend(budget, text) {
  if (!text) return "";
  if (budget.left <= 0) return "";
  const kept = text.slice(0, budget.left);
  budget.left -= kept.length;
  return kept;
}

// One plain-text rendering, shared by the brief writer and by the size guard,
// so validation measures exactly what an agent later receives.
export function formatDesignArtifacts(artifacts) {
  const items = Array.isArray(artifacts) ? artifacts : [];
  if (!items.length) return "";
  const lines = ["Design artifacts:"];
  for (const artifact of items) {
    if (artifact?.kind === "flow") {
      lines.push(`Flow ${artifact.id}: ${artifact.title || "untitled"}`);
      if (artifact.summary) lines.push(`  ${artifact.summary}`);
      for (const node of artifact.nodes || []) lines.push(`- node ${node.id} (${node.kind}): ${node.label}`);
      for (const edge of artifact.edges || []) lines.push(`- edge ${edge.from} -> ${edge.to}${edge.label ? `: ${edge.label}` : ""}`);
    } else if (artifact?.kind === "screen") {
      lines.push(`Screen ${artifact.id}: ${artifact.title || "untitled"}`);
      if (artifact.summary) lines.push(`  ${artifact.summary}`);
      if (artifact.screen?.name) lines.push(`- screen ${artifact.screen.name}`);
      for (const element of artifact.screen?.elements || []) {
        lines.push(`- ${element.change} ${element.kind} ${element.id}: ${element.label}${element.note ? ` (${element.note})` : ""}`);
      }
    }
  }
  return lines.join("\n");
}

export function formatOptionEvidence(evidence) {
  const source = evidence && typeof evidence === "object" ? evidence : {};
  const lines = [];
  for (const id of SPEC_OPTION_IDS) {
    const entry = source[id];
    if (!entry) continue;
    const links = [
      ...(entry.taskIds?.length ? [`tasks ${entry.taskIds.join(", ")}`] : []),
      ...(entry.criterionIds?.length ? [`criteria ${entry.criterionIds.join(", ")}`] : []),
    ].join("; ");
    lines.push(`- ${id}: ${entry.status}${links ? ` (${links})` : ""}${entry.rationale ? ` — ${entry.rationale}` : ""}`);
  }
  return lines.length ? ["Specification option evidence:", ...lines].join("\n") : "";
}

export function normalizeContractTask(raw, index = 0) {
  const source = raw && typeof raw === "object" && !Array.isArray(raw) ? raw : {};
  return {
    id: taskId(source.id, index),
    title: clean(source.title, 300),
    branch: clean(source.branch, 100),
    prompt: clean(source.prompt, 12_000),
    type: taskType(source.type),
    // Keep malformed references long enough for validation to reject them.
    // Silently dropping a bad dependency would incorrectly make two tasks
    // look safe to run in parallel.
    criterionIds: unique(strings(source.criterionIds, 20, 40)),
    dependsOn: unique(strings(source.dependsOn, 8, 40)),
    ownedAreas: strings(source.ownedAreas, 20, 300),
    verification: strings(source.verification, 20, 500),
  };
}

export function validateDeliveryContract(specValue, taskValues, specOptionsValue) {
  const spec = normalizeDeliveryContract(specValue);
  const specOptions = normalizeSpecOptions(specOptionsValue);
  const tasks = (Array.isArray(taskValues) ? taskValues : []).map(normalizeExistingTask);
  const errors = [];
  const warnings = [];
  if (!spec.outcome) errors.push("The delivery outcome is missing");
  if (!spec.acceptanceCriteria.length) errors.push("Add at least one acceptance criterion");
  if (!tasks.length) errors.push("Add at least one implementation task");

  const criterionIds = new Set();
  for (const criterion of spec.acceptanceCriteria) {
    if (!CRITERION_ID.test(criterion.id)) errors.push(`Acceptance criterion ${criterion.id || "without an id"} needs a stable id`);
    else if (criterionIds.has(criterion.id)) errors.push(`Acceptance criterion ${criterion.id} is duplicated`);
    else criterionIds.add(criterion.id);
    if (!criterion.verification) errors.push(`Acceptance criterion ${criterion.id} needs a verification method`);
  }

  const taskIds = new Set();
  const branches = new Set();
  for (const task of tasks) {
    if (!TASK_ID.test(task.id)) errors.push(`Task ${task.title || "without a title"} needs a stable id`);
    else if (taskIds.has(task.id)) errors.push(`Task ${task.id} is duplicated`);
    else taskIds.add(task.id);
    if (!task.title || !task.branch || !task.prompt) errors.push(`Task ${task.id} needs a title, branch and prompt`);
    if (task.branch && (!BRANCH.test(task.branch) || task.branch.includes(".."))) errors.push(`Task ${task.id} needs a valid Git branch name`);
    else if (task.branch && branches.has(task.branch)) errors.push(`Task branch ${task.branch} is duplicated`);
    else if (task.branch) branches.add(task.branch);
    if (!task.criterionIds.length) errors.push(`Task ${task.id} is not linked to an acceptance criterion`);
    if (!task.ownedAreas.length) errors.push(`Task ${task.id} needs at least one owned file or area`);
    if (!task.verification.length) errors.push(`Task ${task.id} needs an expected verification`);
    if (taskBriefSize(spec, task, specOptions) > MAX_TASK_BRIEF) errors.push(`Task ${task.id} would produce an oversized brief file; split it or shorten its contract`);
  }

  for (const task of tasks) {
    for (const criterionId of task.criterionIds) {
      if (!criterionIds.has(criterionId)) errors.push(`Task ${task.id} references unknown criterion ${criterionId}`);
    }
    for (const dependency of task.dependsOn) {
      if (dependency === task.id) errors.push(`Task ${task.id} cannot depend on itself`);
      else if (!taskIds.has(dependency)) errors.push(`Task ${task.id} depends on unknown task ${dependency}`);
    }
  }

  for (const criterionId of criterionIds) {
    if (!tasks.some((task) => task.criterionIds.includes(criterionId))) errors.push(`Acceptance criterion ${criterionId} has no task`);
  }

  const workflow = deliveryWaves(tasks);
  errors.push(...workflow.errors);
  for (const wave of workflow.waves) {
    const members = wave.map((id) => tasks.find((task) => task.id === id)).filter(Boolean);
    for (let left = 0; left < members.length; left += 1) {
      for (let right = left + 1; right < members.length; right += 1) {
        const overlap = ownershipOverlap(members[left].ownedAreas, members[right].ownedAreas);
        if (overlap.length) warnings.push(`${members[left].id} and ${members[right].id} may overlap in ${overlap.join(", ")}`);
      }
    }
  }
  if (spec.assumptions.length) warnings.push(`${spec.assumptions.length} planner assumption${spec.assumptions.length === 1 ? " remains" : "s remain"} visible for approval`);

  const optionCoverage = specOptionCoverage(spec, tasks, specOptions);
  for (const entry of optionCoverage) {
    if (entry.status === "missing") warnings.push(`Requested ${entry.id} coverage is missing: ${entry.message}`);
  }

  const coverage = spec.acceptanceCriteria.map((criterion) => ({
    criterionId: criterion.id,
    taskIds: tasks.filter((task) => task.criterionIds.includes(criterion.id)).map((task) => task.id),
  }));
  return { ready: errors.length === 0, errors: unique(errors), warnings: unique(warnings), waves: workflow.waves, coverage, optionCoverage };
}

// Coverage is computed from explicit references only. Searching task prose for
// words such as "unit" or "e2e" would report rigor that nobody planned.
function specOptionCoverage(spec, tasks, specOptions) {
  const taskById = new Map(tasks.map((task) => [task.id, task]));
  const criterionIds = new Set(spec.acceptanceCriteria.map((criterion) => criterion.id));
  const artifactKinds = new Set(spec.designArtifacts.map((artifact) => artifact.kind));
  return SPEC_OPTIONS.options.map((option) => {
    const requested = specOptions[option.id] === true;
    if (!requested) return { id: option.id, requested: false, status: "not_requested", message: "" };
    const entry = spec.optionEvidence[option.id];
    if (!entry) return missingOption(option.id, "the contract records no evidence entry");
    if (entry.status === "not_applicable") {
      if (!entry.rationale) return missingOption(option.id, "the not-applicable entry has no rationale");
      return { id: option.id, requested: true, status: "not_applicable", message: entry.rationale };
    }
    const linkedTasks = entry.taskIds.filter((id) => taskById.has(id));
    const linkedCriteria = entry.criterionIds.filter((id) => criterionIds.has(id));
    if (!linkedTasks.length) return missingOption(option.id, "the evidence names no known task");
    if (!linkedCriteria.length) return missingOption(option.id, "the evidence names no known acceptance criterion");
    if (option.id === "refactorPass" && !linkedTasks.some((id) => taskById.get(id).type === "refactor")) {
      return missingOption(option.id, "no linked task has the refactor type");
    }
    if (option.id === "screenMocks" && !artifactKinds.has("screen")) return missingOption(option.id, "the contract holds no screen artifact");
    if (option.id === "flowcharts" && !artifactKinds.has("flow")) return missingOption(option.id, "the contract holds no flow artifact");
    return { id: option.id, requested: true, status: "covered", message: `${linkedTasks.join(", ")} · ${linkedCriteria.join(", ")}` };
  });
}

function missingOption(id, message) {
  return { id, requested: true, status: "missing", message };
}

export function deliveryWaves(taskValues) {
  const tasks = (Array.isArray(taskValues) ? taskValues : []).map(normalizeExistingTask);
  const known = new Set(tasks.map((task) => task.id));
  const remaining = new Map(tasks.map((task) => [task.id, task.dependsOn.filter((id) => known.has(id))]));
  const completed = new Set();
  const waves = [];
  while (remaining.size) {
    const wave = [...remaining.entries()].filter(([, dependencies]) => dependencies.every((id) => completed.has(id))).map(([id]) => id);
    if (!wave.length) return { waves, errors: [`Task dependency cycle: ${[...remaining.keys()].join(", ")}`] };
    waves.push(wave);
    for (const id of wave) { remaining.delete(id); completed.add(id); }
  }
  return { waves, errors: [] };
}

export function taskWave(taskIdValue, readiness) {
  const index = (readiness?.waves || []).findIndex((wave) => wave.includes(taskIdValue));
  return index < 0 ? 0 : index;
}

export function completionReportInstruction(task) {
  const criterionIds = ids(task?.criterionIds, CRITERION_ID, 20);
  const verification = strings(task?.verification, 20, 500);
  const example = JSON.stringify({ criteria: criterionIds, verification: verification.map((check) => ({ check, status: "passed" })), limitations: [] });
  return [
    "Record completion evidence in the final commit message.",
    "Add one single-line trailer whose value is valid compact JSON:",
    `\`Cmux-Goal-Report: ${example}\``,
    `The criteria array must contain exactly the criteria this task completed: ${criterionIds.join(", ") || "none"}.`,
    `Use these expected verification strings verbatim as check values: ${verification.join("; ") || "none"}.`,
    "Verification status is `passed`, `failed`, or `not_run`. Do not claim `passed` without running the check.",
  ].join("\n");
}

export function parseCompletionReport(message) {
  const line = String(message || "").split("\n").find((value) => value.startsWith("Cmux-Goal-Report:"));
  if (!line) return { report: null, error: "The final commit has no Cmux-Goal-Report trailer" };
  const json = line.slice("Cmux-Goal-Report:".length).trim();
  if (!json || json.length > 4_000) return { report: null, error: "The completion report is empty or too large" };
  let raw;
  try { raw = JSON.parse(json); } catch { return { report: null, error: "The completion report is not valid JSON" }; }
  const report = {
    criteria: ids(raw?.criteria, CRITERION_ID, 20),
    verification: list(raw?.verification, 20).map((item) => ({
      check: clean(item?.check, 500),
      status: ["passed", "failed", "not_run"].includes(item?.status) ? item.status : "not_run",
    })).filter((item) => item.check),
    limitations: strings(raw?.limitations, 12, 500),
  };
  return { report, error: "" };
}

export function validateCompletionReport(task, reportValue) {
  const expected = ids(task?.criterionIds, CRITERION_ID, 20);
  const expectedVerification = strings(task?.verification, 20, 500);
  const report = reportValue && typeof reportValue === "object" ? reportValue : null;
  const errors = [];
  if (!report) return { ready: false, errors: ["The task has no completion report"] };
  for (const id of expected) if (!report.criteria?.includes(id)) errors.push(`Completion evidence is missing ${id}`);
  for (const id of report.criteria || []) if (!expected.includes(id)) errors.push(`Completion evidence claims unassigned criterion ${id}`);
  if (!report.verification?.length) errors.push("Completion evidence lists no verification");
  for (const check of expectedVerification) {
    if (!report.verification?.some((item) => item.check === check)) errors.push(`Completion evidence is missing expected verification: ${check}`);
  }
  if (report.verification?.some((item) => item.status !== "passed")) errors.push("Every reported verification must pass before the branch is ready");
  return { ready: errors.length === 0, errors };
}

export function scopeDrift(files, ownedAreas) {
  const patterns = strings(ownedAreas, 20, 300);
  return strings(files, 500, 1_000).filter((file) => !patterns.some((pattern) => matchesArea(file, pattern)));
}

// A nullable launch status belongs to legacy plans and means the task was
// launched before that field existed. Explicitly queued and failed tasks do
// not owe a branch in the current wave.
export function readyCount(tasks) {
  const launched = (tasks || []).filter((task) => !task.launchStatus || task.launchStatus === "launched");
  const ready = launched.filter((task) => task.deliveryStatus === "ready" || task.deliveryStatus === "integrated");
  return { ready: ready.length, total: launched.length };
}

function normalizeCriterion(raw, index) {
  if (typeof raw === "string") return { id: `AC-${index + 1}`, text: clean(raw, MAX_TEXT), verification: "Verify against the repository's declared checks" };
  return {
    id: normalizedId(raw?.id, `AC-${index + 1}`, CRITERION_ID),
    text: clean(raw?.text || raw?.criterion, MAX_TEXT),
    verification: clean(raw?.verification, MAX_TEXT),
  };
}

function taskBriefSize(spec, task, specOptions) {
  const criteria = spec.acceptanceCriteria.filter((criterion) => task.criterionIds.includes(criterion.id));
  return 1_600
    + formatDesignArtifacts(spec.designArtifacts).length
    + formatOptionEvidence(spec.optionEvidence).length
    + specOptionsBriefLines(specOptions).join("\n").length
    + spec.outcome.length
    + task.prompt.length
    + task.ownedAreas.join(", ").length
    + task.dependsOn.join(", ").length
    + (task.verification.join("; ").length * 2)
    + criteria.reduce((total, criterion) => total + criterion.id.length + criterion.text.length + criterion.verification.length, 0);
}

function normalizeRisk(raw) {
  if (typeof raw === "string") return { text: clean(raw, MAX_TEXT), mitigation: "", level: "medium" };
  return {
    text: clean(raw?.text || raw?.risk, MAX_TEXT),
    mitigation: clean(raw?.mitigation, MAX_TEXT),
    level: ["low", "medium", "high"].includes(raw?.level) ? raw.level : "medium",
  };
}

function normalizeExistingTask(task, index = 0) {
  const normalized = normalizeContractTask(task, index);
  return { ...task, ...normalized, id: clean(task?.id, 40) || normalized.id };
}

function ownershipOverlap(left, right) {
  const overlaps = [];
  for (const a of left) for (const b of right) {
    if (a === b || universalArea(a) || universalArea(b)) { overlaps.push(universalArea(a) ? a : b); continue; }
    const aRoot = areaRoot(a); const bRoot = areaRoot(b);
    if (aRoot && bRoot && (aRoot === bRoot || aRoot.startsWith(`${bRoot}/`) || bRoot.startsWith(`${aRoot}/`))) overlaps.push(aRoot.length <= bRoot.length ? a : b);
  }
  return unique(overlaps);
}

function areaRoot(value) {
  return clean(value, 300).replace(/^\.\//, "").split(/[?*[{]/, 1)[0].replace(/\/$/, "");
}

function matchesArea(file, pattern) {
  const normalizedFile = clean(file, 1_000).replace(/^\.\//, "");
  const normalizedPattern = clean(pattern, 300).replace(/^\.\//, "");
  if (!normalizedPattern) return false;
  if (!/[?*[]/.test(normalizedPattern)) return normalizedFile === normalizedPattern || normalizedFile.startsWith(`${normalizedPattern.replace(/\/$/, "")}/`);
  return globPattern(normalizedPattern).test(normalizedFile);
}

function universalArea(value) {
  return ["*", "**", "**/*"].includes(clean(value, 300).replace(/^\.\//, ""));
}

function globPattern(pattern) {
  let source = "";
  for (let index = 0; index < pattern.length; index += 1) {
    const character = pattern[index];
    if (character === "*" && pattern[index + 1] === "*") {
      index += 1;
      if (pattern[index + 1] === "/") { index += 1; source += "(?:.*/)?"; }
      else source += ".*";
    } else if (character === "*") source += "[^/]*";
    else if (character === "?") source += "[^/]";
    else source += character.replace(/[.+^${}()|[\]\\]/g, "\\$&");
  }
  return new RegExp(`^${source}$`);
}

function taskId(value, index) {
  return normalizedId(value, `t${index + 1}`, TASK_ID);
}

function taskType(value) {
  const type = clean(value, 40).toLowerCase();
  return ["feature", "bugfix", "ui", "backend", "docs", "test", "migration", "investigation", "refactor"].includes(type) ? type : "feature";
}

function normalizedId(value, fallback, pattern) {
  const id = clean(value, 40);
  return pattern.test(id) ? id : fallback;
}

function ids(values, pattern, maximum) {
  return unique(strings(values, maximum, 40).filter((value) => pattern.test(value)));
}

function strings(values, maximum, length) {
  return list(values, maximum).map((value) => clean(value, length)).filter(Boolean);
}

function list(value, maximum) {
  return Array.isArray(value) ? value.slice(0, maximum) : [];
}

function unique(values) {
  return [...new Set(values)];
}

function clean(value, maximum) {
  return typeof value === "string" ? value.trim().replace(/\r/g, "").slice(0, maximum) : "";
}
