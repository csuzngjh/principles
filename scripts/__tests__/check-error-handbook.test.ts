/**
 * check:error-handbook gate tests — PRI-799 Phase C authority cutover.
 *
 * The gate's authoritative object is the structured records tree plus the
 * routing SSoT (ERROR_PATTERN_INDEX.md). These tests pin the new contract:
 * record-tree integrity, INDEX↔records display-id integrity, routing
 * reference integrity — and, as a regression guard, the ABSENCE of the old
 * zero-sum byte gates (handbook size ceiling / recurrence truncation): a
 * pattern record may grow without any size finding, and the frozen legacy
 * handbook is never read.
 */

import { describe, expect, it } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { writePatternRecord, writeOccurrenceRecord } from '../error-records.cjs';
import { collectFindings } from '../check-error-handbook.cjs';

const { serializeRecord } = require('../error-records.cjs') as typeof import('../error-records.cjs');

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

function indexMarkdown(representativeErrs = 'ERR-068.'): string {
  return [
    '# Error Pattern Index',
    '',
    '## Pattern Cards',
    '',
    '### EP-06 Dependency & Lockfile Integrity',
    '',
    `- **Representative ERRs**: ${representativeErrs}`,
    '',
    '<!-- error-pattern-routing',
    '{',
    '  "id": "EP-06",',
    '  "risk": "high",',
    '  "pathSignals": ["package-lock.json", "pnpm-lock.yaml"],',
    '  "diffSignals": ["dependency bump without lockfile"],',
    '  "requiredEvidence": ["lockfile diff reviewed"],',
    '  "enforcement": "blocking"',
    '}',
    '-->',
  ].join('\n');
}

function setupRepo(indexErrs = 'ERR-068.'): string {
  const root = mkdtempSync(path.join(os.tmpdir(), 'pri799-gate-'));
  mkdirSync(path.join(root, 'docs', 'process', 'error-management'), { recursive: true });
  writeFileSync(path.join(root, 'docs', 'process', 'error-management', 'ERROR_PATTERN_INDEX.md'), indexMarkdown(indexErrs));
  writePatternRecord(root, patternMeta, '**Recurrence**: Yes');
  writeOccurrenceRecord(root, occurrenceMeta, 'dependabot missed release-locks.');
  // frozen legacy snapshot: present but never read by the gate
  writeFileSync(
    path.join(root, 'docs', 'process', 'error-management', 'ERROR_EXPERIENCE_HANDBOOK.md'),
    '# Error Experience Handbook\n\nfrozen legacy snapshot\n',
  );
  return root;
}

describe('check:error-handbook — records authority gate', () => {
  it('passes a valid records tree and never reads the frozen handbook', () => {
    const root = setupRepo();
    try {
      const findings = collectFindings(root, { now: new Date('2026-09-17T00:00:00Z') });
      expect(findings.errors).toEqual([]);
      expect(findings.stats.patterns).toBe(1);
      expect(findings.stats.activeCount).toBe(1);
      expect(findings.stats.occurrences).toBe(1);
      expect(findings.stats.structuredCount).toBe(1);
      expect(findings.stats.routingCards).toBe(1);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('fails on an INDEX reference without a pattern record (dangling display id)', () => {
    const root = setupRepo('ERR-068, ERR-999.');
    try {
      const findings = collectFindings(root);
      expect(findings.errors.some((e) => e.includes('ERR-999') && e.includes('no pattern record'))).toBe(true);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('fails when an active pattern record is not mapped in the INDEX', () => {
    const root = setupRepo('');
    try {
      const findings = collectFindings(root);
      expect(findings.errors.some((e) => e.includes('ERR-068') && e.includes('not mapped in ERROR_PATTERN_INDEX.md'))).toBe(true);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('fails when a record references an unknown routing pattern', () => {
    const root = setupRepo();
    try {
      const patternFile = path.join(root, 'docs', 'process', 'error-management', 'records', 'patterns', 'P-ERR-068.md');
      writeFileSync(patternFile, serializeRecord({ ...patternMeta, ep: 'EP-99' }, '**Recurrence**: Yes'));
      const findings = collectFindings(root);
      expect(findings.errors.some((e) => e.includes('ERR-068') && e.includes('unknown routing pattern EP-99'))).toBe(true);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('has NO size gate: a 320KB pattern body produces no size finding (300KB ceiling removed)', () => {
    // 320KB narrative body — far beyond the old handbook ceiling. The gate
    // must stay silent about size; recording a lesson never requires
    // freeing bytes anywhere else.
    const hugeBody = 'x'.repeat(320 * 1024);
    const root = setupRepo('ERR-068, ERR-069.');
    try {
      writePatternRecord(root, { ...patternMeta, recordId: 'P-ERR-069', displayId: 'ERR-069' }, hugeBody);
      const findings = collectFindings(root);
      expect(findings.errors).toEqual([]);
      expect(findings.warnings).toEqual([]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('requires structured recurrence fields on runtime-recorded occurrences', () => {
    const root = setupRepo();
    try {
      writeOccurrenceRecord(
        root,
        {
          schemaVersion: 1,
          recordType: 'occurrence',
          occurrenceId: 'OCC-20260917T120000Z-abc234',
          patternRecordId: 'P-ERR-068',
          displayId: 'ERR-068',
          observedAt: '2026-09-17',
          source: 'PR #1700',
        },
        'recurrence without structured facts',
      );
      const findings = collectFindings(root);
      expect(
        findings.errors.some(
          (e) => e.includes('OCC-20260917T120000Z-abc234') && e.includes('missing structured recurrence fields'),
        ),
      ).toBe(true);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('accepts a runtime-recorded occurrence that carries all structured fields', () => {
    const root = setupRepo();
    try {
      writeOccurrenceRecord(
        root,
        {
          schemaVersion: 1,
          recordType: 'occurrence',
          occurrenceId: 'OCC-20260917T120000Z-abc234',
          patternRecordId: 'P-ERR-068',
          displayId: 'ERR-068',
          observedAt: '2026-09-17',
          source: 'PR #1700',
          originPattern: 'EP-06',
          invariant: 'auxiliary-release-lockfile-not-updated',
          severity: 'P1',
          escaped: 'none',
          caughtBy: 'pr-review',
          guard: 'check:release-locks',
        },
        'recurrence with structured facts',
      );
      const findings = collectFindings(root);
      expect(findings.errors).toEqual([]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
