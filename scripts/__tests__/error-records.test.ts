/**
 * error-records tests — PRI-799 Phase B tooling.
 *
 * Covers the record contract end to end on fixtures: serialization
 * round-trips (including `-->` escaping inside the HTML-comment block),
 * validator rejections, referential integrity, writer semantics (atomic
 * write, duplicate refusal, archive lifecycle flip), id collision
 * resistance, legacy entry parsing (bullets / recurrence-meta attribution /
 * trailer capture), and projection parity on a fixture.
 */

import { describe, expect, it } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  MARKER,
  serializeRecord,
  parseRecordFile,
  validatePatternMeta,
  validateOccurrenceMeta,
  loadRecords,
  writePatternRecord,
  writeOccurrenceRecord,
  archivePattern,
  aggregatePatternStats,
  generatePatternRecordId,
  generateOccurrenceId,
  isValidObservedAt,
} from '../error-records.cjs';
import {
  parseEntryBody,
  parseLegacyEntry,
  projectEntries,
  verifyParity,
} from '../error-records-migrate.cjs';

function tmpRoot(): string {
  return mkdtempSync(path.join(os.tmpdir(), 'pri799-records-'));
}

const patternMeta = {
  schemaVersion: 1,
  recordType: 'pattern',
  recordId: 'P-ERR-068',
  displayId: 'ERR-068',
  title: 'Lockfile drift ships green',
  status: 'active',
  category: 'Process & Workflow',
  ep: 'EP-06',
  createdAt: '2026-06-16',
  source: 'PRI-518',
};

const occurrenceMeta = {
  schemaVersion: 1,
  recordType: 'occurrence',
  occurrenceId: 'OCC-2026-09-14-err-068-r1',
  patternRecordId: 'P-ERR-068',
  displayId: 'ERR-068',
  observedAt: '2026-09-14',
  source: 'PR #1689',
  severity: 'P1',
  escaped: 'none',
  caughtBy: 'pr-review',
  guard: 'check:release-locks',
  invariant: 'auxiliary-release-lockfile-not-updated',
};

describe('record serialization', () => {
  it('round-trips meta and body through the marker block', () => {
    const text = serializeRecord(patternMeta, 'narrative body\nsecond line');
    const parsed = parseRecordFile(text);
    expect(parsed.error).toBeUndefined();
    expect(parsed.meta).toEqual(patternMeta);
    expect(parsed.body.trim()).toBe('narrative body\nsecond line');
  });

  it('escapes `-->` inside values so the comment block stays intact', () => {
    const meta = { ...occurrenceMeta, guard: 'run x --> y --> z' };
    const text = serializeRecord(meta, 'body');
    expect(text.includes('-->\n\nbody')).toBe(true);
    const parsed = parseRecordFile(text);
    expect(parsed.error).toBeUndefined();
    expect(parsed.meta.guard).toBe('run x --> y --> z');
  });

  it('rejects files without a marker block', () => {
    expect(parseRecordFile('just prose').error).toBeDefined();
    expect(parseRecordFile('<!-- other-marker\n{}\n-->').error).toBeDefined();
  });
});

describe('validators', () => {
  it('accepts valid pattern and occurrence metadata', () => {
    expect(validatePatternMeta(patternMeta, 'p').error).toBeUndefined();
    expect(validateOccurrenceMeta(occurrenceMeta, 'o').error).toBeUndefined();
  });

  it('accepts month-precision observedAt', () => {
    expect(isValidObservedAt('2026-06')).toBe(true);
    expect(isValidObservedAt('2026-06-15')).toBe(true);
    expect(isValidObservedAt('2026-13-01')).toBe(false);
    expect(isValidObservedAt('2026-02-30')).toBe(false);
    expect(validateOccurrenceMeta({ ...occurrenceMeta, observedAt: '2026-06' }, 'o').error).toBeUndefined();
  });

  it('rejects invalid severity, category, and ids', () => {
    expect(validateOccurrenceMeta({ ...occurrenceMeta, severity: 'P9' }, 'o').error).toContain('severity');
    expect(
      validatePatternMeta({ ...patternMeta, category: 'Made Up Category' }, 'p').error,
    ).toContain('category');
    expect(validatePatternMeta({ ...patternMeta, recordId: 'P-001' }, 'p').error).toContain('recordId');
    expect(validateOccurrenceMeta({ ...occurrenceMeta, occurrenceId: 'OCC-001' }, 'o').error).toContain(
      'occurrenceId',
    );
  });

  it('rejects partial structured recurrence fields', () => {
    const partial = { ...occurrenceMeta };
    delete (partial as Record<string, unknown>).severity;
    expect(validateOccurrenceMeta(partial, 'o').error).toContain('must be present together');
  });
});

