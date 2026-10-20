'use strict';

const ALLOWED_CATEGORIES = Object.freeze([
  'Amateur', 'Artistic', 'Couples', 'Educational', 'Lifestyle', 'Interviews', 'Other'
]);

function isValidEmail(email) {
  return typeof email === 'string' && email.length <= 254 && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
}

function isStrongEnoughPassword(password) {
  return typeof password === 'string' && password.length >= 12 && password.length <= 128;
}

function isAdultDateOfBirth(value, now = new Date()) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const dob = new Date(`${value}T00:00:00.000Z`);
  if (Number.isNaN(dob.getTime()) || dob.toISOString().slice(0, 10) !== value) return false;
  const today = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
  const eighteenthBirthday = new Date(Date.UTC(dob.getUTCFullYear() + 18, dob.getUTCMonth(), dob.getUTCDate()));
  return eighteenthBirthday <= today;
}

function validUsername(value) {
  return typeof value === 'string' && /^[a-zA-Z0-9_]{3,24}$/.test(value);
}

function normalizeVideoMetadata({ title, description, category, tags }) {
  const cleanTitle = typeof title === 'string' ? title.trim() : '';
  const cleanDescription = typeof description === 'string' ? description.trim() : '';
  const cleanCategory = typeof category === 'string' ? category.trim() : '';
  const normalizedTags = typeof tags === 'string'
    ? [...new Set(tags.split(',').map((tag) => tag.trim().toLowerCase()).filter(Boolean))].slice(0, 10)
    : [];
  if (cleanTitle.length < 5 || cleanTitle.length > 120) {
    return { error: 'Title must be between 5 and 120 characters.' };
  }
  if (cleanDescription.length > 3000) {
    return { error: 'Description must be 3,000 characters or fewer.' };
  }
  if (!ALLOWED_CATEGORIES.includes(cleanCategory)) {
    return { error: 'Choose a category from the available list.' };
  }
  if (normalizedTags.some((tag) => tag.length > 30)) {
    return { error: 'Each tag must be 30 characters or fewer.' };
  }
  return { value: { title: cleanTitle, description: cleanDescription, category: cleanCategory, tags: normalizedTags } };
}

function validReportCategory(value) {
  return ['non-consensual-content', 'underage-safety-concern', 'copyright', 'privacy', 'spam', 'other'].includes(value);
}

module.exports = {
  ALLOWED_CATEGORIES,
  isValidEmail,
  isStrongEnoughPassword,
  isAdultDateOfBirth,
  validUsername,
  normalizeVideoMetadata,
  validReportCategory
};
