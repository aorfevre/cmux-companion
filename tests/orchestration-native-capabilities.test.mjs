import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, mkdir, realpath, writeFile, readFile, rm, symlink, unlink, access } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { probeNativeCapabilities } from '../server/orchestration/adapters/native-capabilities.mjs';
import { NativeInputs } from '../server/orchestration/adapters/native-inputs.mjs';
import { NativeBackground } from '../server/orchestration/adapters/native-background.mjs';

const help = `--restricted --permission-mode "manual" --permission-prompts "none" --setting-sources --strict-mcp-config --mcp-config --settings --tools --allowed-tools --disable-slash-commands --session-id --resume --print --output-format stream-json --verbose --no-session-persistence --model --effort --append-system-prompt[-file]`;
async function fixture(t, { version = '2.1.268', cliHelp = help, wrapperVersion = '8.9.0' } = {}) {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'orchestration-capability-')));
  t.after(() => rm(root, { recursive: true, force: true }));
  const dist = join(root, 'dist'); await mkdir(dist);
  const ccsBin = join(dist, 'ccs.js'), claudeBin = join(root, 'claude-version'), calls = join(root, 'metadata-calls');
  await writeFile(join(root, 'package.json'), JSON.stringify({ name: '@kaitranntt/ccs', version: wrapperVersion, bin: { ccs: 'dist/ccs.js' } }));
  await writeFile(ccsBin, `#!${process.execPath}\nthrow new Error('CCS must not execute during probing');\n`, { mode: 0o700 });
  await writeFile(claudeBin, `#!${process.execPath}
const fs = require('node:fs');
fs.appendFileSync(${JSON.stringify(calls)}, JSON.stringify({ argv: process.argv.slice(2), leaked: Object.keys(process.env).some(key => /TOKEN|CREDENTIAL|ANTHROPIC|OPENAI|CCS_/.test(key)) }) + '\\n');
if (process.argv[2] === '--version') process.stdout.write(${JSON.stringify(`${version} (Claude Code)`)});
else if (process.argv[2] === '--help') process.stdout.write(${JSON.stringify(cliHelp)});
else throw new Error('Unexpected provider launch');
`, { mode: 0o700 });
  return { root, ccsBin, claudeBin, calls };
}

test('capability probe runs only pinned native metadata and never starts CCS or inherits credentials', async (t) => {
  const f = await fixture(t), installation = await probeNativeCapabilities(f);
  assert.deepEqual(installation.evidence, { claudeVersion: '2.1.268', ccsVersion: '8.9.0', permissionEnforcement: 'unverified' });
  const calls = (await readFile(f.calls, 'utf8')).trim().split('\n').map(JSON.parse);
  assert.deepEqual(calls.map((call) => call.argv[0]).sort(), ['--help', '--version']);
  assert.ok(calls.every((call) => !call.leaked));
  assert.equal(installation.env.CCS_CLAUDE_PATH, f.claudeBin);
  assert.ok(Object.isFrozen(installation.capabilities)); installation.assertCurrent();
});

test('unsupported versions or missing permission capabilities fail closed with sanitized errors', async (t) => {
  for (const changes of [{ version: '2.1.267' }, { wrapperVersion: '8.8.0' }, { cliHelp: help.replace('--restricted', '') }, { cliHelp: help.replace('"manual"', '"bypassPermissions"') }]) {
    const f = await fixture(t, changes);
    await assert.rejects(probeNativeCapabilities(f), (error) => error.code === 'UNSUPPORTED_CAPABILITY' && !error.message.includes(f.root));
  }
});

test('native inputs pin the probed CLI despite PATH overrides and reject installation changes before writing context', async (t) => {
  const f = await fixture(t), installation = await probeNativeCapabilities(f);
  const inputs = new NativeInputs({ engine: { provider: 'default', model: 'fixture' }, capabilities: installation.capabilities, installation, env: { CCS_CLAUDE_PATH: '/unprobed/cli' }, describe: () => { throw new Error('Context must not be minted after installation changes'); } });
  assert.equal(inputs.env.CCS_CLAUDE_PATH, f.claudeBin);
  const alias = join(f.root, 'current'); await symlink(f.claudeBin, alias);
  const pinned = await probeNativeCapabilities({ ccsBin: f.ccsBin, claudeBin: alias });
  await unlink(alias); await symlink('/unavailable/new-version', alias);
  pinned.assertCurrent(); assert.equal(pinned.nativeBin, f.claudeBin);
  await writeFile(f.claudeBin, 'replaced installation');
  assert.throws(() => installation.assertCurrent(), { code: 'UNSUPPORTED_CAPABILITY' });
  await assert.rejects(inputs.prepare({ operationId: 'operation' }, join(f.root, 'private')), { code: 'UNSUPPORTED_CAPABILITY' });
  await assert.rejects(access(join(f.root, 'private')), { code: 'ENOENT' });
});

test('native driver refuses an unprobed wrapper before creating runtime state', async (t) => {
  const f = await fixture(t), installation = await probeNativeCapabilities(f);
  const inputs = new NativeInputs({ engine: { provider: 'default', model: 'fixture' }, capabilities: installation.capabilities, installation, env: {}, describe: () => ({ prompt: 'fixture' }) });
  const directory = join(f.root, 'native');
  assert.throws(() => new NativeBackground({ directory, bin: '/other/wrapper', inputs, policy: { ceilingMs: 1000, idleMs: 500, maxOutputBytes: 1000, killGraceMs: 50 }, onResult() {} }), { code: 'UNSUPPORTED_CAPABILITY' });
  await assert.rejects(access(directory), { code: 'ENOENT' });
});
