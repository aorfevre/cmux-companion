import assert from "node:assert/strict";
import test from "node:test";

import { SPEC_OPTIONS } from "../server/worktree-planner-options.mjs";
import { normalizeSpecOptions, specOptionsBriefLines, specOptionsPromptLines } from "../server/spec-options.mjs";

const ALL_FALSE = {
  unitTests: false,
  e2eTests: false,
  edgeCases: false,
  refactorPass: false,
  screenMocks: false,
  flowcharts: false,
};

test("the catalog lists the six options in a stable order", () => {
  assert.deepEqual(SPEC_OPTIONS.options.map((option) => option.id), Object.keys(ALL_FALSE));
  assert.deepEqual({ ...SPEC_OPTIONS.defaults }, ALL_FALSE);
  assert.ok(SPEC_OPTIONS.options.every((option) => option.label && option.hint));
  assert.ok(Object.isFrozen(SPEC_OPTIONS.defaults));
});

test("missing input returns a fresh all-false object", () => {
  assert.deepEqual(normalizeSpecOptions(undefined), ALL_FALSE);
  assert.deepEqual(normalizeSpecOptions(null), ALL_FALSE);
  const first = normalizeSpecOptions(null);
  first.unitTests = true;
  assert.equal(normalizeSpecOptions(null).unitTests, false);
  assert.notEqual(normalizeSpecOptions(null), SPEC_OPTIONS.defaults);
});

test("normalization keeps known booleans and fills the rest", () => {
  assert.deepEqual(normalizeSpecOptions({ e2eTests: true }), { ...ALL_FALSE, e2eTests: true });
  assert.deepEqual(normalizeSpecOptions({ ...ALL_FALSE, refactorPass: true, flowcharts: true }), {
    ...ALL_FALSE,
    refactorPass: true,
    flowcharts: true,
  });
});

test("normalization rejects every invalid shape", () => {
  assert.throws(() => normalizeSpecOptions("unitTests"), /must be an object/);
  assert.throws(() => normalizeSpecOptions(7), /must be an object/);
  assert.throws(() => normalizeSpecOptions(true), /must be an object/);
  assert.throws(() => normalizeSpecOptions([]), /must be an object/);
  assert.throws(() => normalizeSpecOptions(["unitTests"]), /must be an object/);
  assert.throws(() => normalizeSpecOptions({ unknown: true }), /Unknown specification option unknown/);
  assert.throws(() => normalizeSpecOptions({ unitTests: "yes" }), /unitTests must be true or false/);
  assert.throws(() => normalizeSpecOptions({ unitTests: 1 }), /unitTests must be true or false/);
  assert.throws(() => normalizeSpecOptions({ flowcharts: null }), /flowcharts must be true or false/);
});

test("all-false options produce no instruction lines", () => {
  assert.deepEqual(specOptionsPromptLines(ALL_FALSE), []);
  assert.deepEqual(specOptionsPromptLines(null), []);
  assert.deepEqual(specOptionsBriefLines(ALL_FALSE), []);
  assert.deepEqual(specOptionsBriefLines(undefined), []);
});

test("each single option contributes its own label and hint", () => {
  for (const option of SPEC_OPTIONS.options) {
    const prompt = specOptionsPromptLines({ [option.id]: true }).join("\n");
    const brief = specOptionsBriefLines({ [option.id]: true }).join("\n");
    assert.ok(prompt.includes(option.label), `${option.id} label missing from prompt`);
    assert.ok(prompt.includes(option.hint), `${option.id} hint missing from prompt`);
    assert.ok(brief.includes(option.label), `${option.id} label missing from brief`);
    assert.ok(brief.includes(option.hint), `${option.id} hint missing from brief`);
  }
});

test("prompt lines explain evidence, refactor and artifact handling", () => {
  const generic = specOptionsPromptLines({ unitTests: true }).join("\n");
  assert.match(generic, /spec\.optionEvidence/);
  assert.match(generic, /taskIds/);
  assert.match(generic, /criterionIds/);
  assert.match(generic, /not_applicable/);
  assert.ok(!generic.includes("spec.designArtifacts"));
  assert.ok(!generic.includes('type is "refactor"'));

  const refactor = specOptionsPromptLines({ refactorPass: true }).join("\n");
  assert.match(refactor, /type is "refactor"/);
  assert.match(refactor, /not_applicable with a rationale/);

  for (const id of ["screenMocks", "flowcharts"]) {
    const design = specOptionsPromptLines({ [id]: true }).join("\n");
    assert.match(design, /spec\.designArtifacts/);
    assert.match(design, /"kind":"flow"/);
    assert.match(design, /"kind":"screen"/);
    assert.match(design, /no screen or no flow/);
  }
});

test("brief lines ask the agent to report an unmet request", () => {
  const brief = specOptionsBriefLines({ edgeCases: true, unitTests: true });
  assert.match(brief[0], /Requested specification rigor/);
  assert.equal(brief.length, 4);
  assert.match(brief.at(-1), /completion limitations/);
});

test("instruction builders reject invalid options the same way", () => {
  assert.throws(() => specOptionsPromptLines({ unknown: true }), /Unknown specification option/);
  assert.throws(() => specOptionsBriefLines([]), /must be an object/);
});
