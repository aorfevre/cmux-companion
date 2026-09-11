import assert from 'node:assert/strict';
import test from 'node:test';
import { a } from '../src/a.mjs';
import { b } from '../src/b.mjs';
import { composition } from '../src/composition.mjs';

test('module A returns two', () => assert.equal(a(), 2));
test('module B returns three', () => assert.equal(b(), 3));
test('composition uses both modules', () => assert.equal(composition(), 5));
