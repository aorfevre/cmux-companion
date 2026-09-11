import { run } from 'node:test';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
// Fixed, local suites only: no inherited live-test selector or provider adapters.
const files = ['faults', 'recovery', 'cleanup', 'integration', 'result-inbox'].map(name => `tests/orchestration-${name}.test.mjs`);
const reportPath = resolve(process.argv[2] ?? 'coverage/orchestration-faults.json');
const cases = new Map(), observations = new Map();
for await (const event of run({ files, concurrency: 1 })) {
  if (event.type === 'test:diagnostic') {
    try {
      const evidence = JSON.parse(event.data.message);
      if (evidence.caseId && evidence.observed) observations.set(evidence.caseId, [...(observations.get(evidence.caseId) ?? []), evidence]);
    } catch { /* Standard Node runner summary. */ }
  }
  if (event.type === 'test:pass' || event.type === 'test:fail') {
    const { name, details, skip } = event.data;
    cases.set(name, { caseId: name, seed: 0, status: skip ? 'unverified' : event.type === 'test:pass' ? 'passed' : 'failed', durationMs: details.duration_ms, failure: event.type === 'test:fail' ? 'Assertion or child-process failure; inspect targeted suite output' : null });
    process.stdout.write(`${event.type === 'test:pass' ? 'PASS' : 'FAIL'} ${name}\n`);
  }
}
const entries = [...cases.values()].map(entry => ({ ...entry, observations: observations.get(entry.caseId) ?? [], verification: 'Executable assertions in the named local test', fixtureSeed: '0 selects the fixed disposable fixture; process identities remain unique' }));
mkdirSync(dirname(reportPath), { recursive: true });
writeFileSync(reportPath, JSON.stringify({ schemaVersion: 1, generatedAt: new Date().toISOString(), live: false, suites: files, cases: entries }, null, 2), { mode: 0o600 });
process.stdout.write(`Fault report: ${reportPath}\n`);
if (entries.some(entry => entry.status === 'failed')) process.exitCode = 1;
