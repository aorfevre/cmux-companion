// Candidate review aid, not a zero-duplication certificate.
// Run from the checkout: node scripts/audit-duplication.mjs > candidates.json
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import ts from "typescript";

const roots = ["app", "server", "scripts"];
const keywords = new Set(["if", "return", "throw", "await", "new", "const", "let", "try", "catch", "finally", "async", "for", "of", "true", "false", "null", "undefined"]);
const files = [];
function collect(directory) {
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) collect(path);
    else if (/\.(mjs|tsx?|jsx?)$/.test(path)) files.push(path);
  }
}
roots.forEach(collect);
const functions = [];
for (const file of files) {
  const source = ts.createSourceFile(file, readFileSync(file, "utf8"), ts.ScriptTarget.Latest, true);
  function visit(node) {
    if ((ts.isFunctionDeclaration(node) || ts.isMethodDeclaration(node) || ts.isArrowFunction(node)) && node.body) {
      const tokens = node.body.getText(source).match(/[A-Za-z_$][\w$]*|\d+|[^\s]/g) || [];
      if (tokens.length >= 60) {
        const normalized = tokens.map(token => /^[A-Za-z_$]/.test(token) && !keywords.has(token) ? "ID" : token);
        const shingles = new Set();
        for (let i = 0; i + 5 < normalized.length; i++) shingles.add(normalized.slice(i, i + 6).join(" "));
        functions.push({
          file, line: source.getLineAndCharacterOfPosition(node.getStart(source)).line + 1,
          name: node.name?.getText(source) || "(callback)", tokens: tokens.length,
          start: node.getStart(source), end: node.end, shingles,
        });
      }
    }
    ts.forEachChild(node, visit);
  }
  visit(source);
}
const candidates = [];
const location = ({ file, line, name, tokens }) => ({ file, line, name, tokens });
for (let i = 0; i < functions.length; i++) {
  for (let j = i + 1; j < functions.length; j++) {
    const a = functions[i], b = functions[j];
    // A function containing its own callback is not a separate implementation.
    if (a.file === b.file && a.start < b.end && b.start < a.end) continue;
    if (Math.min(a.tokens, b.tokens) / Math.max(a.tokens, b.tokens) < 0.65) continue;
    let shared = 0;
    for (const shingle of a.shingles) if (b.shingles.has(shingle)) shared++;
    const score = shared / (a.shingles.size + b.shingles.size - shared);
    if (score > 0.65) candidates.push({ score: Number(score.toFixed(3)), a: location(a), b: location(b) });
  }
}
candidates.sort((a, b) => b.score - a.score);
console.log(JSON.stringify({ roots, minimumTokens: 60, threshold: 0.65, files: files.length, functions: functions.length, candidates }, null, 2));
