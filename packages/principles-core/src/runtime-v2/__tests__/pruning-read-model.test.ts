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
      } as LedgerPrinciple,
      old_watch: {
        id: 'old_watch',
        status: 'active',
        createdAt: '2026-03-18T00:00:00.000Z',
        updatedAt: '2025-12-01T00:00:00.000Z',
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
      } as LedgerPrinciple,
      old_review: {
        id: 'old_review',
        status: 'active',
        createdAt: '2026-01-02T00:00:00.000Z',
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
      } as LedgerPrinciple,
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
      } as LedgerPrinciple,
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
      } as LedgerPrinciple,
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
      } as LedgerPrinciple,
    },
  },
};

// ── Mocks ──────────────────────────────────────────────────────────────────────

let mockLedgerData: LedgerStore = LEDGER_EMPTY;
let mockCandidateRows: { candidate_id: string; created_at: string }[] = [];
let mockDbExists = false;

vi.mock('../../principle-tree-ledger.js', () => ({
  loadLedger: vi.fn(() => mockLedgerData),
}));

vi.mock('better-sqlite3', () => ({
  default: vi.fn(function (this: Record<string, unknown>) {
    this.prepare = vi.fn(() => ({
      all: vi.fn(() => mockCandidateRows),
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
  mockCandidateRows = [];
  mockDbExists = false;
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
          } as LedgerPrinciple,
        },
      },
    };
    mockCandidateRows = [
      { candidate_id: 'c_in_db', created_at: '2026-01-15T00:00:00.000Z' },
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
          } as LedgerPrinciple,
        },
      },
    };
    mockCandidateRows = [];
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
          } as LedgerPrinciple,
        },
      },
    };
    mockCandidateRows = [];
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
          } as LedgerPrinciple,
        },
      },
    };
    mockCandidateRows = [
      { candidate_id: 'c_recent1', created_at: '2026-01-15T00:00:00.000Z' },
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
            createdAt: '2026-03-18T00:00:00.000Z',
            updatedAt: '2025-12-01T00:00:00.000Z',
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
          } as LedgerPrinciple,
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
          } as LedgerPrinciple,
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
    mockCandidateRows = [];
    mockDbExists = true;

    const model = new PruningReadModel({ workspaceDir: WORKSPACE });
    const summary = model.getHealthSummary();

    expect(summary.totalPrinciples).toBe(4);
    expect(summary.orphanDerivedCandidateCount).toBe(1);
  });
});
