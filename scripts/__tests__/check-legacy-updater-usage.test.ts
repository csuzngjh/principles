/**
 * Tests for scripts/check-legacy-updater-usage.mjs (PRI-701).
 *
 * These exercise the census through its real public boundary: the exported
 * `run()` entry point reading actual journal files on disk — the same call
 * shape the CNB weekly audit pipeline makes. Helper-level unit tests are
 * included only where they prove a rule the boundary test cannot isolate.
 *
 * Fixture shapes are copied from the REAL writer, not invented:
 * `legacy-mutation-journal.ts` (`detail: 'actor=console-updater kind=…'`) and
 * `installer.ts` (`detail: 'actor=installer kind=…'`).
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  assessDrain,
  computeCensus,
  defaultTransactionsDir,
  parseArgs,
  parseDetailTokens,
  readTransactionFile,
  run,
} from '../check-legacy-updater-usage.mjs';

const NOW = new Date('2026-09-12T12:00:00.000Z');

let root: string;
let transactionsDir: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'pd-701-'));
  transactionsDir = join(root, 'transactions');
  mkdirSync(transactionsDir, { recursive: true });
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

/** One full transition chain in the exact shape the writers persist. */
function writeTransaction(
  fileName: string,
  actor: string,
  kind: string,
  transition: { from: string | null; to: string; at: string },
  extraLines: unknown[] = [],
): void {
  const record = {
    at: transition.at,
    from: transition.from,
    to: transition.to,
    transactionId: fileName.replace(/\.jsonl$/u, ''),
    releaseId: `${actor}-${kind}-release`,
    productVersion: '1.231.0',
    releaseMetadataDigest: 'deadbeef',
    releaseMetadataDigestSource: 'fallback',
    generation: 1,
    detail: `actor=${actor} kind=${kind}`,
  };
  const lines = [JSON.stringify(record), ...extraLines.map((line) => JSON.stringify(line))];
  writeFileSync(join(transactionsDir, fileName), `${lines.join('\n')}\n`, 'utf8');
}

/** A legacy mutation that reached a terminal state — the census's target. */
function writeLegacyAttempt(fileName: string, kind: string, to: 'confirmed' | 'failed' = 'confirmed'): void {
  writeTransaction(fileName, 'console-updater', kind, { from: null, to: 'planned', at: '2026-09-10T02:00:00.000Z' }, [
    {
      at: '2026-09-10T02:03:00.000Z',
      from: 'planned',
      to,
      transactionId: fileName.replace(/\.jsonl$/u, ''),
      releaseId: `console-${kind}-release`,
      productVersion: '1.231.0',
      releaseMetadataDigest: 'deadbeef',
      releaseMetadataDigestSource: 'fallback',
      generation: 1,
      detail: `actor=console-updater kind=${kind} ${kind}: done`,
    },
  ]);
}

describe('census counts legacy updater usage from the real journal', () => {
  it('counts a legacy apply-full attempt that reached a terminal state', () => {
    writeLegacyAttempt('console-apply-full-1757680000000-abc.jsonl', 'apply-full');
    const report = computeCensus(transactionsDir, { now: NOW });
    expect(report.legacy.attemptCount).toBe(1);
    expect(report.legacy.byKind).toEqual({ 'apply-full': 1 });
    expect(report.legacy.lastAttemptAt).toBe('2026-09-10T02:03:00.000Z');
    expect(report.filesScanned).toBe(1);
  });

  it('counts a failed legacy rollback attempt too — an attempt is usage', () => {
    writeLegacyAttempt('console-rollback-1757680000100-abc.jsonl', 'rollback', 'failed');
    const report = computeCensus(transactionsDir, { now: NOW });
    expect(report.legacy.attemptCount).toBe(1);
    expect(report.legacy.byKind).toEqual({ rollback: 1 });
  });

  it('aggregates across kinds and reports the latest attempt', () => {
    writeLegacyAttempt('console-apply-full-1757680000000-a.jsonl', 'apply-full');
    writeLegacyAttempt('console-rollback-1757680000100-b.jsonl', 'rollback');
    const report = computeCensus(transactionsDir, { now: NOW });
    expect(report.legacy.attemptCount).toBe(2);
    expect(report.legacy.byKind).toEqual({ 'apply-full': 1, rollback: 1 });
  });

  it('does not count a legacy transaction that is still unfinished', () => {
    // `planned` only: the mutation never reached a terminal state. Counting it
    // would be a guess; the census reports it separately instead.
    writeTransaction('console-apply-1757680000200-c.jsonl', 'console-updater', 'apply', {
      from: null,
      to: 'planned',
      at: '2026-09-10T05:00:00.000Z',
    });
    const report = computeCensus(transactionsDir, { now: NOW });
    expect(report.legacy.attemptCount).toBe(0);
    expect(report.unfinished).toBe(1);
  });

  it('does not count a refused legacy transaction as usage — no mutation ran', () => {
    writeTransaction('console-apply-1757680000300-d.jsonl', 'console-updater', 'apply', {
      from: null,
      to: 'planned',
      at: '2026-09-10T05:00:00.000Z',
    }, [
      {
        at: '2026-09-10T05:00:01.000Z',
        from: 'planned',
        to: 'refused',
        transactionId: 'console-apply-1757680000300-d',
        releaseId: 'r',
        productVersion: '1.231.0',
        releaseMetadataDigest: 'x',
        releaseMetadataDigestSource: 'fallback',
        generation: 1,
        detail: 'actor=console-updater kind=apply refused',
      },
    ]);
    const report = computeCensus(transactionsDir, { now: NOW });
    expect(report.legacy.attemptCount).toBe(0);
    expect(report.refused).toBe(1);
  });
});

