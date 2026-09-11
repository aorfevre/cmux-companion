import { OrchestrationStore } from '../../../server/orchestration/storage/store.mjs';
import { OrchestrationService } from '../../../server/orchestration/service.mjs';
const store = new OrchestrationStore({ path: process.argv[2] });
const service = new OrchestrationService({ store, agents: { capabilities: [{ role: 'planner', mode: 'interactive' }] }, limits: { planners: 1 }, repositoryIds: new Set(['repo']) });
process.stdout.write('READY\n');
let input = '';
for await (const chunk of process.stdin) input += chunk;
try { service.execute(JSON.parse(input), { kind: 'system' }); process.stdout.write('ACCEPTED\n'); }
catch (error) { process.stdout.write(`${error.code}\n`); }
finally { store.close(); }
