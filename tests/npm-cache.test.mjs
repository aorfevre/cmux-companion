import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtempSync, mkdirSync, rmSync, statSync, writeFileSync, utimesSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { NpmCache } from '../server/orchestration/adapters/npm-cache.mjs';

test('the shared npm cache is private, sets npm_config_cache and prunes oldest content under the cap', () => {
  const directory = mkdtempSync(join(tmpdir(), 'npm-cache-'));
  const cache = new NpmCache({ directory: join(directory, 'npm-cache') });
  assert.equal(statSync(cache.path).mode & 0o777, 0o700);
  assert.deepEqual(cache.environment(), { npm_config_cache: cache.path });
  assert.deepEqual(cache.prune(10), []);
  const content = join(cache.path, '_cacache', 'content-v2', 'sha512');
  mkdirSync(content, { recursive: true });
  for (const [name, age] of [['old', 3], ['mid', 2], ['new', 1]]) {
    mkdirSync(join(content, name)); writeFileSync(join(content, name, 'blob'), 'x'.repeat(1000));
    const when = new Date(Date.now() - age * 60000); utimesSync(join(content, name), when, when);
  }
  const removed = cache.prune(2500);
  assert.deepEqual(removed, [join(content, 'old')]);
  assert.equal(existsSync(join(content, 'old')), false); assert.equal(existsSync(join(content, 'new')), true);
  assert.deepEqual(cache.prune(2500), []);
  rmSync(directory, { recursive: true, force: true });
});
