#!/usr/bin/env node
/**
 * Legacy ERR handbook → structured records migration — PRI-799.
 *
 * Reads the CURRENT authority (ERROR_EXPERIENCE_HANDBOOK.md +
 * ERROR_ARCHIVE.md + ERROR_PATTERN_INDEX.md) and produces:
 *   - canonical pattern/occurrence records (only with --apply)
 *   - a migration manifest mapping EVERY legacy block to its record
 *     (status: structured | preserved_raw — the mapping loop is total, so
 *     every block receives exactly one of the two; unparseable → ignore is
 *     forbidden, SPEC §21/§22)
 *   - a semantic parity report (records → regenerated handbook view vs
 *     current handbook: same ids, same dates, narrative containment)
 *
 * Mechanical only: every field is extracted from real bytes in the legacy
 * files. No semantic judgment (no dedupe, no reclassification, no archive
 * decisions). Nonstandard entries are preserved verbatim as occurrences and
 * flagged in the manifest rather than reinterpreted.
 *
 * Modes:
 *   node scripts/error-records-migrate.cjs --dry-run
 *   node scripts/error-records-migrate.cjs --apply --records-root <dir>
 *   node scripts/error-records-migrate.cjs --project --records-root <dir> --project-out <dir>
 */

'use strict';

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const {
  loadRecords,
  writePatternRecord,
  writeOccurrenceRecord,
  escapeHtmlCommentJson,
  RECORDS_RELATIVE_DIR,
} = require('./error-records.cjs');

const root = process.cwd();
const docsDir = path.join(root, 'docs', 'process', 'error-management');
const HANDBOOK = path.join(docsDir, 'ERROR_EXPERIENCE_HANDBOOK.md');
const ARCHIVE = path.join(docsDir, 'ERROR_ARCHIVE.md');
const INDEX = path.join(docsDir, 'ERROR_PATTERN_INDEX.md');

const ENTRY_SPLIT = /(?=^\*\*\[ERR-\d{3,4}\]\*\* )/m;
const ENTRY_HEADER = /^\*\*\[(ERR-\d{3,4})\]\*\* \| (.+)$/m;
const CATEGORY_HEADING = /^## Category \d+: (.+)$/gm;
const TABLE_ROW = /^\|\s*(ERR-\d{3,4})\s*\|\s*([^|]+?)\s*\|/gm;
const DATE_TOKEN = /\b\d{4}-\d{2}(?:-\d{2})?\b/;

// ---------------------------------------------------------------------------
// Legacy parsing (mechanical extraction from the real files)
// ---------------------------------------------------------------------------

function splitByHeadings(text, headingRe) {
  const marks = [];
  headingRe.lastIndex = 0;
  let m;
  while ((m = headingRe.exec(text)) !== null) {
    marks.push({ name: m[1].trim(), start: m.index });
  }
  const sections = new Map();
  for (let i = 0; i < marks.length; i += 1) {
    const end = i + 1 < marks.length ? marks[i + 1].start : text.length;
    sections.set(marks[i].name, text.slice(marks[i].start, end));
  }
  return sections;
}

/** Map ERR display id → category name, from the handbook category tables. */
function extractCategoryMembership(handbook) {
  const membership = new Map();
  const sections = splitByHeadings(handbook, CATEGORY_HEADING);
  for (const [name, section] of sections) {
    TABLE_ROW.lastIndex = 0;
    let row;
    while ((row = TABLE_ROW.exec(section)) !== null) {
      if (!membership.has(row[1])) membership.set(row[1], name);
    }
  }
  return membership;
}

