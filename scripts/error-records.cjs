/**
 * Structured error records — PRI-799 Phase B tooling.
 *
 * Canonical storage for the ERR knowledge base after the Phase C cutover:
 *
 *   docs/process/error-management/records/
 *   ├── patterns/<recordId>.md            small mutable pattern records
 *   └── occurrences/<recordId>/<occId>.md one independently mergeable fact per file
 *
 * Record file format (decided by the Phase 0 Reality Audit, docs/audit/
 * PRI-799-ERR-STRUCTURED-RECORDS-REALITY-AUDIT.md): a leading HTML-comment
 * JSON metadata block using the SAME marker protocol as error-pattern-routing
 * and recurrence-meta (reuses extractHtmlComments parsing), followed by a
 * Markdown narrative body. Zero new serialization dependencies — js-yaml 5 is
 * ESM-only and cannot be required from the CJS checker (ERR-131).
 *
 * Identity model (SPEC §9/§10):
 *   - pattern recordId is collision-resistant; migration assigns
 *     deterministic `P-ERR-NNN` ids derived from existing display ids, new
 *     patterns get `P-<UTCtimestamp>-<rand>`.
 *   - occurrenceId is `OCC-<compactUTC>-<rand>` at runtime (no central
 *     counter) and deterministic `OCC-<date>-<displayId>-R<n>` for migration
 *     re-runs. Display ids (ERR-NNN) stay user-facing; storage never relies
 *     on them being unique across concurrent writers — the validator fails
 *     loud on duplicate display ids instead (SPEC §10.1).
 *
 * Runtime contracts: parsed file content is untrusted (rc-1); validators
 * reject instead of coercing (rc-2/rc-3); every element of metadata arrays is
 * checked (rc-4); Object.hasOwn for key membership (rc-5); writes are atomic
 * tmp+rename; nothing here makes semantic judgments for the Owner (no auto
 * dedupe, no auto archive, no LLM rewrite — SPEC §16).
 */

'use strict';

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const MARKER = 'pd-error-record';
const RECORDS_RELATIVE_DIR = path.join('docs', 'process', 'error-management', 'records');
const PATTERNS_DIR = 'patterns';
const OCCURRENCES_DIR = 'occurrences';
const SCHEMA_VERSION = 1;

const VALID_STATUS = new Set(['active', 'archived']);
const VALID_RECORD_TYPES = new Set(['pattern', 'occurrence']);
const VALID_CAUGHT_BY = new Set(['self-review', 'pr-review', 'ci', 'runtime', 'owner']);
const VALID_SEVERITY = new Set(['P0', 'P1', 'P2', 'P3']);
/** Category headings are stable prose in the handbook; classified on migration. */
const VALID_CATEGORIES = new Set([
  'Architecture Boundary Violations',
  'Missing Tests & Verification',
  'Schema & Type Mistakes',
  'Documentation & Spec Drift',
  'Security & Safety',
  'Process & Workflow',
]);

const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;
const DISPLAY_ID_PATTERN = /^ERR-\d{3,4}$/;
const RECORD_ID_PATTERN = /^P-(ERR-\d{3,4}|\d{8}T\d{6}Z-[0-9a-z]{6})$/;
// Two occurrence-id shapes:
//   runtime   OCC-<compactUTC>-<rand4>          e.g. OCC-20260916T143000Z-a3k9
//   migration OCC-<date>-err-NNN-r<index>       deterministic, re-runnable
const OCCURRENCE_ID_RE = /^OCC-(\d{8}T\d{6}Z-[0-9a-z]{6}|\d{4}-\d{2}(?:-\d{2})?-err-\d{3,4}-r\d+)$/;
const EP_ID_PATTERN = /^EP-\d{2}$/;

/** Crockford-ish base32 (no confusing 0/O/1/I) for random suffixes. */
const ID_ALPHABET = '23456789abcdefghjkmnpqrstvwxyz';

function randomSuffix(length) {
  const bytes = crypto.randomBytes(length);
  let out = '';
  for (let i = 0; i < length; i += 1) out += ID_ALPHABET[bytes[i] % ID_ALPHABET.length];
  return out;
}

function pad2(n) {
  return String(n).padStart(2, '0');
}

