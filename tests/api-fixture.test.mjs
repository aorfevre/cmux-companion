import assert from "node:assert/strict";
import test from "node:test";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

// The sentinel home exists only in this child regression. Ordinary API tests
// must pass with the caller's HOME unchanged and no isolation preload.
test("API fixture never opens operator paths and cleans up after setup failure", async (t) => {
  const operatorDirectory = await mkdtemp(join(tmpdir(), "cmux-operator-sentinel-"));
  t.after(() => rm(operatorDirectory, { recursive: true, force: true }));
  const sentinel = join(operatorDirectory, "sentinel");
  await writeFile(sentinel, "untouched");
  const script = `
    import fs from 'node:fs';
    import fsp from 'node:fs/promises';
    import os from 'node:os';
    import { syncBuiltinESMExports } from 'node:module';
    const operatorDirectory = process.argv[1];
    os.homedir = () => operatorDirectory;
    const touched = [];
    for (const [owner, names] of [[fs, ['readFileSync', 'writeFileSync', 'mkdirSync', 'openSync', 'existsSync']], [fsp, ['readFile', 'writeFile', 'mkdir', 'open', 'readdir']]]) {
      for (const name of names) {
        const original = owner[name];
        owner[name] = function(path, ...args) {
          if (String(path).startsWith(operatorDirectory)) touched.push(name + ':' + path);
          return original.call(this, path, ...args);
        };
      }
    }
    syncBuiltinESMExports();
    const { buildTestApp } = await import(${JSON.stringify(new URL("./helpers/api-app.mjs", import.meta.url).href)});
    const cleanups = [];
    const context = { after: (cleanup) => cleanups.push(cleanup) };
    const app = await buildTestApp(context, { token: 'disposable-api-token', cmux: { bin: '/fake/cmux' } });
    const directory = app.fixtureDirectory;
    const response = await app.inject({ url: '/api/repos', headers: { authorization: 'Bearer disposable-api-token' } });
    if (response.statusCode !== 200 || response.json().repos.length) throw new Error('Fixture must start with empty repository inventory');
    await app.close();
    for (const cleanup of cleanups.splice(0)) await cleanup();
    let failed = false;
    try { await buildTestApp(context, { token: '' }); } catch { failed = true; }
    for (const cleanup of cleanups) await cleanup();
    console.log(JSON.stringify({ touched, removed: !fs.existsSync(directory), failed }));
  `;
  const { stdout } = await promisify(execFile)(process.execPath, ["--input-type=module", "-e", script, operatorDirectory], { timeout: 20_000 });
  assert.deepEqual(JSON.parse(stdout), { touched: [], removed: true, failed: true });
  assert.equal(await readFile(sentinel, "utf8"), "untouched");
});
