import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, lstatSync, realpathSync, rmSync, existsSync, chmodSync, symlinkSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { spawnSync, spawn } from 'node:child_process';
import { once } from 'node:events';
import { prepareCcsLaunch, validateCcsInvocation } from '../server/orchestration/adapters/ccs-managed-launcher.mjs';

function fixture(t) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'ccs-managed-'))); t.after(() => rmSync(root, { recursive: true, force: true }));
  const directory = join(root, 'private'), cwd = join(root, 'worktree'); mkdirSync(directory); mkdirSync(cwd);
  const nativeBin = join(root, 'claude'), bin = join(root, 'ccs'), packagePath = join(root, 'package.json');
  writeFileSync(bin, '#!/bin/sh\nexit 2\n', { mode: 0o700 }); writeFileSync(packagePath, '{"name":"@kaitranntt/ccs","version":"8.10.0"}');
  writeFileSync(nativeBin, `#!${process.execPath}
console.log(JSON.stringify({argv:process.argv.slice(2),pid:process.pid,cwd:process.cwd(),auth:process.env.ANTHROPIC_AUTH_TOKEN==='fixture-secret',endpoint:process.env.ANTHROPIC_BASE_URL==='http://127.0.0.1:9999',preload:!!process.env.NODE_OPTIONS,tty:[process.stdin.isTTY===true,process.stdout.isTTY===true,process.stderr.isTTY===true]}));
if(process.env.FIXTURE_SIGNAL) process.kill(process.pid,'SIGTERM');
process.exitCode=Number(process.env.FIXTURE_EXIT||0);
`, { mode: 0o700 });
  const fingerprint = path => { const s = lstatSync(path); return [s.dev, s.ino, s.size, s.mtimeMs, s.ctimeMs].join(':'); };
  const installation = { bin, nativeBin, packagePath, provider: 'claude', nativeStamp: fingerprint(nativeBin), wrapperStamp: fingerprint(bin), packageStamp: fingerprint(packagePath) };
  const argv = ['profile', '--target', 'claude', '--restricted', '--setting-sources', '', '--strict-mcp-config', '--mcp-config', join(directory, 'mcp.json'), '--append-system-prompt-file', join(directory, 'context.txt'), '--tools', 'Read,Grep,Glob', '--session-id', 'conversation', '--model', 'test', '--', 'Pinned task'];
  const command = { bin, argv, cwd, env: { PATH: process.env.PATH, HOME: root, CCS_CLAUDE_PATH: nativeBin } };
  const injected = approved => ['--settings', 'ccs-settings', ...approved.slice(0, -2), '--append-system-prompt-file', 'ccs-image-prompt', '--append-system-prompt-file', 'ccs-web-prompt', '--dangerously-skip-permissions', ...approved.slice(-2)];
  return { root, directory, cwd, installation, command, injected, run: (prepared, args, env = {}) => spawnSync(prepared.env.CCS_CLAUDE_PATH, args, { cwd, env: { ...prepared.env, ...env }, encoding: 'utf8' }) };
}

test('CCS additions cannot replace pinned task/tool policy; routing, PID, metadata and exit are preserved', async t => {
  const f = fixture(t), command = prepareCcsLaunch(f.command, f.installation, f.directory, 'initial'), approved = f.command.argv.slice(3);
  assert.deepEqual(prepareCcsLaunch(f.command, f.installation, f.directory, 'initial'), command, 'preparation replay is immutable');
  assert.equal(f.command.env.CCS_CLAUDE_PATH, f.installation.nativeBin, 'durable command binding is unchanged');
  const metadata = f.run(command, ['--version']); assert.equal(metadata.status, 0, metadata.stderr); assert.deepEqual(JSON.parse(metadata.stdout).argv, ['--version']);
  assert.equal(existsSync(join(f.directory, 'ccs-initial.json.sent')), false);
  const child = spawn(command.env.CCS_CLAUDE_PATH, f.injected(approved), { cwd: f.cwd, env: { ...command.env, ANTHROPIC_AUTH_TOKEN: 'fixture-secret', ANTHROPIC_BASE_URL: 'http://127.0.0.1:9999', FIXTURE_EXIT: '23' }, stdio: ['ignore', 'pipe', 'pipe'] });
  let stdout = ''; child.stdout.on('data', chunk => { stdout += chunk; });
  const [code, signal] = await once(child, 'exit'); assert.equal(code, 23); assert.equal(signal, null);
  const captured = JSON.parse(stdout); assert.deepEqual(captured.argv, approved); assert.equal(captured.pid, child.pid); assert.equal(captured.cwd, f.cwd); assert.equal(captured.auth, true); assert.equal(captured.endpoint, true);
  assert.equal(f.run(command, f.injected(approved)).status, 2, 'second wrapper invocation cannot duplicate the provider');
});

