import assert from "node:assert/strict";
import test from "node:test";

import {
  completionReportInstruction,
  deliveryWaves,
  normalizeContractTask,
  normalizeDeliveryContract,
  parseCompletionReport,
  scopeDrift,
  validateCompletionReport,
  validateDeliveryContract,
} from "../server/delivery-contract.mjs";

const SPEC = {
  outcome: "Customers can export invoices.",
  inScope: ["Invoice CSV export"],
  nonGoals: ["PDF export"],
  constraints: ["Keep the existing API compatible"],
  assumptions: ["The current authorization model remains"],
  acceptanceCriteria: [
    { id: "AC-1", text: "Authorized users receive a CSV", verification: "API test downloads and parses the CSV" },
    { id: "AC-2", text: "Unauthorized users are rejected", verification: "Authorization test returns 403" },
  ],
  risks: [{ text: "Large exports can consume memory", mitigation: "Stream rows", level: "medium" }],
};

const TASKS = [
  { id: "T1", title: "Export API", branch: "feature/export-api", prompt: "Build it.", type: "backend", criterionIds: ["AC-1"], dependsOn: [], ownedAreas: ["server/export/**"], verification: ["npm test -- export"] },
  { id: "T2", title: "Authorization", branch: "feature/export-auth", prompt: "Protect it.", type: "backend", criterionIds: ["AC-2"], dependsOn: ["T1"], ownedAreas: ["server/auth/**"], verification: ["npm test -- auth"] },
];

test("normalizes the delivery contract and task metadata", () => {
  const spec = normalizeDeliveryContract(SPEC);
  const task = normalizeContractTask(TASKS[0]);
  assert.equal(spec.version, 2);
  assert.equal(spec.acceptanceCriteria[0].id, "AC-1");
  assert.equal(spec.risks[0].level, "medium");
  assert.deepEqual(task.criterionIds, ["AC-1"]);
  assert.deepEqual(task.ownedAreas, ["server/export/**"]);
});

test("computes execution waves from task dependencies", () => {
  assert.deepEqual(deliveryWaves(TASKS), { waves: [["T1"], ["T2"]], errors: [] });
  assert.match(deliveryWaves([{ ...TASKS[0], dependsOn: ["T2"] }, TASKS[1]]).errors[0], /cycle/);
});

test("validates criterion coverage, task ownership and verification", () => {
  const ready = validateDeliveryContract(SPEC, TASKS);
  assert.equal(ready.ready, true);
  assert.deepEqual(ready.waves, [["T1"], ["T2"]]);
  assert.deepEqual(ready.coverage[0], { criterionId: "AC-1", taskIds: ["T1"] });

  const broken = validateDeliveryContract(SPEC, [{ ...TASKS[0], criterionIds: [], verification: [], ownedAreas: [] }]);
  assert.equal(broken.ready, false);
  assert.ok(broken.errors.some((error) => error.includes("not linked")));
  assert.ok(broken.errors.some((error) => error.includes("AC-2 has no task")));

  const unsafe = validateDeliveryContract(SPEC, [TASKS[0], { ...TASKS[1], branch: TASKS[0].branch, dependsOn: ["not a valid id"] }]);
  assert.ok(unsafe.errors.some((error) => error.includes("duplicated")));
  assert.ok(unsafe.errors.some((error) => error.includes("unknown task not a valid id")));

  const inlineSized = validateDeliveryContract(SPEC, [{ ...TASKS[0], prompt: "x".repeat(4_000), verification: ["v".repeat(500)], criterionIds: ["AC-1", "AC-2"] }]);
  assert.equal(inlineSized.ready, true);
  assert.ok(!inlineSized.errors.some((error) => error.includes("brief")));
});

test("rejects a task whose brief file would be oversized", () => {
  const oversized = validateDeliveryContract(SPEC, [{
    ...TASKS[0],
    prompt: "x".repeat(12_000),
    verification: Array.from({ length: 20 }, () => "v".repeat(500)),
    criterionIds: ["AC-1", "AC-2"],
  }]);
  assert.equal(oversized.ready, false);
  assert.ok(oversized.errors.some((error) => error.includes("would produce an oversized brief file")));
});