describe('non-legacy paths are never miscounted as legacy usage', () => {
  it('does not count installer / ReleaseManager transactions', () => {
    writeTransaction('install-1757680500000-def.jsonl', 'installer', 'update', {
      from: null,
      to: 'planned',
      at: '2026-09-11T02:00:00.000Z',
    }, [
      {
        at: '2026-09-11T02:04:00.000Z',
        from: 'planned',
        to: 'confirmed',
        transactionId: 'install-1757680500000-def',
        releaseId: 'bundled-1.231.0-abcdef',
        productVersion: '1.231.0',
        releaseMetadataDigest: 'bbbb',
        releaseMetadataDigestSource: 'manifest',
        generation: 2,
        detail: 'actor=installer kind=update installer: deployed',
      },
    ]);
    const report = computeCensus(transactionsDir, { now: NOW });
    expect(report.legacy.attemptCount).toBe(0);
    expect(report.installer.attemptCount).toBe(1);
    expect(report.installer.byKind).toEqual({ update: 1 });
  });

  it('reports an unrecognised actor separately instead of as legacy usage', () => {
    writeTransaction('mystery-1757680600000-xyz.jsonl', 'third-party-tool', 'apply', {
      from: null,
      to: 'planned',
      at: '2026-09-11T03:00:00.000Z',
    }, [
      {
        at: '2026-09-11T03:01:00.000Z',
        from: 'planned',
        to: 'confirmed',
        transactionId: 'mystery-1757680600000-xyz',
        releaseId: 'r',
        productVersion: '1.231.0',
        releaseMetadataDigest: 'x',
        releaseMetadataDigestSource: 'fallback',
        generation: 1,
        detail: 'actor=third-party-tool kind=apply',
      },
    ]);
    const report = computeCensus(transactionsDir, { now: NOW });
    expect(report.legacy.attemptCount).toBe(0);
    expect(report.otherActors.attemptCount).toBe(1);
    expect(report.otherActors.byActor).toEqual({ 'third-party-tool': 1 });
  });

  it('does not count a terminal transition that did not come from planned', () => {
    // A recovery/reconciliation write (from `activated` → `rolled_back` is not
    // an attempt either; classifyTransition only accepts planned → terminal).
    writeTransaction('install-1757680700000-ghi.jsonl', 'installer', 'update', {
      from: null,
      to: 'planned',
      at: '2026-09-11T04:00:00.000Z',
    }, [
      {
        at: '2026-09-11T04:05:00.000Z',
        from: 'activated',
        to: 'confirmed',
        transactionId: 'install-1757680700000-ghi',
        releaseId: 'r',
        productVersion: '1.231.0',
        releaseMetadataDigest: 'x',
        releaseMetadataDigestSource: 'manifest',
        generation: 2,
        detail: 'actor=console-updater kind=apply launched-later',
      },
    ]);
    const report = computeCensus(transactionsDir, { now: NOW });
    expect(report.legacy.attemptCount).toBe(0);
    expect(report.unfinished).toBe(1);
  });
});

