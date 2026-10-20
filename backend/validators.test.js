'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const {
  isValidEmail,
  isStrongEnoughPassword,
  isAdultDateOfBirth,
  validUsername,
  normalizeVideoMetadata,
  validReportCategory
} = require('./validators');

test('validates email conservatively', () => {
  assert.equal(isValidEmail('creator@example.com'), true);
  assert.equal(isValidEmail('not-an-email'), false);
  assert.equal(isValidEmail(''), false);
});

test('requires a longer password', () => {
  assert.equal(isStrongEnoughPassword('short123'), false);
  assert.equal(isStrongEnoughPassword('a-long-passphrase-2026'), true);
});

test('validates date of birth and adult threshold', () => {
  const now = new Date('2026-10-19T12:00:00Z');
  assert.equal(isAdultDateOfBirth('2000-01-01', now), true);
  assert.equal(isAdultDateOfBirth('2008-10-20', now), false);
  assert.equal(isAdultDateOfBirth('2020-02-30', now), false);
  assert.equal(isAdultDateOfBirth('tomorrow', now), false);
});

test('validates username shape', () => {
  assert.equal(validUsername('Creator_123'), true);
  assert.equal(validUsername('x'), false);
  assert.equal(validUsername('has space'), false);
});

test('normalizes metadata and rejects invalid inputs', () => {
  const result = normalizeVideoMetadata({
    title: 'An Example Title', description: 'Description', category: 'Artistic', tags: 'Art, art, film'
  });
  assert.equal(result.error, undefined);
  assert.deepEqual(result.value.tags, ['art', 'film']);
  assert.equal(normalizeVideoMetadata({ title: 'x', description: '', category: 'invalid', tags: '' }).error !== undefined, true);
});

test('recognizes policy-focused report categories', () => {
  assert.equal(validReportCategory('copyright'), true);
  assert.equal(validReportCategory('underage-safety-concern'), true);
  assert.equal(validReportCategory('make-me-admin'), false);
});
