import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { isAbsolute } from 'node:path';
import { fileURLToPath } from 'node:url';
import { requireValue, DomainError } from '../domain/contracts.mjs';

const execute = promisify(execFile);
const managedRunner = fileURLToPath(new URL('./native-managed-terminal.mjs', import.meta.url));
const runner = fileURLToPath(new URL('./native-terminal-worker.mjs', import.meta.url));
const quote = (/** @type {string} */ value) => `'${value.replace(/'/g, `'\\''`)}'`;
const target = (/** @type {string} */ id) => requireValue(/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(id), 'Invalid cmux identity');
const unconfirmed = () => new DomainError('CMUX_UNAVAILABLE', 'The owned cmux operation could not be confirmed');
/** cmux 0.65 rejects these before it handles the request, so the request made
 * no change. It reports them as the first stderr line of a failed exit; later
 * lines can echo caller text and never count. Any other failure, including a
 * timeout or signal, stays unconfirmed. The returned message is fixed: cmux
 * output never leaves this adapter.
 * @param {unknown} stderr */
function refusal(stderr) {
  const line = String(stderr ?? '').split('\n', 1)[0];
  if (/^Error: (?:auth_required:|ERROR: Invalid password|ERROR: Password mode is enabled but no socket password is configured)/.test(line)) return new DomainError('CMUX_AUTH_REJECTED', 'cmux refused the socket credential');
  if (/^Error: Socket not found /.test(line)) return new DomainError('CMUX_SOCKET_MISSING', 'The cmux socket is not available');
  return null;
}

/** Narrow production terminal transport. Explicit credentials/environment only;
 * no legacy constructor, default credential lookup or generic public RPC route.
 */
export class CmuxTerminal {
  /** @param {{bin:string; env:NodeJS.ProcessEnv}} options */
  constructor({ bin, env }) { requireValue(isAbsolute(bin), 'Explicit cmux executable required'); this.bin = bin; this.env = { ...env }; }
  /** @param {string} method @param {object} input */
  async rpc(method, input) {
    let result;
    try {
      result = await execute(this.bin, ['--json', 'rpc', method, JSON.stringify(input)], { env: this.env, timeout: 10000, maxBuffer: 1024 * 1024, encoding: 'utf8' });
    } catch (error) {
      const failed = /** @type {{code?: unknown; killed?: boolean; stderr?: unknown}} */ (error);
      // Only a process that exited by itself, with a failure status, reported a refusal.
      throw (typeof failed.code === 'number' && !failed.killed && refusal(failed.stderr)) || unconfirmed();
    }
    // A successful exit may have changed cmux state, so it is never a refusal.
    try { return JSON.parse(result.stdout); }
    catch { throw unconfirmed(); }
  }
  /** @param {string} cwd @param {string} [title] */
  async create(cwd, title = 'Companion planning') {
    requireValue(isAbsolute(cwd), 'Absolute terminal checkout required');
    const result = await this.rpc('workspace.create', { cwd, title, focus: false });
    target(result.workspace_id); return { workspaceId: String(result.workspace_id) };
  }
  /** Only a checked-in runner plus a private config path can be sent to a new
   * owned terminal. No goal text, credentials or arbitrary command input.
   * @param {string} workspaceId @param {string} configPath */
  async start(workspaceId, configPath) {
    target(workspaceId); requireValue(isAbsolute(configPath) && !configPath.includes('\0'), 'Invalid terminal configuration path');
    await this.rpc('surface.send_text', { workspace_id: workspaceId, text: `exec ${[process.execPath, runner, configPath].map(quote).join(' ')}\n` });
  }
  /** Fixed managed supervisor; callers cannot supply another executable.
   * @param {string} workspaceId @param {string} configPath */
  async startManaged(workspaceId, configPath) {
    target(workspaceId); requireValue(isAbsolute(configPath) && !configPath.includes('\0'), 'Invalid terminal configuration path');
    await this.rpc('surface.send_text', { workspace_id: workspaceId, text: `exec ${[process.execPath, managedRunner, configPath].map(quote).join(' ')}\n` });
  }
  /** @param {string} workspaceId */
  async open(workspaceId) {
    target(workspaceId); const result = await this.rpc('workspace.select', { workspace_id: workspaceId });
    target(result.window_id); await this.rpc('window.focus', { window_id: result.window_id });
  }
}
