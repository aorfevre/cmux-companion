import { existsSync, mkdirSync, lstatSync, realpathSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { NativeInputs } from './orchestration/adapters/native-inputs.mjs';
import { NativeBackground } from './orchestration/adapters/native-background.mjs';
import { NativeTerminal } from './orchestration/adapters/native-terminal.mjs';
import { CmuxTerminal } from './orchestration/adapters/cmux.mjs';
import { AgentRuntime } from './orchestration/adapters/agent-runtime.mjs';
import { requireValue } from './orchestration/domain/contracts.mjs';
const hook = fileURLToPath(new URL('./codex-role-hook.mjs', import.meta.url));
const files = fileURLToPath(new URL('./codex-files.mjs', import.meta.url));
const quote = value => `'${value.replace(/'/g, `'\\''`)}'`;
const toml = JSON.stringify;

export function codexResult(stdout, conversationId, directory) {
  requireValue(Buffer.byteLength(stdout) <= 2097152, 'Codex output exceeds limit', 'INVALID_RESULT');
  const rows = stdout.split('\n').filter(line => line.trim()).map(line => JSON.parse(line));
  const starts = rows.filter(row => row.type === 'thread.started'), completed = rows.filter(row => row.type === 'turn.completed');
  const session = JSON.parse(readFileSync(join(directory, 'codex-session.json'), 'utf8'));
  requireValue(starts.length === 1 && completed.length === 1 && session.conversationId === conversationId && starts[0].thread_id === session.sessionId
    && !rows.some(row => row.type === 'error' || row.type === 'turn.failed'), 'Codex result does not match its recorded session', 'INVALID_RESULT');
  const messages = rows.filter(row => row.type === 'item.completed' && row.item?.type === 'agent_message');
  const raw = messages.at(-1)?.item.text;
  requireValue(typeof raw === 'string', 'Codex final result is missing', 'INVALID_RESULT');
  const result = JSON.parse(raw);
  requireValue(result && typeof result === 'object' && !Array.isArray(result), 'Codex role result must be an object', 'INVALID_RESULT');
  return raw;
}

export class CodexInputs extends NativeInputs {
  async prepare(request, directory) {
    const prepared = await super.prepare(request, directory);
    const home = join(directory, 'codex-home'); mkdirSync(home, { mode: 0o700, recursive: true });
    requireValue(!lstatSync(home).isSymbolicLink() && realpathSync(home) === home, 'Codex home identity changed', 'OWNERSHIP_UNCERTAIN');
    const save = (path, value) => {
      if (existsSync(path)) requireValue(!lstatSync(path).isSymbolicLink() && readFileSync(path, 'utf8') === value, 'Codex inputs changed', 'IDEMPOTENCY_CONFLICT');
      else writeFileSync(path, value, { mode: 0o600, flag: 'wx' });
    };
    const hookConfig = join(directory, 'codex-hook.json'), fileConfig = join(directory, 'codex-files.json');
    save(hookConfig, JSON.stringify({ directory, role: request.attempt.role, conversationId: request.attempt.conversationId }));
    save(fileConfig, JSON.stringify({ root: request.attempt.worktree, role: request.attempt.role }));
    const context = join(directory, 'context.txt');
    // Private CODEX_HOME prevents inherited user MCP servers, plugins and hooks.
    // Project config is explicitly untrusted. Only credential storage is referred
    // to; its contents are never read or copied into settings or process receipts.
    const auth = join(this.env.CODEX_HOME || join(this.env.HOME || homedir(), '.codex'), 'auth.json');
    if (existsSync(auth) && !existsSync(join(home, 'auth.json'))) symlinkSync(auth, join(home, 'auth.json'));
    const mcp = JSON.parse(readFileSync(join(directory, 'mcp.json'), 'utf8')).mcpServers.companion;
    const command = [process.execPath, hook, hookConfig].map(quote).join(' ');
    const config = [
      `approval_policy = ${toml(request.attempt.mode === 'interactive' ? 'on-request' : 'never')}`,
      'sandbox_mode = "read-only"', // All file writes go through the scoped MCP.
      'web_search = "disabled"', 'allow_login_shell = false',
      `model_instructions_file = ${toml(context)}`,
      'features.hooks = true', 'features.shell_tool = false', 'features.unified_exec = false',
      'features.multi_agent = false', 'features.apps = false', 'features.remote_plugin = false',
      'features.code_mode.enabled = false', 'features.computer_use = false',
      'browser_use.allow_history_access = false',
      'browser_use.default_origin_policy = { access = "deny", uploads = "deny", downloads = "deny", full_cdp_access = "deny" }',
      'computer_use.default_app_access = "deny"',
      'features.skill_mcp_dependency_install = false', 'features.memories = false',
      'apps._default.enabled = false', 'history.persistence = "none"',
      `projects.${toml(request.attempt.worktree)}.trust_level = "untrusted"`,
      '[[hooks.PreToolUse]]', 'matcher = ".*"', '[[hooks.PreToolUse.hooks]]', 'type = "command"', `command = ${toml(command)}`, 'timeout = 10',
      '[[hooks.SessionStart]]', '[[hooks.SessionStart.hooks]]', 'type = "command"', `command = ${toml(command)}`, 'timeout = 10',
      '[mcp_servers.files]', `command = ${toml(process.execPath)}`, `args = ${toml([files, fileConfig])}`, 'required = true',
    ];
    if (mcp) config.push('[mcp_servers.companion]', `command = ${toml(mcp.command)}`, `args = ${toml(mcp.args)}`, 'required = true');
    save(join(home, 'config.toml'), config.join('\n') + '\n');
    // The pinned CCS adapter passes CODEX_HOME through and uses CCS_CODEX_PATH;
    // --target prevents a profile named codex from selecting the Claude target.
    const argv = this.direct ? [] : [this.profile, '--target', 'codex'];
    argv.push('--strict-config', '--dangerously-bypass-hook-trust');
    if (this.engine.model !== 'default') argv.push('--model', this.engine.model);
    if (request.attempt.mode === 'background') argv.push('exec', '--json');
    argv.push('Follow the pinned role context. Read project files using the files MCP server. Use only the scoped role tools. Return the required JSON role envelope as your final answer.');
    return { argv, env: { ...prepared.env, CODEX_HOME: home }, ...(prepared.activation ? { activation: prepared.activation } : {}) };
  }
}

export function createCodexAgents({ directory, installation, direct, profile, engine, env, cmux, policy }, context) {
  const inputs = new CodexInputs({ installation, direct, profile, engine, env, capabilities: installation.capabilities, describe: context.describe });
  const interactive = new NativeTerminal({ directory: join(directory, 'terminals'), bin: installation.bin, inputs, terminal: new CmuxTerminal(cmux), killGraceMs: policy.killGraceMs });
  const background = new NativeBackground({ directory: join(directory, 'background'), bin: installation.bin, inputs, policy, onResult: context.onResult, parseResult: codexResult });
  const runtime = new AgentRuntime({ interactive, background, locate: context.locate });
  return Object.assign(runtime, { async close() {
    const results = await Promise.allSettled([interactive.close(), background.close()]);
    const failures = results.filter(result => result.status === 'rejected');
    if (failures.length) throw new AggregateError(failures.map(result => result.reason), 'Codex workers remain unresolved');
  } });
}
