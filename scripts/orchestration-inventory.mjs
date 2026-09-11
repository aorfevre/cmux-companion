import { legacyInventory, assertRollback } from '../server/orchestration/cutover.mjs';
const [mode, ...paths] = process.argv.slice(2);
if (mode === 'legacy') process.stdout.write(`${JSON.stringify(legacyInventory(paths), null, 2)}\n`);
else if (mode === 'rollback' && paths.length === 1) process.stdout.write(`${JSON.stringify(assertRollback(paths[0]), null, 2)}\n`);
else throw new Error('Usage: node scripts/orchestration-inventory.mjs legacy [absolute-database-path ...] | rollback absolute-new-database-path');
