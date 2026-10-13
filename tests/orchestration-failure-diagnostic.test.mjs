import test from 'node:test';
import assert from 'node:assert/strict';
import { failureDiagnostic } from '../server/orchestration/adapters/failure-diagnostic.mjs';
import { telemetryFilter } from '../server/orchestration/adapters/telemetry-filter.mjs';

test('diagnostics retain bounded exception identity and transport cause without private messages', () => {
  const error = Object.assign(new TypeError('Bearer private-token'), { cause: { code: 'ECONNREFUSED', message: 'private-token' } });
  assert.deepEqual(failureDiagnostic(error, 'wait_for_input'), { phase: 'wait_for_input', name: 'TypeError', code: null, causeCode: 'ECONNREFUSED' });
  assert.equal(failureDiagnostic(new DOMException('private-token', 'TimeoutError'), 'wait_for_input').code, 23);
  assert.deepEqual(failureDiagnostic({ name: 'private-token', code: 'private-token' }, 'launch'), { phase: 'launch', name: 'Error', code: null, causeCode: null });
  assert.equal(failureDiagnostic(null, 'launch').code, null);
});

test('telemetry framing works across chunks and retains unknown, oversized and partial output', () => {
  const telemetry = JSON.stringify({ type: 'system', subtype: 'thinking_tokens', estimated_tokens: 1, estimated_tokens_delta: 1 }) + '\n';
  const retained = [...['uuid', 'session_id'].map(key => JSON.stringify({ type: 'system', subtype: 'thinking_tokens', estimated_tokens: 1, estimated_tokens_delta: 1, [key]: { invalid: true } }) + '\n'), JSON.stringify({ type: 'system', subtype: 'thinking_tokens', estimated_tokens: 1, estimated_tokens_delta: 1, message: 'keep' }) + '\n',
    JSON.stringify({ type: 'system', subtype: 'thinking_tokens', estimated_tokens: 'invalid' }) + '\n', 'x'.repeat(9000) + '\n', 'Résumé\n', 'partial'];
  const output = [], filter = telemetryFilter(chunk => output.push(chunk));
  const data = Buffer.from(telemetry + retained.join(''));
  for (let i = 0; i < data.length; i += 17) filter.write(data.subarray(i, i + 17));
  filter.end(); filter.end();
  assert.equal(Buffer.concat(output).toString(), retained.join(''));
  assert.equal(filter.stats.discardedTelemetryFrames, 1);
});
