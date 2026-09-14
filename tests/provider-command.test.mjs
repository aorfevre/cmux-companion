import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, readFileSync, realpathSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { simpleAliasWords, resolveProviderCommand, validateResolvedCommand } from '../server/provider-command.mjs';
import { probeNativeCapabilities } from '../server/orchestration/adapters/native-capabilities.mjs';
import { providerCommand, LocalSettings, defaultSettings } from '../server/local-settings.mjs';

const command = executable => ({ executable, args: [], model: 'default' });
test('simple aliases resolve known provider argv and report discarded permission bypass flags', async () => {
  const aliases = { xclaude: 'ccs claude --dangerously-skip-permissions', xcodex: 'ccsxp --yolo' };
  const options = { readAlias: async name => aliases[name], resolve: name => `/canonical/${name}` };
  const claude = await resolveProviderCommand('claude', command('xclaude'), options);
  assert.equal(claude.kind, 'ccs'); assert.deepEqual(claude.args, ['claude']);
  assert.deepEqual(claude.ignoredPermissionFlags, ['--dangerously-skip-permissions']); assert.match(claude.message, /Ignored.*Companion manages/);
  const codex = await resolveProviderCommand('codex', command('xcodex'), options);
  assert.equal(codex.kind, 'ccsxp'); assert.deepEqual(codex.args, []); assert.deepEqual(codex.ignoredPermissionFlags, ['--yolo']);
  aliases.xcodex = 'codex';
  assert.equal(validateResolvedCommand('codex', codex).kind, 'ccsxp', 'frozen resolution does not reevaluate the changed alias');
  assert.equal(providerCommand(command('xcodex'), 'codex').executable, 'xcodex');
});

test('aliases cannot introduce shell execution, arbitrary flags, other providers or cycles', async () => {
  for (const source of ['ccsxp; touch /tmp/unsafe', 'ccsxp $(whoami)', 'ccsxp | cat', 'FOO=value ccsxp', 'function run() { ccsxp; }', 'ccsxp --config malicious', 'claude', 'again']) {
    await assert.rejects(resolveProviderCommand('codex', command('again'), { readAlias: async () => source, resolve: name => `/canonical/${name}` }), { code: 'UNSUPPORTED_CAPABILITY' }, source);
  }
  assert.deepEqual(simpleAliasWords('"/path with spaces/ccs" \'claude\''), ['/path with spaces/ccs', 'claude']);
  await assert.rejects(resolveProviderCommand('codex', command('ccsxp'), { resolve: () => null }), /not found/);
  assert.throws(() => providerCommand({ ...command('sh'), args: ['-c', 'echo nope'] }, 'codex'));
});

test('CCSXP capabilities require its package-owned entry and never execute the wrapper while probing', async t => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'ccsxp-capability-'))); t.after(() => rmSync(root, { recursive: true, force: true }));
  mkdirSync(join(root, 'dist', 'bin'), { recursive: true });
  const wrapper = join(root, 'dist', 'bin', 'ccsxp-runtime.js'), native = join(root, 'codex');
  writeFileSync(wrapper, `#!${process.execPath}\nthrow new Error('CCSXP must never execute in a metadata probe');`, { mode: 0o700 });
  writeFileSync(native, `#!${process.execPath}\nprocess.stdout.write(process.argv.includes('--version') ? 'codex-cli 0.154.0' : '--config --sandbox --ask-for-approval --strict-config --dangerously-bypass-hook-trust');`, { mode: 0o700 });
  const packageFile = join(root, 'package.json');
  writeFileSync(packageFile, JSON.stringify({ name: '@kaitranntt/ccs', version: '8.10.0', bin: { ccsxp: 'dist/bin/ccsxp-runtime.js' } }));
  const installation = await probeNativeCapabilities({ ccsBin: wrapper, claudeBin: native, provider: 'codex', ccsxp: true });
  assert.equal(installation.ccsxp, true); assert.equal(installation.env.CCS_CODEX_PATH, native); installation.assertCurrent();
  writeFileSync(packageFile, JSON.stringify({ ...JSON.parse(readFileSync(packageFile, 'utf8')), bin: { ccsxp: 'other.js' } }));
  assert.throws(() => installation.assertCurrent(), { code: 'UNSUPPORTED_CAPABILITY' });
  await assert.rejects(probeNativeCapabilities({ ccsBin: wrapper, claudeBin: native, provider: 'codex', ccsxp: true }), { code: 'UNSUPPORTED_CAPABILITY' });
});

test('goal settings preserve requested alias and its first normalized resolution across later settings changes', () => {
  const settings = new LocalSettings();
  try {
    const value = defaultSettings(); value.provider = 'codex'; value.providers.codex = command('xcodex');
    value.projects = [{ id: 'project', name: 'Project', enabled: true, path: '/disposable', github: 'owner/project', remote: 'ssh://git@github.com/owner/project.git', checks: [] }];
    settings.write(0, value);
    const resolution = { version: 1, provider: 'codex', executable: '/canonical/ccsxp-runtime.js', args: [], kind: 'ccsxp', model: 'default' };
    const saved = settings.snapshotGoal('goal', 'project', resolution);
    value.providers.codex = command('codex'); settings.write(1, value);
    assert.deepEqual(settings.snapshotGoal('goal', 'project', { ...resolution, executable: '/different' }), saved);
    assert.equal(saved.command.executable, 'xcodex'); assert.equal(saved.providerResolution.executable, resolution.executable);
  } finally { settings.close(); }
});