test('trusted resume and background modes get distinct recipes; unknown modes never consume them', t => {
  const f = fixture(t), initial = f.command.argv.slice(3), resume = [...f.command.argv]; resume[resume.indexOf('--session-id')] = '--resume';
  const command = prepareCcsLaunch({ ...f.command, argv: resume }, f.installation, f.directory, 'resume-one');
  assert.equal(f.run(command, f.injected(initial)).status, 2); assert.equal(existsSync(join(f.directory, 'ccs-resume-one.json.sent')), false);
  const resumed = f.run(command, f.injected(resume.slice(3))); assert.equal(resumed.status, 0, resumed.stderr); assert.deepEqual(JSON.parse(resumed.stdout).argv, resume.slice(3));
  const background = [...f.command.argv.slice(0, -2), '--print', '--permission-prompts', 'none', ...f.command.argv.slice(-2)];
  const bg = prepareCcsLaunch({ ...f.command, argv: background }, f.installation, f.directory, 'background');
  const killed = f.run(bg, f.injected(background.slice(3)), { FIXTURE_SIGNAL: '1' }); assert.equal(killed.signal, 'SIGTERM');
  for (const supplied of [['--help', ...initial], ['doctor'], [...initial, 'another prompt'], initial.filter(value => value !== '--restricted'), [...initial.slice(0, -2), '--resume', 'conversation', ...initial.slice(-2)]]) assert.throws(() => validateCcsInvocation(supplied, initial));
});

test('private recipe, installation and environment are revalidated after CCS routing', t => {
  const f = fixture(t), prepared = prepareCcsLaunch(f.command, f.installation, f.directory, 'initial'), approved = f.command.argv.slice(3);
  const preloader = join(f.root, 'preload.cjs'), marker = join(f.root, 'preloaded'); writeFileSync(preloader, `require('node:fs').writeFileSync(${JSON.stringify(marker)},'unsafe');`);
  const metadata = f.run(prepared, ['--help'], { NODE_OPTIONS: `--require=${preloader}` }); assert.equal(metadata.status, 0, metadata.stderr); assert.equal(existsSync(marker), false); assert.equal(JSON.parse(metadata.stdout).preload, false);
  for (const name of ['CLAUDE_CODE_SKIP_PERMISSIONS', 'CLAUDE_CODE_DISABLE_HOOKS', 'CLAUDE_CODE_BARE']) assert.equal(f.run(prepared, f.injected(approved), { [name]: '1' }).status, 2);
  const recipe = join(f.directory, 'ccs-initial.json'), body = readFileSync(recipe, 'utf8'); chmodSync(recipe, 0o600); writeFileSync(recipe, body.replace('Pinned task', 'Untrusted task')); assert.equal(f.run(prepared, f.injected(approved)).status, 2);
  assert.throws(() => prepareCcsLaunch(f.command, f.installation, f.directory, 'initial'), /recipe changed/);
});

test('direct Claude and Codex preserve their existing launch boundary', t => {
  const f = fixture(t);
  assert.equal(prepareCcsLaunch(f.command, undefined, f.directory, 'initial'), f.command);
  assert.equal(prepareCcsLaunch(f.command, { ...f.installation, provider: 'codex' }, f.directory, 'initial'), f.command);
  assert.equal(prepareCcsLaunch(f.command, { ...f.installation, bin: f.installation.nativeBin }, f.directory, 'initial'), f.command);
});


test('managed native exec retains all three terminal streams through a real PTY', t => {
  const f = fixture(t), command = prepareCcsLaunch(f.command, f.installation, f.directory, 'terminal');
  const quote = value => "'" + value.replaceAll("'", "'\\''") + "'";
  const nativeArgs = [command.env.CCS_CLAUDE_PATH, ...f.injected(f.command.argv.slice(3))];
  const scriptArgs = process.platform === 'darwin' ? ['-q', '/dev/null', ...nativeArgs] : ['-q', '-e', '-c', nativeArgs.map(quote).join(' '), '/dev/null'];
  const result = spawnSync('/bin/sh', ['-c', '/bin/cat | exec "$@"', 'fixture-pty', '/usr/bin/script', ...scriptArgs], { cwd: f.cwd, env: { ...command.env, TERM: 'xterm' }, input: '', encoding: 'utf8', timeout: 5000 });
  assert.equal(result.status, 0, result.stderr);
  const capture = result.stdout.match(/\{"argv":[^\r\n]+\}/)?.[0];
  assert.ok(capture, result.stdout); assert.deepEqual(JSON.parse(capture).tty, [true, true, true]);
});

test('replaced native binary, exposed recipe or symlink is rejected before native exec', t => {
  const f = fixture(t), command = prepareCcsLaunch(f.command, f.installation, f.directory, 'initial'), approved = f.command.argv.slice(3);
  const path = join(f.directory, 'ccs-initial.json'), original = readFileSync(path, 'utf8');
  chmodSync(path, 0o644); assert.equal(f.run(command, f.injected(approved)).status, 2);
  rmSync(path); const other = join(f.directory, 'other'); writeFileSync(other, original, { mode: 0o400 }); symlinkSync(other, path);
  assert.equal(f.run(command, f.injected(approved)).status, 2);
  rmSync(path); writeFileSync(path, original, { mode: 0o400 });
  writeFileSync(f.installation.nativeBin, '#!/bin/sh\nexit 0\n'); assert.equal(f.run(command, f.injected(approved)).status, 2);
  assert.equal(existsSync(`${path}.sent`), false);
});
