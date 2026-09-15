#!/usr/bin/env node
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

// Git runs this fixed helper only for the configured GitHub HTTPS destination.
// Credentials travel through its private pipe, never argv, persisted config or
// the browser. Refuse redirected hosts and unexpected credential prompts.
/** @param {string} prompt @param {()=>string} [token] */
export function githubCredentialAnswer(prompt, token = () => execFileSync('gh', ['auth', 'token', '--hostname', 'github.com'], { encoding: 'utf8', timeout: 10000, maxBuffer: 16384, stdio: ['ignore', 'pipe', 'pipe'] }).trim()) {
  if (/^Username for 'https:\/\/github\.com':\s*$/.test(prompt)) return 'x-access-token';
  if (/^Password for 'https:\/\/x-access-token@github\.com':\s*$/.test(prompt)) return token();
  throw new Error('Unsupported credential prompt');
}
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  try { process.stdout.write(`${githubCredentialAnswer(process.argv[2] ?? '')}\n`); }
  catch { process.exitCode = 1; }
}
