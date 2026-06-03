const fs = require('node:fs');
const path = require('node:path');

const root = process.cwd();
const handbookPath = path.join(root, 'docs', 'ERROR_EXPERIENCE_HANDBOOK.md');
const indexPath = path.join(root, 'docs', 'ERROR_PATTERN_INDEX.md');

function read(filePath) {
  return fs.readFileSync(filePath, 'utf8');
}

function fail(messages) {
  for (const message of messages) {
    console.error(`[check:error-handbook] ${message}`);
  }
  process.exit(1);
}

function normalizeSummary(summary) {
  return summary.trim().replace(/\s+/g, ' ');
}

const handbook = read(handbookPath);
const index = read(indexPath);
const errors = [];

const detailEntries = new Map();
const detailPattern = /^\*\*\[(ERR-\d{3})\]\*\* \| ([^\r\n]+)$/gm;
let detailMatch;

while ((detailMatch = detailPattern.exec(handbook)) !== null) {
  const id = detailMatch[1];
  const summary = normalizeSummary(detailMatch[2]);
  const entries = detailEntries.get(id) ?? [];
  entries.push(summary);
  detailEntries.set(id, entries);
}

for (const [id, summaries] of detailEntries.entries()) {
  if (summaries.length > 1) {
    errors.push(`${id} has ${summaries.length} detailed entries: ${summaries.join(' | ')}`);
  }
}

const categoryEntries = new Map();
const categoryPattern = /^\|\s*(ERR-\d{3})\s*\|\s*([^|]+?)\s*\|/gm;
let categoryMatch;

while ((categoryMatch = categoryPattern.exec(handbook)) !== null) {
  const id = categoryMatch[1];
  const summary = normalizeSummary(categoryMatch[2]);
  const summaries = categoryEntries.get(id) ?? new Set();
  summaries.add(summary);
  categoryEntries.set(id, summaries);
}

for (const [id, summaries] of categoryEntries.entries()) {
  if (summaries.size > 1) {
    errors.push(`${id} has conflicting category summaries: ${Array.from(summaries).join(' | ')}`);
  }
}

for (const id of categoryEntries.keys()) {
  if (!detailEntries.has(id)) {
    errors.push(`${id} appears in a category table but has no detailed entry`);
  }
}

for (const id of detailEntries.keys()) {
  if (!categoryEntries.has(id)) {
    errors.push(`${id} has a detailed entry but is missing from category tables`);
  }
}

const referencedInIndex = new Set(index.match(/\bERR-\d{3}\b/g) ?? []);

for (const id of referencedInIndex) {
  if (!detailEntries.has(id)) {
    errors.push(`${id} is referenced in ERROR_PATTERN_INDEX.md but has no detailed handbook entry`);
  }
}

for (const id of detailEntries.keys()) {
  if (!referencedInIndex.has(id)) {
    errors.push(`${id} has a detailed handbook entry but is not mapped in ERROR_PATTERN_INDEX.md`);
  }
}

if (errors.length > 0) {
  fail(errors);
}

console.log(
  `[check:error-handbook] OK: ${detailEntries.size} detailed ERR entries, ${categoryEntries.size} categorized ERR entries, ${referencedInIndex.size} pattern-index references.`
);
