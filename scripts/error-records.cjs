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
 * checked (rc-4); Object.hasOwn for key membership (rc-5).
 * Record creation uses filesystem-level no-clobber via open(..., 'wx').
 * Archive lifecycle replacement uses tmp+rename on a known-existing record.
 * Creation is not crash-atomic: a crash can leave a partial file; loadRecords
 * fails loud, and recovery requires removing the partial file before retrying.
 * Nothing here makes semantic judgments for the Owner (no auto dedupe,
 * no auto archive, no LLM rewrite — SPEC §16).
 */

'use strict';

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
// Shared error-experience metadata helpers: the caught-by enum and the strict
// calendar-date validator have ONE implementation (error-handbook-meta.cjs,
// the v2 parser this module extends), not a third mirror copy.
const { isValidCalendarDate, VALID_CAUGHT_BY } = require('./error-handbook-meta.cjs');

const MARKER = 'pd-error-record';
const RECORDS_RELATIVE_DIR = path.join('docs', 'process', 'error-management', 'records');
const PATTERNS_DIR = 'patterns';
const OCCURRENCES_DIR = 'occurrences';
const SCHEMA_VERSION = 1;

const VALID_STATUS = new Set(['active', 'archived']);
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

const DISPLAY_ID_PATTERN = /^ERR-\d{3,4}$/;
const RECORD_ID_PATTERN = /^P-(ERR-\d{3,4}|\d{8}T\d{6}Z-[0-9a-z]{6})$/;
// Two occurrence-id shapes:
//   runtime   OCC-<compactUTC>-<rand6>          e.g. OCC-20260916T143000Z-a3k9
//   migration OCC-<date>-err-NNN-r<index>       deterministic, re-runnable
const OCCURRENCE_ID_RE = /^OCC-(\d{8}T\d{6}Z-[0-9a-z]{6}|\d{4}-\d{2}(?:-\d{2})?-err-\d{3,4}-r\d+)$/;
const EP_ID_PATTERN = /^EP-\d{2}$/;

/** Crockford-ish base32 (no confusing 0/O/1/I) for random suffixes. */
const ID_ALPHABET = '23456789abcdefghjkmnpqrstvwxyz';

/**
 * Reject byte values outside the largest complete multiple of the alphabet
 * length within 256, so every character has equal probability.
 */
function randomSuffix(length) {
  const limit = 256 - (256 % ID_ALPHABET.length);
  let out = '';
  while (out.length < length) {
    const bytes = crypto.randomBytes(length * 2);
    for (const byte of bytes) {
      if (byte >= limit) continue;
      out += ID_ALPHABET[byte % ID_ALPHABET.length];
      if (out.length === length) break;
    }
  }
  return out;
}

function pad2(n) {
  return String(n).padStart(2, '0');
}

/**
 * Month-precision dates are legitimate observed facts — several legacy
 * recurrence bullets say "2026-06" without a day. Store exactly what the
 * source states; `YYYY-MM` passes when the month is real. Calendar-day
 * validation is reused from error-handbook-meta.cjs.
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
 * Make a JSON text safe to embed inside an HTML comment. HTML comments have
 * TWO end markers — `-->` and `--!>` — and one open marker `<!--`; after
 * this transform none of them can occur in the literal text:
 *   `-->` → `\u002d\u002d>`  (cannot terminate the comment early)
 *   `!`   → `\u0021`         (kills `--!>`; also covers stray `!` harmlessly)
 *   `<`   → `\u003c`         (kills `<!--`)
 * All three are standard JSON unicode escapes — JSON.parse restores the
 * original string losslessly.
 */
function escapeHtmlCommentJson(text) {
  return String(text)
    .split('-->')
    .join('\\u002d\\u002d>')
    .split('!')
    .join('\\u0021')
    .split('<')
    .join('\\u003c');
}

/**
 * Find the earliest supported comment terminator in one forward scan.
 * Stop at the first match so repeated comments never rescan a suffix.
 *
 * @returns {{index: number, length: number} | null}
 */
function findHtmlCommentEnd(text, fromIndex) {
  for (let index = fromIndex; index < text.length - 2; index += 1) {
    if (text[index] !== '-' || text[index + 1] !== '-') continue;
    if (text[index + 2] === '>') return { index, length: 3 };
    if (text[index + 2] === '!' && text[index + 3] === '>') return { index, length: 4 };
  }
  return null;
}