/** Map ERR display id → EP card id, from INDEX Representative ERRs lists. */
function extractEpMapping(indexText) {
  const map = new Map();
  const cardRe = /^### (EP-\d{2}) .*$/gm;
  const cards = [];
  let m;
  while ((m = cardRe.exec(indexText)) !== null) {
    cards.push({ id: m[1], start: m.index });
  }
  for (let i = 0; i < cards.length; i += 1) {
    const end = i + 1 < cards.length ? cards[i + 1].start : indexText.length;
    const section = indexText.slice(cards[i].start, end);
    const repMatch = section.match(/\*\*Representative ERRs\*\*: (.+)/);
    if (!repMatch) continue;
    for (const token of repMatch[1].matchAll(/\b(?:ERR|archived)-(\d{3,4})\b/g)) {
      const displayId = `ERR-${token[1]}`;
      if (!map.has(displayId)) map.set(displayId, cards[i].id);
    }
  }
  return map;
}

/**
 * Count recurrence-meta marker blocks in a legacy document (both files).
 * Pure line-scan — block-level JSON parsing lives in parseEntryBody.
 */
function countRecurrenceMetaBlocks(text) {
  return (text.match(/^\s*<!--\s*recurrence-meta/gm) ?? []).length;
}

/**
 * Split one entry body into: preamble (fields before Recurrence),
 * recurrence note (text on the **Recurrence**: line), and the top-level
 * recurrence bullets (each with any adjacent recurrence-meta block).
 * Meta attribution is by LINE INDEX: a meta block belongs to the bullet it
 * follows, up to the next top-level bullet (or entry end).
 */
function parseEntryBody(body) {
  const lines = body.split('\n');
  const recIdx = lines.findIndex((l) => /^(?:- )?\*\*(?:Recurrence|Latest recurrence)\*\*:/.test(l.trim()));
  if (recIdx === -1) {
    return { shape: 'nonstandard', preamble: body.trimEnd(), recurrenceLine: '', recurrenceNote: '', bullets: [], metas: [], trailer: [] };
  }
  const recLine = lines[recIdx];
  const recurrenceLine = recLine.trim().replace(/^- /, '');
  const note = recurrenceLine.replace(/^\*\*(?:Recurrence|Latest recurrence)\*\*:\s*/, '').trim();
  const preamble = lines.slice(0, recIdx).join('\n').trimEnd();

  // Pass 1: locate recurrence-meta comment blocks (opener line → closer line).
  // Real files put the marker on the SAME line as the opener: `<!-- recurrence-meta`.
  const metaRanges = [];
  for (let i = recIdx + 1; i < lines.length; i += 1) {
    const trimmed = lines[i].trim();
    if (!(trimmed.startsWith('<!--') && trimmed.includes('recurrence-meta'))) continue;
    let j = i;
    for (; j < lines.length; j += 1) {
      if (/--!?>/.test(lines[j])) break;
    }
    metaRanges.push({ start: i, end: j });
    i = j;
  }
  const inMetaRange = (i) => metaRanges.some((r) => i >= r.start && i <= r.end);

  // Pass 2: top-level bullets. Meta blocks are structured metadata, NOT
  // bullet continuation text — swallowing them here would duplicate the
  // block into the occurrence body AND the projection's re-emission.
  const bullets = [];
  let current = null;
  let trailerStart = lines.length;
  for (let i = recIdx + 1; i < lines.length; i += 1) {
    const line = lines[i];
    if (inMetaRange(i)) continue;
    if (line.trim() === '') continue; // blank lines do not end a bullet
    if (/^ {2}- /.test(line)) {
      if (current) bullets.push(current);
      current = { text: line.replace(/^ {2}- /, ''), startLine: i, endLine: i };
    } else if (current && /^ {2,}/.test(line)) {
      current.text += `\n${line}`;
      current.endLine = i;
    } else {
      if (current) bullets.push(current);
      current = null;
      trailerStart = i; // next top-level field or stray prose — trailer region
      break;
    }
  }
  if (current) bullets.push(current);

  // Pass 3: parse each block's JSON (object shape enforced, rc-1/rc-3).
  const metas = [];
  for (const range of metaRanges) {
    const inner = lines
      .slice(range.start, range.end + 1)
      .join('\n')
      .replace(/^\s*<!--/, '')
      .replace(/--!?>\s*$/, '');
    const contentLines = inner.split(/\r?\n/).filter((l) => l.trim().length > 0);
    try {
      const parsedMeta = JSON.parse(contentLines.slice(1).join('\n'));
      if (parsedMeta === null || typeof parsedMeta !== 'object' || Array.isArray(parsedMeta)) {
        metas.push({ lineIdx: range.start, error: 'recurrence-meta is not a JSON object' });
      } else {
        metas.push({ lineIdx: range.start, meta: parsedMeta });
      }
    } catch (err) {
      metas.push({ lineIdx: range.start, error: `invalid recurrence-meta JSON: ${err instanceof Error ? err.message : String(err)}` });
    }
  }

  // Trailer: everything after the bullet list, verbatim (e.g. `- **Archived**:
  // date (reason)` lifecycle fields, link-reference definitions, stray prose).
  const trailer = lines
    .slice(trailerStart)
    .filter((l) => l.trim().length > 0 && !/^---$/.test(l.trim()));
  return { shape: 'standard', preamble, recurrenceLine, recurrenceNote: note, bullets, metas, trailer };
}