/**
 * Strict YYYY-MM-DD calendar validation. Date.parse silently rolls impossible
 * dates over (2026-02-30 → 2026-03-02); parse components and require the UTC
 * round-trip to reproduce them exactly. Mirrors error-handbook-meta.cjs.
 */
function isValidCalendarDate(value) {
  if (typeof value !== 'string' || !DATE_PATTERN.test(value)) return false;
  const [year, month, day] = value.split('-').map((p) => Number.parseInt(p, 10));
  if (!Number.isInteger(year) || !Number.isInteger(month) || !Number.isInteger(day)) return false;
  const date = new Date(Date.UTC(year, month - 1, day));
  return date.getUTCFullYear() === year && date.getUTCMonth() + 1 === month && date.getUTCDate() === day;
}

/**
 * Month-precision dates are legitimate observed facts — several legacy
 * recurrence bullets say "2026-06" without a day. Store exactly what the
 * source states; `YYYY-MM` passes when the month is real.
 */
function isValidObservedAt(value) {
  if (isValidCalendarDate(value)) return true;
  if (typeof value !== 'string' || !/^\d{4}-\d{2}$/.test(value)) return false;
  const [year, month] = value.split('-').map((p) => Number.parseInt(p, 10));
  return Number.isInteger(year) && year >= 1 && Number.isInteger(month) && month >= 1 && month <= 12;
}

function compactUtc(now) {
  return `${now.getUTCFullYear()}${pad2(now.getUTCMonth() + 1)}${pad2(now.getUTCDate())}T${pad2(
    now.getUTCHours(),
  )}${pad2(now.getUTCMinutes())}${pad2(now.getUTCSeconds())}Z`;
}

function generatePatternRecordId(now = new Date()) {
  return `P-${compactUtc(now)}-${randomSuffix(6)}`;
}

function generateOccurrenceId(now = new Date()) {
  return `OCC-${compactUtc(now)}-${randomSuffix(6)}`;
}

/**
 * Serialize one record file: marker JSON block + markdown body.
 * Deterministic — key order is the object's own insertion order and the
 * writer always serializes from a freshly constructed meta object.
 * `-->` inside string values would terminate the HTML comment early and
 * truncate the JSON, so it is escaped as `\u002d\u002d>` (JSON.parse
 * restores it losslessly).
 */
function serializeRecord(meta, body) {
  const json = JSON.stringify(meta, null, 2).replace(/-->/g, '\\u002d\\u002d>');
  return `<!-- ${MARKER}\n${json}\n-->\n\n${body.trimEnd()}\n`;
}

/**
 * Parse one record file. Returns { meta, body } or { error }.
 * The marker protocol mirrors parseMarkerComment in error-handbook-meta.cjs:
 * first non-empty line of the comment must start with the marker.
 */
function parseRecordFile(text) {
  if (typeof text !== 'string' || text.length === 0) return { error: 'empty record file' };
  const match = text.match(/^<!--\s*\n?([\s\S]*?)-->/);
  if (!match) return { error: 'no HTML-comment block found' };
  const lines = match[1].split(/\r?\n/);
  const firstIdx = lines.findIndex((l) => l.trim().length > 0);
  if (firstIdx === -1) return { error: 'empty metadata block' };
  if (!lines[firstIdx].trim().startsWith(MARKER)) {
    return { error: `metadata block does not start with ${MARKER} marker` };
  }
  let meta;
  try {
    meta = JSON.parse(lines.slice(firstIdx + 1).join('\n'));
  } catch (err) {
    return { error: `invalid JSON: ${err instanceof Error ? err.message : String(err)}` };
  }
  if (meta === null || typeof meta !== 'object' || Array.isArray(meta)) {
    return { error: 'metadata is not a JSON object' };
  }
  const body = text.slice(match[0].length).replace(/^\s*\n/, '');
  return { meta, body };
}

function isNonEmptyString(value) {
  return typeof value === 'string' && value.trim().length > 0;
}

