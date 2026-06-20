/**
 * PruningReadModel unit tests — PRI-15.
 *
 * Tests the non-destructive read model's external contract.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { PruningReadModel } from '../pruning-read-model.js';
import type { LedgerPrinciple } from '../../principle-tree-ledger.js';

// ── Test fixtures ──────────────────────────────────────────────────────────────

const WORKSPACE = '/tmp/ws';

// Relative date helpers — tests must not use hardcoded dates that age out
const MS_PER_DAY = 86_400_000;
function daysAgo(n: number): string {
  return new Date(Date.now() - n * MS_PER_DAY).toISOString();
}

interface LedgerStore {
  tree: {
    principles: Record<string, LedgerPrinciple>;
  };
}

const LEDGER_EMPTY: LedgerStore = { tree: { principles: {} } };

const LEDGER_MIXED: LedgerStore = {
  tree: {
    principles: {
      active1: {
        id: 'active1',
        status: 'active',
        createdAt: '2026-01-01T00:00:00.000Z',
        updatedAt: '2026-01-01T00:00:00.000Z',
        derivedFromPainIds: ['c_active1'],
        ruleIds: [],
        conflictsWithPrincipleIds: [],
        version: 1,
        text: '',
        triggerPattern: '',
        action: '',
        priority: 'P1',
        scope: 'general',
        evaluability: 'deterministic',
        valueScore: 0,
        adherenceRate: 0,
        painPreventedCount: 0,
      },
      old_watch: {
        id: 'old_watch',
        status: 'active',
        createdAt: daysAgo(45),
        updatedAt: daysAgo(180),
        derivedFromPainIds: [],
        ruleIds: [],
        conflictsWithPrincipleIds: [],
        version: 1,
        text: '',
        triggerPattern: '',
        action: '',
        priority: 'P1',
        scope: 'general',
        evaluability: 'deterministic',
        valueScore: 0,
        adherenceRate: 0,
        painPreventedCount: 0,
      },
      old_review: {
        id: 'old_review',
        status: 'active',
        createdAt: daysAgo(120),
        updatedAt: daysAgo(500),
        derivedFromPainIds: [],
        ruleIds: [],
        conflictsWithPrincipleIds: [],
        version: 1,
        text: '',
        triggerPattern: '',
        action: '',
        priority: 'P1',
        scope: 'general',
        evaluability: 'deterministic',
        valueScore: 0,
        adherenceRate: 0,
        painPreventedCount: 0,
      },
      archived1: {
        id: 'archived1',
        status: 'archived',
        createdAt: '2025-01-01T00:00:00.000Z',
        updatedAt: '2025-01-01T00:00:00.000Z',
        derivedFromPainIds: [],
        ruleIds: [],
        conflictsWithPrincipleIds: [],
        version: 1,
        text: '',
        triggerPattern: '',
        action: '',
        priority: 'P1',
        scope: 'general',
        evaluability: 'deterministic',
        valueScore: 0,
        adherenceRate: 0,
        painPreventedCount: 0,
      },
    },
  },
};

const LEDGER_PROBATION: LedgerStore = {
  tree: {
    principles: {
      prob1: {
        id: 'prob1',
        status: 'probation',
        createdAt: '2026-01-01T00:00:00.000Z',
        updatedAt: '2026-01-01T00:00:00.000Z',
        derivedFromPainIds: ['c_old1'],
        ruleIds: [],
        conflictsWithPrincipleIds: [],
        version: 1,
        text: '',
        triggerPattern: '',
        action: '',
        priority: 'P1',
        scope: 'general',
        evaluability: 'deterministic',
        valueScore: 0,
        adherenceRate: 0,
        painPreventedCount: 0,
      },
    },
  },
};

const LEDGER_DEPRECATED: LedgerStore = {
  tree: {
    principles: {
      dep1: {
        id: 'dep1',
        status: 'deprecated',
        createdAt: '2025-06-01T00:00:00.000Z',
        updatedAt: '2025-06-01T00:00:00.000Z',
        derivedFromPainIds: [],
        ruleIds: [],
        conflictsWithPrincipleIds: [],
        version: 1,
        text: '',
        triggerPattern: '',
        action: '',
        priority: 'P1',
        scope: 'general',
        evaluability: 'deterministic',
        valueScore: 0,
        adherenceRate: 0,
        painPreventedCount: 0,
      },
    },
  },
};

// ── Mocks ──────────────────────────────────────────────────────────────────────

let mockLedgerData: LedgerStore = LEDGER_EMPTY;
let _mockCandidateRows: { candidate_id: string; created_at: string }[] = [];
let mockAllCandidateRows: { candidate_id: string; status: string; created_at?: string }[] = [];
let mockDbExists = false;
let mockDbShouldThrow = false;

vi.mock('../../principle-tree-ledger.js', () => ({
  loadLedger: vi.fn(() => mockLedgerData),
}));

vi.mock('better-sqlite3', () => ({
  default: vi.fn(function (this: Record<string, unknown>) {
    if (mockDbShouldThrow) {
      throw new Error('SQLITE_CANTOPEN');
    }
    this.prepare = vi.fn((sql: string) => ({
      all: vi.fn(() => {
        if (sql.includes('status') && sql.includes('created_at')) {
          return mockAllCandidateRows.map(r => ({
            candidate_id: r.candidate_id,
            status: r.status,
            created_at: r.created_at ?? '2026-01-15T00:00:00.000Z',
          }));
        }
        if (sql.includes('FROM principle_candidates')) {
          return mockAllCandidateRows.map(r => ({ candidate_id: r.candidate_id }));
        }
        return [];
      }),
    }));
    this.close = vi.fn();
  }),
}));

vi.mock('fs', () => ({
  existsSync: vi.fn(() => mockDbExists),
}));

// ── Helpers ────────────────────────────────────────────────────────────────────

function reset() {
  mockLedgerData = LEDGER_EMPTY;
  _mockCandidateRows = [];
  mockAllCandidateRows = [];
  mockDbExists = false;
  mockDbShouldThrow = false;
  vi.clearAllMocks();
}

// ── Tests ──────────────────────────────────────────────────────────────────────

describe('PruningReadModel', () => {
  beforeEach(() => {
    reset();
  });

  it('empty ledger returns empty signals', () => {
    mockLedgerData = LEDGER_EMPTY;
    mockDbExists = false;

    const model = new PruningReadModel({ workspaceDir: WORKSPACE });
    const signals = model.getPrincipleSignals();
    expect(signals).toEqual([]);
  });

  it('status grouping counts correct', () => {
    mockLedgerData = LEDGER_MIXED;
    mockDbExists = false;

    const model = new PruningReadModel({ workspaceDir: WORKSPACE });
    const signals = model.getPrincipleSignals();

    const byStatus: Record<string, number> = {};
    for (const s of signals) {
      byStatus[s.status] = (byStatus[s.status] ?? 0) + 1;
    }
    expect(byStatus.active).toBe(3);
    expect(byStatus.archived).toBe(1);
  });

  it('old principle with no recent candidate → riskLevel watch', () => {
    mockLedgerData = LEDGER_MIXED;
    mockDbExists = false;

    const model = new PruningReadModel({ workspaceDir: WORKSPACE });
    const signals = model.getPrincipleSignals();

    const oldWatch = signals.find((s) => s.principleId === 'old_watch');
    expect(oldWatch).toBeDefined();
    expect(oldWatch && oldWatch.riskLevel).toBe('watch');
    expect(oldWatch && oldWatch.reasons.some((r) => r.includes('watch'))).toBe(true);
  });

  it('very old principle with no derived candidates → riskLevel review', () => {
    mockLedgerData = LEDGER_MIXED;
    mockDbExists = false;

    const model = new PruningReadModel({ workspaceDir: WORKSPACE });
    const signals = model.getPrincipleSignals();

    const oldReview = signals.find((s) => s.principleId === 'old_review');
    expect(oldReview).toBeDefined();
    expect(oldReview && oldReview.riskLevel).toBe('review');
    expect(oldReview && oldReview.reasons.some((r) => r.includes('review'))).toBe(true);
  });

  it('recent derived candidate → riskLevel none', () => {
    mockLedgerData = LEDGER_MIXED;
    mockDbExists = false;

    const model = new PruningReadModel({ workspaceDir: WORKSPACE });
    const signals = model.getPrincipleSignals();

    const active1 = signals.find((s) => s.principleId === 'active1');
    expect(active1).toBeDefined();
    expect(active1 && active1.riskLevel).toBe('none');
    expect(active1 && active1.derivedPainCount).toBe(1);
  });

  it('all derived candidates present in DB → orphan count 0', () => {
    mockLedgerData = {
      tree: {
        principles: {
          p_orphan: {
            id: 'p_orphan',
            status: 'active',
            createdAt: '2026-01-01T00:00:00.000Z',
            updatedAt: '2026-01-01T00:00:00.000Z',
            derivedFromPainIds: ['c_in_db'],
            ruleIds: [],
            conflictsWithPrincipleIds: [],
            version: 1,
            text: '',
            triggerPattern: '',
            action: '',
            priority: 'P1',
            scope: 'general',
            evaluability: 'deterministic',
            valueScore: 0,
            adherenceRate: 0,
            painPreventedCount: 0,
          },
        },
      },
    };
    _mockCandidateRows = [
      { candidate_id: 'c_in_db', created_at: '2026-01-15T00:00:00.000Z' },
    ];
    mockAllCandidateRows = [
      { candidate_id: 'c_in_db', status: 'consumed', created_at: '2026-01-15T00:00:00.000Z' },
    ];
    mockDbExists = true;

    const model = new PruningReadModel({ workspaceDir: WORKSPACE });
    const signals = model.getPrincipleSignals();
    const summary = model.getHealthSummary();

    const [s0] = signals;
    expect(s0).toBeDefined();
    if (!s0) return;
    expect(s0.matchedCandidateCount).toBe(1);
    expect(s0.orphanCandidateCount).toBe(0);
    expect(summary.orphanDerivedCandidateCount).toBe(0);
  });

  it('orphan candidates detected when derived ID not in DB', () => {
    mockLedgerData = {
      tree: {
        principles: {
          p1: {
            id: 'p1',
            status: 'active',
            createdAt: '2026-01-01T00:00:00.000Z',
            updatedAt: '2026-01-01T00:00:00.000Z',
            derivedFromPainIds: ['c_missing'],
            ruleIds: [],
            conflictsWithPrincipleIds: [],
            version: 1,
            text: '',
            triggerPattern: '',
            action: '',
            priority: 'P1',
            scope: 'general',
            evaluability: 'deterministic',
            valueScore: 0,
            adherenceRate: 0,
            painPreventedCount: 0,
          },
        },
      },
    };
    _mockCandidateRows = [];
    mockDbExists = true;

    const model = new PruningReadModel({ workspaceDir: WORKSPACE });
    const signals = model.getPrincipleSignals();
    const summary = model.getHealthSummary();

    const [s0] = signals;
    expect(s0).toBeDefined();
    if (!s0) return;
    expect(s0.orphanCandidateCount).toBe(1);
    expect(s0.matchedCandidateCount).toBe(0);
    expect(summary.orphanDerivedCandidateCount).toBe(1);
  });

  it('gap reason when derivedPainCount > 0 but matchedCandidateCount === 0', () => {
    mockLedgerData = {
      tree: {
        principles: {
          p_gap: {
            id: 'p_gap',
            status: 'active',
            createdAt: '2026-01-01T00:00:00.000Z',
            updatedAt: '2026-01-01T00:00:00.000Z',
            derivedFromPainIds: ['c_orphan'],
            ruleIds: [],
            conflictsWithPrincipleIds: [],
            version: 1,
            text: '',
            triggerPattern: '',
            action: '',
            priority: 'P1',
            scope: 'general',
            evaluability: 'deterministic',
            valueScore: 0,
            adherenceRate: 0,
            painPreventedCount: 0,
          },
        },
      },
    };
    _mockCandidateRows = [];
    mockDbExists = true;

    const model = new PruningReadModel({ workspaceDir: WORKSPACE });
    const signals = model.getPrincipleSignals();

    const [s0] = signals;
    expect(s0).toBeDefined();
    if (!s0) return;
    expect(s0.reasons.some((r) => r.includes('gap'))).toBe(true);
  });

  it('principle in probation → reasons include status source', () => {
    mockLedgerData = LEDGER_PROBATION;
    mockDbExists = false;

    const model = new PruningReadModel({ workspaceDir: WORKSPACE });
    const signals = model.getPrincipleSignals();

    const prob = signals.find((s) => s.principleId === 'prob1');
    expect(prob).toBeDefined();
    expect(prob && prob.status).toBe('probation');
    expect(prob && prob.reasons.some((r) => r.includes('probation'))).toBe(true);
  });

  it('deprecated principle → reasons include deprecated status', () => {
    mockLedgerData = LEDGER_DEPRECATED;
    mockDbExists = false;

    const model = new PruningReadModel({ workspaceDir: WORKSPACE });
    const signals = model.getPrincipleSignals();

    const dep = signals.find((s) => s.principleId === 'dep1');
    expect(dep).toBeDefined();
    expect(dep && dep.status).toBe('deprecated');
    expect(dep && dep.reasons.some((r) => r.includes('deprecated'))).toBe(true);
  });

  it('empty ledger returns zero summary counts', () => {
    mockLedgerData = LEDGER_EMPTY;
    mockDbExists = false;

    const model = new PruningReadModel({ workspaceDir: WORKSPACE });
    const summary = model.getHealthSummary();

    expect(summary.totalPrinciples).toBe(0);
    expect(summary.watchCount).toBe(0);
    expect(summary.reviewCount).toBe(0);
    expect(summary.averageAgeDays).toBe(0);
    expect(summary.activeL1Count).toBe(0);
    expect(summary.l1Cap).toBe(12);
    expect(summary.generatedAt).toBeTruthy();
  });

  it('recent candidate present → orphan count 0', () => {
    mockLedgerData = {
      tree: {
        principles: {
          p1: {
            id: 'p1',
            status: 'active',
            createdAt: '2026-01-01T00:00:00.000Z',
            updatedAt: '2026-01-01T00:00:00.000Z',
            derivedFromPainIds: ['c_recent1'],
            ruleIds: [],
            conflictsWithPrincipleIds: [],
            version: 1,
            text: '',
            triggerPattern: '',
            action: '',
            priority: 'P1',
            scope: 'general',
            evaluability: 'deterministic',
            valueScore: 0,
            adherenceRate: 0,
            painPreventedCount: 0,
          },
        },
      },
    };
    _mockCandidateRows = [
      { candidate_id: 'c_recent1', created_at: '2026-01-15T00:00:00.000Z' },
    ];
    mockAllCandidateRows = [
      { candidate_id: 'c_recent1', status: 'consumed', created_at: '2026-01-15T00:00:00.000Z' },
    ];
    mockDbExists = true;

    const model = new PruningReadModel({ workspaceDir: WORKSPACE });
    const signals = model.getPrincipleSignals();
    const summary = model.getHealthSummary();

    expect(summary.totalPrinciples).toBe(1);
    const [s0] = signals;
    expect(s0).toBeDefined();
    if (!s0) return;
    expect(s0.orphanCandidateCount).toBe(0);
    expect(summary.orphanDerivedCandidateCount).toBe(0);
  });

  it('DB does not exist → graceful degradation, orphan count reflects missing DB', () => {
    mockLedgerData = LEDGER_MIXED;
    mockDbExists = false;

    const model = new PruningReadModel({ workspaceDir: WORKSPACE });
    const summary = model.getHealthSummary();

    expect(summary.totalPrinciples).toBe(4);
    expect(summary.orphanDerivedCandidateCount).toBe(1);
  });

  it('custom threshold options respected', () => {
    mockLedgerData = {
      tree: {
        principles: {
          mid_age: {
            id: 'mid_age',
            status: 'active',
            createdAt: daysAgo(45),
            updatedAt: daysAgo(180),
            derivedFromPainIds: [],
            ruleIds: [],
            conflictsWithPrincipleIds: [],
            version: 1,
            text: '',
            triggerPattern: '',
            action: '',
            priority: 'P1',
            scope: 'general',
            evaluability: 'deterministic',
            valueScore: 0,
            adherenceRate: 0,
            painPreventedCount: 0,
          },
        },
      },
    };
    mockDbExists = false;

    const modelDefault = new PruningReadModel({ workspaceDir: WORKSPACE });
    const signalsDefault = modelDefault.getPrincipleSignals();
    expect(signalsDefault.length).toBe(1);
    const signalDefault0 = signalsDefault.at(0);
    expect(signalDefault0 && signalDefault0.riskLevel).toBe('watch');

    const modelCustom = new PruningReadModel({
      workspaceDir: WORKSPACE,
      watchThresholdDays: 90,
    });
    const signalsCustom = modelCustom.getPrincipleSignals();
    expect(signalsCustom.length).toBe(1);
    const signalCustom0 = signalsCustom.at(0);
    expect(signalCustom0 && signalCustom0.riskLevel).toBe('none');
  });

  it('invalid createdAt returns large ageDays (not 0)', () => {
    mockLedgerData = {
      tree: {
        principles: {
          bad_date: {
            id: 'bad_date',
            status: 'active',
            createdAt: 'not-a-date',
            updatedAt: '2026-01-01T00:00:00.000Z',
            derivedFromPainIds: [],
            ruleIds: [],
            conflictsWithPrincipleIds: [],
            version: 1,
            text: '',
            triggerPattern: '',
            action: '',
            priority: 'P1',
            scope: 'general',
            evaluability: 'deterministic',
            valueScore: 0,
            adherenceRate: 0,
            painPreventedCount: 0,
          },
        },
      },
    };
    mockDbExists = false;

    const model = new PruningReadModel({ workspaceDir: WORKSPACE });
    const signals = model.getPrincipleSignals();

    const [s0] = signals;
    expect(s0).toBeDefined();
    if (!s0) return;
    expect(s0.ageDays).toBe(9999);
    expect(s0.riskLevel).toBe('review');
  });

  it('getHealthSummary reuses signals without duplicate DB query', () => {
    mockLedgerData = LEDGER_MIXED;
    _mockCandidateRows = [];
    mockDbExists = true;

    const model = new PruningReadModel({ workspaceDir: WORKSPACE });
    const summary = model.getHealthSummary();

    expect(summary.totalPrinciples).toBe(4);
    expect(summary.orphanDerivedCandidateCount).toBe(1);
    expect(summary.activeL1Count).toBe(3);
  });

  it('health summary uses custom l1Cap when provided', () => {
    mockLedgerData = LEDGER_MIXED;
    mockDbExists = false;

    const model = new PruningReadModel({ workspaceDir: WORKSPACE, l1Cap: 8 });
    const summary = model.getHealthSummary();

    expect(summary.l1Cap).toBe(8);
    expect(summary.activeL1Count).toBe(3);
  });

  it('constructor rejects invalid l1Cap via validateL1CapConfig', () => {
    expect(() => new PruningReadModel({ workspaceDir: WORKSPACE, l1Cap: 0 })).toThrow();
    expect(() => new PruningReadModel({ workspaceDir: WORKSPACE, l1Cap: 13 })).toThrow();
    expect(() => new PruningReadModel({ workspaceDir: WORKSPACE, l1Cap: 1.5 })).toThrow();
  });

  it('orphan count matches getOrphanDerivedCandidates for same data', () => {
    mockLedgerData = {
      tree: {
        principles: {
          p1: {
            id: 'p1',
            status: 'active',
            createdAt: '2026-01-01T00:00:00.000Z',
            updatedAt: '2026-01-01T00:00:00.000Z',
            derivedFromPainIds: ['c_consumed', 'c_pending', 'c_missing'],
            ruleIds: [],
            conflictsWithPrincipleIds: [],
            version: 1,
            text: '',
            triggerPattern: '',
            action: '',
            priority: 'P1',
            scope: 'general',
            evaluability: 'deterministic',
            valueScore: 0,
            adherenceRate: 0,
            painPreventedCount: 0,
          },
        },
      },
    };
    _mockCandidateRows = [
      { candidate_id: 'c_consumed', created_at: '2026-01-15T00:00:00.000Z' },
    ];
    mockAllCandidateRows = [
      { candidate_id: 'c_consumed', status: 'consumed', created_at: '2026-01-15T00:00:00.000Z' },
      { candidate_id: 'c_pending', status: 'pending', created_at: '2026-01-15T00:00:00.000Z' },
    ];
    mockDbExists = true;

    const model = new PruningReadModel({ workspaceDir: WORKSPACE });
    const summary = model.getHealthSummary();
    const orphanResult = model.getOrphanDerivedCandidates();

    expect(summary.orphanDerivedCandidateCount).toBe(orphanResult.candidates.length);
    expect(orphanResult.candidates.length).toBe(1);
    expect(orphanResult.candidates[0]?.candidateId).toBe('c_missing');
  });

  it('pending candidate in DB is not counted as orphan', () => {
    mockLedgerData = {
      tree: {
        principles: {
          p1: {
            id: 'p1',
            status: 'active',
            createdAt: '2026-01-01T00:00:00.000Z',
            updatedAt: '2026-01-01T00:00:00.000Z',
            derivedFromPainIds: ['c_pending'],
            ruleIds: [],
            conflictsWithPrincipleIds: [],
            version: 1,
            text: '',
            triggerPattern: '',
            action: '',
            priority: 'P1',
            scope: 'general',
            evaluability: 'deterministic',
            valueScore: 0,
            adherenceRate: 0,
            painPreventedCount: 0,
          },
        },
      },
    };
    _mockCandidateRows = [];
    mockAllCandidateRows = [
      { candidate_id: 'c_pending', status: 'pending', created_at: '2026-01-15T00:00:00.000Z' },
    ];
    mockDbExists = true;

    const model = new PruningReadModel({ workspaceDir: WORKSPACE });
    const signals = model.getPrincipleSignals();
    const summary = model.getHealthSummary();

    expect(signals[0]?.orphanCandidateCount).toBe(0);
    expect(summary.orphanDerivedCandidateCount).toBe(0);
  });

  describe('getOrphanDerivedCandidates', () => {
    it('returns list with detail, not just count', () => {
      mockLedgerData = {
        tree: {
          principles: {
            p1: {
              id: 'p1',
              status: 'active',
              createdAt: '2026-01-01T00:00:00.000Z',
              updatedAt: '2026-01-01T00:00:00.000Z',
              derivedFromPainIds: ['c_missing1', 'c_missing2'],
              ruleIds: [],
              conflictsWithPrincipleIds: [],
              version: 1,
              text: '',
              triggerPattern: '',
              action: '',
              priority: 'P1',
              scope: 'general',
              evaluability: 'deterministic',
              valueScore: 0,
              adherenceRate: 0,
              painPreventedCount: 0,
            },
          },
        },
      };
      _mockCandidateRows = [];
      mockAllCandidateRows = [];
      mockDbExists = true;

      const model = new PruningReadModel({ workspaceDir: WORKSPACE });
      const result = model.getOrphanDerivedCandidates();

      expect(result.dbReadable).toBe(true);
      expect(result.candidates).toHaveLength(2);
      expect(result.candidates[0]?.candidateId).toBe('c_missing1');
      expect(result.candidates[0]?.principleId).toBe('p1');
      expect(result.candidates[0]?.reason).toBe('candidate not found in state.db');
      expect(result.candidates[0]?.sourceRef).toBe('derivedFromPainIds');
      expect(result.candidates[0]?.status).toBe('active');
    });

    it('does not include non-orphan candidates', () => {
      mockLedgerData = {
        tree: {
          principles: {
            p1: {
              id: 'p1',
              status: 'active',
              createdAt: '2026-01-01T00:00:00.000Z',
              updatedAt: '2026-01-01T00:00:00.000Z',
              derivedFromPainIds: ['c_exists', 'c_missing'],
              ruleIds: [],
              conflictsWithPrincipleIds: [],
              version: 1,
              text: '',
              triggerPattern: '',
              action: '',
              priority: 'P1',
              scope: 'general',
              evaluability: 'deterministic',
              valueScore: 0,
              adherenceRate: 0,
              painPreventedCount: 0,
            },
          },
        },
      };
      _mockCandidateRows = [
        { candidate_id: 'c_exists', created_at: '2026-01-15T00:00:00.000Z' },
      ];
      mockAllCandidateRows = [
        { candidate_id: 'c_exists', status: 'consumed', created_at: '2026-01-15T00:00:00.000Z' },
      ];
      mockDbExists = true;

      const model = new PruningReadModel({ workspaceDir: WORKSPACE });
      const result = model.getOrphanDerivedCandidates();

      expect(result.dbReadable).toBe(true);
      expect(result.candidates).toHaveLength(1);
      expect(result.candidates[0]?.candidateId).toBe('c_missing');
    });

    it('returns empty for empty ledger', () => {
      mockLedgerData = LEDGER_EMPTY;
      mockDbExists = false;

      const model = new PruningReadModel({ workspaceDir: WORKSPACE });
      const result = model.getOrphanDerivedCandidates();

      expect(result.candidates).toEqual([]);
      expect(result.dbReadable).toBe(true);
    });

    it('returns dbReadable=false when DB does not exist', () => {
      mockLedgerData = {
        tree: {
          principles: {
            p1: {
              id: 'p1',
              status: 'active',
              createdAt: '2026-01-01T00:00:00.000Z',
              updatedAt: '2026-01-01T00:00:00.000Z',
              derivedFromPainIds: ['c_orphan1'],
              ruleIds: [],
              conflictsWithPrincipleIds: [],
              version: 1,
              text: '',
              triggerPattern: '',
              action: '',
              priority: 'P1',
              scope: 'general',
              evaluability: 'deterministic',
              valueScore: 0,
              adherenceRate: 0,
              painPreventedCount: 0,
            },
          },
        },
      };
      _mockCandidateRows = [];
      mockAllCandidateRows = [];
      mockDbExists = false;

      const model = new PruningReadModel({ workspaceDir: WORKSPACE });
      const result = model.getOrphanDerivedCandidates();

      expect(result.dbReadable).toBe(false);
      expect(result.candidates).toHaveLength(1);
      expect(result.candidates[0]?.reason).toBe('candidate not verifiable: state.db unreadable');
    });

    it('returns dbReadable=false when DB read throws', () => {
      mockLedgerData = {
        tree: {
          principles: {
            p1: {
              id: 'p1',
              status: 'active',
              createdAt: '2026-01-01T00:00:00.000Z',
              updatedAt: '2026-01-01T00:00:00.000Z',
              derivedFromPainIds: ['c_orphan1'],
              ruleIds: [],
              conflictsWithPrincipleIds: [],
              version: 1,
              text: '',
              triggerPattern: '',
              action: '',
              priority: 'P1',
              scope: 'general',
              evaluability: 'deterministic',
              valueScore: 0,
              adherenceRate: 0,
              painPreventedCount: 0,
            },
          },
        },
      };
      _mockCandidateRows = [];
      mockAllCandidateRows = [];
      mockDbExists = true;
      mockDbShouldThrow = true;

      const model = new PruningReadModel({ workspaceDir: WORKSPACE });
      const result = model.getOrphanDerivedCandidates();

      expect(result.dbReadable).toBe(false);
      expect(result.candidates).toHaveLength(1);
      expect(result.candidates[0]?.reason).toContain('not verifiable');
    });
  });
});
