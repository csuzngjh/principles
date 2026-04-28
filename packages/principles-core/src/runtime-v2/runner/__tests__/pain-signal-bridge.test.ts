/* eslint-disable @typescript-eslint/no-explicit-any */
/**
 * PainSignalBridge unit tests.
 *
 * Tests the critical buildExistingResult() behavior:
 *   - succeeded requires candidates (P8 LOCKED contract)
 *   - When autoIntakeEnabled=true, succeeded also requires ledgerEntryIds
 *   - When autoIntakeEnabled=false, succeeded is allowed without ledger entries
 */
import { describe, it, expect } from 'vitest';
import { PainSignalBridge } from '../../pain-signal-bridge.js';
import type { RuntimeStateManager, CandidateRecord } from '../../store/runtime-state-manager.js';
import type { LedgerAdapter, LedgerPrincipleEntry } from '../../candidate-intake.js';
import type { RunnerResult } from '../runner-result.js';

const TASK_ID = 'diagnosis_pain-001';
const PAIN_ID = 'pain-001';

// ── Mock implementations (plain objects, not classes) ─────────────────────

const mockCandidate = (id: string, taskId: string): CandidateRecord => ({
  candidateId: id,
  taskId,
  artifactId: `artifact-${id}`,
  sourceRunId: `run-${id}`,
  title: `Candidate ${id}`,
  description: `Description for ${id}`,
  confidence: 0.8,
  sourceRecommendationJson: '{}',
  status: 'pending',
  createdAt: new Date().toISOString(),
});

const mockLedgerEntry = (candidateId: string): LedgerPrincipleEntry => ({
  id: `ledger-${candidateId}`,
  status: 'probation',
  createdAt: new Date().toISOString(),
  text: `Principle text for ${candidateId}`,
  sourceRef: `candidate://${candidateId}`,
  title: `Principle ${candidateId}`,
  evaluability: 'weak_heuristic',
});

function makeMockStateManager(overrides: {
  candidates?: CandidateRecord[];
  runs?: { runId: string; taskId: string; status: string }[];
}): RuntimeStateManager {
  return {
    getCandidatesByTaskId: async () => overrides.candidates ?? [],
    getRunsByTask: async () => overrides.runs ?? ([] as any),
    getTask: async () => ({ taskId: TASK_ID, status: 'succeeded', leaseExpiresAt: null } as any),
  } as unknown as RuntimeStateManager;
}

function makeMockLedgerAdapter(entries: Map<string, LedgerPrincipleEntry>): LedgerAdapter {
  return {
    existsForCandidate: (candidateId: string) => entries.get(candidateId) ?? null,
  } as unknown as LedgerAdapter;
}

