/**
 * ERR merge gate — PRI-799 Phase C authority cutover (2026-09-17).
 *
 * The authoritative object is the structured records tree
 * `docs/process/error-management/records/` (patterns/ + occurrences/), NOT a
 * Markdown document. `ERROR_EXPERIENCE_HANDBOOK.md` and `ERROR_ARCHIVE.md` are
 * frozen legacy snapshots: they are never parsed here and there is no size
 * gate on any Markdown file. The 300KB ceiling, the recurrence-bytes
 * truncation rule and the active-entry-count warning were zero-sum byte
 * budgets on a single shared file and are deleted, not relocated — recording a
 * lesson now adds one small file and requires no compression at all.
 *
 * What this gate verifies instead (same invariants, new authority):
 *   - schema validation            → loadRecords (field enums, dates, versions)
 *   - duplicate identity           → loadRecords (recordId/displayId/occurrenceId)
 *   - reference integrity          → loadRecords (occurrence→pattern, rc-6)
 *                                    + INDEX tokens ↔ pattern records
 *   - recurrence metadata          → occurrence structured fields
 *                                    (invariant/severity/escaped/caughtBy/guard)
 *   - pattern routing              → error-pattern-routing blocks in
 *                                    ERROR_PATTERN_INDEX.md (routing SSoT,
 *                                    unchanged) + records' ep/originPattern
 *                                    must reference existing routing ids
 *   - archive state                → pattern status lifecycle (archive via
 *                                    `npm run error:record archive`)
 *   - hotspot / aggregation facts  → --hotspots aggregates structured
 *                                    occurrences; --audit lists stale patterns
 *
 * `parseRecurrenceMeta` is intentionally no longer used here: recurrence-meta
 * HTML comments are a legacy-handbook convention. Structured recurrence facts
 * live as occurrence metadata fields now. The parser itself stays in
 * error-handbook-meta.cjs as the CJS parity reference for the ESM mirror in
 * error-context.mjs (error-context.test.ts imports BOTH and asserts they
 * agree, so the mirror cannot silently drift); it has no other production
 * consumer since this cutover.
 */

'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { parsePatternRouting, aggregateHotspots } = require('./error-handbook-meta.cjs');
const { loadRecords, aggregatePatternStats } = require('./error-records.cjs');

const INDEX_RELATIVE_PATH = path.join('docs', 'process', 'error-management', 'ERROR_PATTERN_INDEX.md');

function read(filePath) {
  return fs.readFileSync(filePath, 'utf8');
}

/**
 * ERR tokens in ERROR_PATTERN_INDEX.md use two presentations: `ERR-NNN` for
 * active patterns and `archived-NNN` for archived ones. Bare 3-4 digit
 * numbers (PRI-828, PR #1234, dates) are NOT ERR tokens and must be ignored.
 * @returns {{ referenced: Set<string>, activeTokens: Set<string> }}
 */
function extractIndexErrIds(index) {
  const referenced = new Set();
  const activeTokens = new Set();
  for (const m of index.matchAll(/\b(?:archived-)?(?:ERR-)?(\d{3,4})\b/g)) {
    if (m[0].startsWith('archived-')) {
      referenced.add(`ERR-${m[1]}`);
    } else if (m[0].startsWith('ERR-')) {
      referenced.add(`ERR-${m[1]}`);
      activeTokens.add(`ERR-${m[1]}`);
    }
  }
  return { referenced, activeTokens };
}

/**
 * observedAt may be month-precision (YYYY-MM, a legitimate legacy fact);
 * normalize to first-of-month before Date.parse so it cannot lose to a
 * day-precision date in comparisons.
 */
function observedAtToMs(observedAt) {
  return Date.parse(`${observedAt}${observedAt.length === 7 ? '-01' : ''}T00:00:00Z`);
}

/** Id shape produced by `error:record add-occurrence` (vs migration ids). */
const RUNTIME_OCCURRENCE_ID = /^OCC-\d{8}T\d{6}Z-[0-9a-z]{6}$/;
const STRUCTURED_RECURRENCE_FIELDS = ['originPattern', 'invariant', 'severity', 'escaped', 'caughtBy', 'guard'];

/**
 * Collect every gate finding for the records authority.
 * @param {string} repoRoot
 * @param {{ now?: Date }} [options]
 * @returns {{ errors: string[], warnings: string[], stats: object }}
 */
