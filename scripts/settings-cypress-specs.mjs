import { globSync } from 'node:fs';
import { relative, resolve, sep } from 'node:path';

// Preserve the caller's pattern order so reverse-order isolation is testable.
// Each selected spec receives its own service, database and owned workers.
export function settingsSpecs(patterns, { open = false, cwd = process.cwd() } = {}) {
  const requested = patterns ?? (open ? 'cypress/e2e/settings-onboarding.cy.ts' : 'cypress/e2e/settings-onboarding.cy.ts,cypress/e2e/updates.cy.ts,cypress/e2e/notifications.cy.ts');
  const specs = [];
  for (const pattern of requested.split(',')) {
    const matches = globSync(pattern.trim(), { cwd }).sort();
    if (!matches.length) throw new Error(`No Cypress specs match ${pattern}`);
    for (const match of matches) {
      const path = relative(cwd, resolve(cwd, match));
      if (!path.startsWith(`cypress${sep}e2e${sep}`) || !path.endsWith('.cy.ts')) throw new Error('Choose a Cypress spec inside cypress/e2e');
      if (!specs.includes(path)) specs.push(path);
    }
  }
  if (open && specs.length !== 1) throw new Error('Interactive settings runs require one --spec; each spec owns an isolated service.');
  return specs;
}