test("warns when parallel tasks claim the same implementation area", () => {
  const tasks = [TASKS[0], { ...TASKS[1], dependsOn: [], ownedAreas: ["server/export/routes"] }];
  const result = validateDeliveryContract(SPEC, tasks);
  assert.ok(result.warnings.some((warning) => warning.includes("may overlap")));
  const universal = validateDeliveryContract(SPEC, [
    { ...TASKS[0], ownedAreas: ["**/*"] },
    { ...TASKS[1], dependsOn: [], ownedAreas: ["docs/**"] },
  ]);
  assert.ok(universal.warnings.some((warning) => warning.includes("**/*")));
});

test("parses and checks compact completion evidence", () => {
  const message = [
    "Ship export",
    "",
    'Cmux-Goal-Report: {"criteria":["AC-1"],"verification":[{"check":"npm test -- export","status":"passed"}],"limitations":[]}',
    "Cmux-Goal-Ready: plan/T1",
  ].join("\n");
  const parsed = parseCompletionReport(message);
  assert.equal(parsed.error, "");
  assert.equal(validateCompletionReport(TASKS[0], parsed.report).ready, true);
  assert.match(completionReportInstruction(TASKS[0]), /AC-1/);
  assert.match(completionReportInstruction(TASKS[0]), /npm test -- export/);

  const failed = parseCompletionReport('Cmux-Goal-Report: {"criteria":[],"verification":[]}');
  assert.equal(validateCompletionReport(TASKS[0], failed.report).ready, false);
  const unrelated = { criteria: ["AC-1", "AC-2"], verification: [{ check: "echo ok", status: "passed" }], limitations: [] };
  const unrelatedResult = validateCompletionReport(TASKS[0], unrelated);
  assert.equal(unrelatedResult.ready, false);
  assert.ok(unrelatedResult.errors.some((error) => error.includes("unassigned criterion AC-2")));
  assert.ok(unrelatedResult.errors.some((error) => error.includes("npm test -- export")));
});

test("finds changed files outside exact, directory and glob ownership", () => {
  assert.deepEqual(scopeDrift(
    ["server/export/index.mjs", "server/export/routes/csv.mjs", "tests/export.test.mjs", "README.md"],
    ["server/export/**", "tests/export.test.mjs"],
  ), ["README.md"]);
  assert.deepEqual(scopeDrift(["README.md", "src/app.ts", "src/nested/view.ts"], ["**/*"]), []);
  assert.deepEqual(scopeDrift(["src/app.ts", "src/nested/view.ts", "src/app.js"], ["src/**/*.ts"]), ["src/app.js"]);
});

const OPTION_TASKS = [
  ...TASKS,
  { id: "T3", title: "Refactor pass", branch: "feature/export-refactor", prompt: "Clean it.", type: "refactor", criterionIds: ["AC-1"], dependsOn: ["T2"], ownedAreas: ["server/export/tidy/**"], verification: ["npm test"] },
];

const FLOW = {
  id: "F1",
  kind: "flow",
  title: "Export flow",
  nodes: [
    { id: "n1", label: "Open export", kind: "start" },
    { id: "n2", label: "Authorized?", kind: "decision" },
    { id: "n3", label: "Download CSV", kind: "end" },
  ],
  edges: [
    { from: "n1", to: "n2", label: "click" },
    { from: "n2", to: "n3", label: "yes" },
  ],
};

const SCREEN = {
  id: "S1",
  kind: "screen",
  title: "Export screen",
  summary: "The invoice list gains an export action.",
  screen: {
    name: "Invoices",
    elements: [
      { id: "e1", label: "Invoices", kind: "header", change: "unchanged" },
      { id: "e2", label: "Export CSV", kind: "button", change: "added", note: "Top right of the header." },
    ],
  },
};

function evidence(id, entry) {
  return { [id]: { status: "planned", rationale: "", taskIds: ["T1"], criterionIds: ["AC-1"], ...entry } };
}

function coverageOf(result, id) {
  return result.optionCoverage.find((entry) => entry.id === id);
}

test("keeps two-argument callers working and reports unrequested options", () => {
  const result = validateDeliveryContract(SPEC, TASKS);
  assert.equal(result.ready, true);
  assert.equal(result.optionCoverage.length, 6);
  assert.ok(result.optionCoverage.every((entry) => entry.requested === false && entry.status === "not_requested"));
  assert.ok(!result.warnings.some((warning) => warning.includes("coverage is missing")));
});