/**
 * Linear HTML-comment stripper for parity normalization: keeps the text
 * before each `<!--`, skips to the earliest `-->`/`--!>`, repeats. An
 * unterminated `<!--` throws — silently swallowing the remainder would
 * hide malformed records from the parity gate (fail-loud by design).
 */
function stripHtmlComments(text) {
  let out = '';
  let i = 0;
  while (i < text.length) {
    const open = text.indexOf('<!--', i);
    if (open === -1) {
      out += text.slice(i);
      break;
    }
    out += text.slice(i, open);
    const end = findHtmlCommentEnd(text, open + 4);
    if (end === null) {
      throw new Error(`unterminated HTML comment at offset ${open}`);
    }
    i = end.index + end.length;
  }
  return out;
}

/**
 * Serialize one record file: marker JSON block + markdown body.
 * Deterministic — key order is the object's own insertion order and the
 * writer always serializes from a freshly constructed meta object.
 */
function serializeRecord(meta, body) {
  return `<!-- ${MARKER}\n${escapeHtmlCommentJson(JSON.stringify(meta, null, 2))}\n-->\n\n${body.trimEnd()}\n`;
}

/**
 * Parse one record file. Returns { meta, body } or { error }.
 * The marker protocol mirrors parseMarkerComment in error-handbook-meta.cjs:
 * first non-empty line of the comment must start with the marker.
 * Comment end detection is the shared linear scanner (both `-->` and
 * `--!>` are legal end markers) — no filtering regex.
 */
function parseRecordFile(text) {
  if (typeof text !== 'string' || text.length === 0) return { error: 'empty record file' };
  if (!text.startsWith('<!--')) return { error: 'no HTML-comment block found' };
  const end = findHtmlCommentEnd(text, 4);
  if (end === null) return { error: 'unterminated metadata comment' };
  const lines = text.slice(4, end.index).split(/\r?\n/);
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
  const body = text.slice(end.index + end.length).replace(/^\s*\n/, '');
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
    problems.push('recordId must match P-(ERR-NNN|timestamp-rand6)');
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
    problems.push('patternRecordId must match P-(ERR-NNN|timestamp-rand6)');
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
  for (const occ of occurrences) {
    if (seenOccurrenceIds.has(occ.meta.occurrenceId)) {
      errors.push(`duplicate occurrence id: ${occ.meta.occurrenceId}`);
    }
    seenOccurrenceIds.add(occ.meta.occurrenceId);
    const pattern = patterns.get(occ.meta.patternRecordId);
    if (!pattern) {
      errors.push(`occurrence ${occ.meta.occurrenceId} references unknown pattern ${occ.meta.patternRecordId}`);
    } else if (pattern.meta.displayId !== occ.meta.displayId) {
      // rc-6 lineage consistency: an occurrence's display id must agree with
      // the pattern it references, or lineage queries silently split.
      errors.push(
        `occurrence ${occ.meta.occurrenceId} displayId ${occ.meta.displayId} does not match pattern ${occ.meta.patternRecordId} displayId ${pattern.meta.displayId}`,
      );
    }
  }
  const seenDisplayIds = new Set();
  for (const pattern of patterns.values()) {
    if (seenDisplayIds.has(pattern.meta.displayId)) {
      errors.push(`duplicate pattern display id: ${pattern.meta.displayId}`);
    }
    seenDisplayIds.add(pattern.meta.displayId);
  }

  return { patterns, occurrences, errors };
}

/** Normalize an observed date for time comparison (month → first of month). */
function observedAtTimeKey(observedAt) {
  return observedAt.length === 7 ? `${observedAt}-01` : observedAt;
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
    // Month-precision dates ("2026-06") parse at month precision via the
    // first-of-month key; raw strings are kept for display, compared via the
    // key so YYYY-MM cannot lexicographically lose to YYYY-MM-DD.
    const timeKey = observedAtTimeKey(occ.meta.observedAt);
    const t = Date.parse(`${timeKey}T00:00:00Z`);
    if (!Number.isNaN(t)) {
      if (entry.lastSeen === null || timeKey > observedAtTimeKey(entry.lastSeen)) entry.lastSeen = occ.meta.observedAt;
      if (t >= cutoff) entry.recentCount += 1;
    }
  }
  return stats;
}