function validatePatternMeta(meta, label) {
  const problems = [];
  const has = (key) => Object.hasOwn(meta, key);
  if (!has('schemaVersion') || meta.schemaVersion !== SCHEMA_VERSION) {
    problems.push(`schemaVersion must be ${SCHEMA_VERSION}`);
  }
  if (!has('recordType') || meta.recordType !== 'pattern') {
    problems.push("recordType must be 'pattern'");
  }
  if (!has('recordId') || !isNonEmptyString(meta.recordId) || !RECORD_ID_PATTERN.test(meta.recordId)) {
    problems.push('recordId must match P-(ERR-NNN|timestamp-rand4)');
  }
  if (!has('displayId') || !isNonEmptyString(meta.displayId) || !DISPLAY_ID_PATTERN.test(meta.displayId)) {
    problems.push('displayId must match ERR-NNN');
  }
  if (!has('title') || !isNonEmptyString(meta.title)) problems.push('title must be a non-empty string');
  if (!has('status') || !VALID_STATUS.has(meta.status)) {
    problems.push(`status must be one of ${[...VALID_STATUS].join('|')}`);
  }
  // Category is nullable: archived entries had their category-table rows
  // removed when they were moved, so the fact is genuinely absent in legacy
  // data. Null simply means "no category table membership" in views.
  if (has('category') && meta.category !== null && !VALID_CATEGORIES.has(meta.category)) {
    problems.push(`category must be one of ${[...VALID_CATEGORIES].join('|')} or null`);
  }
  if (has('ep') && meta.ep !== null && !EP_ID_PATTERN.test(meta.ep)) {
    problems.push('ep must be EP-NN or null');
  }
  if (!has('createdAt') || !isValidCalendarDate(meta.createdAt)) {
    problems.push('createdAt must be a valid YYYY-MM-DD');
  }
  if (!has('source') || !isNonEmptyString(meta.source)) problems.push('source must be a non-empty string');
  if (has('undatedRecurrences')) {
    if (
      !Array.isArray(meta.undatedRecurrences) ||
      !meta.undatedRecurrences.every((v) => typeof v === 'string' && v.trim().length > 0)
    ) {
      problems.push('undatedRecurrences must be an array of non-empty strings');
    }
  }
  if (has('trailerLines')) {
    if (!Array.isArray(meta.trailerLines) || !meta.trailerLines.every((v) => typeof v === 'string' && v.trim().length > 0)) {
      problems.push('trailerLines must be an array of non-empty strings');
    }
  }
  if (problems.length > 0) return { error: `${label}: ${problems.join('; ')}` };
  return { ok: true, meta };
}

function validateOccurrenceMeta(meta, label) {
  const problems = [];
  const has = (key) => Object.hasOwn(meta, key);
  if (!has('schemaVersion') || meta.schemaVersion !== SCHEMA_VERSION) {
    problems.push(`schemaVersion must be ${SCHEMA_VERSION}`);
  }
  if (!has('recordType') || meta.recordType !== 'occurrence') {
    problems.push("recordType must be 'occurrence'");
  }
  if (!has('occurrenceId') || !isNonEmptyString(meta.occurrenceId) || !OCCURRENCE_ID_RE.test(meta.occurrenceId)) {
    problems.push('occurrenceId must match OCC-<date|compactUTC-rand4>');
  }
  if (!has('patternRecordId') || !isNonEmptyString(meta.patternRecordId) || !RECORD_ID_PATTERN.test(meta.patternRecordId)) {
    problems.push('patternRecordId must match P-(ERR-NNN|timestamp-rand4)');
  }
  if (!has('displayId') || !isNonEmptyString(meta.displayId) || !DISPLAY_ID_PATTERN.test(meta.displayId)) {
    problems.push('displayId must match ERR-NNN');
  }
  if (!has('observedAt') || !isValidObservedAt(meta.observedAt)) {
    problems.push('observedAt must be a valid YYYY-MM-DD (or YYYY-MM for month precision)');
  }
  if (!has('source') || !isNonEmptyString(meta.source)) problems.push('source must be a non-empty string');
  if (has('originPattern') && meta.originPattern !== null && !EP_ID_PATTERN.test(meta.originPattern)) {
    // the EP value recorded in the original recurrence-meta block, kept verbatim
    problems.push('originPattern must be EP-NN when present');
  }
  for (const key of ['invariant', 'severity', 'escaped', 'caughtBy', 'guard']) {
    if (!has(key)) continue; // pre-v2 occurrences legitimately lack the structured block
    if (key === 'severity' && !VALID_SEVERITY.has(meta.severity)) {
      problems.push(`severity must be one of ${[...VALID_SEVERITY].join('|')}`);
    } else if (key === 'caughtBy' && !VALID_CAUGHT_BY.has(meta.caughtBy)) {
      problems.push(`caughtBy must be one of ${[...VALID_CAUGHT_BY].join('|')}`);
    } else if (key !== 'severity' && key !== 'caughtBy' && !isNonEmptyString(meta[key])) {
      problems.push(`${key} must be a non-empty string`);
    }
  }
  const structured = ['severity', 'escaped', 'caughtBy', 'guard'].filter((k) => has(k));
  if (structured.length > 0 && structured.length < 4) {
    problems.push('structured recurrence fields (severity/escaped/caughtBy/guard) must be present together');
  }
  if (problems.length > 0) return { error: `${label}: ${problems.join('; ')}` };
  return { ok: true, meta };
}