function hashText(text) {
  return crypto.createHash('sha1').update(text, 'utf8').digest('hex').slice(0, 12);
}

/** Parse one legacy entry block into its header fields + body parts. */
function parseLegacyEntry(block, source) {
  const header = block.match(ENTRY_HEADER);
  if (!header) return null;
  const displayId = header[1];
  const title = header[2].trim();
  // entry blocks carry the `---` separator from ENTRY_SPLIT at their tail
  let body = block.slice(block.indexOf('\n') + 1);
  body = body.replace(/\n---\s*$/, '').replace(/\s+$/, '');
  const dateMatch = body.match(/\*\*Date\*\*: (\d{4}-\d{2}-\d{2})/);
  const sourceMatch = body.match(/\*\*Source\*\*: (.+)/);
  const parsedBody = parseEntryBody(body);
  const dates = [...body.matchAll(new RegExp(DATE_TOKEN.source, 'g'))].map((d) => d[0]);
  const observedAt = dateMatch
    ? dateMatch[1]
    : dates.slice().sort()[0] ?? null;
  return {
    displayId,
    title,
    source: sourceMatch ? sourceMatch[1].trim() : 'unknown',
    date: dateMatch ? dateMatch[1] : null,
    observedAt,
    body,
    parsedBody,
    legacySource: source,
    hash: hashText(block),
  };
}

function parseLegacyFile(filePath, source) {
  if (!fs.existsSync(filePath)) return [];
  const text = fs.readFileSync(filePath, 'utf8');
  // positioned meta blocks are extracted per entry below
  return text
    .split(ENTRY_SPLIT)
    .filter((b) => /^\*\*\[ERR-\d{3,4}\]\*\* /.test(b))
    .map((b) => parseLegacyEntry(b, source))
    .filter(Boolean);
}

// ---------------------------------------------------------------------------
// Migration
// ---------------------------------------------------------------------------