test("normalizes design artifacts, evidence and their caps", () => {
  const spec = normalizeDeliveryContract({
    ...SPEC,
    optionEvidence: evidence("unitTests"),
    designArtifacts: [FLOW, SCREEN],
  });
  assert.deepEqual(spec.designArtifacts.map((artifact) => artifact.id), ["F1", "S1"]);
  assert.equal(spec.designArtifacts[0].nodes.length, 3);
  assert.equal(spec.designArtifacts[0].edges.length, 2);
  assert.equal(spec.designArtifacts[1].screen.name, "Invoices");
  assert.equal(spec.designArtifacts[1].screen.elements[1].change, "added");
  assert.equal(spec.designArtifacts[1].screen.elements[1].note, "Top right of the header.");
  assert.equal(spec.designArtifacts[1].summary, "The invoice list gains an export action.");
  assert.deepEqual(spec.optionEvidence.unitTests, { status: "planned", rationale: "", taskIds: ["T1"], criterionIds: ["AC-1"] });
  assert.deepEqual(spec.optionEvidence, normalizeDeliveryContract({ ...SPEC, optionEvidence: evidence("unitTests") }).optionEvidence);

  const capped = normalizeDeliveryContract({
    ...SPEC,
    designArtifacts: [
      ...Array.from({ length: 8 }, (_, index) => ({ ...FLOW, id: `F${index + 1}` })),
    ],
  });
  assert.equal(capped.designArtifacts.length, 6);

  const overLists = normalizeDeliveryContract({
    ...SPEC,
    designArtifacts: [
      { ...FLOW, nodes: Array.from({ length: 40 }, (_, index) => ({ id: `n${index + 1}`, label: `node ${index + 1}` })), edges: [] },
      { ...SCREEN, screen: { name: "Invoices", elements: Array.from({ length: 40 }, (_, index) => ({ id: `e${index + 1}`, label: `element ${index + 1}` })) } },
    ],
  });
  assert.equal(overLists.designArtifacts[0].nodes.length, 24);
  assert.equal(overLists.designArtifacts[1].screen.elements.length, 24);
  assert.equal(overLists.designArtifacts[0].nodes[0].label.length, 6);

  const overText = normalizeDeliveryContract({
    ...SPEC,
    designArtifacts: [{ ...FLOW, title: "t".repeat(400), summary: "s".repeat(900), nodes: [{ id: "n1", label: "l".repeat(400), kind: "start" }], edges: [] }],
  });
  assert.equal(overText.designArtifacts[0].title.length, 200);
  assert.equal(overText.designArtifacts[0].summary.length, 600);
  assert.equal(overText.designArtifacts[0].nodes[0].label.length, 120);

  const overNote = normalizeDeliveryContract({
    ...SPEC,
    designArtifacts: [{ ...SCREEN, screen: { name: "n".repeat(300), elements: [{ id: "e1", label: "Row", note: "x".repeat(400) }] } }],
  });
  assert.equal(overNote.designArtifacts[0].screen.name.length, 120);
  assert.equal(overNote.designArtifacts[0].screen.elements[0].note.length, 240);
});

test("repairs duplicate ids, drops dangling edges, empty artifacts and unknown kinds", () => {
  const spec = normalizeDeliveryContract({
    ...SPEC,
    designArtifacts: [
      { ...FLOW, id: "F1" },
      { ...SCREEN, id: "F1" },
      { id: "X1", kind: "sequence", title: "Unknown", nodes: [{ id: "n1", label: "n" }] },
      { id: "X2", kind: "flow", title: "Empty", nodes: [], edges: [] },
      { id: "X3", kind: "screen", title: "Empty", screen: { name: "Empty", elements: [{ id: "e1", label: "" }] } },
      {
        id: "F4",
        kind: "flow",
        title: "Repairs",
        nodes: [{ id: "n1", label: "first" }, { id: "n1", label: "second" }, { id: "!!", label: "third" }],
        edges: [{ from: "n1", to: "missing" }, { from: "ghost", to: "n1" }, { from: "n1", to: "n2" }],
      },
    ],
  });
  assert.deepEqual(spec.designArtifacts.map((artifact) => artifact.id), ["F1", "a2", "F4"]);
  assert.equal(spec.designArtifacts[1].kind, "screen");
  const repaired = spec.designArtifacts[2];
  assert.deepEqual(repaired.nodes.map((node) => node.id), ["n1", "n2", "n3"]);
  assert.deepEqual(repaired.edges, [{ from: "n1", to: "n2", label: "" }]);

  // A screen with no name is not a wireframe, so it is dropped like an empty one.
  const nameless = normalizeDeliveryContract({
    ...SPEC,
    designArtifacts: [{ id: "S9", kind: "screen", title: "Nameless", screen: { name: "", elements: [{ id: "e1", label: "Row" }] } }],
  });
  assert.deepEqual(nameless.designArtifacts, []);
});

