import { lstatSync, realpathSync, readFileSync, writeFileSync } from 'node:fs';
import { isAbsolute, join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { identifier, requireValue } from '../domain/contracts.mjs';
import { ccsCommand, requireNativeCapabilities, validateNativeEnvironment } from './ccs.mjs';

const hook = fileURLToPath(new URL('./agent-tool-hook.mjs', import.meta.url));
const mcp = fileURLToPath(new URL('../agent-mcp.mjs', import.meta.url));
/** Fixed executable paths still need shell quoting in the native hook protocol.
 * No goal/agent text is interpolated into that command. @param {string} value */
const quote = (value) => `'${value.replace(/'/g, `'\\''`)}'`;

/** Private inputs are outside native file-tool working directories. Their
 * lifecycle belongs to the process adapter; preparation never starts a worker.
 */
export class NativeInputs {
  /** @param {{ engine: import('./ccs.mjs').Engine; capabilities: import('./ccs.mjs').NativeCapabilities; env: NodeJS.ProcessEnv; describe: (request: import('../types.d.ts').LaunchRequest) => Promise<{ prompt: string; bridge?: { endpoint: string; credential: string } }> | { prompt: string; bridge?: { endpoint: string; credential: string } } }} options */
  constructor({ engine, capabilities, env, describe }) {
    validateNativeEnvironment(env);
    this.engine = engine; this.capabilities = capabilities; this.env = { ...env }; this.describe = describe;
  }
  /** @param {import('../types.d.ts').LaunchRequest} request @param {string} directory */
  async prepare(request, directory) {
    identifier(request.operationId); requireNativeCapabilities(this.capabilities, request.attempt.role, request.attempt.mode);
    requireValue(realpathSync(directory) === directory && lstatSync(directory).isDirectory() && !lstatSync(directory).isSymbolicLink(), 'Native input directory identity changed', 'OWNERSHIP_UNCERTAIN');
    requireValue(request.attempt.worktree, 'Native worktree is unavailable');
    const fromWorktree = relative(realpathSync(request.attempt.worktree), directory);
    requireValue(fromWorktree === '..' || fromWorktree.startsWith(`..${sep}`) || isAbsolute(fromWorktree), 'Private native inputs must be outside the worktree', 'FORBIDDEN');
    const description = await this.describe(request);
    requireValue(typeof description.prompt === 'string' && Buffer.byteLength(description.prompt) <= 1024 * 1024, 'Native role context exceeds limit');
    const { attempt, goalId, operationId } = request;
    const binding = { goalId, operationId, attemptId: attempt.id, generation: attempt.generation, revision: attempt.revision, role: attempt.role, target: attempt.target };
    const contextPath = join(directory, 'context.txt'), settingsPath = join(directory, 'settings.json'), mcpPath = join(directory, 'mcp.json');
    const hookConfig = join(directory, 'hook.json'), bridgeConfig = join(directory, 'bridge.json');
    /** @param {string} path @param {string} value */
    const save = (path, value) => {
      try { writeFileSync(path, value, { mode: 0o600, flag: 'wx' }); }
      catch (error) {
        if (/** @type {NodeJS.ErrnoException} */ (error).code !== 'EEXIST') throw error;
        requireValue(lstatSync(path).isFile() && !lstatSync(path).isSymbolicLink() && readFileSync(path, 'utf8') === value, 'Native inputs changed for the recorded operation', 'IDEMPOTENCY_CONFLICT');
      }
    };
    const nativeInstructions = attempt.role === 'planner'
      ? 'Publish your contract with companion.submit_result using a stable result id and output:{contract}. This receipt is not user approval. Native permission prompts remain interactive.'
      : attempt.role === 'reviewer' ? 'You have no mutating tools or command execution. Return only the required role envelope in your final answer.'
        : 'Edit only the assigned scope with native file tools. To commit, call companion.commit_candidate with a stable id, expectedHead (initially the recorded baseSha), and a commit message. The tool returns headSha. It cannot publish or accept your work. Repository checks run independently after integration; report checks you could not run. Return the required role envelope in your final answer.';
    save(contextPath, `${description.prompt}\n\n${nativeInstructions}\n`);
    save(hookConfig, JSON.stringify({ role: attempt.role }));
    save(settingsPath, JSON.stringify({ hooks: { PreToolUse: [{ matcher: '*', hooks: [{ type: 'command', command: [process.execPath, hook, hookConfig].map(quote).join(' '), timeout: 10 }] }] } }));
    if (attempt.role === 'reviewer') save(mcpPath, JSON.stringify({ mcpServers: {} }));
    else {
      requireValue(description.bridge && description.bridge.credential.length >= 32, 'Scoped native bridge configuration is required');
      const endpoint = new URL(description.bridge.endpoint);
      requireValue(endpoint.protocol === 'http:' && endpoint.hostname === '127.0.0.1' && !endpoint.username && !endpoint.password, 'Native bridge must use loopback');
      save(bridgeConfig, JSON.stringify({ ...description.bridge, binding }));
      save(mcpPath, JSON.stringify({ mcpServers: { companion: { command: process.execPath, args: [mcp, bridgeConfig] } } }));
    }
    const argv = ccsCommand({ request, engine: this.engine, capabilities: this.capabilities, env: this.env, contextPath, settingsPath, mcpPath });
    return { argv, env: { ...this.env } };
  }
}
