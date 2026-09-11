import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

for (const boundary of ['intent', 'dispatch', 'completion']) {
  test(`process death after ${boundary} recovers durable work with exactly one external launch`, (t) => {
    const directory = mkdtempSync(join(tmpdir(), 'orchestration-recovery-'));
    t.after(() => rmSync(directory, { recursive: true, force: true }));
    const run = (point) => spawnSync(process.execPath, ['tests/helpers/orchestration/recovery-child.mjs', directory, point], { encoding: 'utf8', timeout: 10000 });
    const crashed = run(boundary);
    assert.equal(crashed.error, undefined); assert.equal(crashed.signal, 'SIGKILL', crashed.stderr);
    assert.equal(readFileSync(join(directory, 'checkpoint'), 'utf8'), boundary);
    for (let restart = 0; restart < 2; restart++) {
      const recovered = run('none');
      assert.equal(recovered.error, undefined); assert.equal(recovered.status, 0, recovered.stderr);
      const state = JSON.parse(recovered.stdout);
      assert.equal(state.attempt.workerState, 'running'); assert.equal(state.capacity.total, 1);
      assert.deepEqual(state.operations, []);
      assert.deepEqual(readFileSync(join(directory, 'launches.txt'), 'utf8').trim().split('\n'), [state.attempt.operationId]);
    }
  });
}
