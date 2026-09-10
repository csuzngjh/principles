/**
 * Error-handbook metadata helpers — Error Experience v2.
 *
 * Shared parsing for the machine-readable metadata embedded in the error
 * experience docs, so scripts/check-error-handbook.cjs (validation) and its
 * hotspot report consume ONE implementation:
 *
 *   - `error-pattern-routing` HTML-comment JSON blocks in ERROR_PATTERN_INDEX.md
 *     (one per active EP card, schema: id/risk/pathSignals/diffSignals/
 *     requiredEvidence/enforcement);
 *   - `recurrence-meta` HTML-comment JSON blocks in ERROR_EXPERIENCE_HANDBOOK.md
 *     (adjacent to new natural-language recurrences, schema: date/pattern/
 *     invariant/severity/escaped/caughtBy/guard).
 *
 * Mirrors the ESM logic in scripts/error-context.mjs (kept in sync by
 * error-context.test.ts importing BOTH and comparing against fixtures).
 */

'use strict';

const ROUTING_MARKER = 'error-pattern-routing';
const RECURRENCE_MARKER = 'recurrence-meta';

const VALID_RISK = new Set(['high', 'medium', 'low']);
const VALID_ENFORCEMENT = new Set(['blocking', 'advisory', 'semantic', 'mixed']);
const VALID_CAUGHT_BY = new Set(['self-review', 'pr-review', 'ci', 'runtime', 'owner']);

/** HTML-comment JSON blocks carrying this marker are subject to validation. */
function markerStartsWithMarker(commentBody, marker) {
  const first = commentBody.split(/\r?\n/).find((l) => l.trim().length > 0);
  return first !== undefined && first.trim().startsWith(marker);
}

/** Extract all `<!-- ... -->` comment bodies. */
function extractHtmlComments(markdown) {
  const comments = [];
  const re = /<!--([\s\S]*?)-->/g;
  let m;
  while ((m = re.exec(markdown)) !== null) comments.push(m[1]);
  return comments;
}

function isNonEmptyStringArray(value) {
  return (
    Array.isArray(value) &&
    value.length > 0 &&
    value.every((v) => typeof v === 'string' && v.trim().length > 0)
  );
}

/**
 * Parse one marker comment into its JSON object, or an error string.
 * Returns null for comments that do not carry the marker (not our business).
 */
function parseMarkerComment(commentBody, marker) {
  if (!markerStartsWithMarker(commentBody, marker)) return null;
  const lines = commentBody.split(/\r?\n/);
  const firstIdx = lines.findIndex((l) => l.trim().length > 0);
  let parsed;
  try {
    parsed = JSON.parse(lines.slice(firstIdx + 1).join('\n'));
  } catch (err) {
    return { error: `invalid JSON: ${err instanceof Error ? err.message : String(err)}` };
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return { error: 'metadata is not a JSON object' };
  }
  return { meta: parsed };
}

/**
 * Parse all pattern routing metadata from an index document.
 * @returns {{patterns: Array<object>, errors: string[]}}
 */
