import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ModelSettings } from "../server/model-settings.mjs";
import { DEFAULT_MODEL_ROLES } from "../server/model-options.mjs";

function settingsFile(t) {
  const directory = mkdtempSync(join(tmpdir(), "companion-models-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  return join(directory, "models.json");
}

test("built-in defaults match Astra planning and Fable review without a settings file", (t) => {
  const settings = new ModelSettings({ path: settingsFile(t) });
  assert.deepEqual(settings.engine("planner"), { provider: "codex", model: "gpt-6" });
  assert.equal(settings.engine("codeReviewer", "claude").model, "claude-fable-5-1");
  assert.deepEqual(settings.workspace("coder", "shell"), { agent: "shell" });
  const status = settings.status();
  status.roles.planner.models.codex = "changed";
  assert.equal(settings.engine("planner").model, "gpt-6");
});

test("saves role overrides atomically, retains other roles, and reloads them after restart", (t) => {
  const path = settingsFile(t);
  const settings = new ModelSettings({ path });
  settings.configure({ roles: { planner: { provider: "claude", models: { claude: "custom/planner-v2" } }, coder: { models: { codex: "custom-coder" } } } });
  const restarted = new ModelSettings({ path });
  assert.deepEqual(restarted.engine("planner"), { provider: "claude", model: "custom/planner-v2" });
  assert.deepEqual(restarted.workspace("coder", "codex"), { agent: "codex", model: "custom-coder" });
  assert.deepEqual(restarted.engine("merger"), { provider: "claude", model: "default" });
  assert.equal(statSync(path).mode & 0o777, 0o600);
  restarted.configure({ roles: { planner: DEFAULT_MODEL_ROLES.planner } });
  assert.equal(new ModelSettings({ path }).engine("planner").model, "gpt-6");
  assert.equal(restarted.engine("coder", "codex").model, "custom-coder");
});

test("invalid updates neither change memory nor replace the last saved settings", (t) => {
  const path = settingsFile(t);
  const settings = new ModelSettings({ path });
  settings.configure({ roles: { coder: { models: { codex: "custom-coder" } } } });
  const before = readFileSync(path, "utf8");
  for (const body of [null, [], {}, { unknown: true }, { roles: { missing: {} } }, { roles: { coder: { provider: "codex" } } }, { roles: { planner: { provider: "unknown" } } }, { roles: { coder: { models: { other: "foo" } } } }]) {
    assert.throws(() => settings.configure(body), TypeError);
  }
  for (const model of ["", "--help", "bad model", "$(touch /tmp/no)", "x;echo", "x\ny", "x".repeat(161), null, 12]) {
    assert.throws(() => settings.configure({ roles: { planner: { provider: "claude" }, coder: { models: { codex: model } } } }), /Model must/);
  }
  assert.equal(readFileSync(path, "utf8"), before);
  assert.equal(settings.engine("planner").provider, "codex");
});

test("reports corrupt storage and retains defaults until explicitly saved", (t) => {
  const path = settingsFile(t);
  writeFileSync(path, "not json");
  const settings = new ModelSettings({ path });
  assert.match(settings.status().warning, /Built-in defaults/);
  assert.equal(settings.engine("planner").model, "gpt-6");
  settings.configure({ roles: DEFAULT_MODEL_ROLES });
  assert.equal(settings.status().warning, null);
});

test("a failed write does not claim to have saved or change active defaults", (t) => {
  const path = settingsFile(t);
  writeFileSync(path, "parent is a file");
  const settings = new ModelSettings({ path: join(path, "models.json") });
  assert.throws(() => settings.configure({ roles: { planner: { models: { codex: "custom-model" } } } }));
  assert.equal(settings.engine("planner").model, "gpt-6");
});
