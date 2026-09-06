import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, mkdir, readFile, readdir, rm, stat, writeFile, chmod } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { configureCmuxAutomation } from "../scripts/configure-cmux-automation.mjs";

for (const alreadyConfigured of [false, true]) {
  test(`automation config repairs permissive files when contents ${alreadyConfigured ? "match" : "change"}`, async (t) => {
    const directory = await mkdtemp(join(tmpdir(), "cmux-config-permissions-"));
    t.after(() => rm(directory, { recursive: true, force: true }));
    const configDir = join(directory, ".config", "cmux");
    const credentialDir = join(directory, ".config", "cmux-companion");
    await mkdir(configDir, { recursive: true });
    await mkdir(credentialDir, { recursive: true });
    const configPath = join(configDir, "cmux.json");
    const credentialPath = join(credentialDir, "cmux-socket-password");
    const password = "disposable-password-".repeat(3);
    const original = JSON.stringify({ keep: "sentinel", automation: { socketControlMode: alreadyConfigured ? "password" : "allowAll", socketPassword: password } }, null, 2);
    await writeFile(configPath, original);
    await writeFile(credentialPath, password);
    await chmod(configPath, 0o644);
    await chmod(credentialPath, 0o644);
    const calls = [];
    const run = () => configureCmuxAutomation({ directory, cmuxBin: "/fake/cmux", execute: (...args) => calls.push(args) });
    const result = run();
    assert.equal(result.configurationChanged, !alreadyConfigured);
    const current = JSON.parse(await readFile(configPath, "utf8"));
    assert.equal(current.keep, "sentinel");
    assert.equal(current.automation.socketControlMode, "password");
    assert.equal(current.automation.socketPassword, password);
    assert.equal((await stat(configPath)).mode & 0o777, 0o600);
    assert.equal((await stat(credentialPath)).mode & 0o777, 0o600);
    const backups = (await readdir(configDir)).filter((name) => name.endsWith(".bak"));
    assert.equal(backups.length, alreadyConfigured ? 0 : 1);
    for (const name of backups) {
      assert.equal((await stat(join(configDir, name))).mode & 0o777, 0o600);
      assert.equal(await readFile(join(configDir, name), "utf8"), original);
    }
    assert.equal(calls.length, alreadyConfigured ? 0 : 1);
    if (calls.length) assert.deepEqual(calls[0].slice(0, 2), ["/fake/cmux", ["reload-config"]]);
    await chmod(configPath, 0o644);
    assert.equal(run().configurationChanged, false);
    assert.equal((await stat(configPath)).mode & 0o777, 0o600);
  });
}
