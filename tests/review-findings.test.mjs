import test from "node:test";
import assert from "node:assert/strict";
import { parseReviewFindings, MAX_FINDINGS } from "../server/review-findings.mjs";

const block = (findings) => "Intro text.\n\n```json\n" + JSON.stringify({ findings }) + "\n```\n\n## Details\nMore prose.";

test("a valid findings block yields one finding per entry, in order, and keeps the whole markdown", () => {
  const markdown = block([
    { id: "F1", severity: "high", title: "Missing rollback", evidence: "No migration down step", suggestion: "Add one" },
    { id: "F2", severity: "note", title: "Naming", evidence: "chartTheme vs ChartTheme", suggestion: "" },
  ]);
  const parsed = parseReviewFindings(markdown);
  assert.equal(parsed.markdown, markdown);
  assert.deepEqual(parsed.findings.map((finding) => finding.id), ["F1", "F2"]);
  assert.equal(parsed.findings[0].severity, "high");
  assert.equal(parsed.findings[1].suggestion, "");
});

test("markdown without a block becomes one note finding holding the full text", () => {
  const parsed = parseReviewFindings("# Review\n\nJust prose.");
  assert.deepEqual(parsed.findings, [{ id: "review", severity: "note", title: "Review findings", evidence: "# Review\n\nJust prose.", suggestion: "" }]);
});

test("hostile entries are dropped or capped without failing", () => {
  const long = "x".repeat(5_000);
  const entries = [
    { id: "bad id!", severity: "high", title: "dropped: bad id" },
    { id: "F1", severity: "critical", title: "unknown severity becomes note", evidence: long },
    { id: "F1", severity: "low", title: "duplicate id dropped" },
    { id: "F2", severity: "low", title: "" },
    "not an object",
    { id: "F3", severity: "medium", title: "kept", evidence: { nested: true }, suggestion: 42 },
  ];
  for (let index = 0; index < MAX_FINDINGS + 5; index += 1) entries.push({ id: `G${index}`, severity: "low", title: `Overflow ${index}` });
  const parsed = parseReviewFindings(block(entries));
  assert.equal(parsed.findings.length, MAX_FINDINGS);
  assert.equal(parsed.findings[0].id, "F1");
  assert.equal(parsed.findings[0].severity, "note");
  assert.equal(Buffer.byteLength(parsed.findings[0].evidence), 2_000);
  assert.deepEqual(parsed.findings[1], { id: "F3", severity: "medium", title: "kept", evidence: "", suggestion: "" });
  assert.equal(parseReviewFindings("```json\n{not json\n```").findings[0].id, "review", "broken JSON falls back");
  assert.equal(parseReviewFindings("```json\n{\"findings\":[\"junk\"]}\n```").findings[0].id, "review", "a list with no usable entry falls back");
});

test("an explicit empty findings list is a valid clean review, not a fallback", () => {
  const parsed = parseReviewFindings("```json\n{\"findings\":[]}\n```\n\nNo issues found.");
  assert.deepEqual(parsed.findings, []);
  assert.match(parsed.markdown, /No issues found/);
});