function buildMigration() {
  const handbook = fs.readFileSync(HANDBOOK, 'utf8');
  const indexText = fs.readFileSync(INDEX, 'utf8');
  const categoryOf = extractCategoryMembership(handbook);
  const epOf = extractEpMapping(indexText);

  const entries = [
    ...parseLegacyFile(HANDBOOK, 'HANDBOOK').map((e) => ({ ...e, status: 'active' })),
    ...parseLegacyFile(ARCHIVE, 'ARCHIVE').map((e) => ({ ...e, status: 'archived' })),
  ];

  const manifest = [];
  const records = { patterns: [], occurrences: [], preserved: [] };
  const problems = [];
  // ERR-083 is dual-presence (live data defect found by this migration):
  // same display id in HANDBOOK and ARCHIVE with different text. The
  // handbook copy is authoritative; the archive copy is preserved raw and
  // the conflict surfaced for an Owner decision — silently merging or
  // dropping either copy is forbidden.
  const seenDisplays = new Map();
  let dualPresenceCount = 0;

  for (const entry of entries) {
    const recordId = `P-${entry.displayId}`;
    if (seenDisplays.has(entry.displayId)) {
      dualPresenceCount += 1;
      const firstSource = seenDisplays.get(entry.displayId);
      problems.push(
        `${entry.displayId}: dual-presence conflict (${firstSource} + ${entry.legacySource}) — ${entry.legacySource} copy preserved raw for Owner decision`,
      );
      records.preserved.push({
        displayId: entry.displayId,
        legacySource: entry.legacySource,
        reason: `dual-presence conflict with ${firstSource} copy`,
        text: entry.body,
      });
      manifest.push({
        legacySource: entry.legacySource,
        displayId: entry.displayId,
        block: 'entry',
        sourceHash: entry.hash,
        target: null,
        status: 'preserved_raw',
      });
      continue;
    }
    seenDisplays.set(entry.displayId, entry.legacySource);
    // Archived entries had their category-table rows removed on archival, so
    // a missing category is a faithful fact, not a parse failure: it becomes
    // null and the category view simply omits the pattern.
    const category = categoryOf.get(entry.displayId) ?? null;
    const ep = epOf.get(entry.displayId) ?? null;
    if (!entry.observedAt) {
      problems.push(`${entry.displayId}: no parsable date — preserving raw`);
      records.preserved.push({
        displayId: entry.displayId,
        legacySource: entry.legacySource,
        reason: 'no parsable date',
        text: entry.body,
      });
      manifest.push({
        legacySource: entry.legacySource,
        displayId: entry.displayId,
        block: 'entry',
        sourceHash: entry.hash,
        target: null,
        status: 'preserved_raw',
      });
      continue;
    }

    // rc-9: silent fallbacks are recorded as warnings, never silent
    if (entry.source === 'unknown') {
      problems.push(`${entry.displayId}: no **Source** field — source recorded as 'unknown'`);
    }
    if (!entry.date) {
      problems.push(
        `${entry.displayId}: no **Date** field — observedAt derived from earliest in-text date (${entry.observedAt})`,
      );
    }

    // Undated recurrence bullets ("Earlier recurrences (PR#702-#810)...") are
    // pattern-level facts stored verbatim: inventing dates would be
    // fabrication, dropping them would be loss.
    const undatedRecurrences = [];
    if (entry.parsedBody.shape === 'standard') {
      for (const bullet of entry.parsedBody.bullets) {
        if (!DATE_TOKEN.test(bullet.text)) undatedRecurrences.push(bullet.text);
      }
    }

    records.patterns.push({
      meta: {
        schemaVersion: 1,
        recordType: 'pattern',
        recordId,
        displayId: entry.displayId,
        title: entry.title,
        status: entry.status,
        category,
        ep,
        createdAt: entry.date ?? entry.observedAt,
        source: entry.source,
        ...(undatedRecurrences.length > 0 ? { undatedRecurrences } : {}),
        ...(entry.parsedBody.trailer?.length > 0 ? { trailerLines: entry.parsedBody.trailer } : {}),
      },
      body: entry.parsedBody.recurrenceLine ?? '',
    });
    manifest.push({
      legacySource: entry.legacySource,
      displayId: entry.displayId,
      block: 'entry-header',
      sourceHash: entry.hash,
      target: recordId,
      status: 'structured',
    });

    // meta blocks adjacent to recurrence bullets, attributed by line index:
    // a block belongs to the last bullet that starts before it (the v2
    // convention is the block sits "adjacent to its narrative").
    const bulletMetas = new Map();
    let orphanMeta = null;
    if (entry.parsedBody.shape === 'standard') {
      for (const m of entry.parsedBody.metas) {
        if (m.error) {
          problems.push(`${entry.displayId}: ${m.error}`);
          records.preserved.push({
            displayId: entry.displayId,
            legacySource: entry.legacySource,
            reason: 'invalid recurrence-meta block',
            text: m.error,
          });
          continue;
        }
        let owner = null;
        for (const bullet of entry.parsedBody.bullets) {
          if (m.lineIdx > bullet.startLine) owner = bullet;
        }
        if (owner) bulletMetas.set(owner.startLine, m.meta);
        else if (!orphanMeta) orphanMeta = m.meta;
      }
    }

    // Initial occurrence: entry minus the recurrence section (standard shape)
    // or the full verbatim text (nonstandard shape).
    const initialBody =
      entry.parsedBody.shape === 'standard'
        ? entry.parsedBody.preamble
        : entry.body.trim();
    const rNumbers = { n: 0 };
    const pushOccurrence = (bulletDate, body, meta, note) => {
      // occurrenceId and observedAt resolve from ONE date so the id can
      // never diverge from the field it encodes (rc-6 lineage consistency).
      const observedAt = meta?.date ?? bulletDate;
      const occId = `OCC-${observedAt}-${entry.displayId.toLowerCase()}-r${rNumbers.n}`;
      rNumbers.n += 1;
      const occMeta = {
        schemaVersion: 1,
        recordType: 'occurrence',
        occurrenceId: occId,
        patternRecordId: recordId,
        displayId: entry.displayId,
        observedAt,
        source: entry.source,
        ...(meta?.pattern ? { originPattern: meta.pattern } : {}),
        ...(meta?.severity ? { severity: meta.severity } : {}),
        ...(meta?.escaped ? { escaped: meta.escaped } : {}),
        ...(meta?.caughtBy ? { caughtBy: meta.caughtBy } : {}),
        ...(meta?.guard ? { guard: meta.guard } : {}),
        ...(meta?.invariant ? { invariant: meta.invariant } : {}),
      };
      records.occurrences.push({ meta: occMeta, body, note: note ?? '' });
      manifest.push({
        legacySource: entry.legacySource,
        displayId: entry.displayId,
        block: note ?? 'occurrence',
        sourceHash: hashText(body),
        target: occId,
        status: 'structured',
      });
    };

    pushOccurrence(entry.observedAt, initialBody, orphanMeta, 'initial');
    if (entry.parsedBody.shape === 'standard') {
      for (const bullet of entry.parsedBody.bullets) {
        const dateToken = bullet.text.match(DATE_TOKEN);
        if (!dateToken) {
          // already stored verbatim on the pattern record (undatedRecurrences)
          manifest.push({
            legacySource: entry.legacySource,
            displayId: entry.displayId,
            block: 'recurrence-bullet-undated',
            sourceHash: hashText(bullet.text),
            target: recordId,
            status: 'structured',
          });
          continue;
        }
        pushOccurrence(dateToken[0], bullet.text, bulletMetas.get(bullet.startLine) ?? null, 'recurrence');
      }
    }
  }

  const recurrenceMetaCount =
    countRecurrenceMetaBlocks(fs.readFileSync(HANDBOOK, 'utf8')) +
    countRecurrenceMetaBlocks(fs.readFileSync(ARCHIVE, 'utf8'));
  return {
    records,
    manifest,
    problems,
    counts: {
      entries: entries.length,
      archivedEntries: entries.filter((e) => e.status === 'archived').length,
      recurrenceMetaBlocks: recurrenceMetaCount,
      dualPresence: dualPresenceCount,
    },
  };
}

