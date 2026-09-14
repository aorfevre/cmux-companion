'use client';
import { useState } from 'react';
import { ModelSelect } from '../model-settings';
import type { Command, Provider } from './settings-panel';
type Connection = 'ccs' | 'direct' | 'terminal';
function connection(command: Command): Connection {
  const executable = command.executable.split('/').at(-1);
  return executable === 'ccs' || executable === 'ccsxp' ? 'ccs' : executable === 'claude' || executable === 'codex' ? 'direct' : 'terminal';
}
export function ProviderCommand({ provider, command, change, validate, validation }: { provider: Provider; command: Command; change(value: Partial<Command>): void; validate(): void; validation?: string }) {
  const [mode, setMode] = useState<Connection>(() => connection(command));
  return <article><h3>{provider === 'claude' ? 'Claude' : 'Codex'}</h3><label>{provider} connection<select value={mode} onChange={event => {
    const next = event.target.value as Connection; setMode(next);
    change(next === 'ccs' ? { executable: 'ccs', args: [provider] } : next === 'direct' ? { executable: provider, args: [] } : { executable: connection(command) === 'terminal' ? command.executable : '', args: [] });
  }}><option value="ccs">CCS profile</option><option value="direct">Direct CLI</option><option value="terminal">Terminal command</option></select></label>
    {mode === 'ccs' && <label>{provider} profile<input value={command.args[0] ?? ''} onChange={event => change({ args: [event.target.value] })} /></label>}
    {mode === 'terminal' && <><label>{provider} terminal command<input value={command.executable} placeholder={provider === 'claude' ? 'xclaude' : 'xcodex'} onChange={event => change({ executable: event.target.value })} autoCapitalize="none" spellCheck={false} /></label><p className="settings-hint">Enter the command name you use in Terminal. Companion resolves supported aliases on your Mac; pipelines, shell scripts and extra flags are not accepted here.</p></>}
    <ModelSelect label={`${provider} model`} provider={provider} value={command.model} onChange={model => change({ model })} />
    {mode !== 'terminal' && <details><summary>Advanced command location</summary><label>{provider} executable<input value={command.executable} onChange={event => change({ executable: event.target.value })} autoCapitalize="none" spellCheck={false} /></label></details>}
    <p className="settings-hint">Companion supplies the model, session and tool flags needed for managed agents.</p>
    <button type="button" onClick={validate}>Validate {provider}</button>{validation && <p role="status">{validation}</p>}
  </article>;
}
