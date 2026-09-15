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

/** @typedef {{ prompt: string; plannerName?: string; bridge?: { endpoint: string; credential: string }; activation?: import('./native-activation.mjs').NativeActivation }} NativeDescription */

/** Private inputs are outside native file-tool working directories. Their
 * lifecycle belongs to the process adapter; preparation never starts a worker.
 */
export class NativeInputs {
  /** @param {{ profile?: string; direct?: boolean; ccsxp?: boolean; engine: import('./ccs.mjs').Engine; capabilities: import('./ccs.mjs').NativeCapabilities; env: NodeJS.ProcessEnv; installation?: Awaited<ReturnType<typeof import('./native-capabilities.mjs').probeNativeCapabilities>>; describe: (request: import('../types.d.ts').LaunchRequest) => Promise<NativeDescription> | NativeDescription }} options */
  constructor({ engine, capabilities, env, describe, installation, direct = false, profile, ccsxp = false }) {
    validateNativeEnvironment(env);
    installation?.assertCurrent();
    this.installation = installation; this.ccsxp = ccsxp; this.direct = direct; this.profile = profile ?? engine.provider;
    requireValue(/^[A-Za-z0-9][A-Za-z0-9_-]{0,79}$/.test(this.profile), 'Invalid CCS profile');
    this.engine = engine; this.capabilities = installation?.capabilities ?? capabilities; this.env = { ...env, ...installation?.env }; this.describe = describe;
  }
  /** @param {import('../types.d.ts').LaunchRequest} request @param {string} directory */
  async prepare(request, directory) {
    this.installation?.assertCurrent();
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
      ? 'Call companion.submit_result with exactly {id,output:{contract}} to submit a plan, or {id,output:{question}} to ask a focused clarification and stop. The tool supplies the outer identity envelope; never put that envelope inside output. This receipt is not user approval. Native permission prompts remain interactive.'
      : attempt.role === 'reviewer' ? 'You have no mutating tools or command execution. Return only the required role envelope as raw JSON in your final answer, with no Markdown fences or surrounding commentary. Finding severity must be high, medium, low or note (never info).'
        : 'Edit only the assigned scope with native file tools. To commit, call companion.commit_candidate with a stable id, expectedHead (initially the recorded baseSha), and a commit message. The tool returns headSha. It cannot publish or accept your work. Repository checks run independently after integration; report checks you could not run. Return the required role envelope in your final answer.';
    save(contextPath, `${description.prompt}\n\n${nativeInstructions}\n`);
    save(hookConfig, JSON.stringify({ role: attempt.role }));
    save(settingsPath, JSON.stringify({ hooks: { PreToolUse: [{ matcher: '*', hooks: [{ type: 'command', command: [process.execPath, hook, hookConfig].map(quote).join(' '), timeout: 10 }] }] } }));
    {
      requireValue(description.bridge && description.bridge.credential.length >= 32, 'Scoped native bridge configuration is required');
      const endpoint = new URL(description.bridge.endpoint);
      requireValue(endpoint.protocol === 'http:' && endpoint.hostname === '127.0.0.1' && !endpoint.username && !endpoint.password, 'Native bridge must use loopback');
      save(bridgeConfig, JSON.stringify({ ...description.bridge, binding, ...(attempt.role === 'planner' ? { handoffProtocol: 1, outbox: join(directory, 'outbox') } : {}) }));
      save(mcpPath, JSON.stringify({ mcpServers: { companion: { command: process.execPath, args: [mcp, bridgeConfig] } } }));
    }
    this.installation?.assertCurrent();
    const argv = ccsCommand({ request, engine: this.engine, capabilities: this.capabilities, env: this.env, contextPath, settingsPath, mcpPath });
    argv[0] = this.profile;
    return { plannerName: description.plannerName, argv: this.direct ? argv.slice(3) : argv, env: { ...this.env }, ...(description.activation ? { activation: description.activation } : {}) };
  }
}
