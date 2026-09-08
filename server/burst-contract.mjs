import { MAX_GOAL_TEXT } from "./goal-limits.mjs";

// The shape every burst module agrees on: ids, statuses and the proposal a
// scan must return. Data-only, so the store, the service, the scanner and the
// browser bundle can all import it.
export const BURST_ID = /^burst-[A-Za-z0-9-]{1,64}$/;
export const REPOSITORY_ID = /^[A-Za-z0-9_-]{18}$/;
export const SIZE_ESTIMATES = Object.freeze(["small", "medium", "large"]);
export const CANDIDATE_STATUSES = Object.freeze(["scanning", "proposed", "failed", "approved", "declined"]);
// The same limit goalSessions.start enforces on a goal, so an approved
// candidate never fails there with an unrelated message. Both read it from
// server/goal-limits.mjs; the burst name is kept for the modules that use it.
export const MAX_BURST_GOAL = MAX_GOAL_TEXT;

export function normalizeProposal(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new TypeError("The scan returned no proposal object");
  const goal = String(value.goal || "").trim();
  if (!goal || goal.length > MAX_BURST_GOAL) throw new TypeError("The scan returned no usable goal");
  const rationale = String(value.rationale || "").trim().slice(0, 4_000);
  if (!rationale) throw new TypeError("The scan returned no rationale");
  const evidence = Array.isArray(value.evidence) ? value.evidence.map((item) => String(item || "").trim()).filter(Boolean).slice(0, 20) : [];
  const sizeEstimate = SIZE_ESTIMATES.includes(value.sizeEstimate) ? value.sizeEstimate : "medium";
  return { goal, rationale, evidence, sizeEstimate };
}