/**
 * Load and validate the whole records tree.
 * Fail-loud referential contract (SPEC §36): unknown pattern refs, duplicate
 * ids, and record-type mismatches are errors, never skipped.
 */
function loadRecords(repoRoot) {
  const recordsDir = path.join(repoRoot, RECORDS_RELATIVE_DIR);
  const patternsDir = path.join(recordsDir, PATTERNS_DIR);
  const errors = [];
  const patterns = new Map();
  const occurrences = [];

  if (!fs.existsSync(patternsDir)) {
    return { patterns, occurrences, errors: [`records directory not found: ${recordsDir}`] };
  }

  for (const entry of fs.readdirSync(patternsDir)) {
    if (!entry.endsWith('.md')) continue;
    const filePath = path.join(patternsDir, entry);
    const parsed = parseRecordFile(fs.readFileSync(filePath, 'utf8'));
    if (parsed.error) {
      errors.push(`pattern ${entry}: ${parsed.error}`);
      continue;
    }
    const validated = validatePatternMeta(parsed.meta, `pattern ${entry}`);
    if (validated.error) {
      errors.push(validated.error);
      continue;
    }
    if (patterns.has(validated.meta.recordId)) {
      errors.push(`duplicate pattern recordId: ${validated.meta.recordId}`);
      continue;
    }
    patterns.set(validated.meta.recordId, { meta: validated.meta, body: parsed.body, file: filePath });
  }

  const occDir = path.join(recordsDir, OCCURRENCES_DIR);
  if (fs.existsSync(occDir)) {
    for (const group of fs.readdirSync(occDir)) {
      const groupDir = path.join(occDir, group);
      if (!fs.statSync(groupDir).isDirectory()) continue;
      for (const entry of fs.readdirSync(groupDir)) {
        if (!entry.endsWith('.md')) continue;
        const filePath = path.join(groupDir, entry);
        const parsed = parseRecordFile(fs.readFileSync(filePath, 'utf8'));
        if (parsed.error) {
          errors.push(`occurrence ${group}/${entry}: ${parsed.error}`);
          continue;
        }
        const validated = validateOccurrenceMeta(parsed.meta, `occurrence ${group}/${entry}`);
        if (validated.error) {
          errors.push(validated.error);
          continue;
        }
        occurrences.push({ meta: validated.meta, body: parsed.body, file: filePath });
      }
    }
  }

  const seenOccurrenceIds = new Set();
  const seenDisplayIds = new Set();
  for (const occ of occurrences) {
    if (seenOccurrenceIds.has(occ.meta.occurrenceId)) {
      errors.push(`duplicate occurrence id: ${occ.meta.occurrenceId}`);
    }
    seenOccurrenceIds.add(occ.meta.occurrenceId);
    if (!patterns.has(occ.meta.patternRecordId)) {
      errors.push(`occurrence ${occ.meta.occurrenceId} references unknown pattern ${occ.meta.patternRecordId}`);
    }
  }
  for (const [recordId, pattern] of patterns) {
    if (seenDisplayIds.has(pattern.meta.displayId)) {
      errors.push(`duplicate pattern display id: ${pattern.meta.displayId}`);
    }
    seenDisplayIds.add(pattern.meta.displayId);
    if (pattern.meta.ep !== null && pattern.meta.ep !== undefined && !EP_ID_PATTERN.test(pattern.meta.ep ?? '')) {
      errors.push(`pattern ${recordId} has invalid ep reference`);
    }
  }

  return { patterns, occurrences, errors };
}

