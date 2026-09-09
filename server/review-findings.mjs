// Reviewer output is untrusted text. The parser keeps only well-formed
// findings and never throws, so a malformed block cannot fail a completed
// review; the Markdown itself is always preserved next to the findings.
export const MAX_FINDINGS = 40;
export const MAX_FEEDBACK_BYTES = 4_000;
const SEVERITIES = new Set(["high", "medium", "low", "note"]);
const ID = /^[A-Za-z0-9_-]{1,16}$/;
const FIELD_BYTES = 2_000;
const BLOCK = /```json[^\S\n]*\n([\s\S]*?)\n```/;

const clip = (value, bytes) => {
  const text = typeof value === "string" ? value.trim() : "";
  if (Buffer.byteLength(text) <= bytes) return text;
  return Buffer.from(text).subarray(0, bytes).toString().replace(/�+$/, "");
};

export function parseReviewFindings(markdown) {
  const text = typeof markdown === "string" ? markdown : "";
  const fallback = { findings: [{ id: "review", severity: "note", title: "Review findings", evidence: text, suggestion: "" }], markdown: text };
  const raw = text.match(BLOCK)?.[1];
  if (!raw) return fallback;
  let parsed;
  try { parsed = JSON.parse(raw); } catch { return fallback; }
  const seen = new Set();
  const findings = [];
  for (const entry of Array.isArray(parsed?.findings) ? parsed.findings : []) {
    if (findings.length >= MAX_FINDINGS) break;
    if (!entry || typeof entry !== "object") continue;
    const id = typeof entry.id === "string" ? entry.id.trim() : "";
    const title = clip(entry.title, FIELD_BYTES);
    if (!ID.test(id) || seen.has(id) || !title) continue;
    seen.add(id);
    findings.push({ id, severity: SEVERITIES.has(entry.severity) ? entry.severity : "note", title, evidence: clip(entry.evidence, FIELD_BYTES), suggestion: clip(entry.suggestion, FIELD_BYTES) });
  }
  return findings.length ? { findings, markdown: text } : fallback;
}

function render(review, evidenceBytes) {
  const decisions = new Map((review.decisions || []).map((decision) => [decision.findingId, decision]));
  const agreed = []; const disagreed = [];
  let shortened = 0;
  for (const finding of review.findings || []) {
    const decision = decisions.get(finding.id);
    if (decision?.verdict === "agree") {
      const evidence = clip(finding.evidence, evidenceBytes);
      if (evidence.length < (finding.evidence || "").trim().length) shortened += 1;
      const lines = [`## [${finding.severity}] ${finding.title}`];
      if (evidence) lines.push(`Evidence: ${evidence}`);
      if (finding.suggestion) lines.push(`Suggestion: ${finding.suggestion}`);
      if (decision.comment) lines.push(`Comment: ${decision.comment}`);
      agreed.push(lines.join("\n"));
    } else if (decision?.verdict === "disagree") {
      disagreed.push(decision.comment ? `- ${finding.title} — reason: ${decision.comment}` : `- ${finding.title}`);
    }
  }
  const sections = [`Independent review decisions for proposal revision ${review.target}.`];
  if (agreed.length) sections.push(["Apply these findings:", ...agreed].join("\n"));
  if (disagreed.length) sections.push(["Do not apply these findings:", ...disagreed].join("\n"));
  if (shortened) sections.push(`(evidence shortened for ${shortened} finding${shortened === 1 ? "" : "s"})`);
  return sections.join("\n\n");
}

// The planner's change request accepts 4,000 bytes; evidence gives way first so
// every agreed title and the user's own comments survive the cap.
export function reviewDecisionFeedback(review) {
  let evidenceBytes = FIELD_BYTES;
  let text = render(review, evidenceBytes);
  while (Buffer.byteLength(text) > MAX_FEEDBACK_BYTES && evidenceBytes > 0) {
    evidenceBytes = Math.floor(evidenceBytes / 2);
    text = render(review, evidenceBytes);
  }
  return clip(text, MAX_FEEDBACK_BYTES);
}
