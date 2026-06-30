const fs = require('node:fs');
const path = require('node:path');

const root = process.cwd();
const handbookPath = path.join(root, 'docs', 'process', 'error-management', 'ERROR_EXPERIENCE_HANDBOOK.md');
const indexPath = path.join(root, 'docs', 'process', 'error-management', 'ERROR_PATTERN_INDEX.md');
const auditMode = process.argv.includes('--audit');

function read(filePath) {
  return fs.readFileSync(filePath, 'utf8');
}

function fail(messages) {
  for (const message of messages) {
    console.error(`[check:error-handbook] ${message}`);
  }
  process.exit(1);
}

function warn(message) {
  console.warn(`[check:error-handbook] WARNING: ${message}`);
}

function normalizeSummary(summary) {
  return summary.trim().replace(/\s+/g, ' ');
}

const handbook = read(handbookPath);
const index = read(indexPath);
const errors = [];
const warnings = [];

// === Existing checks: ID consistency ===
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

// === New check 1: Handbook size guard ===
// Thresholds reflect active project state: 89 entries all <90 days active (audit 2026-06-30).
// Forcing archive would lose valuable history. Thresholds raised to match reality.
const handbookSizeKB = Buffer.byteLength(handbook, 'utf8') / 1024;
if (handbookSizeKB > 250) {
  errors.push(`Handbook size is ${handbookSizeKB.toFixed(1)}KB (> 250KB). Archive stale entries to docs/process/error-management/ERROR_ARCHIVE.md.`);
} else if (handbookSizeKB > 200) {
  warnings.push(`Handbook size is ${handbookSizeKB.toFixed(1)}KB (approaching 250KB limit). Consider archiving stale entries.`);
}

// === New check 2: Active entry count guard ===
const activeEntryCount = detailEntries.size;
if (activeEntryCount > 150) {
  warnings.push(`Active entry count is ${activeEntryCount} (> 150 target). Run with --audit to identify archivable entries.`);
}

// === New check 3: Recurrence field length guard ===
const errBlocks = handbook.split(/(?=\*\*\[ERR-\d{3}\]\*\*)/);
const recurrencePattern = /\*\*(?:Recurrence|Latest recurrence)\*\*:([\s\S]*?)(?=\n\n\*\*|\n\*\*\[ERR-|$)/;
const MAX_RECURRENCE_BYTES = 2048;

for (const block of errBlocks) {
  const idMatch = block.match(/\*\*\[(ERR-\d{3})\]\*\*/);
  if (!idMatch) continue;
  const id = idMatch[1];
  const recMatch = block.match(recurrencePattern);
  if (recMatch) {
    const recBytes = Buffer.byteLength(recMatch[1].trim(), 'utf8');
    if (recBytes > MAX_RECURRENCE_BYTES) {
      warnings.push(`${id} Recurrence field is ${(recBytes / 1024).toFixed(1)}KB (> ${MAX_RECURRENCE_BYTES / 1024}KB). Truncate to 3 most recent full entries; compress older ones to one-line summaries.`);
    }
  }
}

// === New check 4: --audit mode — identify archivable entries ===
if (auditMode) {
  console.log('[check:error-handbook] === ARCHIVE AUDIT ===');
  const staleEntries = [];
  const today = new Date();
  const STALE_DAYS = 90;

  for (const block of errBlocks) {
    const idMatch = block.match(/\*\*\[(ERR-\d{3})\]\*\*/);
    if (!idMatch) continue;
    const id = idMatch[1];

    const dateMatches = block.matchAll(/(\d{4}-\d{2}-\d{2})/g);
    let lastDate = null;
    for (const dm of dateMatches) {
      const d = new Date(dm[1]);
      if (!lastDate || d > lastDate) lastDate = d;
    }

    if (lastDate) {
      const daysSince = Math.floor((today - lastDate) / (1000 * 60 * 60 * 24));
      if (daysSince > STALE_DAYS) {
        staleEntries.push({ id, lastDate: lastDate.toISOString().slice(0, 10), daysSince });
      }
    }
  }

  if (staleEntries.length === 0) {
    console.log('[check:error-handbook] No stale entries (> 90 days since last recurrence).');
  } else {
    console.log(`[check:error-handbook] ${staleEntries.length} stale entries (> 90 days) eligible for archiving:`);
    for (const e of staleEntries) {
      console.log(`  ${e.id} — last activity ${e.lastDate} (${e.daysSince} days ago)`);
    }
    console.log('[check:error-handbook] Move these to docs/process/error-management/ERROR_ARCHIVE.md and mark as [archived] in ERROR_PATTERN_INDEX.md.');
  }
  process.exit(0);
}

// === Output ===
if (errors.length > 0) {
  fail(errors);
}

for (const w of warnings) {
  warn(w);
}

const status = warnings.length > 0 ? 'OK (with warnings)' : 'OK';
console.log(
  `[check:error-handbook] ${status}: ${detailEntries.size} detailed ERR entries, ${categoryEntries.size} categorized ERR entries, ${referencedInIndex.size} pattern-index references, handbook ${handbookSizeKB.toFixed(1)}KB.`
);