describe('records tree loading and referential integrity', () => {
  it('fails loud on unknown pattern references and duplicate ids', () => {
    const root = tmpRoot();
    try {
      writePatternRecord(root, patternMeta, 'body');
      writeOccurrenceRecord(root, occurrenceMeta, 'narrative');
      const happy = loadRecords(root);
      expect(happy.errors).toEqual([]);
      expect(happy.patterns.size).toBe(1);
      expect(happy.occurrences.length).toBe(1);

      const strayDir = path.join(root, 'docs', 'process', 'error-management', 'records', 'occurrences', 'P-ERR-999');
      mkdirSync(strayDir, { recursive: true });
      writeFileSync(
        path.join(strayDir, 'OCC-2026-09-15-err-999-r0.md'),
        serializeRecord({ ...occurrenceMeta, occurrenceId: 'OCC-2026-09-15-err-999-r0', patternRecordId: 'P-ERR-999' }, 'x'),
      );
      const orphaned = loadRecords(root);
      expect(orphaned.errors.join('\n')).toContain('unknown pattern P-ERR-999');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('fails loud on duplicate pattern display ids and lineage mismatches (rc-6)', () => {
    const root = tmpRoot();
    try {
      writePatternRecord(root, patternMeta, 'body');
      writePatternRecord(
        root,
        { ...patternMeta, recordId: 'P-20260916T000000Z-aaaaaa', displayId: 'ERR-068' },
        'other body',
      );
      writeOccurrenceRecord(root, occurrenceMeta, 'narrative');
      const loaded = loadRecords(root);
      expect(loaded.errors.join('\n')).toContain('duplicate pattern display id: ERR-068');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }

    const root2 = tmpRoot();
    try {
      writePatternRecord(root2, patternMeta, 'body');
      writeOccurrenceRecord(root2, { ...occurrenceMeta, displayId: 'ERR-999' }, 'narrative');
      const loaded = loadRecords(root2);
      expect(loaded.errors.join('\n')).toContain('does not match pattern P-ERR-068 displayId ERR-068');
    } finally {
      rmSync(root2, { recursive: true, force: true });
    }
  });

  it('refuses duplicate occurrence ids on write', () => {
    const root = tmpRoot();
    try {
      writePatternRecord(root, patternMeta, 'body');
      writeOccurrenceRecord(root, occurrenceMeta, 'narrative');
      expect(() => writeOccurrenceRecord(root, occurrenceMeta, 'narrative')).toThrow(/already exists/);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('archive is a lifecycle flip: status changes, body and occurrences untouched', () => {
    const root = tmpRoot();
    try {
      writePatternRecord(root, patternMeta, '**Recurrence**: Yes — note');
      writeOccurrenceRecord(root, occurrenceMeta, 'narrative');
      archivePattern(root, 'P-ERR-068');
      const after = readFileSync(path.join(root, 'docs', 'process', 'error-management', 'records', 'patterns', 'P-ERR-068.md'), 'utf8');
      expect(JSON.parse(after.match(new RegExp(`${MARKER}\\n([\\s\\S]*?)\\n-->`))![1]).status).toBe('archived');
      expect(after.includes('**Recurrence**: Yes — note')).toBe(true);
      expect(existsSync(path.join(root, 'docs', 'process', 'error-management', 'records', 'occurrences', 'P-ERR-068', 'OCC-2026-09-14-err-068-r1.md'))).toBe(true);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('refuses to overwrite an existing pattern record', () => {
    const root = tmpRoot();
    try {
      writePatternRecord(root, patternMeta, 'body');
      expect(() => writePatternRecord(root, { ...patternMeta, status: 'archived' }, 'body')).toThrow(
        /refusing to overwrite/,
      );
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe('aggregation and id generation', () => {
  it('derives per-pattern recurrence stats from occurrences', () => {
    const patterns = new Map([[patternMeta.recordId, { meta: patternMeta, body: '', file: 'x' }]]);
    const now = new Date('2026-09-16T00:00:00Z');
    const stats = aggregatePatternStats(
      patterns,
      [
        { meta: occurrenceMeta, body: '', file: 'a' },
        { meta: { ...occurrenceMeta, occurrenceId: 'OCC-2026-09-15-err-068-r2', observedAt: '2026-09-15' }, body: '', file: 'b' },
        { meta: { ...occurrenceMeta, occurrenceId: 'OCC-2026-01-01-err-068-r3', observedAt: '2026-01-01' }, body: '', file: 'c' },
      ],
      now,
    );
    const s = stats.get('P-ERR-068')!;
    expect(s.occurrenceCount).toBe(3);
    expect(s.recentCount).toBe(2);
    expect(s.lastSeen).toBe('2026-09-15');
  });

  it('generates collision-resistant ids (2000 samples, no repeats)', () => {
    const pids = new Set<string>();
    const oids = new Set<string>();
    for (let i = 0; i < 2000; i += 1) {
      pids.add(generatePatternRecordId());
      oids.add(generateOccurrenceId());
    }
    expect(pids.size).toBe(2000);
    expect(oids.size).toBe(2000);
  });
});

describe('concurrency acceptance (SPEC §24, real git merge shape)', () => {
  const { execFileSync } = require('node:child_process') as typeof import('node:child_process');

  function git(cwd: string, ...args: string[]): void {
    execFileSync('git', ['-c', 'user.email=test@local', '-c', 'user.name=test', ...args], { cwd });
  }

  function commitRecord(root: string, file: string, content: string): void {
    mkdirSync(path.dirname(file), { recursive: true });
    writeFileSync(file, content);
    git(root, 'add', '.');
    git(root, 'commit', '-m', `add ${path.basename(file)}`);
  }

  function initRepo(): string {
    const root = mkdtempSync(path.join(os.tmpdir(), 'pri799-concurrency-'));
    git(root, 'init', '-b', 'main');
    commitRecord(
      root,
      path.join(root, 'docs/process/error-management/records/patterns/P-ERR-068.md'),
      serializeRecord(patternMeta, 'body'),
    );
    return root;
  }

  function occurrenceText(id: string): string {
    return serializeRecord({ ...occurrenceMeta, occurrenceId: id }, `narrative for ${id}`);
  }

  it('Test A — two occurrences of DIFFERENT existing patterns from two branches merge clean', () => {
    const root = initRepo();
    try {
      const base = path.join(root, 'docs/process/error-management/records/patterns');
      commitRecord(
        root,
        path.join(base, 'P-ERR-130.md'),
        serializeRecord({ ...patternMeta, recordId: 'P-ERR-130', displayId: 'ERR-130' }, 'other pattern'),
      );
      const occBase = path.join(root, 'docs/process/error-management/records/occurrences');
      git(root, 'checkout', '-b', 'agent-a');
      commitRecord(root, path.join(occBase, 'P-ERR-068', 'OCC-2026-09-15-err-068-r90.md'), occurrenceText('OCC-2026-09-15-err-068-r90'));
      git(root, 'checkout', 'main');
      git(root, 'checkout', '-b', 'agent-b');
      commitRecord(root, path.join(occBase, 'P-ERR-130', 'OCC-2026-09-15-err-130-r90.md'), occurrenceText('OCC-2026-09-15-err-130-r90').replace('P-ERR-068', 'P-ERR-130').replace('ERR-068', 'ERR-130'));
      git(root, 'merge', 'agent-a', '--no-edit'); // must not throw
      const loaded = loadRecords(root);
      expect(loaded.errors).toEqual([]);
      expect(loaded.occurrences.length).toBe(2);
      expect(loaded.patterns.size).toBe(2);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('Test B — two occurrences of the SAME pattern from two branches merge clean', () => {
    const root = initRepo();
    try {
      const occDir = path.join(root, 'docs/process/error-management/records/occurrences/P-ERR-068');
      git(root, 'checkout', '-b', 'agent-a');
      commitRecord(root, path.join(occDir, 'OCC-2026-09-15-err-068-r90.md'), occurrenceText('OCC-2026-09-15-err-068-r90'));
      git(root, 'checkout', 'main');
      git(root, 'checkout', '-b', 'agent-b');
      commitRecord(root, path.join(occDir, 'OCC-2026-09-15-err-068-r91.md'), occurrenceText('OCC-2026-09-15-err-068-r91'));
      git(root, 'merge', 'agent-a', '--no-edit'); // must not throw
      expect(existsSync(path.join(occDir, 'OCC-2026-09-15-err-068-r90.md'))).toBe(true);
      expect(existsSync(path.join(occDir, 'OCC-2026-09-15-err-068-r91.md'))).toBe(true);
      const loaded = loadRecords(root);
      expect(loaded.errors).toEqual([]);
      expect(loaded.occurrences.length).toBe(2);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('Test C — two NEW patterns from two branches merge clean (no add/add collision)', () => {
    const root = initRepo();
    try {
      const patternsDir = path.join(root, 'docs/process/error-management/records/patterns');
      git(root, 'checkout', '-b', 'agent-a');
      commitRecord(
        root,
        path.join(patternsDir, 'P-20260916T120000Z-aaaaaa.md'),
        serializeRecord({ ...patternMeta, recordId: 'P-20260916T120000Z-aaaaaa', displayId: 'ERR-132' }, 'a'),
      );
      git(root, 'checkout', 'main');
      git(root, 'checkout', '-b', 'agent-b');
      commitRecord(
        root,
        path.join(patternsDir, 'P-20260916T120000Z-bbbbbb.md'),
        serializeRecord({ ...patternMeta, recordId: 'P-20260916T120000Z-bbbbbb', displayId: 'ERR-133' }, 'b'),
      );
      git(root, 'merge', 'agent-a', '--no-edit'); // must not throw
      const loaded = loadRecords(root);
      expect(loaded.errors).toEqual([]);
      expect(loaded.patterns.size).toBe(3);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe('legacy parsing and projection parity (fixture)', () => {
  const legacyEntry = [
    '**[ERR-068]** | Used the wrong package manager leaving lockfile drift',
    '',
    '- **What happened**: pnpm install updated pnpm-lock.yaml only.',
    '- **Date**: 2026-06-16',
    '- **Source**: PRI-518',
    '- **Recurrence**: Yes — lockfile the consuming npm ci reads was not updated.',
    '  - 2026-09-14 PR #1689: dependabot missed release-locks.',
    '  <!-- recurrence-meta',
    '  {',
    '    "date": "2026-09-14",',
    '    "pattern": "EP-06",',
    '    "invariant": "auxiliary-release-lockfile-not-updated",',
    '    "severity": "P1",',
    '    "escaped": "none",',
    '    "caughtBy": "pr-review",',
    '    "guard": "check:release-locks"',
    '  }',
    '  -->',
    '  - Earlier recurrences (PR#702-#810): see git history.',
    '- **Archived**: 2026-08-25 (no recurrence in > 90 days)',
    '[ERR-068]: docs/process/error-management/ERROR_EXPERIENCE_HANDBOOK.md#ERR-068',
  ].join('\n');

  it('parses fields, bullets, meta attribution, and trailer verbatim', () => {
    const entry = parseLegacyEntry(legacyEntry, 'HANDBOOK')!;
    expect(entry.displayId).toBe('ERR-068');
    expect(entry.title).toBe('Used the wrong package manager leaving lockfile drift');
    expect(entry.parsedBody.shape).toBe('standard');
    expect(entry.parsedBody.bullets.length).toBe(2);
    expect(entry.parsedBody.bullets[0].text.startsWith('2026-09-14 PR #1689')).toBe(true);
    // the meta block must NOT be swallowed into the bullet's narrative text —
    // that duplicated it into the occurrence body AND the projection
    expect(entry.parsedBody.bullets[0].text.includes('recurrence-meta')).toBe(false);
    expect(entry.parsedBody.bullets[0].text.includes('-->')).toBe(false);
    expect(entry.parsedBody.metas.length).toBe(1);
    expect(entry.parsedBody.metas[0].meta.guard).toBe('check:release-locks');
    expect(entry.parsedBody.trailer).toEqual([
      '- **Archived**: 2026-08-25 (no recurrence in > 90 days)',
      '[ERR-068]: docs/process/error-management/ERROR_EXPERIENCE_HANDBOOK.md#ERR-068',
    ]);
  });

  it('projects the record back with narrative containment (zero line loss)', () => {
    const entry = parseLegacyEntry(legacyEntry, 'HANDBOOK')!;
    const patterns = new Map([
      [
        'P-ERR-068',
        {
          meta: {
            schemaVersion: 1,
            recordType: 'pattern',
            recordId: 'P-ERR-068',
            displayId: 'ERR-068',
            title: entry.title,
            status: 'active',
            category: 'Process & Workflow',
            ep: 'EP-06',
            createdAt: '2026-06-16',
            source: 'PRI-518',
            undatedRecurrences: ['Earlier recurrences (PR#702-#810): see git history.'],
            trailerLines: entry.parsedBody.trailer,
          },
          body: entry.parsedBody.recurrenceLine,
          file: 'x',
        },
      ],
    ]);
    const occurrences = [
      {
        meta: {
          schemaVersion: 1,
          recordType: 'occurrence',
          occurrenceId: 'OCC-2026-06-16-err-068-r0',
          patternRecordId: 'P-ERR-068',
          displayId: 'ERR-068',
          observedAt: '2026-06-16',
          source: 'PRI-518',
        },
        body: [
          '- **What happened**: pnpm install updated pnpm-lock.yaml only.',
          '- **Date**: 2026-06-16',
          '- **Source**: PRI-518',
        ].join('\n'),
        file: 'a',
      },
      {
        meta: {
          schemaVersion: 1,
          recordType: 'occurrence',
          occurrenceId: 'OCC-2026-09-14-err-068-r1',
          patternRecordId: 'P-ERR-068',
          displayId: 'ERR-068',
          observedAt: '2026-09-14',
          source: 'PR #1689',
          severity: 'P1',
          escaped: 'none',
          caughtBy: 'pr-review',
          guard: 'check:release-locks',
          invariant: 'auxiliary-release-lockfile-not-updated',
          originPattern: 'EP-06',
        },
        body: '2026-09-14 PR #1689: dependabot missed release-locks.',
        file: 'b',
      },
    ];
    const projected = projectEntries(patterns, occurrences, 'active');
    const report: string[] = [];
    verifyParity(projected, legacyEntry, 'fixture', report, new Set());
    expect(report).toEqual([]);
    // the recurrence-meta block appears exactly ONCE (re-emitted from
    // structured fields), never twice via an embedded copy
    expect(projected.split('recurrence-meta').length - 1).toBe(1);
    expect(projected).toContain('- **Recurrence**: Yes — lockfile the consuming npm ci reads was not updated.');
    expect(projected).toContain('  - 2026-09-14 PR #1689: dependabot missed release-locks.');
    expect(projected).toContain('  - Earlier recurrences (PR#702-#810): see git history.');
    expect(projected).toContain('  <!-- recurrence-meta');
    expect(projected).toContain('- **Archived**: 2026-08-25 (no recurrence in > 90 days)');
  });
});