describe('drain assessment is fail-loud, never optimistic', () => {
  it('reports IN_USE when legacy usage is present', () => {
    writeLegacyAttempt('console-apply-full-1757680000000-a.jsonl', 'apply-full');
    const assessment = assessDrain(computeCensus(transactionsDir, { now: NOW }));
    expect(assessment.verdict).toBe('IN_USE');
    expect(assessment.drained).toBe(false);
    expect(assessment.usageObserved).toBe(true);
  });

  it('reports NO_USAGE_OBSERVED when a complete journal shows zero legacy attempts', () => {
    writeTransaction('install-1757680500000-def.jsonl', 'installer', 'update', {
      from: null,
      to: 'planned',
      at: '2026-09-11T02:00:00.000Z',
    }, [
      {
        at: '2026-09-11T02:04:00.000Z',
        from: 'planned',
        to: 'confirmed',
        transactionId: 'install-1757680500000-def',
        releaseId: 'r',
        productVersion: '1.231.0',
        releaseMetadataDigest: 'x',
        releaseMetadataDigestSource: 'manifest',
        generation: 2,
        detail: 'actor=installer kind=update',
      },
    ]);
    const assessment = assessDrain(computeCensus(transactionsDir, { now: NOW }));
    expect(assessment.verdict).toBe('NO_USAGE_OBSERVED');
    expect(assessment.drained).toBe(true);
  });

  it('never equates an unreadable journal with "zero usage"', () => {
    writeFileSync(join(transactionsDir, 'console-apply-full-broken.jsonl'), '{"at": "x", "from": null}\n', 'utf8');
    const report = computeCensus(transactionsDir, { now: NOW });
    const assessment = assessDrain(report);
    expect(report.filesUnreadable).toHaveLength(1);
    expect(assessment.verdict).toBe('UNDETERMINED');
    expect(assessment.drained).toBe(false);
    expect(assessment.obstructions).toContain('journal_files_unreadable');
  });

  it('never equates a directory that was never created with "zero usage"', () => {
    const missing = join(root, 'never-created', 'transactions');
    const report = computeCensus(missing, { now: NOW });
    expect(report.directoryAbsent).toBe(true);
    const assessment = assessDrain(report);
    expect(assessment.verdict).toBe('UNDETERMINED');
    expect(assessment.obstructions).toContain('transactions_directory_absent');
  });

  it('treats a present-but-empty transactions directory as UNDETERMINED', () => {
    const assessment = assessDrain(computeCensus(transactionsDir, { now: NOW }));
    expect(assessment.verdict).toBe('UNDETERMINED');
    expect(assessment.obstructions).toContain('no_journal_files_present');
  });
});

describe('observation window', () => {
  it('excludes legacy attempts older than the window', () => {
    writeTransaction('console-apply-full-old.jsonl', 'console-updater', 'apply-full', {
      from: null,
      to: 'planned',
      at: '2026-06-01T02:00:00.000Z',
    }, [
      {
        at: '2026-06-01T02:03:00.000Z',
        from: 'planned',
        to: 'confirmed',
        transactionId: 'console-apply-full-old',
        releaseId: 'r',
        productVersion: '1.200.0',
        releaseMetadataDigest: 'x',
        releaseMetadataDigestSource: 'fallback',
        generation: 1,
        detail: 'actor=console-updater kind=apply-full',
      },
    ]);
    const report = computeCensus(transactionsDir, { now: NOW, windowDays: 30 });
    expect(report.legacy.attemptCount).toBe(0);
    expect(report.filesScanned).toBe(1);
  });

  it('includes a recent legacy attempt and reports it as usage', () => {
    writeLegacyAttempt('console-apply-full-recent.jsonl', 'apply-full');
    const report = computeCensus(transactionsDir, { now: NOW, windowDays: 30 });
    expect(report.legacy.attemptCount).toBe(1);
  });
});

