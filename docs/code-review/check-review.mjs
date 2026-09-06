// Run from the repository root: node docs/code-review/check-review.mjs
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
const root = "docs/code-review/";
const names = ["server-planning.md", "server-goals.md", "server-platform.md", "client.md", "tests-and-tooling.md"];
const read = (p) => readFileSync(p, "utf8");
// Findings and citations are an immutable review snapshot, not a rolling audit
// of unrelated changes later merged from main. Current suite membership is
// checked separately below and by tests/test-script-list.test.mjs.
const sourceRef = "f4052f1a8dc63761b50f874d452f7d551790d57a";
const sourceCache = new Map();
const source = (p) => {
  if (!sourceCache.has(p)) sourceCache.set(p, execFileSync("git", ["show", `${sourceRef}:${p}`], { encoding: "utf8" }));
  return sourceCache.get(p);
};
const tracked = (...patterns) => execFileSync("git", ["ls-tree", "-r", "--name-only", sourceRef], { encoding: "utf8" }).trim().split("\n").filter((p) => patterns.some((pattern) => {
  if (pattern.endsWith("/**")) return p.startsWith(pattern.slice(0, -2));
  if (pattern.includes("*")) {
    const [prefix, suffix] = pattern.split("*");
    return p.startsWith(prefix) && p.endsWith(suffix) && !p.slice(prefix.length).includes("/");
  }
  return p === pattern;
}));
const equal = (actual, expected, label) => {
  assert.equal(new Set(actual).size, actual.length, `${label}: duplicate paths`);
  assert.deepEqual([...actual].sort(), [...expected].sort(), label);
};
const reports = names.map((name) => read(root + name));
const coverage = reports.map((s) => {
  for (const heading of ["Summary", "Coverage", "What is good", "Findings", "Test gaps"]) assert.ok(s.includes(`## ${heading}`), heading);
  const body = s.match(/<!-- coverage:start -->([\s\S]*?)<!-- coverage:end -->/i)?.[1].replace(/```(?:json|text)?/g, "").trim();
  assert.ok(body, "coverage block");
  return body.startsWith("[") ? JSON.parse(body) : body.split("\n");
});
equal(coverage.slice(0, 3).flat(), tracked("server/*.mjs"), "server partition");
equal(coverage[3], tracked("app/**", "public/sw.js", "public/manifest.webmanifest"), "client coverage");
equal(coverage[4], tracked("tests/**", "cypress/**", "scripts/**", "package.json", "package-lock.json", "eslint.config.mjs", "vitest.config.ts", "vite.config.ts", "cypress.config.ts", "cypress.live.config.ts", "tsconfig.json", "next.config.ts", "postcss.config.mjs", "AGENTS.md", "CLAUDE.md", "README.md"), "tests/tooling coverage");
const gaps = (s) => s.match(/<!-- dedicated-test-gap:start -->\n([\s\S]*?)\n<!-- dedicated-test-gap:end -->/)[1].split("\n");
const suites = tracked("tests/*.test.mjs");
const suiteNames = suites.map((p) => p.slice(6, -9));
const expectedGaps = tracked("server/*.mjs").map((p) => p.slice(7, -4)).filter((p) => !suiteNames.includes(p)).sort();
assert.deepEqual(gaps(reports[4]), expectedGaps, "sorted dedicated-suite gaps");
const command = JSON.parse(source("package.json")).scripts.test;
const members = command.match(/tests\/[\w-]+\.test\.mjs/g);
equal(members, suites.filter((p) => p !== "tests/live-cmux.test.mjs"), "npm test membership");
assert.ok(!members.includes("tests/synthetic-new-suite.test.mjs"), "explicit discovery requires manifest update");
const final = read(root + "README.md");
assert.deepEqual([...final.matchAll(/^### (\d+)\./gm)].map((m) => Number(m[1])), Array.from({ length: 10 }, (_, i) => i + 1), "ten ranked headings");
for (const name of names) assert.ok(final.includes(`](${name})`), `link ${name}`);
assert.deepEqual(gaps(final), expectedGaps, "final gap copy");
const ids = reports.flatMap((s) => [...s.matchAll(/^### ((?:PLN|GOAL|PLAT|CLIENT|TEST)-\d+)/gm)].map((m) => m[1]));
const ledger = final.split("## Disposition ledger\n")[1].split("\n## ")[0];
const rows = [...ledger.matchAll(/^\| ((?:PLN|GOAL|PLAT|CLIENT|TEST)-\d+) \| (open|resolved|consolidated|rejected) \|/gm)];
equal(rows.map((m) => m[1]), ids, "complete unique disposition ledger");
assert.ok(rows.some((m) => m[1] === "PLAT-007" && m[2] === "resolved"));
let citations = 0;
for (const s of [...reports, final]) {
  for (const [, p, line] of s.matchAll(/`([^`\s]+):(\d+)`/g)) {
    const contents = source(p);
    const length = contents.split(/\n/).length - Number(contents.endsWith("\n"));
    assert.ok(Number(line) >= 1 && Number(line) <= length, `${p}:${line} exceeds ${length}`);
    citations++;
  }
}
const currentSuites = execFileSync("git", ["ls-files", "tests/*.test.mjs"], { encoding: "utf8" }).trim().split("\n").filter((p) => p !== "tests/live-cmux.test.mjs");
const currentMembers = JSON.parse(read("package.json")).scripts.test.match(/tests\/[\w-]+\.test\.mjs/g);
equal(currentMembers, currentSuites, "current npm test membership");
console.log(JSON.stringify({ sourceRef, currentNpmSuites: currentMembers.length, server: coverage.slice(0, 3).map((v) => v.length), client: coverage[3].length, tooling: coverage[4].length, dedicatedGaps: expectedGaps.length, npmSuites: members.length, findings: ids.length, citations, status: "passed" }));