/** Derived per-pattern recurrence facts — never hand-maintained (SPEC §11). */
function aggregatePatternStats(patterns, occurrences, now = new Date(), recentDays = 90) {
  const cutoff = now.getTime() - recentDays * 24 * 60 * 60 * 1000;
  const stats = new Map();
  for (const recordId of patterns.keys()) {
    stats.set(recordId, { occurrenceCount: 0, structuredCount: 0, lastSeen: null, recentCount: 0 });
  }
  for (const occ of occurrences) {
    const entry = stats.get(occ.meta.patternRecordId);
    if (!entry) continue;
    entry.occurrenceCount += 1;
    if (Object.hasOwn(occ.meta, 'guard')) entry.structuredCount += 1;
    const t = Date.parse(`${occ.meta.observedAt}T00:00:00Z`);
    if (!Number.isNaN(t)) {
      if (entry.lastSeen === null || occ.meta.observedAt > entry.lastSeen) entry.lastSeen = occ.meta.observedAt;
      if (t >= cutoff) entry.recentCount += 1;
    }
  }
  return stats;
}

/**
 * Atomic write: temp file in the target directory + rename. Never leaves a
 * partial record visible to a concurrent reader/validator.
 */
function writeRecordAtomic(filePath, content) {
  const dir = path.dirname(filePath);
  fs.mkdirSync(dir, { recursive: true });
  const tmp = path.join(dir, `.${path.basename(filePath)}.${process.pid}.tmp`);
  fs.writeFileSync(tmp, content, 'utf8');
  fs.renameSync(tmp, filePath);
}

function recordFilePath(repoRoot, meta) {
  const recordsDir = path.join(repoRoot, RECORDS_RELATIVE_DIR);
  if (meta.recordType === 'pattern') {
    return path.join(recordsDir, PATTERNS_DIR, `${meta.recordId}.md`);
  }
  return path.join(recordsDir, OCCURRENCES_DIR, meta.patternRecordId, `${meta.occurrenceId}.md`);
}

/** Validate-then-write for one record. Returns written path or throws. */
function writePatternRecord(repoRoot, meta, body) {
  const validated = validatePatternMeta(meta, `pattern ${meta.recordId ?? '<unparsed>'}`);
  if (validated.error) throw new Error(validated.error);
  const filePath = recordFilePath(repoRoot, meta);
  writeRecordAtomic(filePath, serializeRecord(meta, body));
  return filePath;
}

function writeOccurrenceRecord(repoRoot, meta, body) {
  const validated = validateOccurrenceMeta(meta, `occurrence ${meta.occurrenceId ?? '<unparsed>'}`);
  if (validated.error) throw new Error(validated.error);
  const filePath = recordFilePath(repoRoot, meta);
  if (fs.existsSync(filePath)) {
    throw new Error(`occurrence already exists: ${meta.occurrenceId} (refusing to overwrite)`);
  }
  writeRecordAtomic(filePath, serializeRecord(meta, body));
  return filePath;
}

/** Archive is a lifecycle flip, never a narrative move (SPEC §12). */
function archivePattern(repoRoot, recordId) {
  const { patterns, errors } = loadRecords(repoRoot);
  if (errors.length > 0) throw new Error(`cannot archive: records tree invalid:\n${errors.join('\n')}`);
  const pattern = patterns.get(recordId);
  if (!pattern) throw new Error(`unknown pattern record: ${recordId}`);
  if (pattern.meta.status === 'archived') return pattern.file;
  const nextMeta = { ...pattern.meta, status: 'archived' };
  writeRecordAtomic(pattern.file, serializeRecord(nextMeta, pattern.body));
  return pattern.file;
}

// ---------------------------------------------------------------------------
// Minimal writer CLI (SPEC §16): create pattern / add occurrence / validate /
// archive. The writer owns collision-resistant ids, file placement, atomic
// writes and validation. It never judges semantics (no dedupe, no root-cause
// rewriting, no archive decisions).
// ---------------------------------------------------------------------------

function readFlag(argv, flag) {
  const idx = argv.indexOf(flag);
  return idx !== -1 ? argv[idx + 1] : undefined;
}

function readBody(argv) {
  const bodyFile = readFlag(argv, '--body-file');
  if (bodyFile) return fs.readFileSync(bodyFile, 'utf8');
  const inline = readFlag(argv, '--body');
  if (inline !== undefined) return inline;
  return '';
}