describe('CLI boundary (cli-7: parser + real entry point)', () => {
  it('rejects an unknown argument with a next action', () => {
    const parsed = parseArgs(['--nope']);
    expect(parsed.ok).toBe(false);
    expect(parsed.nextAction).toContain('Usage:');
  });

  it('rejects a non-numeric window', () => {
    const parsed = parseArgs(['--window-days', 'soon']);
    expect(parsed.ok).toBe(false);
  });

  it('exits 0 and reports IN_USE without --check even when usage exists', () => {
    writeLegacyAttempt('console-apply-full-1757680000000-a.jsonl', 'apply-full');
    const result = run({ argv: ['--pd-home', root], now: NOW });
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain('IN_USE');
    expect(result.stdout).toContain('legacy-console-updater : 1');
  });

  it('exits 1 under --check when usage exists, with an actionable next action', () => {
    writeLegacyAttempt('console-apply-full-1757680000000-a.jsonl', 'apply-full');
    const result = run({ argv: ['--pd-home', root, '--check'], now: NOW });
    expect(result.exitCode).toBe(1);
    expect(result.stdout).toContain('Gate B is NOT satisfied');
  });

  it('exits 0 under --check when the journal is complete and shows no usage', () => {
    writeTransaction('install-1757680500000-def.jsonl', 'installer', 'update', {
      from: null,
      to: 'planned',
      at: '2026-09-11T02:00:00.000Z',
    }, [
      {
        at: '2026-09-11T02:04:00.000Z',
        from: 'planned',
        to: 'confirmed',
        transactionId: 'install-1757680500000-def',
        releaseId: 'r',
        productVersion: '1.231.0',
        releaseMetadataDigest: 'x',
        releaseMetadataDigestSource: 'manifest',
        generation: 2,
        detail: 'actor=installer kind=update',
      },
    ]);
    const result = run({ argv: ['--pd-home', root, '--check'], now: NOW });
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain('NO_USAGE_OBSERVED');
  });

  it('exits 2 under --check when the census is incomplete — never certifies drain', () => {
    writeFileSync(join(transactionsDir, 'console-apply-full-broken.jsonl'), 'not json\n', 'utf8');
    const result = run({ argv: ['--pd-home', root, '--check'], now: NOW });
    expect(result.exitCode).toBe(2);
    expect(result.stdout).toContain('cannot certify drain');
  });

  it('emits machine-readable JSON on --json with the drain assessment attached', () => {
    writeLegacyAttempt('console-apply-full-1757680000000-a.jsonl', 'apply-full');
    const result = run({ argv: ['--pd-home', root, '--json'], now: NOW });
    expect(result.exitCode).toBe(0);
    const parsed = JSON.parse(result.stdout);
    expect(parsed.legacy.attemptCount).toBe(1);
    expect(parsed.assessment.verdict).toBe('IN_USE');
  });
});

describe('side effects: the census is read-only', () => {
  it('writes nothing to the transactions directory', () => {
    writeLegacyAttempt('console-apply-full-1757680000000-a.jsonl', 'apply-full');
    const before = readdirSync(transactionsDir).sort();
    run({ argv: ['--pd-home', root, '--json'], now: NOW });
    run({ argv: ['--pd-home', root, '--check'], now: NOW });
    expect(readdirSync(transactionsDir).sort()).toEqual(before);
  });

  it('does not create a transactions directory for a missing pd home', () => {
    const missingPdHome = join(root, 'absent-pd-home');
    const result = run({ argv: ['--pd-home', missingPdHome], now: NOW });
    expect(result.exitCode).toBe(0);
    expect(readdirSync(root)).not.toContain('absent-pd-home');
    expect(result.stdout).toContain('UNDETERMINED');
  });
});

describe('helpers', () => {
  it('parses detail tokens order-insensitively and keeps unknown keys', () => {
    const tokens = parseDetailTokens('kind=apply-full actor=console-updater note=hi');
    expect(tokens?.get('actor')).toBe('console-updater');
    expect(tokens?.get('kind')).toBe('apply-full');
    expect(tokens?.get('note')).toBe('hi');
    expect(parseDetailTokens(undefined)).toBeNull();
  });

  it('fails loud on a malformed journal line instead of skipping it', () => {
    writeFileSync(join(transactionsDir, 'broken.jsonl'), '{not json}\n', 'utf8');
    const read = readTransactionFile(join(transactionsDir, 'broken.jsonl'));
    expect(read.ok).toBe(false);
    expect(read.reason).toContain('malformed_json');
  });

  it('resolves the default transactions dir from PD_HOME then the home dir', () => {
    expect(defaultTransactionsDir({ PD_HOME: '/custom/pd' }, '/home/u')).toBe(join('/custom/pd', 'transactions'));
    expect(defaultTransactionsDir({}, '/home/u')).toBe(join('/home/u', '.pd', 'transactions'));
  });
});