function makeMockRunner(): { run: (taskId: string) => Promise<RunnerResult> } {
  return {
    run: async (_taskId: string): Promise<RunnerResult> => ({
      status: 'succeeded',
      taskId: TASK_ID,
      attemptCount: 1,
    }),
  };
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('PainSignalBridge.buildExistingResult', () => {
  it('P8: succeeded requires candidates — no candidates returns failed', async () => {
    const stateManager = makeMockStateManager({ candidates: [], runs: [{ runId: 'run-1', taskId: TASK_ID, status: 'succeeded' } as any] });
    const ledgerAdapter = makeMockLedgerAdapter(new Map());
    const runner = makeMockRunner();

    const bridge = new PainSignalBridge({
      stateManager,
      runner: runner as any,
      intakeService: undefined as any,
      ledgerAdapter,
      autoIntakeEnabled: false,
    });

    const result = await (bridge as any).buildExistingResult({ painId: PAIN_ID, taskId: TASK_ID });
    expect(result.status).toBe('failed');
    expect(result.message).toContain('no principle candidates');
  });

  it('succeeded is allowed when candidates exist (autoIntakeEnabled=false, no ledger)', async () => {
    const candidates = [mockCandidate('c1', TASK_ID)];
    const stateManager = makeMockStateManager({ candidates, runs: [{ runId: 'run-1', taskId: TASK_ID, status: 'succeeded' } as any] });
    const ledgerAdapter = makeMockLedgerAdapter(new Map());
    const runner = makeMockRunner();

    const bridge = new PainSignalBridge({
      stateManager,
      runner: runner as any,
      intakeService: undefined as any,
      ledgerAdapter,
      autoIntakeEnabled: false,
    });

    const result = await (bridge as any).buildExistingResult({ painId: PAIN_ID, taskId: TASK_ID });
    expect(result.status).toBe('succeeded');
    expect(result.candidateIds).toEqual(['c1']);
    expect(result.ledgerEntryIds).toEqual([]);
  });

  it('HG-4: autoIntakeEnabled=true requires ledger entries — none exist returns failed', async () => {
    const candidates = [mockCandidate('c1', TASK_ID)];
    const stateManager = makeMockStateManager({ candidates, runs: [{ runId: 'run-1', taskId: TASK_ID, status: 'succeeded' } as any] });
    const ledgerAdapter = makeMockLedgerAdapter(new Map());
    const runner = makeMockRunner();

    const bridge = new PainSignalBridge({
      stateManager,
      runner: runner as any,
      intakeService: undefined as any,
      ledgerAdapter,
      autoIntakeEnabled: true,
    });

    const result = await (bridge as any).buildExistingResult({ painId: PAIN_ID, taskId: TASK_ID });
    expect(result.status).toBe('failed');
    expect(result.message).toContain('ledger entry');
  });

  it('HG-4: autoIntakeEnabled=true with ledger entries returns succeeded', async () => {
    const candidates = [mockCandidate('c1', TASK_ID)];
    const entries = new Map<string, LedgerPrincipleEntry>([['c1', mockLedgerEntry('c1')]]);
    const stateManager = makeMockStateManager({ candidates, runs: [{ runId: 'run-1', taskId: TASK_ID, status: 'succeeded' } as any] });
    const ledgerAdapter = makeMockLedgerAdapter(entries);
    const runner = makeMockRunner();

    const bridge = new PainSignalBridge({
      stateManager,
      runner: runner as any,
      intakeService: undefined as any,
      ledgerAdapter,
      autoIntakeEnabled: true,
    });

    const result = await (bridge as any).buildExistingResult({ painId: PAIN_ID, taskId: TASK_ID });
    expect(result.status).toBe('succeeded');
    expect(result.candidateIds).toEqual(['c1']);
    expect(result.ledgerEntryIds).toEqual(['ledger-c1']);
  });

  it('multiple candidates — all returned correctly', async () => {
    const candidates = [mockCandidate('c1', TASK_ID), mockCandidate('c2', TASK_ID)];
    const stateManager = makeMockStateManager({ candidates, runs: [{ runId: 'run-1', taskId: TASK_ID, status: 'succeeded' } as any] });
    const ledgerAdapter = makeMockLedgerAdapter(new Map());
    const runner = makeMockRunner();

    const bridge = new PainSignalBridge({
      stateManager,
      runner: runner as any,
      intakeService: undefined as any,
      ledgerAdapter,
      autoIntakeEnabled: false,
    });

    const result = await (bridge as any).buildExistingResult({ painId: PAIN_ID, taskId: TASK_ID });
    expect(result.status).toBe('succeeded');
    expect(result.candidateIds).toEqual(['c1', 'c2']);
  });

  it('runId and artifactId are populated from state', async () => {
    const candidates = [mockCandidate('c1', TASK_ID)];
    const stateManager = makeMockStateManager({ candidates, runs: [{ runId: 'run-run-1', taskId: TASK_ID, status: 'succeeded' } as any] });
    const ledgerAdapter = makeMockLedgerAdapter(new Map());
    const runner = makeMockRunner();

    const bridge = new PainSignalBridge({
      stateManager,
      runner: runner as any,
      intakeService: undefined as any,
      ledgerAdapter,
      autoIntakeEnabled: false,
    });

    const result = await (bridge as any).buildExistingResult({ painId: PAIN_ID, taskId: TASK_ID });
    expect(result.runId).toBe('run-run-1');
    expect(result.artifactId).toBe('artifact-c1');
  });
});
