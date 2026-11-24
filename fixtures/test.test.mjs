import test from 'node:test';
import assert from 'node:assert/strict';
import { sum } from './sum.mjs';
test('adds positive numbers', () => assert.equal(sum(2, 3), 5));
test('adds negative numbers', () => assert.equal(sum(-2, -3), -5));
test('zero identity', () => assert.equal(sum(4, 0), 4));
