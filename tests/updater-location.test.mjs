import assert from 'node:assert/strict';
import test from 'node:test';
import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';

const execute = promisify(execFile);

test('operator lookup uses the configured installation home and retains explicit overrides', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'companion-lookup-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const installation = join(directory, 'custom home');
  const bundled = join(installation, '.local/share/cmux-companion/current/updater/scripts');
  const override = join(directory, 'explicit updater');
  for (const scripts of [bundled, join(override, 'scripts')]) {
    await mkdir(scripts, { recursive: true });
    // Only this fake operator executes: no installed control state or services.
    await writeFile(join(scripts, 'operator.mjs'), 'console.log(JSON.stringify({ script: import.meta.url, action: process.argv[2] }));\n');
  }
  const env = { ...process.env, CMUX_COMPANION_HOME: installation, CMUX_COMPANION_UPDATER_REPOSITORY: '' };
  for (const explicit of ['', override]) {
    const options = { env: { ...env, CMUX_COMPANION_UPDATER_REPOSITORY: explicit } };
    const expected = join(explicit ? join(explicit, 'scripts') : bundled, 'operator.mjs');
    const result = JSON.parse((await execute(process.execPath, ['scripts/updater-operator.mjs', 'check'], options)).stdout);
    assert.equal(fileURLToPath(result.script), await realpath(expected));
    assert.equal(result.action, 'check');
    if (existsSync('/bin/zsh')) {
      const result = await execute('/bin/zsh', ['-c', 'source "$1"; resolve_updater_script operator.mjs', 'lookup', resolve('scripts/updater-location.sh')], options);
      assert.equal(result.stdout.trim(), expected);
    }
  }
  await assert.rejects(execute(process.execPath, ['scripts/updater-operator.mjs', 'check'], { env: { ...env, CMUX_COMPANION_HOME: 'relative-home' } }), /absolute directory/);
});
