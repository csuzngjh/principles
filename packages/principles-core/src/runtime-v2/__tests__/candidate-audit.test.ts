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

function makeLedgerWithEntries(entries: {
  id: string;
  derivedFromPainIds?: string[];
  reuseEvidence?: unknown[];
}[]) {
  const principles: Record<string, { id: string; derivedFromPainIds?: string[]; reuseEvidence?: unknown[] }> = {};
  for (const e of entries) {
    principles[e.id] = e;
  }
  return { tree: { principles } };
}

function setupConsumedRows(rows: { candidate_id: string; recommendation_kind?: string | null }[]) {
  const stmt = { all: vi.fn(() => rows) };
  mockDb.prepare.mockReturnValue(stmt);
}

/** A well-formed reuseEvidence entry (PRI-917 SPEC v0.2.1 §12). */
function reuseEvidenceFor(candidateId: string, painId = 'pain-001') {
  return {
    painId,
    candidateId,
    decision: 'reuse',
    actor: { kind: 'owner', id: 'owner-1' },
    reason: 'duplicate of existing principle',
    decidedAt: '2026-10-06T17:22:44.000Z',
  };
}

// ── Tests ───────────────────────────────────────────────────────────────────

describe('auditCandidateLedgerConsistency', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    vi.clearAllMocks();
  });

  it('returns ok when all consumed candidates have ledger entries', async () => {
    setupConsumedRows([
      { candidate_id: 'c1', recommendation_kind: 'principle' },
      { candidate_id: 'c2', recommendation_kind: 'principle' },
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
      { candidate_id: 'c1', recommendation_kind: 'principle' },
      { candidate_id: 'c2', recommendation_kind: 'principle' },
      { candidate_id: 'c3', recommendation_kind: 'principle' },
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
    expect(result.missingLedgerEntryIds).toEqual(['c2', 'c3']);
    expect(result.reusedResolvedCount).toBe(0);
    expect(result.nonLedgerKindCount).toBe(0);
  });

  it('counts a reuse-resolved consumed candidate as resolved, not missing (PRI-917 / R7)', async () => {
    // A successful reuse decision is BY DESIGN zero ledger growth: the
    // candidate never appears in derivedFromPainIds, only in the target
    // principle's reuseEvidence. This is the OC-02 / CX-02 false-positive
    // reproduction class (was: degraded + ledger_write_failed).
    setupConsumedRows([
      { candidate_id: 'c-reuse', recommendation_kind: 'principle' },
      { candidate_id: 'c-created', recommendation_kind: 'principle' },
    ]);
    mockLoadLedgerFn.mockReturnValue(makeLedgerWithEntries([
      { id: 'p-target', reuseEvidence: [reuseEvidenceFor('c-reuse')] },
      { id: 'p-new', derivedFromPainIds: ['c-created'] },
    ]));

    const result = await auditCandidateLedgerConsistency(WS);

    expect(result.status).toBe('ok');
    expect(result.consumedCount).toBe(2);
    expect(result.missingLedgerCount).toBe(0);
    expect(result.missingLedgerEntryIds).toEqual([]);
    expect(result.reusedResolvedCount).toBe(1);
    expect(result.nonLedgerKindCount).toBe(0);
  });

  it('counts consumed candidates of non-Principle-Ledger kinds as excluded, not missing', async () => {
    // rule / prompt / implementation candidates never write the principle
    // ledger by design (Phase 1 / PR1 write boundary); unknown kinds are
    // refused fail-closed. None of them are "missing".
    setupConsumedRows([
      { candidate_id: 'c-rule', recommendation_kind: 'rule' },
      { candidate_id: 'c-prompt', recommendation_kind: 'prompt' },
      { candidate_id: 'c-impl', recommendation_kind: 'implementation' },
      { candidate_id: 'c-defer', recommendation_kind: 'defer' },
      { candidate_id: 'c-unknown', recommendation_kind: null },
      { candidate_id: 'c-garbage', recommendation_kind: 'skill' },
      { candidate_id: 'c-principle', recommendation_kind: 'principle' },
    ]);
    mockLoadLedgerFn.mockReturnValue(makeLedgerWithEntries([
      { id: 'p1', derivedFromPainIds: ['c-principle'] },
    ]));

    const result = await auditCandidateLedgerConsistency(WS);

    expect(result.status).toBe('ok');
    expect(result.consumedCount).toBe(7);
    expect(result.missingLedgerCount).toBe(0);
    expect(result.nonLedgerKindCount).toBe(6);
    expect(result.reusedResolvedCount).toBe(0);
  });

  it('still reports true drift: principle-kind consumed candidate with no resolution anywhere', async () => {
    setupConsumedRows([
      { candidate_id: 'c-drift', recommendation_kind: 'principle' },
    ]);
    mockLoadLedgerFn.mockReturnValue(makeLedgerWithEntries([
      { id: 'p1', derivedFromPainIds: ['someone-else'] },
      { id: 'p2', reuseEvidence: [reuseEvidenceFor('someone-else-too')] },
    ]));

    const result = await auditCandidateLedgerConsistency(WS);

    expect(result.status).toBe('degraded');
    expect(result.missingLedgerCount).toBe(1);
    expect(result.missingLedgerEntryIds).toEqual(['c-drift']);
  });

  it('guards against malformed reuseEvidence shapes instead of trusting them', async () => {
    setupConsumedRows([
      { candidate_id: 'c1', recommendation_kind: 'principle' },
    ]);
    mockLoadLedgerFn.mockReturnValue(makeLedgerWithEntries([
      {
        id: 'p-bad',
        reuseEvidence: [
          'not-an-object',
          { candidateId: 42 },
          { painId: 'pain-001' }, // no candidateId
          null,
        ],
      },
    ]));

    const result = await auditCandidateLedgerConsistency(WS);

    // None of the malformed entries resolve c1 → still true drift.
    expect(result.status).toBe('degraded');
    expect(result.missingLedgerCount).toBe(1);
    expect(result.missingLedgerEntryIds).toEqual(['c1']);
    expect(result.reusedResolvedCount).toBe(0);
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
