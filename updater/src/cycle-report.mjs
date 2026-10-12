// Exit codes are duplicated in updater/scripts/bootstrap.mjs, which cannot import this file.
export const CYCLE_EXIT = Object.freeze({ ok: 0, lockHeld: 3, lowDisk: 4 });

export function cycleMessage(code, signal, error) {
  if (error) return error.message;
  if (signal) return `Updater cycle terminated by ${signal}`;
  if (code === CYCLE_EXIT.ok) return null;
  if (code === CYCLE_EXIT.lockHeld) return 'Updater cycle skipped: the updater lock is held by another process. An orphaned lock is reclaimed 15 minutes after its owner exits.';
  if (code === CYCLE_EXIT.lowDisk) return 'Updater cycle refused: free disk space is below the updater floor; free space before updates can resume.';
  return `Updater cycle exited with ${code}`;
}

// The launcher runs a cycle every 5 seconds. Log a condition when it appears,
// not on every cycle, and log once when cycles become healthy again.
export function createCycleReporter(write) {
  let previous = null;
  return (code, signal, error) => {
    const message = cycleMessage(code, signal, error);
    if (message === previous) return;
    if (message === null) write('Updater cycle recovered');
    else write(message);
    previous = message;
  };
}
