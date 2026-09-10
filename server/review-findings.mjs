// Reviewer output is untrusted text. The parser keeps only well-formed
// findings and never throws, so a malformed block cannot fail a completed
// review; the Markdown itself is always preserved next to the findings.
// An explicit empty list is a valid "no findings" result that the planner
// still assesses; anything unparseable falls back to one full-text finding.
export const MAX_FINDINGS = 40;
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
  if (Array.isArray(parsed?.findings) && parsed.findings.length === 0) return { findings: [], markdown: text };
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
