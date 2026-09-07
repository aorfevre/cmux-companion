// Merge and follow-up launchers sharing the application store must not write
// into the same goal checkout concurrently. Acquire before the first await.
const claims = new WeakMap();

export async function withGoalSessionClaim(store, planId, work) {
  let active = claims.get(store);
  if (!active) { active = new Set(); claims.set(store, active); }
  if (active.has(planId)) {
    const error = new TypeError("A session launch already owns this goal. Wait for it to finish");
    error.code = "GOAL_SESSION_BUSY";
    throw error;
  }
  active.add(planId);
  try { return await work(); }
  finally { active.delete(planId); }
}
