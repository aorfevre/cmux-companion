import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { cleanupFixture } from './cleanup-fixture.mjs';
const [directory, boundary] = process.argv.slice(2);
const repo = JSON.parse(readFileSync(join(directory, 'cleanup-input.json'), 'utf8'));
const f = await cleanupFixture(repo, point => { if (point === boundary) { writeFileSync(join(directory, 'cleanup-checkpoint'), point); process.kill(process.pid, 'SIGKILL'); } });
await f.cleanup.execute(f.input);
process.stdout.write(JSON.stringify({ receipt: f.store.db.prepare('SELECT * FROM resource_cleanup').get(), goal: f.store.get('goal'), capacity: f.store.ownedCapacity('goal', 'interactive') }));
f.store.close();
