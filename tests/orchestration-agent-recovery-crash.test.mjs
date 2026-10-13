import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

for (const boundary of ['reserved', 'applied', 'sent']) test(`automatic recovery survives SIGKILL after ${boundary} with one charged action and one replacement`, t => {
  const directory = mkdtempSync(join(tmpdir(), 'agent-recovery-crash-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const run = point => spawnSync(process.execPath, ['tests/helpers/orchestration/agent-recovery-child.mjs', directory, point], { encoding: 'utf8', timeout: 10000 });
  const killed = run(boundary);
  assert.equal(killed.error, undefined); assert.equal(killed.signal, 'SIGKILL', killed.stderr);
  for (let i = 0; i < 2; i++) {
    const resumed = run('none'); assert.equal(resumed.status, 0, resumed.stderr);
    const result = JSON.parse(resumed.stdout);
    assert.equal(result.goal.recoveryPolicy.decisions.length, 1);
    assert.equal(result.goal.recoveryPolicy.decisions[0].state, 'applied');
    assert.equal(result.goal.attempts.length, 2);
    assert.equal(result.goal.attempts.at(-1).workerState, 'running');
    assert.equal(result.capacity.total, 1); assert.deepEqual(result.operations, []);
    assert.deepEqual(readFileSync(join(directory, 'launches.txt'), 'utf8').trim().split('\n'), [result.goal.attempts.at(-1).operationId]);
  }
});
