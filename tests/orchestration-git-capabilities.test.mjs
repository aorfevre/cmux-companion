import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { probeGitCapabilities } from '../server/orchestration/adapters/git-capabilities.mjs';

function executable(t, source) {
  const directory = mkdtempSync(join(tmpdir(), 'companion-git-capability-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const bin = join(directory, 'git');
  writeFileSync(bin, `#!${process.execPath}\n${source}\n`, { mode: 0o700 });
  return bin;
}

test('installed Git supports the exact merge-tree options required by integration', async () => {
  await probeGitCapabilities();
});

test('Git capability probing accepts help exit 129 and vendor option notation without relying on a version label', async t => {
  const bin = executable(t, `
    if (JSON.stringify(process.argv.slice(2)) !== JSON.stringify(['--no-pager', 'merge-tree', '-h'])) process.exit(2);
    if (process.env.LC_ALL !== 'C' || process.env.GIT_CONFIG_GLOBAL !== '/dev/null' || process.env.GH_TOKEN) process.exit(2);
    process.stderr.write('usage: git merge-tree\\n --write-tree\\n --[no-]messages\\n --[no-]merge-base <tree-ish>\\n');
    process.exitCode = 129;
  `);
  await probeGitCapabilities({ bin });
});

for (const help of [
  '--write-tree\n--messages\n', // Git 2.39 lacks the explicit merge base.
  '--write-tree\n--merge-base <tree-ish>\n',
  '--write-tree-extra\n--messages\n--merge-base <tree-ish>\n',
]) test(`unsupported Git options fail before integration: ${JSON.stringify(help)}`, async t => {
  const bin = executable(t, `process.stderr.write(${JSON.stringify(help)}); process.exitCode = 129;`);
  await assert.rejects(probeGitCapabilities({ bin }), error => error.code === 'UNSUPPORTED_CAPABILITY' && /2\.40/.test(error.message) && /service PATH/.test(error.message));
});

test('a failed executable cannot pass using incidental option text', async t => {
  const bin = executable(t, `process.stderr.write('--write-tree\\n--messages\\n--merge-base\\n'); process.exitCode = 1;`);
  await assert.rejects(probeGitCapabilities({ bin }), { code: 'UNSUPPORTED_CAPABILITY' });
  await assert.rejects(probeGitCapabilities({ bin: join(bin, 'missing') }), { code: 'UNSUPPORTED_CAPABILITY' });
});

test('successful stdout help is accepted but oversized metadata is refused', async t => {
  const help = '--write-tree\n--messages\n--merge-base <tree-ish>\n';
  const supported = executable(t, `process.stdout.write(${JSON.stringify(help)});`);
  await probeGitCapabilities({ bin: supported });
  const excessive = executable(t, `process.stdout.write(${JSON.stringify(help)} + 'x'.repeat(128 * 1024));`);
  await assert.rejects(probeGitCapabilities({ bin: excessive }), { code: 'UNSUPPORTED_CAPABILITY' });
});

test('Git metadata probes have a hard timeout even if the executable ignores TERM', async t => {
  const bin = executable(t, `process.on('SIGTERM', () => {}); setInterval(() => {}, 1000);`);
  await assert.rejects(probeGitCapabilities({ bin }), { code: 'UNSUPPORTED_CAPABILITY' });
});