function todayIso() {
  return new Date().toISOString().slice(0, 10);
}

function runCli(argv) {
  const command = argv[0];
  try {
    if (command === 'validate') {
      const { patterns, occurrences, errors } = loadRecords(process.cwd());
      if (errors.length > 0) {
        for (const e of errors) console.error(`[error:record] ${e}`);
        process.exit(1);
      }
      const stats = aggregatePatternStats(patterns, occurrences);
      console.log(
        `[error:record] OK: ${patterns.size} patterns, ${occurrences.length} occurrences. ` +
          `${[...stats.values()].filter((s) => s.recentCount > 0).length} patterns with recurrences in the last 90 days.`,
      );
      return;
    }
    if (command === 'create-pattern') {
      const meta = {
        schemaVersion: SCHEMA_VERSION,
        recordType: 'pattern',
        recordId: readFlag(argv, '--record-id') ?? generatePatternRecordId(),
        displayId: readFlag(argv, '--display'),
        title: readFlag(argv, '--title'),
        status: 'active',
        category: readFlag(argv, '--category') ?? null,
        ep: readFlag(argv, '--ep') ?? null,
        createdAt: readFlag(argv, '--date') ?? todayIso(),
        source: readFlag(argv, '--source'),
      };
      const written = writePatternRecord(process.cwd(), meta, readBody(argv));
      console.log(`[error:record] pattern written: ${written}`);
      return;
    }
    if (command === 'add-occurrence') {
      const patternRef = readFlag(argv, '--pattern');
      if (!patternRef) throw new Error('--pattern <recordId> is required');
      const { patterns, errors } = loadRecords(process.cwd());
      if (errors.length > 0) throw new Error(`records tree invalid, refusing to write:\n${errors.join('\n')}`);
      const pattern = patterns.get(patternRef);
      if (!pattern) throw new Error(`unknown pattern: ${patternRef}`);
      const meta = {
        schemaVersion: SCHEMA_VERSION,
        recordType: 'occurrence',
        occurrenceId: readFlag(argv, '--occurrence-id') ?? generateOccurrenceId(),
        patternRecordId: patternRef,
        displayId: pattern.meta.displayId,
        observedAt: readFlag(argv, '--date') ?? todayIso(),
        source: readFlag(argv, '--source'),
      };
      for (const [flag, key] of [
        ['--invariant', 'invariant'],
        ['--severity', 'severity'],
        ['--escaped', 'escaped'],
        ['--caughtBy', 'caughtBy'],
        ['--guard', 'guard'],
      ]) {
        const value = readFlag(argv, flag);
        if (value !== undefined) meta[key] = value;
      }
      const written = writeOccurrenceRecord(process.cwd(), meta, readBody(argv));
      console.log(`[error:record] occurrence written: ${written}`);
      return;
    }
    if (command === 'archive') {
      const patternRef = readFlag(argv, '--pattern');
      if (!patternRef) throw new Error('--pattern <recordId> is required');
      const written = archivePattern(process.cwd(), patternRef);
      console.log(`[error:record] pattern archived (lifecycle flip only, narrative untouched): ${written}`);
      return;
    }
    throw new Error(
      `unknown command: ${command ?? '<none>'} (usage: error-records <validate|create-pattern|add-occurrence|archive> [...])`,
    );
  } catch (err) {
    console.error(`[error:record] FAILED: ${err instanceof Error ? err.message : String(err)}`);
    process.exit(1);
  }
}

module.exports = {
  MARKER,
  RECORDS_RELATIVE_DIR,
  SCHEMA_VERSION,
  VALID_CATEGORIES,
  VALID_CAUGHT_BY,
  VALID_SEVERITY,
  VALID_STATUS,
  isValidCalendarDate,
  isValidObservedAt,
  generatePatternRecordId,
  generateOccurrenceId,
  serializeRecord,
  parseRecordFile,
  validatePatternMeta,
  validateOccurrenceMeta,
  loadRecords,
  aggregatePatternStats,
  writeRecordAtomic,
  writePatternRecord,
  writeOccurrenceRecord,
  archivePattern,
  runCli,
};

const invokedDirectly = process.argv[1] && process.argv[1].endsWith('error-records.cjs');
if (invokedDirectly) runCli(process.argv.slice(2));
