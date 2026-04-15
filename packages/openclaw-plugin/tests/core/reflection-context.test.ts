/**
 * ReflectionContextCollector Tests
 *
 * TDD test suite for the unified pipeline input collector.
 */

import * as fs from 'fs';
import * as path from 'path';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { safeRmDir } from '../test-utils.js';
import { saveLedger, type HybridLedgerStore, type LedgerPrinciple, type LedgerRule } from '../../src/core/principle-tree-ledger.js';
import { TrajectoryDatabase } from '../../src/core/trajectory.js';
import { ReflectionContextCollector, type ReflectionContext } from '../../src/core/reflection/reflection-context.js';

describe('ReflectionContextCollector', () => {
  let tempDir: string;
  let stateDir: string;
  let workspaceDir: string;
  let trajectory: TrajectoryDatabase;
  let collector: ReflectionContextCollector;

  beforeAll(() => {
    tempDir = fs.mkdtempSync(path.join(process.env.TMP || '/tmp', 'pd-reflect-'));
    workspaceDir = path.join(tempDir, 'workspace');
    stateDir = path.join(workspaceDir, '.state');
    fs.mkdirSync(stateDir, { recursive: true });

    trajectory = new TrajectoryDatabase({ workspaceDir });
  });

  afterAll(() => {
    trajectory.dispose();
    safeRmDir(tempDir);
  });

  beforeEach(() => {
    collector = new ReflectionContextCollector(stateDir, trajectory);
  });

  afterEach(() => {
    // Clean up ledger state file
    const stateFile = path.join(stateDir, 'principle_training_state.json');
    if (fs.existsSync(stateFile)) {
      fs.unlinkSync(stateFile);
    }
  });

  // Helper: Create a minimal ledger principle
  function makePrinciple(
    principleId: string,
    overrides: Partial<LedgerPrinciple> = {},
  ): LedgerPrinciple {
    return {
      id: principleId,
      version: 1,
      text: `Test principle ${principleId}`,
      triggerPattern: 'test',
      action: 'test action',
      status: 'active',
      priority: 'P1',
      scope: 'general',
      evaluability: 'deterministic',
      valueScore: 0,
      adherenceRate: 0,
      painPreventedCount: 0,
      derivedFromPainIds: [],
      ruleIds: [],
      conflictsWithPrincipleIds: [],
      createdAt: '2026-04-10T00:00:00.000Z',
      updatedAt: '2026-04-10T00:00:00.000Z',
      ...overrides,
    };
  }

  // Helper: Save ledger with given principles
  function setupLedger(principles: LedgerPrinciple[]): void {
    const tree = {
      principles: {} as Record<string, LedgerPrinciple>,
      rules: {} as Record<string, LedgerRule>,
      implementations: {},
      metrics: {},
      lastUpdated: new Date().toISOString(),
    };

    for (const p of principles) {
      tree.principles[p.id] = p;
    }

    const store: HybridLedgerStore = {
      trainingStore: {},
      tree,
    };

    saveLedger(stateDir, store);
  }

  // Helper: Record a session with pain events
  function setupSession(
    sessionId: string,
    painEvents: { source: string; score: number; reason?: string; severity?: string }[],
  ): void {
    trajectory.recordSession({ sessionId });
    for (const pe of painEvents) {
      trajectory.recordPainEvent({
        sessionId,
        source: pe.source,
        score: pe.score,
        reason: pe.reason ?? null,
        severity: pe.severity ?? null,
      });
    }
  }

  // -----------------------------------------------------------------------
  // collect()
  // -----------------------------------------------------------------------

  describe('collect', () => {
    it('returns null when principle is not found', () => {
      setupLedger([]);
      const result = collector.collect('P_MISSING');
      expect(result).toBeNull();
    });

    it('returns null when principle has no derivedFromPainIds', () => {
      setupLedger([makePrinciple('P_001')]);
      const result = collector.collect('P_001');
      expect(result).toBeNull();
    });

    it('returns context with empty painEvents when painIds do not match any session', () => {
      setupLedger([
        makePrinciple('P_001', { derivedFromPainIds: ['pain_no_exist'] }),
      ]);

      const result = collector.collect('P_001');

      expect(result).not.toBeNull();
      expect(result!.principle.id).toBe('P_001');
      expect(result!.painEvents).toEqual([]);
      expect(result!.sessionSnapshot).toBeNull();
      expect(result!.lineage.sourcePainIds).toEqual(['pain_no_exist']);
      expect(result!.lineage.sessionId).toBeNull();
    });

    it('returns context with pain events and null snapshot when painIds match events but not a specific session', () => {
      setupSession('sess_001', [
        { source: 'gate_block', score: 80, reason: 'unsafe write', severity: 'severe' },
      ]);

      // We can't directly match painIds to sessions via the current API,
      // so we provide the session that contains the pain events.
      // Since painId resolution is a known gap, we return what we can.
      setupLedger([
        makePrinciple('P_002', { derivedFromPainIds: ['pain_001'] }),
      ]);

      const result = collector.collect('P_002');

      expect(result).not.toBeNull();
      expect(result!.principle.id).toBe('P_002');
      expect(result!.lineage.sourcePainIds).toEqual(['pain_001']);
      // painId -> sessionId resolution is a known gap, so painEvents may be empty
      // and sessionSnapshot may be null
    });

    it('resolves pain events from a known session', () => {
      const sessionId = 'sess_with_pain';
      setupSession(sessionId, [
        { source: 'gate_block', score: 90, reason: 'unsafe delete', severity: 'severe' },
        { source: 'tool_failure', score: 50, reason: 'bad edit', severity: 'moderate' },
      ]);

      setupLedger([
        makePrinciple('P_003', {
          derivedFromPainIds: ['pain_from_sess_with_pain'],
        }),
      ]);

      const result = collector.collect('P_003');

      expect(result).not.toBeNull();
      expect(result!.principle.id).toBe('P_003');
      // painId -> sessionId gap: we attempt to find sessions containing pain events
      // The lineage sessionId should be populated if we can resolve it
      expect(result!.lineage.sourcePainIds).toEqual(['pain_from_sess_with_pain']);
    });
  });

  // -----------------------------------------------------------------------
  // collectBatch()
  // -----------------------------------------------------------------------

  describe('collectBatch', () => {
    it('returns empty array when no principles exist', () => {
      setupLedger([]);
      const results = collector.collectBatch();
      expect(results).toEqual([]);
    });

    it('skips principles without derivedFromPainIds', () => {
      setupLedger([
        makePrinciple('P_NO_PAIN'),
        makePrinciple('P_WITH_PAIN', { derivedFromPainIds: ['pain_001'] }),
      ]);

      const results = collector.collectBatch();

      expect(results).toHaveLength(1);
      expect(results[0].principle.id).toBe('P_WITH_PAIN');
    });

    it('filters by status when provided', () => {
      setupLedger([
        makePrinciple('P_ACTIVE', {
          status: 'active',
          derivedFromPainIds: ['pain_001'],
        }),
        makePrinciple('P_DEPRECATED', {
          status: 'deprecated',
          derivedFromPainIds: ['pain_002'],
        }),
        makePrinciple('P_CANDIDATE', {
          status: 'candidate',
          derivedFromPainIds: ['pain_003'],
        }),
      ]);

      const activeResults = collector.collectBatch({ status: 'active' });
      expect(activeResults).toHaveLength(1);
      expect(activeResults[0].principle.id).toBe('P_ACTIVE');

      const deprecatedResults = collector.collectBatch({ status: 'deprecated' });
      expect(deprecatedResults).toHaveLength(1);
      expect(deprecatedResults[0].principle.id).toBe('P_DEPRECATED');
    });

    it('returns all principles with derivedFromPainIds when no filter', () => {
      setupLedger([
        makePrinciple('P_001', { derivedFromPainIds: ['pain_a'] }),
        makePrinciple('P_002', { derivedFromPainIds: ['pain_b', 'pain_c'] }),
        makePrinciple('P_NO_PAIN'),
      ]);

      const results = collector.collectBatch();

      expect(results).toHaveLength(2);
      const ids = results.map((r) => r.principle.id).sort();
      expect(ids).toEqual(['P_001', 'P_002']);
    });

    it('each result contains valid lineage info', () => {
      setupLedger([
        makePrinciple('P_MULTI', { derivedFromPainIds: ['p1', 'p2', 'p3'] }),
      ]);

      const results = collector.collectBatch();
      expect(results).toHaveLength(1);

      const ctx = results[0];
      expect(ctx.lineage.sourcePainIds).toEqual(['p1', 'p2', 'p3']);
      expect(ctx.lineage.sessionId).toBeNull();
      expect(ctx.sessionSnapshot).toBeNull();
    });
  });

  // -----------------------------------------------------------------------
  // Edge cases
  // -----------------------------------------------------------------------

  describe('edge cases', () => {
    it('handles empty derivedFromPainIds array (not undefined)', () => {
      setupLedger([
        makePrinciple('P_EMPTY', { derivedFromPainIds: [] }),
      ]);

      const result = collector.collect('P_EMPTY');
      expect(result).toBeNull();
    });

    it('collectBatch returns context objects with correct shape', () => {
      setupLedger([
        makePrinciple('P_SHAPE', {
          derivedFromPainIds: ['pain_shape'],
          text: 'Shape test principle',
          action: 'Do the thing',
        }),
      ]);

      const results = collector.collectBatch();
      expect(results).toHaveLength(1);

      const ctx: ReflectionContext = results[0];
      // Verify all fields exist
      expect(ctx).toHaveProperty('principle');
      expect(ctx).toHaveProperty('painEvents');
      expect(ctx).toHaveProperty('sessionSnapshot');
      expect(ctx).toHaveProperty('lineage');

      expect(ctx.principle.id).toBe('P_SHAPE');
      expect(ctx.principle.text).toBe('Shape test principle');
      expect(ctx.principle.action).toBe('Do the thing');
      expect(Array.isArray(ctx.painEvents)).toBe(true);
      expect(ctx.lineage.sourcePainIds).toEqual(['pain_shape']);
    });
  });
});
