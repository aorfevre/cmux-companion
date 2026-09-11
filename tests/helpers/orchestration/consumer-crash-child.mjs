import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { OrchestrationStore } from '../../../server/orchestration/storage/store.mjs';
import { JournalConsumer } from '../../../server/orchestration/event-consumers.mjs';
const [directory, point] = process.argv.slice(2);
const store = new OrchestrationStore({ path: join(directory, 'state.sqlite') });
store.apply({ id: 'create', goalId: 'goal', expectedVersion: 0, type: 'create_goal', payload: { title: 'Consumer fixture', repositoryId: 'repo', baseSha: 'a'.repeat(40) } }, { kind: 'user' });
const path = join(directory, 'sink.json'), delivered = existsSync(path) ? JSON.parse(readFileSync(path, 'utf8')) : [];
const consumer = new JournalConsumer({ store, id: 'fixture', handle(_event, { idempotencyKey }) {
  if (!delivered.includes(idempotencyKey)) { delivered.push(idempotencyKey); writeFileSync(path, JSON.stringify(delivered)); }
  if (point === 'consumer_sent') process.kill(process.pid, 'SIGKILL');
} });
await consumer.start(); await consumer.stop();
process.stdout.write(JSON.stringify({ delivered: delivered.length, cursor: consumer.cursor, goalVersion: store.get('goal').version, operations: store.operations().length })); store.close();
