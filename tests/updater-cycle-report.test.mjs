import test from 'node:test';
import assert from 'node:assert/strict';
import { CYCLE_EXIT, cycleMessage, createCycleReporter } from '../updater/src/cycle-report.mjs';

test('cycle messages name held locks and low disk, and stay silent on success', () => {
  assert.equal(cycleMessage(CYCLE_EXIT.ok, null, null), null);
  assert.match(cycleMessage(CYCLE_EXIT.lockHeld, null, null), /lock is held/);
  assert.match(cycleMessage(CYCLE_EXIT.lowDisk, null, null), /free disk space/);
  assert.equal(cycleMessage(1, null, null), 'Updater cycle exited with 1');
  assert.equal(cycleMessage(null, 'SIGKILL', null), 'Updater cycle terminated by SIGKILL');
  assert.equal(cycleMessage(null, null, new Error('spawn failed')), 'spawn failed');
});

test('the reporter writes once per state change and announces recovery', () => {
  const lines = []; const report = createCycleReporter(line => lines.push(line));
  report(CYCLE_EXIT.ok, null, null); report(CYCLE_EXIT.ok, null, null);
  assert.deepEqual(lines, [], 'healthy cycles are silent');
  report(CYCLE_EXIT.lockHeld, null, null); report(CYCLE_EXIT.lockHeld, null, null); report(CYCLE_EXIT.lockHeld, null, null);
  assert.equal(lines.length, 1, 'a held lock is reported once');
  report(1, null, null); assert.equal(lines.length, 2, 'a different failure is reported');
  report(1, null, null); assert.equal(lines.length, 2);
  report(CYCLE_EXIT.ok, null, null); assert.deepEqual(lines.at(-1), 'Updater cycle recovered');
  report(CYCLE_EXIT.ok, null, null); assert.equal(lines.length, 3);
});
