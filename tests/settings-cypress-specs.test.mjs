import assert from 'node:assert/strict';
import test from 'node:test';
import { settingsSpecs } from '../scripts/settings-cypress-specs.mjs';

test('settings specs select independent lifecycles in explicit forward and reverse order', () => {
  const onboarding = 'cypress/e2e/settings-onboarding.cy.ts', updates = 'cypress/e2e/updates.cy.ts';
  assert.deepEqual(settingsSpecs(), [onboarding, updates]);
  assert.deepEqual(settingsSpecs(`${updates},${onboarding}`), [updates, onboarding]);
  assert.deepEqual(settingsSpecs(`${updates},${updates}`), [updates]);
  assert.deepEqual(settingsSpecs('cypress/e2e/updates*.cy.ts'), [updates]);
  assert.throws(() => settingsSpecs('cypress/e2e/missing.cy.ts'), /No Cypress specs/);
  assert.throws(() => settingsSpecs('package.json'), /inside cypress/);
  assert.throws(() => settingsSpecs(`${updates},${onboarding}`, { open: true }), /one --spec/);
  assert.deepEqual(settingsSpecs(undefined, { open: true }), [onboarding]);
  assert.deepEqual(settingsSpecs(updates, { open: true }), [updates]);
});
