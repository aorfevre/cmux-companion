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

  const oversized = validateDeliveryContract(SPEC, [{ ...TASKS[0], prompt: "x".repeat(4_000), verification: ["v".repeat(500)], criterionIds: ["AC-1", "AC-2"] }]);
  assert.ok(oversized.errors.some((error) => error.includes("too large for one agent brief")));
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
