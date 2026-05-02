/**
 * PruningReviewLog unit tests — PRI-24.
 *
 * Tests the append-only JSONL audit log for human review decisions.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { appendPruningReview, listPruningReviews } from '../pruning-review-log.js';
import type { PrinciplePruningSignal } from '../pruning-read-model.js';

const FIXTURE_SIGNAL: PrinciplePruningSignal = {
  principleId: 'p_test',
  status: 'active',
  createdAt: '2026-01-01T00:00:00.000Z',
  updatedAt: '2026-01-01T00:00:00.000Z',
  derivedCandidateIds: ['c1'],
  derivedPainCount: 2,
  matchedCandidateCount: 1,
  recentCandidateCount: 0,
  orphanCandidateCount: 0,
  ageDays: 45,
  riskLevel: 'watch',
  reasons: ['watch: principle older than 30 days'],
};

describe('PruningReviewLog', () => {
  let tmpDir = '';

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pruning-review-log-test-'));
  });

  afterEach(() => {
    const stateDir = path.join(tmpDir, '.state');
    if (fs.existsSync(stateDir)) {
      fs.rmSync(stateDir, { recursive: true, force: true });
    }
    if (fs.existsSync(tmpDir)) fs.rmdirSync(tmpDir);
  });

  it('append creates .state/pruning_reviews.jsonl', () => {
    appendPruningReview(tmpDir, {
      principleId: 'p1',
      decision: 'keep',
      signalSnapshot: FIXTURE_SIGNAL,
    });
    const logPath = path.join(tmpDir, '.state', 'pruning_reviews.jsonl');
    expect(fs.existsSync(logPath)).toBe(true);
  });

  it('append returns record with reviewId and reviewedAt', () => {
    const record = appendPruningReview(tmpDir, {
      principleId: 'p1',
      decision: 'keep',
      signalSnapshot: FIXTURE_SIGNAL,
    });
    expect(record.reviewId).toBeTruthy();
    expect(typeof record.reviewId).toBe('string');
    expect(record.reviewedAt).toBeTruthy();
    expect(record.principleId).toBe('p1');
    expect(record.decision).toBe('keep');
  });

  it('append defaults reviewer to operator', () => {
    const record = appendPruningReview(tmpDir, {
      principleId: 'p1',
      decision: 'keep',
      signalSnapshot: FIXTURE_SIGNAL,
    });
    expect(record.reviewer).toBe('operator');
  });

  it('append uses provided reviewer', () => {
    const record = appendPruningReview(tmpDir, {
      principleId: 'p1',
      decision: 'keep',
      reviewer: 'alice',
      signalSnapshot: FIXTURE_SIGNAL,
    });
    expect(record.reviewer).toBe('alice');
  });

  it('list returns appended records', () => {
    appendPruningReview(tmpDir, {
      principleId: 'p1',
      decision: 'keep',
      signalSnapshot: FIXTURE_SIGNAL,
    });
    appendPruningReview(tmpDir, {
      principleId: 'p2',
      decision: 'defer',
      signalSnapshot: { ...FIXTURE_SIGNAL, principleId: 'p2' },
    });
    const records = listPruningReviews(tmpDir);
    expect(records).toHaveLength(2);
    expect(records[0]?.principleId).toBe('p1');
    expect(records[1]?.principleId).toBe('p2');
  });

  it('list filters by principleId', () => {
    appendPruningReview(tmpDir, {
      principleId: 'p1',
      decision: 'keep',
      signalSnapshot: FIXTURE_SIGNAL,
    });
    appendPruningReview(tmpDir, {
      principleId: 'p2',
      decision: 'defer',
      signalSnapshot: { ...FIXTURE_SIGNAL, principleId: 'p2' },
    });
    const records = listPruningReviews(tmpDir, { principleId: 'p1' });
    expect(records).toHaveLength(1);
    expect(records[0]?.principleId).toBe('p1');
  });

  it('invalid decision rejected with clear Error', () => {
    expect(() =>
      appendPruningReview(tmpDir, {
        principleId: 'p1',
        decision: 'invalid' as unknown as 'keep',
        signalSnapshot: FIXTURE_SIGNAL,
      }),
    ).toThrow(/Invalid decision/i);
  });

  it('append preserves previous records', () => {
    appendPruningReview(tmpDir, {
      principleId: 'p1',
      decision: 'keep',
      note: 'first',
      signalSnapshot: FIXTURE_SIGNAL,
    });
    appendPruningReview(tmpDir, {
      principleId: 'p1',
      decision: 'defer',
      note: 'second',
      signalSnapshot: { ...FIXTURE_SIGNAL, riskLevel: 'review' },
    });
    const records = listPruningReviews(tmpDir);
    expect(records).toHaveLength(2);
    expect(records[0]?.note).toBe('first');
    expect(records[1]?.note).toBe('second');
  });

  it('missing log returns empty array', () => {
    const records = listPruningReviews(tmpDir);
    expect(records).toEqual([]);
  });

  it('does not modify ledger file', () => {
    const ledgerPath = path.join(tmpDir, '.state', 'principle_training_state.json');
    fs.mkdirSync(path.dirname(ledgerPath), { recursive: true });
    fs.writeFileSync(ledgerPath, JSON.stringify({ tree: { principles: {} } }));
    const mtimeBefore = fs.statSync(ledgerPath).mtimeMs;

    appendPruningReview(tmpDir, {
      principleId: 'p1',
      decision: 'keep',
      signalSnapshot: FIXTURE_SIGNAL,
    });

    const mtimeAfter = fs.statSync(ledgerPath).mtimeMs;
    expect(mtimeAfter).toBe(mtimeBefore);
  });

  it('corrupt line skipped on list', () => {
    const logPath = path.join(tmpDir, '.state', 'pruning_reviews.jsonl');
    fs.mkdirSync(path.dirname(logPath), { recursive: true });
    fs.writeFileSync(logPath, 'valid json line\n{"reviewId":"r1","principleId":"p1","decision":"keep","note":"ok","reviewer":"op","reviewedAt":"2026-05-02T00:00:00.000Z","signalSnapshot":{}}\n');

    const records = listPruningReviews(tmpDir);
    expect(records).toHaveLength(1);
    expect(records[0]?.reviewId).toBe('r1');
  });
});