function collectFindings(repoRoot, options = {}) {
  const now = options.now ?? new Date();
  const errors = [];
  const warnings = [];

  const { patterns, occurrences, errors: recordErrors } = loadRecords(repoRoot);
  errors.push(...recordErrors);

  const indexPath = path.join(repoRoot, INDEX_RELATIVE_PATH);
  const index = read(indexPath);
  const routing = parsePatternRouting(index);
  errors.push(...routing.errors);
  const routingIds = new Set(routing.patterns.map((p) => p.id));

  // Records → routing: a pattern's EP card and an occurrence's recorded
  // pattern must exist in the routing SSoT (same rule the old gate applied to
  // recurrence-meta blocks: no dangling pattern references).
  for (const pattern of patterns.values()) {
    if (pattern.meta.ep && !routingIds.has(pattern.meta.ep)) {
      errors.push(`${pattern.meta.displayId} references unknown routing pattern ${pattern.meta.ep}`);
    }
  }
  for (const occ of occurrences) {
    if (occ.meta.originPattern && !routingIds.has(occ.meta.originPattern)) {
      errors.push(`occurrence ${occ.meta.occurrenceId} references unknown routing pattern ${occ.meta.originPattern}`);
    }
    // Occurrences recorded at runtime (via `error:record add-occurrence`) are
    // recurrences and must carry the structured recurrence facts — the
    // post-cutover successor of the v2 "recurrence-meta mandatory" rule that
    // was prose-only before. Migration-shaped ids are grandfathered history.
    if (RUNTIME_OCCURRENCE_ID.test(occ.meta.occurrenceId)) {
      const missing = STRUCTURED_RECURRENCE_FIELDS.filter((k) => !Object.hasOwn(occ.meta, k));
      if (missing.length > 0) {
        errors.push(
          `occurrence ${occ.meta.occurrenceId} (recorded at runtime) is missing structured recurrence fields: ${missing.join(', ')}`,
        );
      }
    }
  }

  // INDEX ↔ records display-id integrity (both directions, active only —
  // archived patterns may legitimately be absent from the index cards).
  const indexIds = extractIndexErrIds(index);
  for (const displayId of indexIds.referenced) {
    if (![...patterns.values()].some((p) => p.meta.displayId === displayId)) {
      errors.push(`${displayId} is referenced in ERROR_PATTERN_INDEX.md but has no pattern record`);
    }
  }
  for (const pattern of patterns.values()) {
    if (pattern.meta.status !== 'active') continue;
    if (!indexIds.activeTokens.has(pattern.meta.displayId)) {
      errors.push(`${pattern.meta.displayId} is an active pattern record but is not mapped in ERROR_PATTERN_INDEX.md`);
    }
  }

  const stats = aggregatePatternStats(patterns, occurrences, now);
  const activeCount = [...patterns.values()].filter((p) => p.meta.status === 'active').length;
  const archivedCount = patterns.size - activeCount;
  const structuredCount = occurrences.filter((o) => Object.hasOwn(o.meta, 'guard')).length;

  return {
    errors,
    warnings,
    stats: {
      patterns: patterns.size,
      activeCount,
      archivedCount,
      occurrences: occurrences.length,
      structuredCount,
      routingCards: routing.patterns.length,
      recentPatterns: [...stats.values()].filter((s) => s.recentCount > 0).length,
    },
    // exposed for --hotspots / --audit without re-reading the tree
    patterns,
    occurrences,
    routing,
    patternStats: stats,
  };
}

function fail(messages) {
  for (const message of messages) {
    console.error(`[check:error-handbook] ${message}`);
  }
  process.exit(1);
}

