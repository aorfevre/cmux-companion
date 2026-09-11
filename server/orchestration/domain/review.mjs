import { array, identifier, object, requireValue, text } from './contracts.mjs';
/** @param {unknown} value @param {string} expectedTarget @returns {import('../types.d.ts').ReviewResult} */
export function parseReview(value, expectedTarget) {
  const input = object(value);
  requireValue(input.schemaVersion === 1, 'Unsupported review schema');
  requireValue(input.target === expectedTarget, 'Review target changed', 'STALE_TARGET');
  requireValue(input.disposition === 'accept' || input.disposition === 'request_changes', 'Invalid review disposition');
  const findings = array(input.findings, 40).map((entry) => {
    const finding = object(entry);
    requireValue(['high', 'medium', 'low', 'note'].includes(String(finding.severity)), 'Invalid severity');
    requireValue(typeof finding.blocking === 'boolean', 'Missing blocking decision');
    return { id: identifier(finding.id), severity: /** @type {import('../types.d.ts').Finding['severity']} */ (finding.severity), blocking: finding.blocking,
      title: text(finding.title, 500), evidence: text(finding.evidence, 8000), suggestion: text(finding.suggestion, 4000) };
  });
  requireValue(new Set(findings.map((finding) => finding.id)).size === findings.length, 'Duplicate findings');
  requireValue(input.disposition === 'accept' ? findings.every((finding) => !finding.blocking) : findings.some((finding) => finding.blocking), 'Disposition conflicts with blocking findings');
  return { schemaVersion: 1, target: expectedTarget, disposition: input.disposition, findings };
}
/** @param {import('../types.d.ts').Goal} goal @param {string} target @param {import('../types.d.ts').Review['kind']} kind */
export function acceptedReview(goal, target, kind) {
  const reviews = goal.reviews.filter((review) => review.target === target && review.kind === kind);
  return reviews.at(-1)?.disposition === 'accept';
}
