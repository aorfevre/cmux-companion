import assert from 'node:assert/strict';
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import test from 'node:test';
import ts from 'typescript';

const root = resolve('server/orchestration');
function inspect(path) {
  const source = ts.createSourceFile(path, readFileSync(path, 'utf8'), ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
  const imports = [], globals = [];
  function visit(node) {
    if ((ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) && node.moduleSpecifier && ts.isStringLiteral(node.moduleSpecifier)) imports.push(node.moduleSpecifier.text);
    if (ts.isCallExpression(node) && node.expression.kind === ts.SyntaxKind.ImportKeyword) {
      assert.ok(node.arguments.length === 1 && ts.isStringLiteral(node.arguments[0]), 'Computed dynamic imports are outside the pure domain');
      imports.push(node.arguments[0].text);
    }
    if (ts.isIdentifier(node) && ['process', 'Buffer', 'require'].includes(node.text)) globals.push(node.text);
    ts.forEachChild(node, visit);
  }
  visit(source); return { imports, globals };
}
function walk(path, seen = new Set()) {
  if (seen.has(path)) return; seen.add(path);
  const result = inspect(path);
  assert.deepEqual(result.globals, [], `${path} references runtime globals`);
  for (const name of result.imports) {
    assert.ok(name.startsWith('./') || name.startsWith('../'), `${path} imports external runtime ${name}`);
    const target = resolve(dirname(path), name);
    assert.ok(target.startsWith(`${root}/domain/`), `${path} escapes pure domain: ${target}`);
    walk(target, seen);
  }
}
test('domain and browser projection imports stay transitively pure', () => {
  for (const file of readdirSync(`${root}/domain`).filter((file) => file.endsWith('.mjs'))) walk(`${root}/domain/${file}`);
});
test('application core does not import concrete adapters or legacy orchestration', () => {
  for (const file of ['service.mjs', 'scheduler.mjs', 'reconciler.mjs', 'ports.mjs']) {
    const path = `${root}/${file}`;
    if (!existsSync(path)) continue;
    for (const dependency of inspect(path).imports) {
      assert.ok(!dependency.includes('/adapters/') && !dependency.includes('worktree-plan') && !dependency.includes('goal-session'), `${file}: ${dependency}`);
    }
  }
});
