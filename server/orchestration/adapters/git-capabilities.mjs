import { execFile } from 'node:child_process';
import { tmpdir } from 'node:os';
import { DomainError } from '../domain/contracts.mjs';

/** Inspect the actual Git option contract without opening a repository or loading
 * its configuration. Vendor versions may backport options, so version strings
 * alone are not evidence. Help normally exits 129 and writes to stderr.
 * @param {{ bin?: string; path?: string }} [options]
 */
export async function probeGitCapabilities({ bin = 'git', path = process.env.PATH } = {}) {
  const supported = await new Promise((resolve) => {
    execFile(bin, ['--no-pager', 'merge-tree', '-h'], {
      cwd: tmpdir(), env: { PATH: path, LANG: 'C', LC_ALL: 'C', GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null' },
      timeout: 5000, killSignal: 'SIGKILL', maxBuffer: 64 * 1024,
    }, (error, stdout, stderr) => {
      if (error && (error.code !== 129 || error.killed || error.signal)) return resolve(false);
      const help = `${stdout}\n${stderr}`.replaceAll('[no-]', '');
      resolve(['--write-tree', '--no-messages', '--merge-base'].every(option => {
        // Git advertises the messages toggle as either --messages or --[no-]messages.
        const flag = option === '--no-messages' ? '--messages' : option;
        return new RegExp(`${flag}(?=[\\s=]|$)`).test(help);
      }));
    });
  }).catch(() => false);
  if (!supported) throw new DomainError('UNSUPPORTED_CAPABILITY', 'Git on the service PATH must support merge-tree --write-tree, --no-messages and --merge-base (upstream Git 2.40 or newer); install a supported Git and restart the service with its PATH.');
}