test("holds design artifacts inside an aggregate text budget without throwing", () => {
  const spec = normalizeDeliveryContract({
    ...SPEC,
    designArtifacts: Array.from({ length: 6 }, (_, artifact) => ({
      id: `F${artifact + 1}`,
      kind: "flow",
      title: "t".repeat(200),
      nodes: Array.from({ length: 24 }, (_, node) => ({ id: `n${node + 1}`, label: "l".repeat(160) })),
      edges: Array.from({ length: 40 }, (_, edge) => ({ from: "n1", to: "n2", label: `${"e".repeat(150)}${edge}` })),
    })),
  });
  const retained = spec.designArtifacts.reduce((total, artifact) => total
    + artifact.title.length
    + artifact.nodes.reduce((sum, node) => sum + node.label.length, 0)
    + artifact.edges.reduce((sum, edge) => sum + edge.label.length, 0), 0);
  assert.ok(retained <= 16_000, `retained ${retained} characters`);
  assert.ok(spec.designArtifacts.length > 0);
  assert.equal(validateDeliveryContract(spec, TASKS).ready, true);
});

test("cyclic flows and malformed evidence never block readiness", () => {
  const cyclic = {
    ...SPEC,
    optionEvidence: {
      unitTests: "planned",
      e2eTests: { status: "unknown", taskIds: ["T1"] },
      edgeCases: ["planned"],
      refactorPass: { status: "planned", taskIds: ["not a task id"], criterionIds: ["nope"] },
      flowcharts: null,
    },
    designArtifacts: [{
      ...FLOW,
      edges: [{ from: "n1", to: "n2" }, { from: "n2", to: "n3" }, { from: "n3", to: "n1" }],
    }],
  };
  const spec = normalizeDeliveryContract(cyclic);
  assert.deepEqual(Object.keys(spec.optionEvidence), ["refactorPass"]);
  assert.deepEqual(spec.optionEvidence.refactorPass, { status: "planned", rationale: "", taskIds: [], criterionIds: [] });
  assert.equal(spec.designArtifacts[0].edges.length, 3);
  const result = validateDeliveryContract(cyclic, TASKS);
  assert.equal(result.ready, true);
  assert.deepEqual(result.errors, []);
});