function main() {
  const root = process.cwd();
  const auditMode = process.argv.includes('--audit');
  const hotspotMode = process.argv.includes('--hotspots');
  const now = new Date();
  const findings = collectFindings(root, { now });

  if (hotspotMode) {
    // Recurrence escalation report over structured occurrences (same
    // decision rule as before: same pattern+invariant >=2 recent recurrences
    // with guard 'none' ⇒ enforcement decision required).
    console.log('[check:error-handbook] === RECURRENCE HOTSPOTS ===');
    const recurrences = findings.occurrences
      .filter((o) => o.meta.originPattern && o.meta.invariant && Object.hasOwn(o.meta, 'guard'))
      .map((o) => ({
        date: o.meta.observedAt,
        pattern: o.meta.originPattern,
        invariant: o.meta.invariant,
        severity: o.meta.severity,
        escaped: o.meta.escaped,
        caughtBy: o.meta.caughtBy,
        guard: o.meta.guard,
      }));
    const { hotspots, decisionRequired } = aggregateHotspots(recurrences, findings.routing.patterns, now);
    if (hotspots.length === 0) {
      console.log('[check:error-handbook] No structured recurrence records yet.');
      console.log('[check:error-handbook] Record recurrences via `npm run error:record add-occurrence --invariant ... --severity ... --escaped ... --caughtBy ... --guard ...`.');
    } else {
      for (const h of hotspots) {
        console.log(`${h.pattern} / ${h.invariant}`);
        console.log(`  structured recurrences: ${h.total} (recent 90d: ${h.recent}, last: ${h.lastDate})`);
        if (h.escapedGates.length > 0) console.log(`  escaped gates: ${h.escapedGates.join(', ')}`);
        console.log(`  caught by: ${h.caughtBy.join(', ')}`);
        console.log(`  current guard: ${h.guard} (enforcement: ${h.enforcement})`);
        if (decisionRequired.includes(h)) {
          console.log('  status: ENFORCEMENT DECISION REQUIRED — repeated escape of the same invariant without mechanization.');
          console.log('  Decide: blocking guard / advisory guard / semantic verification obligation / not-mechanizable + reason.');
        }
      }
      if (decisionRequired.length > 0) {
        console.log(`[check:error-handbook] ${decisionRequired.length} hotspot(s) require an enforcement decision.`);
      } else {
        console.log('[check:error-handbook] No hotspot currently requires an enforcement decision.');
      }
    }
    process.exit(0);
  }

  if (auditMode) {
    // Archive audit over record lifecycle facts: a pattern is archivable when
    // its most recent occurrence is older than 90 days (or it has none).
    // Archiving itself is `npm run error:record archive --pattern <recordId>`.
    console.log('[check:error-handbook] === ARCHIVE AUDIT ===');
    const STALE_DAYS = 90;
    const stale = [];
    for (const pattern of findings.patterns.values()) {
      if (pattern.meta.status !== 'active') continue;
      const entry = findings.patternStats.get(pattern.meta.recordId);
      if (!entry || entry.lastSeen === null) {
        stale.push({ id: pattern.meta.displayId, recordId: pattern.meta.recordId, lastSeen: null, daysSince: null });
        continue;
      }
      const t = observedAtToMs(entry.lastSeen);
      if (!Number.isNaN(t)) {
        const daysSince = Math.floor((now.getTime() - t) / (1000 * 60 * 60 * 24));
        if (daysSince > STALE_DAYS) {
          stale.push({ id: pattern.meta.displayId, recordId: pattern.meta.recordId, lastSeen: entry.lastSeen, daysSince });
        }
      }
    }
    if (stale.length === 0) {
      console.log('[check:error-handbook] No stale entries (> 90 days since last recurrence).');
    } else {
      console.log(`[check:error-handbook] ${stale.length} stale entries (> 90 days) eligible for archiving:`);
      for (const e of stale) {
        console.log(`  ${e.id} — last activity ${e.lastSeen ?? 'never'}${e.daysSince !== null ? ` (${e.daysSince} days ago)` : ''}`);
      }
      console.log('[check:error-handbook] Archive via: npm run error:record archive --pattern <recordId> (then update the INDEX card token).');
    }
    process.exit(0);
  }

  if (findings.errors.length > 0) {
    fail(findings.errors);
  }

  const s = findings.stats;
  console.log(
    `[check:error-handbook] OK: ${s.activeCount} active pattern records, ${s.archivedCount} archived, ` +
      `${s.occurrences} occurrences (${s.structuredCount} structured), ${s.routingCards} routing cards ` +
      `— authority: docs/process/error-management/records/`,
  );
}

const invokedDirectly = process.argv[1] && process.argv[1].endsWith('check-error-handbook.cjs');
if (invokedDirectly) main();

module.exports = { collectFindings, INDEX_RELATIVE_PATH };
