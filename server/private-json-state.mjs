import { readFileSync, copyFileSync, chmodSync, constants } from "node:fs";
import { randomUUID } from "node:crypto";

// Recover only after preserving the exact damaged bytes. Permission/IO errors
// are not missing state: propagate them so a later save cannot destroy history.
export function readPrivateJson(path, fallback, valid = value => value !== null && typeof value === "object" && !Array.isArray(value), onRecovery = backup => process.emitWarning(`Recovered invalid Companion state; original preserved at ${backup}`)) {
  let source;
  try { source = readFileSync(path, "utf8"); }
  catch (error) { if (error.code === "ENOENT") return structuredClone(fallback); throw error; }
  try {
    const value = JSON.parse(source);
    if (valid(value)) return value;
  } catch (error) {
    if (!(error instanceof SyntaxError)) throw error;
  }
  const backup = `${path}.corrupt-${randomUUID()}`;
  copyFileSync(path, backup, constants.COPYFILE_EXCL);
  chmodSync(backup, 0o600);
  onRecovery(backup);
  return structuredClone(fallback);
}