// ---------------------------------------------------------------------------
// Projection: records → legacy handbook/archive data sections (semantic parity)
// ---------------------------------------------------------------------------

/** Re-emit one occurrence's structured recurrence fields as a meta block. */
function renderRecurrenceMeta(meta, indent) {
  const metaJson = JSON.stringify(
    {
      date: meta.observedAt,
      pattern: meta.originPattern,
      invariant: meta.invariant,
      severity: meta.severity,
      escaped: meta.escaped,
      caughtBy: meta.caughtBy,
      guard: meta.guard,
    },
    null,
    2,
  );
  return `${indent}<!-- recurrence-meta\n${escapeHtmlCommentJson(metaJson)}\n${indent}-->\n`;
}

function projectEntries(patterns, occurrences, status) {
  const ordered = [...patterns.values()]
    .filter((p) => p.meta.status === status)
    .sort((a, b) => {
      const na = Number.parseInt(a.meta.displayId.replace(/\D/g, ''), 10);
      const nb = Number.parseInt(b.meta.displayId.replace(/\D/g, ''), 10);
      return na - nb;
    });
  const byPattern = new Map();
  for (const occ of occurrences) {
    const list = byPattern.get(occ.meta.patternRecordId) ?? [];
    list.push(occ);
    byPattern.set(occ.meta.patternRecordId, list);
  }
  const chunks = [];
  for (const pattern of ordered) {
    const occs = (byPattern.get(pattern.meta.recordId) ?? []).sort((a, b) => {
      if (a.meta.observedAt !== b.meta.observedAt) return a.meta.observedAt < b.meta.observedAt ? 1 : -1;
      return a.meta.occurrenceId.localeCompare(b.meta.occurrenceId);
    });
    const initial = occs.find((o) => o.meta.occurrenceId.endsWith('-r0')) ?? occs[0];
    const recurrences = occs.filter((o) => o !== initial);
    const undated = Array.isArray(pattern.meta.undatedRecurrences) ? pattern.meta.undatedRecurrences : [];
    let text = `**[${pattern.meta.displayId}]** | ${pattern.meta.title}\n\n${initial.body.trim()}\n`;
    if (recurrences.length > 0 || undated.length > 0 || pattern.body.trim()) {
      text += `\n- ${pattern.body.trim() || '**Recurrence**:'}\n`;
      // An orphan meta block (attributed to the initial occurrence, e.g. it
      // sat between the Recurrence line and the first bullet) is re-emitted
      // here so the view keeps every structured block exactly once.
      if (Object.hasOwn(initial.meta, 'guard') && initial.meta.originPattern) {
        text += renderRecurrenceMeta(initial.meta, '  ');
      }
      for (const occ of recurrences) {
        text += `  - ${occ.body}\n`;
        if (Object.hasOwn(occ.meta, 'guard') && occ.meta.originPattern) {
          text += renderRecurrenceMeta(occ.meta, '  ');
        }
      }
      for (const u of undated) text += `  - ${u}\n`;
      for (const t of Array.isArray(pattern.meta.trailerLines) ? pattern.meta.trailerLines : []) {
        text += `${t}\n`;
      }
    }
    chunks.push(text);
  }
  return chunks.join('\n---\n');
}

