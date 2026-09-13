import { INITIAL_STATE } from "./constants.mjs";
import { readJson, writeJson } from "./fs-safe.mjs";

export async function loadState(path) {
  return { ...INITIAL_STATE, ...(await readJson(path, {})) };
}

export async function mutateState(path, state, patch) {
  Object.assign(state, patch);
  await writeJson(path, state);
  return state;
}

export function safeError(error) {
  return String(error?.message || error || "Unknown error")
    .replace(/(https?:\/\/)[^/@\s]+@/gi, "$1[redacted]@")
    .replace(/\/(Users|home)\/[^\s:]+/g, "/$1/[redacted]")
    .slice(0, 1000);
}
