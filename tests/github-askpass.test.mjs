import assert from 'node:assert/strict';
import test from 'node:test';
import { execFileSync } from 'node:child_process';
import { githubCredentialAnswer } from '../server/orchestration/adapters/github-askpass.mjs';
test('fixed GitHub credential helper answers only the pinned HTTPS host without requesting tokens for usernames or redirects', () => {
  let reads = 0;
  const token = () => { reads++; return 'disposable-test-token'; };
  assert.equal(githubCredentialAnswer("Username for 'https://github.com': ", token), 'x-access-token'); assert.equal(reads, 0);
  assert.equal(githubCredentialAnswer("Password for 'https://x-access-token@github.com': ", token), 'disposable-test-token'); assert.equal(reads, 1);
  for (const prompt of ["Password for 'https://x-access-token@github.com.evil.test': ", "Password for 'https://x-access-token@evil.test': ", "Password for 'http://x-access-token@github.com': ", "Password for 'https://attacker@github.com': ", 'anything else']) assert.throws(() => githubCredentialAnswer(prompt, token));
  assert.equal(reads, 1);
});
test('helper CLI refuses unknown prompts without emitting a credential or diagnostic payload', () => {
  const file = new URL('../server/orchestration/adapters/github-askpass.mjs', import.meta.url);
  assert.equal(execFileSync(process.execPath, [file.pathname, "Username for 'https://github.com': "], { encoding: 'utf8' }), 'x-access-token\n');
  assert.throws(() => execFileSync(process.execPath, [file.pathname, 'untrusted prompt'], { stdio: 'pipe' }), error => error.status === 1 && !error.stdout.length && !error.stderr.length);
});
