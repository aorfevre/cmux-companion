#!/usr/bin/env node
import { reconcilePreparation } from '../src/preparation-recovery.mjs';
import { retention } from '../src/retention.mjs';
import { loadConfig } from '../src/config.mjs';
import { defaultPaths } from '../src/constants.mjs';
import { UpdateControl } from '../src/control.mjs';
const paths = defaultPaths(process.env.CMUX_COMPANION_HOME);
const command = process.argv[2] || 'status';
const config = await loadConfig(paths.config);
if (command.startsWith('cleanup-')) {
  const operation = command.slice(8);
  if (!['status', 'preview', 'configure', 'run'].includes(operation)) throw new Error('Unknown cleanup command');
  const options = process.argv[3] ? JSON.parse(process.argv[3]) : {};
  console.log(JSON.stringify(await retention(paths, config, { command: operation, patch: options, previewId: options.previewId, ids: options.ids }), null, 2));
} else {
  const control = new UpdateControl(paths.control);
  try {
    if (command === 'check') control.check();
    else if (command === 'enable' || command === 'disable') control.policy(control.status().revision, command === 'enable');
    else if (command === 'retry') { const sha = process.argv[3] || control.status().request?.sha; control.retry({ id: crypto.randomUUID(), sha, whenIdle: true }); }
    else if (command === 'recover') {
      const state = control.read(), item = state.requests[process.argv[3]];
      if (item?.backup) control.recover(process.argv[3]);
      else await reconcilePreparation({ paths, control, id: process.argv[3] });
    }
    else if (command === 'install') control.request({ id: crypto.randomUUID(), sha: process.argv[3], whenIdle: process.argv.includes('--when-idle') });
    else if (command === 'cancel') control.cancel(process.argv[3]);
    else if (command !== 'status') throw new Error('Unknown updater action');
    console.log(JSON.stringify(control.status(), null, 2));
  } finally { control.close(); }
}
