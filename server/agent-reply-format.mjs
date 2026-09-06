// Shared by coding briefs and the editable development-setup goal.
// Keep this data-only so the browser can consume the same policy.
export const AGENT_REPLY_FORMAT = `Human-facing reply format:
Result: The direct answer or concrete outcome.
Checks: Passed, failed or not run, with the relevant check names.
Blockers: Unresolved issues or the specific decision needed.
Omit irrelevant lines. Target at most 80 words for routine replies. No preamble, repeated plan, narration or closing offer. Progress updates: one sentence only for a meaningful finding, blocker or required status update. Expand when explicitly requested or needed for correctness, security or a decision. Put detailed evidence in the PR or report and link it. Never omit failures or unverified work to meet the word target. Preserve required machine-readable output, completion reports and PR templates; this format applies to human-facing prose, not those schemas.`;
