import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';

/** The demo tests completed checks, not exit before watchdog identity persistence. */
export async function waitForVerificationIdentity(path, { pid = process.pid, timeoutMs = 5000 } = {}) {
  const deadline = Date.now() + timeoutMs;
  do {
    try { if (JSON.parse(await readFile(path, 'utf8')).pid === pid) return; }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
    await delay(5);
  } while (Date.now() < deadline);
  throw new Error('Fixture verification identity was not recorded');
}

const checkId = process.env.CMUX_COMPANION_FIXTURE_CHECK;
// node --test starts children; only the original supervised process owns this receipt.
delete process.env.CMUX_COMPANION_FIXTURE_CHECK;
if (checkId) {
  if (!/^[a-zA-Z0-9_-]+$/.test(checkId) || !process.env.TMPDIR) throw new Error('Invalid fixture verification identity path');
  // Node 22 --test loads imports in a test child; its harness owns the receipt.
  const pid = process.env.NODE_TEST_CONTEXT === 'child-v8' ? process.ppid : process.pid;
  await waitForVerificationIdentity(join(dirname(process.env.TMPDIR), 'workers', checkId, 'provider.json'), { pid });
}