function parsePatternRouting(markdown) {
  const patterns = [];
  const errors = [];
  const seenIds = new Set();
  const headingIds = new Set((markdown.match(/^### (EP-\d{2}) /gm) ?? []).map((h) => h.slice(4, 9)));

  for (const body of extractHtmlComments(markdown)) {
    const parsed = parseMarkerComment(body, ROUTING_MARKER);
    if (parsed === null) continue;
    if (parsed.error) {
      errors.push(`routing metadata ${parsed.error}`);
      continue;
    }
    const meta = parsed.meta;
    const problems = [];
    if (typeof meta.id !== 'string' || !/^EP-\d{2}$/.test(meta.id)) problems.push('id must match EP-NN');
    if (!VALID_RISK.has(meta.risk)) problems.push(`risk must be one of ${[...VALID_RISK].join('|')}`);
    if (!VALID_ENFORCEMENT.has(meta.enforcement)) problems.push(`enforcement must be one of ${[...VALID_ENFORCEMENT].join('|')}`);
    if (!isNonEmptyStringArray(meta.pathSignals)) problems.push('pathSignals must be a non-empty string array');
    if (!isNonEmptyStringArray(meta.diffSignals)) problems.push('diffSignals must be a non-empty string array');
    if (!isNonEmptyStringArray(meta.requiredEvidence)) problems.push('requiredEvidence must be a non-empty string array');
    if (problems.length > 0) {
      errors.push(`${String(meta.id ?? '<unparsed>')} routing metadata invalid: ${problems.join('; ')}`);
      continue;
    }
    if (seenIds.has(meta.id)) {
      errors.push(`duplicate routing metadata for ${meta.id}`);
      continue;
    }
    seenIds.add(meta.id);
    if (!headingIds.has(meta.id)) {
      errors.push(`routing metadata id ${meta.id} has no matching pattern card heading`);
      continue;
    }
    patterns.push(meta);
  }

  // Every active card should carry routing metadata — report missing ones.
  for (const id of headingIds) {
    if (!seenIds.has(id)) {
      errors.push(`${id} pattern card has no routing metadata block`);
    }
  }

  return { patterns, errors };
}

/**
 * Parse all structured recurrence metadata from a handbook document.
 * @returns {{recurrences: Array<object>, errors: string[]}}
 */
/**
 * Strict YYYY-MM-DD calendar validation. `Date.parse` silently ROLLS OVER
 * impossible dates (2026-02-30 → 2026-03-02, 2025-02-29 → 2026-03-01), so a
 * regex + Date.parse gate admits them. Parse the components and require the
 * UTC round-trip to reproduce them exactly. Mirrors error-context.mjs.
 *
 * @param {unknown} value
 * @returns {boolean}
 */
function isValidCalendarDate(value) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const [year, month, day] = value.split('-').map((part) => Number.parseInt(part, 10));
  const date = new Date(Date.UTC(year, month - 1, day));
  return (
    date.getUTCFullYear() === year &&
    date.getUTCMonth() + 1 === month &&
    date.getUTCDate() === day
  );
}

function parseRecurrenceMeta(markdown) {
  const recurrences = [];
  const errors = [];

  for (const body of extractHtmlComments(markdown)) {
    const parsed = parseMarkerComment(body, RECURRENCE_MARKER);
    if (parsed === null) continue;
    if (parsed.error) {
      errors.push(`recurrence metadata ${parsed.error}`);
      continue;
    }
    const meta = parsed.meta;
    const problems = [];
    if (typeof meta.pattern !== 'string' || !/^EP-\d{2}$/.test(meta.pattern)) problems.push('pattern must match EP-NN');
    if (!isValidCalendarDate(meta.date)) problems.push('date must be a valid YYYY-MM-DD');
    if (typeof meta.invariant !== 'string' || meta.invariant.trim().length === 0) problems.push('invariant must be a non-empty string');
    if (typeof meta.severity !== 'string' || !/^P[0-3]$/.test(meta.severity)) problems.push('severity must be P0..P3');
    if (typeof meta.escaped !== 'string' || meta.escaped.trim().length === 0) problems.push('escaped must be a non-empty string');
    if (typeof meta.caughtBy !== 'string' || !VALID_CAUGHT_BY.has(meta.caughtBy)) problems.push(`caughtBy must be one of ${[...VALID_CAUGHT_BY].join('|')}`);
    if (typeof meta.guard !== 'string' || meta.guard.trim().length === 0) problems.push('guard must be a non-empty string');
    if (problems.length > 0) {
      errors.push(`recurrence metadata invalid: ${problems.join('; ')}`);
      continue;
    }
    recurrences.push(meta);
  }

  return { recurrences, errors };
}

/**
 * Aggregate recurrences into hotspots: (pattern, invariant) pairs with
 * counts, recent (<=90d) counts, escaped-gate counts, and enforcement status.
 *
 * A hotspot requires an ENFORCEMENT DECISION when the same pattern+invariant
 * has >=2 recent structured recurrences and guard === 'none' — repeated
 * escapes of the same known invariant without any mechanization.
 *
 * @param {Array<object>} recurrences
 * @param {Array<object>} patterns - routing metadata (for enforcement display)
 * @param {Date} now - reference date for the 90-day window
 * @param {number} recentDays - window size, default 90
 * @returns {{hotspots: Array<object>, decisionRequired: Array<object>}}
 */
function aggregateHotspots(recurrences, patterns, now, recentDays = 90) {
  const byKey = new Map();
  const cutoff = new Date(now.getTime() - recentDays * 24 * 60 * 60 * 1000);
  const enforcementById = new Map(patterns.map((p) => [p.id, p.enforcement]));

  for (const r of recurrences) {
    const key = `${r.pattern}|${r.invariant}`;
    let entry = byKey.get(key);
    if (!entry) {
      entry = {
        pattern: r.pattern,
        invariant: r.invariant,
        total: 0,
        recent: 0,
        escapedGates: new Set(),
        caughtBy: new Set(),
        guard: 'none',
        lastDate: r.date,
      };
      byKey.set(key, entry);
    }
    entry.total += 1;
    const d = new Date(r.date);
    if (!Number.isNaN(d.getTime()) && d >= cutoff) entry.recent += 1;
    if (d > new Date(entry.lastDate)) entry.lastDate = r.date;
    if (r.escaped && r.escaped !== 'none') entry.escapedGates.add(r.escaped);
    entry.caughtBy.add(r.caughtBy);
    // Any mechanized guard on any recurrence of this invariant counts as
    // enforcement present.
    if (r.guard && r.guard !== 'none') entry.guard = r.guard;
  }

  const hotspots = [...byKey.values()]
    .map((e) => ({
      ...e,
      escapedGates: [...e.escapedGates],
      caughtBy: [...e.caughtBy],
      enforcement: enforcementById.get(e.pattern) ?? 'unknown',
    }))
    .sort((a, b) => b.recent - a.recent || a.pattern.localeCompare(b.pattern));

  const decisionRequired = hotspots.filter((h) => h.recent >= 2 && h.guard === 'none');
  return { hotspots, decisionRequired };
}

module.exports = {
  parsePatternRouting,
  parseRecurrenceMeta,
  aggregateHotspots,
  extractHtmlComments,
  VALID_CAUGHT_BY,
};
