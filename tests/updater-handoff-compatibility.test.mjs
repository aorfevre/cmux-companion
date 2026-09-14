import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { buildCandidate } from '../updater/src/manifest.mjs';
import { assertHandoffCompatibility } from '../updater/src/handoff-compatibility.mjs';

test('active handoff requires authenticated candidate and rollback-source protocol declarations', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'handoff-capability-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const target = { bundled: true, name: 'companion', entryPoints: [], verificationCommands: [] };
  const sha = 'a'.repeat(40), before = join(directory, 'before'), after = join(directory, 'after');
  const build = root => buildCandidate(target, root, sha, null, { execute: async () => ({ stdout: '10.0.0', code: 0 }) });
  for (const root of [before, after]) {
    await mkdir(join(root, 'updater/scripts'), { recursive: true }); await mkdir(join(root, 'server'));
    for (const name of ['package.json', 'package-lock.json']) await writeFile(join(root, name), '{}');
    for (const name of ['local-updater.mjs', 'bootstrap.mjs', 'launch-companion.mjs']) await writeFile(join(root, 'updater/scripts', name), '// fixture\n');
    await build(root);
  }
  await assert.rejects(assertHandoffCompatibility(target, before, sha, after, sha), { code: 'HANDOFF_UNSUPPORTED' });
  await writeFile(join(before, 'updater/scripts/launch-companion.mjs'), '// companion-native-handoff: 1\n'); await build(before);
  await assert.rejects(assertHandoffCompatibility(target, before, sha, after, sha), { code: 'HANDOFF_UNSUPPORTED' });
  await writeFile(join(after, 'updater/scripts/launch-companion.mjs'), '// companion-native-handoff: 1\n');
  await assert.rejects(assertHandoffCompatibility(target, before, sha, after, sha), /digest/);
  await build(after); await assertHandoffCompatibility(target, before, sha, after, sha);
});
