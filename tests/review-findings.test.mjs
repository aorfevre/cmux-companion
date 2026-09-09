import test from "node:test";
import assert from "node:assert/strict";
import { parseReviewFindings, reviewDecisionFeedback, MAX_FINDINGS } from "../server/review-findings.mjs";

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
  assert.equal(parseReviewFindings("```json\n{\"findings\":[]}\n```").findings[0].id, "review", "an empty list falls back");
});

test("the feedback template lists agreed findings in full and disagreed ones by title, then caps the text", () => {
  const review = {
    target: "3",
    findings: [
      { id: "F1", severity: "high", title: "Missing rollback", evidence: "No down step", suggestion: "Add one" },
      { id: "F2", severity: "low", title: "Naming", evidence: "Mixed case", suggestion: "Pick one" },
      { id: "F3", severity: "note", title: "Style", evidence: "", suggestion: "" },
    ],
    decisions: [
      { findingId: "F1", verdict: "agree", comment: "Also cover the seed data" },
      { findingId: "F2", verdict: "disagree", comment: "Matches the repo convention" },
      { findingId: "F3", verdict: "disagree", comment: "" },
    ],
  };
  const text = reviewDecisionFeedback(review);
  assert.equal(text, [
    "Independent review decisions for proposal revision 3.",
    "",
    "Apply these findings:",
    "## [high] Missing rollback",
    "Evidence: No down step",
    "Suggestion: Add one",
    "Comment: Also cover the seed data",
    "",
    "Do not apply these findings:",
    "- Naming — reason: Matches the repo convention",
    "- Style",
  ].join("\n"));
  const agreedOnly = reviewDecisionFeedback({ ...review, decisions: [{ findingId: "F1", verdict: "agree", comment: "" }] });
  assert.ok(!agreedOnly.includes("Do not apply"));
  assert.ok(!agreedOnly.includes("Comment:"));
  const huge = reviewDecisionFeedback({ target: "1", findings: Array.from({ length: 5 }, (_, index) => ({ id: `F${index}`, severity: "high", title: `T${index}`, evidence: "e".repeat(1_900), suggestion: "s" })), decisions: Array.from({ length: 5 }, (_, index) => ({ findingId: `F${index}`, verdict: "agree", comment: "" })) });
  assert.ok(Buffer.byteLength(huge) <= 4_000);
  assert.match(huge, /evidence shortened for \d+ finding/);
});
