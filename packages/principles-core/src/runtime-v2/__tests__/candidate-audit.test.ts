/**
 * candidate-audit.ts unit tests — core candidate/ledger consistency check.
 *
 * Tests the extracted audit function that was previously inlined in
 * pd-cli/src/commands/candidate.ts and health.ts.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

// ── Mock setup ──────────────────────────────────────────────────────────────

const mockDb = {
  prepare: vi.fn(),
  close: vi.fn(),
};

vi.mock('better-sqlite3', () => ({
  default: vi.fn(function () { return mockDb; }),
}));

const mockLoadLedgerFn = vi.hoisted(() => vi.fn());

vi.mock('../../principle-tree-ledger.js', () => ({
  loadLedger: mockLoadLedgerFn,
  getLedgerFilePathPublic: vi.fn(() => '/fake/ledger.json'),
}));

// Mock fs for existsSync
vi.mock('fs', () => ({
  existsSync: vi.fn(() => true),
  default: { existsSync: vi.fn(() => true) },
}));

import { auditCandidateLedgerConsistency } from '../candidate-audit.js';

// ── Helpers ─────────────────────────────────────────────────────────────────

const WS = '/fake/workspace';

function makeLedgerWithEntries(entries: { id: string; derivedFromPainIds: string[] }[]) {
  const principles: Record<string, { id: string; derivedFromPainIds: string[] }> = {};
  for (const e of entries) {
    principles[e.id] = e;
  }
  return { tree: { principles } };
}

function setupConsumedRows(rows: { candidate_id: string }[]) {
  const stmt = { all: vi.fn(() => rows) };
  mockDb.prepare.mockReturnValue(stmt);
}

// ── Tests ───────────────────────────────────────────────────────────────────

describe('auditCandidateLedgerConsistency', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    vi.clearAllMocks();
  });

  it('returns ok when all consumed candidates have ledger entries', async () => {
    setupConsumedRows([
      { candidate_id: 'c1' },
      { candidate_id: 'c2' },
    ]);
    mockLoadLedgerFn.mockReturnValue(makeLedgerWithEntries([
      { id: 'p1', derivedFromPainIds: ['c1'] },
      { id: 'p2', derivedFromPainIds: ['c2'] },
    ]));

    const result = await auditCandidateLedgerConsistency(WS);

    expect(result.status).toBe('ok');
    expect(result.consumedCount).toBe(2);
    expect(result.orphanCandidateCount).toBe(0);
    expect(result.missingLedgerCount).toBe(0);
  });

  it('returns degraded when consumed candidates are missing ledger entries', async () => {
    setupConsumedRows([
      { candidate_id: 'c1' },
      { candidate_id: 'c2' },
      { candidate_id: 'c3' },
    ]);
    mockLoadLedgerFn.mockReturnValue(makeLedgerWithEntries([
      { id: 'p1', derivedFromPainIds: ['c1'] },
      // c2 and c3 missing from ledger
    ]));

    const result = await auditCandidateLedgerConsistency(WS);

    expect(result.status).toBe('degraded');
    expect(result.consumedCount).toBe(3);
    expect(result.orphanCandidateCount).toBe(2);
    expect(result.missingLedgerCount).toBe(2);
  });

  it('returns ok when no consumed candidates exist', async () => {
    setupConsumedRows([]);
    mockLoadLedgerFn.mockReturnValue(makeLedgerWithEntries([]));

    const result = await auditCandidateLedgerConsistency(WS);

    expect(result.status).toBe('ok');
    expect(result.consumedCount).toBe(0);
    expect(result.orphanCandidateCount).toBe(0);
  });

  it('returns error when state.db does not exist', async () => {
    const fs = await import('fs');
    vi.spyOn(fs, 'existsSync').mockReturnValue(false);

    const result = await auditCandidateLedgerConsistency(WS);

    expect(result.status).toBe('error');
  });

  it('returns error when DB throws', async () => {
    const Database = (await import('better-sqlite3')).default;
    vi.mocked(Database).mockImplementation(() => {
      throw new Error('Cannot open database');
    });

    const result = await auditCandidateLedgerConsistency(WS);

    expect(result.status).toBe('error');
  });
});
