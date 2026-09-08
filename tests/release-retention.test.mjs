import assert from "node:assert/strict";
import test from "node:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { releaseRetention } from "../server/release-retention.mjs";

// The deployed updater CLI is replaced by a tiny script that reports its argv,
// so the forwarding contract is verified without a real installation.
function installFakeOperator(t, body) {
  const home = mkdtempSync(join(tmpdir(), "release-retention-"));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  const scripts = join(home, ".local", "share", "cmux-companion-updater", "current", "scripts");
  mkdirSync(scripts, { recursive: true });
  writeFileSync(join(scripts, "operator.mjs"), body);
  return home;
}

function withEnv(t, values) {
  const previous = Object.fromEntries(Object.keys(values).map((key) => [key, process.env[key]]));
  for (const [key, value] of Object.entries(values)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  t.after(() => {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });
}

const ECHO_ARGV = "process.stdout.write(JSON.stringify({ argv: process.argv.slice(2) }));\n";

test("forwards each retention operation and its options to the deployed updater CLI", async (t) => {
  const home = installFakeOperator(t, ECHO_ARGV);
  withEnv(t, { CMUX_COMPANION_HOME: home });
  const result = await releaseRetention("preview", { keep: 3, dryRun: true });
  assert.deepEqual(result, { argv: ["cleanup-preview", JSON.stringify({ keep: 3, dryRun: true })] });
  const defaults = await releaseRetention("status");
  assert.deepEqual(defaults, { argv: ["cleanup-status", "{}"] });
});

test("locates the updater under the account home when no companion home override is set", async (t) => {
  const home = installFakeOperator(t, ECHO_ARGV);
  withEnv(t, { CMUX_COMPANION_HOME: undefined, HOME: home });
  const result = await releaseRetention("run", { keep: 1 });
  assert.deepEqual(result, { argv: ["cleanup-run", JSON.stringify({ keep: 1 })] });
});

test("rejects unknown operations before touching the updater", async (t) => {
  withEnv(t, { CMUX_COMPANION_HOME: join(tmpdir(), "does-not-exist-release-retention") });
  await assert.rejects(() => releaseRetention("purge"), { name: "TypeError", message: "Unknown release retention operation" });
  await assert.rejects(() => releaseRetention("cleanup-run; rm -rf /"), TypeError);
});

test("surfaces updater output that is not JSON and non-zero updater exits", async (t) => {
  const home = installFakeOperator(t, "process.stdout.write('not json');\n");
  withEnv(t, { CMUX_COMPANION_HOME: home });
  await assert.rejects(() => releaseRetention("configure", { keep: 2 }), SyntaxError);
  const failing = installFakeOperator(t, "process.stderr.write('lock held'); process.exit(3);\n");
  withEnv(t, { CMUX_COMPANION_HOME: failing });
  await assert.rejects(() => releaseRetention("run"), (error) => error.code === 3 && /lock held/.test(error.stderr));
});
