import { randomUUID } from 'node:crypto';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { agentMcpRequest } from '../../../server/orchestration/agent-mcp.mjs';

/** A deterministic worker uses the same scoped commit/check tools as native
 * agents. Its fixed edits demonstrate repair, not model reasoning. */
export async function runScriptedWorkerChecks({ bridge, request, signal }) {
  const { goalId, operationId, attempt } = request;
  const binding = { goalId, operationId, attemptId: attempt.id, generation: attempt.generation, revision: attempt.revision, role: attempt.role, target: attempt.target, experienceVersion: 2 };
  const status = async () => {
    for (;;) {
      signal.throwIfAborted();
      try { return await bridge.status(); }
      catch (error) { if (error.code !== 'FORBIDDEN') throw error; await delay(50, undefined, { signal }); }
    }
  };
  await status();
  let headSha = attempt.baseSha;
  for (const failing of [true, false]) {
    signal.throwIfAborted();
    await writeFile(join(attempt.worktree, 'src/composition.mjs'), `import { a } from './a.mjs';\nimport { b } from './b.mjs';\nexport function composition() { return a() ${failing ? '-' : '+'} b(); }\n`);
    headSha = (await bridge.commit({ id: randomUUID(), expectedHead: headSha, message: failing ? 'Checkpoint failing composition' : 'Repair composition after approved check' })).headSha;
    for (let conflicts = 0; ; conflicts++) {
      const goal = await status();
      const response = await agentMcpRequest({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'run_check', arguments: { id: randomUUID(), expectedVersion: goal.version, expectedHead: headSha, checkId: 'unit' } } }, { binding, bridge });
      const result = JSON.parse(response.result.content[0].text);
      if (response.result.isError) {
        if (result.code === 'VERSION_CONFLICT' && conflicts < 3) continue;
        throw Object.assign(new Error('Scripted worker check failed'), { code: result.code });
      }
      if (result.checks.find(check => check.id === 'unit')?.passed !== !failing) throw new Error('Scripted worker check did not observe its intended outcome');
      break;
    }
  }
  return { headSha, summary: 'Repaired composition after inspecting a failed approved check', evidence: [] };
}
