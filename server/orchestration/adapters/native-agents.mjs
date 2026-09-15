import { join } from 'node:path';
import { AgentRuntime } from './agent-runtime.mjs';
import { NativeInputs } from './native-inputs.mjs';
import { NativeBackground } from './native-background.mjs';
import { NativeTerminal } from './native-terminal.mjs';
import { CmuxTerminal } from './cmux.mjs';

/** Production composition always requires an explicit probed installation and
 * separate cmux/native environments; fixtures may use the individual drivers.
 * No constructor probes, discovers credentials, binds listeners or launches work.
 * @param {{profile?:string; direct?:boolean; directory:string; installation:Awaited<ReturnType<typeof import('./native-capabilities.mjs').probeNativeCapabilities>>; engine:import('./ccs.mjs').Engine; env:NodeJS.ProcessEnv; cmux:{bin:string;env:NodeJS.ProcessEnv}; policy:import('../types.d.ts').BackgroundPolicy}} options
 * @param {Parameters<Parameters<typeof import('../create-runtime.mjs').createRuntime>[0]['createAgents']>[0]} context */
export function createNativeAgents({ directory, installation, engine, env, cmux, policy, direct = false, profile }, context) {
  installation.assertCurrent();
  const inputs = new NativeInputs({ profile, direct, installation, engine, capabilities: installation.capabilities, env, describe: context.describe });
  const terminal = new CmuxTerminal(cmux);
  const interactive = new NativeTerminal({ directory: join(directory, 'terminals'), bin: installation.bin, inputs, terminal, killGraceMs: policy.killGraceMs });
  const background = new NativeBackground({ terminal, directory: join(directory, 'background'), bin: installation.bin, inputs, policy, onResult: context.onResult });
  const runtime = new AgentRuntime({ interactive, background, locate: context.locate });
  return Object.assign(runtime, {
    /** @param {{preserve?: import('../types.d.ts').LaunchRequest[]}} [options] */
    async close({ preserve = [] } = {}) {
    const results = await Promise.allSettled([interactive.close({ preserve }), background.close()]);
    const failures = results.filter((result) => result.status === 'rejected');
    if (failures.length) throw new AggregateError(failures.map((result) => result.reason), 'Native workers remain unresolved');
  } });
}