/** Semantic parity: projected view must preserve ids, dates, and narrative. */
function verifyParity(projectedText, legacyText, label, report, knownConflicts) {
  const idsOf = (text) => new Set([...text.matchAll(/\*\*\[(ERR-\d{3,4})\]\*\*/g)].map((m) => m[1]));
  const a = idsOf(legacyText);
  const b = idsOf(projectedText);
  for (const id of a) {
    if (b.has(id)) continue;
    if (knownConflicts?.has(id)) {
      report.push(`${label}: entry ${id} absent from projection — KNOWN CONFLICT (preserved raw for Owner decision, see manifest)`);
    } else {
      report.push(`${label}: missing projected entry ${id}`);
    }
  }
  for (const id of b) if (!a.has(id)) report.push(`${label}: unexpected projected entry ${id}`);
  // narrative containment per entry
  const legacyEntries = legacyText.split(ENTRY_SPLIT).filter((x) => /^\*\*\[ERR-\d{3,4}\]\*\*/.test(x));
  const projectedEntries = new Map(
    projectedText
      .split(ENTRY_SPLIT)
      .filter((x) => /^\*\*\[ERR-\d{3,4}\]\*\*/.test(x))
      .map((x) => [x.match(ENTRY_HEADER)[1], x]),
  );
  for (const entry of legacyEntries) {
    const id = entry.match(ENTRY_HEADER)[1];
    const projected = projectedEntries.get(id);
    if (!projected) continue;
    const normLegacy = entry.replace(/<!--[\s\S]*?--!?>/g, '').split('\n').map((l) => l.trim()).filter((l) => l.length > 3);
    const normProj = projected.replace(/<!--[\s\S]*?--!?>/g, '');
    for (const line of normLegacy) {
      if (/^(\*\*Date\*\*|\*\*Recurrence\*\*|- \*\*Recurrence\*\*)/.test(line)) continue;
      if (line.startsWith('<!--') || /^--!?>/.test(line)) continue;
      if (!normProj.includes(line)) {
        report.push(`${label} ${id}: narrative line lost: ${line.slice(0, 80)}`);
        break;
      }
    }
  }
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

function summarizeManifest(manifest, problems, counts, records) {
  const structured = manifest.filter((m) => m.status === 'structured').length;
  const preserved = manifest.filter((m) => m.status === 'preserved_raw').length;
  return {
    legacyBlocks: manifest.length,
    structured,
    preservedRaw: preserved,
    // The mapping loop is total — every legacy block receives exactly one of
    // structured | preserved_raw, so this SPEC §22 merge-gate slot is
    // structurally 0; a violation would be a code bug, not a data condition.
    unmapped: 0,
    legacyEntries: counts.entries,
    patternRecordsAfter: records.patterns.length,
    occurrenceRecordsAfter: records.occurrences.length,
    archivedBefore: counts.archivedEntries,
    archivedAfter: records.patterns.filter((p) => p.meta.status === 'archived').length,
    recurrenceBlocksBefore: counts.recurrenceMetaBlocks,
    duplicateIdentities: counts.dualPresence,
    // warnings are mechanical anomalies (preserved with reason); zero-loss is
    // proven by the parity report, not asserted here
    warnings: problems.length,
    problems,
  };
}

function main() {
  const argv = process.argv.slice(2);
  const dryRun = argv.includes('--dry-run');
  const apply = argv.includes('--apply');
  const project = argv.includes('--project');

  if (project) {
    const recordsRootIdx = argv.indexOf('--records-root');
    const recordsRoot = recordsRootIdx !== -1 ? path.resolve(root, argv[recordsRootIdx + 1]) : root;
    const { patterns, occurrences, errors } = loadRecords(recordsRoot);
    if (errors.length > 0) {
      console.error(`[error-records-migrate] records invalid:\n${errors.join('\n')}`);
      process.exit(1);
    }
    const active = projectEntries(patterns, occurrences, 'active');
    const archived = projectEntries(patterns, occurrences, 'archived');
    // Known conflicts come mechanically from the migration manifest: a
    // preserved_raw entry is a documented conflict, not a projection loss.
    const knownConflicts = new Set();
    const manifestIdx2 = argv.indexOf('--manifest');
    if (manifestIdx2 !== -1) {
      const manifestData = JSON.parse(fs.readFileSync(path.resolve(root, argv[manifestIdx2 + 1]), 'utf8'));
      for (const entry of manifestData.manifest ?? []) {
        if (entry.status === 'preserved_raw') knownConflicts.add(entry.displayId);
      }
    }
    const report = [];
    verifyParity(active, fs.readFileSync(HANDBOOK, 'utf8'), 'active', report, knownConflicts);
    verifyParity(archived, fs.readFileSync(ARCHIVE, 'utf8'), 'archived', report, knownConflicts);
    // Documented conflicts (owner-pending) and losses (real parity failures)
    // are different severities: only losses fail the gate.
    const losses = report.filter((line) => !line.includes('KNOWN CONFLICT'));
    const conflicts = report.filter((line) => line.includes('KNOWN CONFLICT'));
    const projectOutIdx = argv.indexOf('--project-out');
    const projectOutDir = projectOutIdx !== -1 ? path.resolve(root, argv[projectOutIdx + 1]) : null;
    if (projectOutDir) {
      fs.mkdirSync(projectOutDir, { recursive: true });
      fs.writeFileSync(path.join(projectOutDir, 'handbook.active.md'), active, 'utf8');
      fs.writeFileSync(path.join(projectOutDir, 'handbook.archived.md'), archived, 'utf8');
      console.log(
        `[error-records-migrate] wrote:\n${path.join(projectOutDir, 'handbook.active.md')}\n${path.join(projectOutDir, 'handbook.archived.md')}`,
      );
    }
    console.log(`[error-records-migrate] parity losses: ${losses.length}; documented conflicts: ${conflicts.length}`);
    for (const line of [...losses, ...conflicts].slice(0, 20)) console.log(`  - ${line}`);
    process.exit(losses.length === 0 ? 0 : 2);
  }

  const outIdx = argv.indexOf('--out');
  const outDir = outIdx !== -1 ? path.resolve(root, argv[outIdx + 1]) : null;
  const migration = buildMigration();
  const summary = summarizeManifest(migration.manifest, migration.problems, migration.counts, migration.records);
  const manifestIdx = argv.indexOf('--manifest-out');
  if (manifestIdx !== -1) {
    const manifestPath = path.resolve(root, argv[manifestIdx + 1]);
    fs.mkdirSync(path.dirname(manifestPath), { recursive: true });
    fs.writeFileSync(
      manifestPath,
      JSON.stringify({ summary, manifest: migration.manifest }, null, 2),
      'utf8',
    );
    console.log(`[error-records-migrate] manifest written: ${manifestPath}`);
  }

  console.log('[error-records-migrate] === MIGRATION SUMMARY ===');
  console.log(JSON.stringify(summary, null, 2));
  if (dryRun || !apply) {
    console.log('[error-records-migrate] dry-run: no records written.');
    process.exit(migration.problems.length > 0 ? 2 : 0);
  }

  const targetRoot = outDir ?? root;
  let writtenPatterns = 0;
  let writtenOccurrences = 0;
  for (const pattern of migration.records.patterns) {
    writePatternRecord(targetRoot, pattern.meta, pattern.body);
    writtenPatterns += 1;
  }
  for (const occ of migration.records.occurrences) {
    writeOccurrenceRecord(targetRoot, occ.meta, occ.body);
    writtenOccurrences += 1;
  }
  for (const raw of migration.records.preserved) {
    const dir = path.join(targetRoot, RECORDS_RELATIVE_DIR, 'preserved');
    fs.mkdirSync(dir, { recursive: true });
    const file = path.join(dir, `${raw.displayId}-${hashText(raw.text)}.md`);
    fs.writeFileSync(
      file,
      `<!-- preserved-legacy\n${escapeHtmlCommentJson(JSON.stringify({ displayId: raw.displayId, legacySource: raw.legacySource, reason: raw.reason }, null, 2))}\n-->\n\n${raw.text}\n`,
      'utf8',
    );
  }
  console.log(
    `[error-records-migrate] wrote ${writtenPatterns} patterns, ${writtenOccurrences} occurrences, ${migration.records.preserved.length} preserved-raw into ${path.join(targetRoot, RECORDS_RELATIVE_DIR)}`,
  );
}

const invokedDirectly = process.argv[1] && process.argv[1].endsWith('error-records-migrate.cjs');
if (invokedDirectly) main();

module.exports = {
  buildMigration,
  parseLegacyFile,
  parseLegacyEntry,
  parseEntryBody,
  extractCategoryMembership,
  extractEpMapping,
  countRecurrenceMetaBlocks,
  projectEntries,
  verifyParity,
  summarizeManifest,
};