test("reports covered, not applicable and missing coverage for each option", () => {
  const cases = [
    { name: "unitTests covered", id: "unitTests", spec: { optionEvidence: evidence("unitTests") }, status: "covered" },
    { name: "e2eTests covered", id: "e2eTests", spec: { optionEvidence: evidence("e2eTests", { taskIds: ["T2"], criterionIds: ["AC-2"] }) }, status: "covered" },
    { name: "edgeCases justified", id: "edgeCases", spec: { optionEvidence: { edgeCases: { status: "not_applicable", rationale: "The endpoint takes no input." } } }, status: "not_applicable" },
    { name: "edgeCases blank rationale", id: "edgeCases", spec: { optionEvidence: { edgeCases: { status: "not_applicable", rationale: "  " } } }, status: "missing", message: /no rationale/ },
    { name: "unitTests without an entry", id: "unitTests", spec: {}, status: "missing", message: /no evidence entry/ },
    { name: "unitTests unknown task", id: "unitTests", spec: { optionEvidence: evidence("unitTests", { taskIds: ["T9"] }) }, status: "missing", message: /no known task/ },
    { name: "unitTests unknown criterion", id: "unitTests", spec: { optionEvidence: evidence("unitTests", { criterionIds: ["AC-9"] }) }, status: "missing", message: /no known acceptance criterion/ },
    { name: "refactorPass without a refactor task", id: "refactorPass", spec: { optionEvidence: evidence("refactorPass") }, status: "missing", message: /refactor type/ },
    { name: "refactorPass with a refactor task", id: "refactorPass", spec: { optionEvidence: evidence("refactorPass", { taskIds: ["T3"] }) }, status: "covered" },
    { name: "screenMocks without an artifact", id: "screenMocks", spec: { optionEvidence: evidence("screenMocks") }, status: "missing", message: /no screen artifact/ },
    { name: "screenMocks with a screen", id: "screenMocks", spec: { optionEvidence: evidence("screenMocks"), designArtifacts: [SCREEN] }, status: "covered" },
    { name: "flowcharts with only a screen", id: "flowcharts", spec: { optionEvidence: evidence("flowcharts"), designArtifacts: [SCREEN] }, status: "missing", message: /no flow artifact/ },
    { name: "flowcharts with a flow", id: "flowcharts", spec: { optionEvidence: evidence("flowcharts"), designArtifacts: [FLOW] }, status: "covered" },
  ];

  for (const item of cases) {
    const result = validateDeliveryContract({ ...SPEC, ...item.spec }, OPTION_TASKS, { [item.id]: true });
    const entry = coverageOf(result, item.id);
    assert.equal(entry.status, item.status, `${item.name} reported ${entry.status}`);
    assert.equal(entry.requested, true, item.name);
    assert.equal(result.ready, true, `${item.name} must not block readiness`);
    assert.equal(result.errors.length, 0, `${item.name} must add no error`);
    const warned = result.warnings.some((warning) => warning.includes(`Requested ${item.id} coverage is missing`));
    assert.equal(warned, item.status === "missing", `${item.name} warning mismatch`);
    if (item.message) assert.match(entry.message, item.message, item.name);
    for (const other of result.optionCoverage.filter((value) => value.id !== item.id)) {
      assert.equal(other.status, "not_requested", `${item.name} leaked into ${other.id}`);
      assert.equal(other.requested, false, item.name);
    }
  }
});

test("reports every requested option together and names each missing one", () => {
  const requested = { unitTests: true, e2eTests: true, edgeCases: true, refactorPass: true, screenMocks: true, flowcharts: true };
  const spec = {
    ...SPEC,
    optionEvidence: {
      ...evidence("unitTests"),
      ...evidence("e2eTests", { taskIds: ["T2"], criterionIds: ["AC-2"] }),
      edgeCases: { status: "not_applicable", rationale: "The export takes no user input." },
      ...evidence("refactorPass", { taskIds: ["T3"] }),
      ...evidence("flowcharts"),
    },
    designArtifacts: [FLOW],
  };
  const result = validateDeliveryContract(spec, OPTION_TASKS, requested);
  assert.equal(result.ready, true);
  assert.deepEqual(result.optionCoverage.map((entry) => entry.status), [
    "covered", "covered", "not_applicable", "covered", "missing", "covered",
  ]);
  assert.equal(result.warnings.filter((warning) => warning.includes("coverage is missing")).length, 1);
  assert.ok(result.warnings.some((warning) => warning.includes("Requested screenMocks coverage is missing")));
  assert.match(coverageOf(result, "unitTests").message, /T1/);
  assert.match(coverageOf(result, "unitTests").message, /AC-1/);
});

test("counts artifacts, evidence and option instructions in the brief size guard", () => {
  const bulky = {
    ...SPEC,
    optionEvidence: evidence("unitTests", { rationale: "r".repeat(500) }),
    designArtifacts: Array.from({ length: 6 }, (_, artifact) => ({
      id: `F${artifact + 1}`,
      kind: "flow",
      title: "t".repeat(200),
      nodes: Array.from({ length: 24 }, (_, node) => ({ id: `n${node + 1}`, label: "l".repeat(160) })),
      edges: [],
    })),
  };
  const task = { ...TASKS[0], prompt: "x".repeat(11_000), criterionIds: ["AC-1", "AC-2"] };
  assert.equal(validateDeliveryContract(SPEC, [{ ...task, criterionIds: ["AC-1"] }, TASKS[1]]).ready, true);
  const oversized = validateDeliveryContract(bulky, [task, TASKS[1]], { unitTests: true });
  assert.equal(oversized.ready, false);
  assert.ok(oversized.errors.some((error) => error.includes("would produce an oversized brief file")));
});