/**
 * Atomic NO-CLOBBER record creation. 'wx' = O_CREAT|O_EXCL: the filesystem
 * itself guarantees an existing recordId/occurrenceId is never replaced —
 * two concurrent writers (or an explicit duplicate --record-id) can only
 * get EEXIST, closing the check-then-rename TOCTOU window. A crash
 * mid-write leaves a truncated file that loadRecords rejects loudly
 * (repair = delete the partial record and retry); tmp+rename atomicity
 * cannot provide no-clobber and was rejected deliberately.
 */
function createRecordFile(filePath, content) {
  const dir = path.dirname(filePath);
  fs.mkdirSync(dir, { recursive: true });
  let fd;
  try {
    fd = fs.openSync(filePath, 'wx');
    fs.writeFileSync(fd, content, 'utf8');
    fs.closeSync(fd);
    fd = undefined;
  } catch (err) {
    if (fd !== undefined) {
      try {
        fs.closeSync(fd);
      } catch {
        /* already closed */
      }
      try {
        fs.unlinkSync(filePath);
      } catch {
        /* nothing was created */
      }
    }
    if (err instanceof Error && err.code === 'EEXIST') {
      throw new Error(`record already exists: ${path.basename(filePath, '.md')} (refusing to overwrite)`);
    }
    throw err;
  }
}

/**
 * Replace a record we have just read (archive lifecycle flip only). This is
 * a read-modify-write of a KNOWN-EXISTING file, not a create: concurrent
 * flips of the same pattern are a semantic conflict that Git surfaces by
 * design (SPEC §3.3) — no-clobber creation semantics do not apply here.
 */
function replaceRecordFile(filePath, content) {
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

/** Validate-then-create for one record. Returns written path or throws. */
function writePatternRecord(repoRoot, meta, body) {
  const validated = validatePatternMeta(meta, `pattern ${meta.recordId ?? '<unparsed>'}`);
  if (validated.error) throw new Error(validated.error);
  const filePath = recordFilePath(repoRoot, meta);
  createRecordFile(filePath, serializeRecord(meta, body));
  return filePath;
}

function writeOccurrenceRecord(repoRoot, meta, body) {
  const validated = validateOccurrenceMeta(meta, `occurrence ${meta.occurrenceId ?? '<unparsed>'}`);
  if (validated.error) throw new Error(validated.error);
  const filePath = recordFilePath(repoRoot, meta);
  createRecordFile(filePath, serializeRecord(meta, body));
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
  replaceRecordFile(pattern.file, serializeRecord(nextMeta, pattern.body));
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

/** A typo'd flag must fail loud, not be silently ignored (rc-9 sibling). */
function rejectUnknownFlags(argv, known) {
  const knownSet = new Set(known);
  for (const arg of argv) {
    if (arg.startsWith('--') && !knownSet.has(arg)) {
      throw new Error(`unknown flag for ${argv[0]}: ${arg} (known: ${[...knownSet].join(' ')})`);
    }
  }
}

const CLI_FLAGS = {
  validate: [],
  'create-pattern': ['--record-id', '--display', '--title', '--category', '--ep', '--date', '--source', '--body-file', '--body'],
  'add-occurrence': ['--pattern', '--occurrence-id', '--date', '--source', '--invariant', '--severity', '--escaped', '--caughtBy', '--guard', '--body-file', '--body'],
  archive: ['--pattern'],
};

function runCli(argv) {
  const command = argv[0];
  try {
    if (!CLI_FLAGS[command]) {
      throw new Error(
        `unknown command: ${command ?? '<none>'} (usage: error-records <validate|create-pattern|add-occurrence|archive> [...])`,
      );
    }
    rejectUnknownFlags(argv.slice(1), CLI_FLAGS[command]);
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
        // check:error-handbook requires runtime-recorded occurrences to carry
        // the structured recurrence facts including originPattern — derive it
        // from the owning pattern's ep so the writer and the gate agree.
        originPattern: pattern.meta.ep ?? null,
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
    throw new Error('unreachable: command dispatch is total');
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
  escapeHtmlCommentJson,
  findHtmlCommentEnd,
  stripHtmlComments,
  validatePatternMeta,
  validateOccurrenceMeta,
  loadRecords,
  aggregatePatternStats,
  createRecordFile,
  replaceRecordFile,
  writePatternRecord,
  writeOccurrenceRecord,
  archivePattern,
  runCli,
};

const invokedDirectly = process.argv[1] && process.argv[1].endsWith('error-records.cjs');
if (invokedDirectly) runCli(process.argv.slice(2));
