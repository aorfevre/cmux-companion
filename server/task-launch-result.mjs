/**
 * @typedef {object} TaskLaunchResult
 * @property {string} id
 * @property {'launched'|'failed'|'queued'} status
 * @property {string|null} branch
 * @property {string|null} path
 * @property {string|null} error
 * @property {string|null} launchReason
 * @property {string|null} startSha
 * @property {unknown} workspace
 */

/** @param {unknown} value @returns {TaskLaunchResult} */
export function taskLaunchResult(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new TypeError("Invalid task launch result");
  const source = /** @type {Record<string, unknown>} */ (value);
  if (typeof source.id !== "string" || !source.id) throw new TypeError("A task launch result requires an id");
  const status = source.status;
  if (status !== "launched" && status !== "failed" && status !== "queued") throw new TypeError("Unknown task launch status");
  return {
    ...source, id: source.id, status,
    branch: optionalText(source.branch), path: optionalText(source.path),
    error: optionalText(source.error), launchReason: optionalText(source.launchReason),
    startSha: optionalText(source.startSha), workspace: source.workspace,
  };
}
/** @param {unknown} value @returns {string|null} */
function optionalText(value) {
  if (value == null) return null;
  if (typeof value !== "string") throw new TypeError("Invalid text in task launch result");
  return value;
}
