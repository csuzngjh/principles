import { describe, it, expect, vi } from 'vitest';
import { PainSignalBridge, createDiagnosticianTaskId, MAX_EVIDENCE_ENTRIES, MAX_EVIDENCE_NOTE_CHARS } from '../pain-signal-bridge.js';
import type { PainDetectedData, PainEvidenceEntry } from '../pain-signal-bridge.js';
import type { RuntimeStateManager } from '../store/runtime-state-manager.js';
import type { LedgerAdapter } from '../candidate-intake.js';
import type { RunnerResult } from '../runner/runner-result.js';
import type { TaskRecord } from '../task-status.js';

function makeMockStateManager(capturedTasks: Map<string, TaskRecord>): RuntimeStateManager {
  return {
    getTask: vi.fn(async (taskId: string) => capturedTasks.get(taskId) ?? null),
    createTask: vi.fn(async (record: Omit<TaskRecord, 'createdAt' | 'updatedAt'>) => {
      const task: TaskRecord = {
        ...record,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      };
      capturedTasks.set(record.taskId, task);
      return task;
    }),
    updateTask: vi.fn(async (taskId: string, patch) => {
      const existing = capturedTasks.get(taskId);
      if (!existing) throw new Error('Task not found');
      const updated = { ...existing, ...patch, updatedAt: new Date().toISOString() };
      capturedTasks.set(taskId, updated);
      return updated;
    }),
    getCandidatesByTaskId: vi.fn(async () => []),
    getRunsByTask: vi.fn(async () => []),
    updateCandidateStatus: vi.fn(async () => { /* noop */ }),
    acquireLease: vi.fn(),
    markTaskSucceeded: vi.fn(),
    markTaskFailed: vi.fn(),
    markTaskRetryWait: vi.fn(),
    getRetryPolicy: vi.fn(() => ({ shouldRetry: () => false })),
    initialize: vi.fn(async () => { /* noop */ }),
  } as unknown as RuntimeStateManager;
}

function makeMockLedgerAdapter(): LedgerAdapter {
  return {
    existsForCandidate: vi.fn(() => null),
  } as unknown as LedgerAdapter;
}

function makeMockRunner(): { run: (taskId: string) => Promise<RunnerResult> } {
  return {
    run: async (_taskId: string): Promise<RunnerResult> => ({
      status: 'succeeded',
      taskId: _taskId,
      attemptCount: 1,
    }),
  };
}

function getDiagnosticJson(capturedTasks: Map<string, TaskRecord>, painId: string): Record<string, unknown> {
  const taskId = createDiagnosticianTaskId(painId);
  const task = capturedTasks.get(taskId);
  if (!task || !task.diagnosticJson) {
    throw new Error(`No task or diagnosticJson for painId=${painId}`);
  }
  return JSON.parse(task.diagnosticJson) as Record<string, unknown>;
}

describe('PainSignalBridge evidence persistence (PRI-255)', () => {
  it('persists pain reason into diagnosticJson when creating a new task', async () => {
    const capturedTasks = new Map<string, TaskRecord>();
    const stateManager = makeMockStateManager(capturedTasks);
    const ledgerAdapter = makeMockLedgerAdapter();
    const runner = makeMockRunner();

    const bridge = new PainSignalBridge({
      stateManager,
      runner: runner,
      intakeService: undefined as never,
      ledgerAdapter,
      autoIntakeEnabled: false,
    });

    const painData: PainDetectedData = {
      painId: 'manual_123_test',
      painType: 'user_frustration',
      source: 'manual',
      reason: 'Before declaring a user journey complete verify the full observable product surface',
      score: 90,
      sessionId: 'cli',
      agentId: 'pd-cli',
      provenance: 'owner_reported_no_host_trace',
    };

    await bridge.onPainDetected(painData);

    const dj = getDiagnosticJson(capturedTasks, painData.painId);
    expect(dj.sourcePainId).toBe('manual_123_test');
    expect(dj.reasonSummary).toBe('Before declaring a user journey complete verify the full observable product surface');
    expect(dj.source).toBe('manual');
    expect(dj.severity).toBe('severe');
    expect(dj.sessionIdHint).toBe('cli');
    expect(dj.agentIdHint).toBe('pd-cli');
    expect(dj.provenance).toBe('owner_reported_no_host_trace');
    expect(dj.provenanceReason).toContain('No authenticated host session provenance');
  });

  it('sets provenance to openclaw_context_bound when session is a real OpenClaw session', async () => {
    const capturedTasks = new Map<string, TaskRecord>();
    const stateManager = makeMockStateManager(capturedTasks);
    const ledgerAdapter = makeMockLedgerAdapter();
    const runner = makeMockRunner();

    const bridge = new PainSignalBridge({
      stateManager,
      runner: runner,
      intakeService: undefined as never,
      ledgerAdapter,
      autoIntakeEnabled: false,
    });

    const painData: PainDetectedData = {
      painId: 'pain_456_real',
      painType: 'user_frustration',
      source: 'pain',
      reason: 'User intervention: fix the bug',
      score: 100,
      sessionId: 'sess-abc-123',
      agentId: 'main',
      provenance: 'host_context_bound',
    };

    await bridge.onPainDetected(painData);

    const dj = getDiagnosticJson(capturedTasks, painData.painId);
    expect(dj.provenance).toBe('host_context_bound');
    expect(dj.provenanceReason).toContain('authenticated host session');
    expect(dj.sessionIdHint).toBe('sess-abc-123');
  });

  it('sets provenance to automatic_hook for hook-detected pain', async () => {
    const capturedTasks = new Map<string, TaskRecord>();
    const stateManager = makeMockStateManager(capturedTasks);
    const ledgerAdapter = makeMockLedgerAdapter();
    const runner = makeMockRunner();

    const bridge = new PainSignalBridge({
      stateManager,
      runner: runner,
      intakeService: undefined as never,
      ledgerAdapter,
      autoIntakeEnabled: false,
    });

    const painData: PainDetectedData = {
      painId: 'pain_789_hook',
      painType: 'tool_failure',
      source: 'write',
      reason: 'Tool write failed on src/main.ts',
      score: 60,
      sessionId: 'sess-hook-123',
      agentId: 'main',
      provenance: 'automatic_hook',
      evidence: [{ sourceRef: 'test-hook', note: 'Hook evidence entry' }],
    };

    await bridge.onPainDetected(painData);

    const dj = getDiagnosticJson(capturedTasks, painData.painId);
    expect(dj.provenance).toBe('automatic_hook');
    expect(dj.provenanceReason).toContain('automatic hook');
  });

  it('infers owner_reported_no_host_trace when manual source with cli session', async () => {
    const capturedTasks = new Map<string, TaskRecord>();
    const stateManager = makeMockStateManager(capturedTasks);
    const ledgerAdapter = makeMockLedgerAdapter();
    const runner = makeMockRunner();

    const bridge = new PainSignalBridge({
      stateManager,
      runner: runner,
      intakeService: undefined as never,
      ledgerAdapter,
      autoIntakeEnabled: false,
    });

    const painData: PainDetectedData = {
      painId: 'pain_infer_cli',
      painType: 'user_frustration',
      source: 'manual',
      reason: 'CLI test reason',
      score: 80,
      sessionId: 'cli',
    };

    await bridge.onPainDetected(painData);

    const dj = getDiagnosticJson(capturedTasks, painData.painId);
    expect(dj.provenance).toBe('owner_reported_no_host_trace');
  });

  it('infers owner_reported_no_host_trace when manual source with unknown sessionId', async () => {
    const capturedTasks = new Map<string, TaskRecord>();
    const stateManager = makeMockStateManager(capturedTasks);
    const ledgerAdapter = makeMockLedgerAdapter();
    const runner = makeMockRunner();

    const bridge = new PainSignalBridge({
      stateManager,
      runner: runner,
      intakeService: undefined as never,
      ledgerAdapter,
      autoIntakeEnabled: false,
    });

    const painData: PainDetectedData = {
      painId: 'pain_infer_unknown_session',
      painType: 'user_frustration',
      source: 'manual',
      reason: 'Manual report with unknown session',
      score: 85,
      sessionId: 'unknown',
    };

    await bridge.onPainDetected(painData);

    const dj = getDiagnosticJson(capturedTasks, painData.painId);
    expect(dj.provenance).toBe('owner_reported_no_host_trace');
    expect(dj.provenanceReason).toContain('No authenticated host session provenance');
  });

  it('maps score to severity correctly', async () => {
    const capturedTasks = new Map<string, TaskRecord>();
    const stateManager = makeMockStateManager(capturedTasks);
    const ledgerAdapter = makeMockLedgerAdapter();
    const runner = makeMockRunner();

    const bridge = new PainSignalBridge({
      stateManager,
      runner: runner,
      intakeService: undefined as never,
      ledgerAdapter,
      autoIntakeEnabled: false,
    });

    const scores: [number, string][] = [
      [90, 'severe'],
      [70, 'severe'],
      [69, 'moderate'],
      [40, 'moderate'],
      [39, 'mild'],
      [0, 'mild'],
    ];

    for (const [score, expectedSeverity] of scores) {
      const painId = `pain_score_${score}`;
      const painData: PainDetectedData = {
        painId,
        painType: 'user_frustration',
        source: 'manual',
        reason: `Score ${score} test`,
        score,
        sessionId: 'cli',
      };

      await bridge.onPainDetected(painData);

      const dj = getDiagnosticJson(capturedTasks, painId);
      expect(dj.severity).toBe(expectedSeverity);
    }
  });
});

describe('PainSignalBridge evidence field (PRI-277)', () => {
  it('persists evidence entries into diagnosticJson', async () => {
    const capturedTasks = new Map<string, TaskRecord>();
    const stateManager = makeMockStateManager(capturedTasks);
    const ledgerAdapter = makeMockLedgerAdapter();
    const runner = makeMockRunner();

    const bridge = new PainSignalBridge({
      stateManager,
      runner: runner,
      intakeService: undefined as never,
      ledgerAdapter,
      autoIntakeEnabled: false,
    });

    const evidence: PainEvidenceEntry[] = [
      { sourceRef: 'owner_message:2026-05-30T12:00:00Z', note: '错了，重写' },
      { sourceRef: 'agent_turn:2026-05-30T12:00:05Z', note: 'I will modify the config file' },
    ];

    const painData: PainDetectedData = {
      painId: 'pain_evidence_test',
      painType: 'tool_failure',
      source: 'write',
      reason: 'Tool write failed on config.ts',
      score: 60,
      sessionId: 'sess-evidence',
      provenance: 'automatic_hook',
      evidence,
    };

    await bridge.onPainDetected(painData);

    const dj = getDiagnosticJson(capturedTasks, painData.painId);
    expect(Array.isArray(dj.evidence)).toBe(true);
    const ev = dj.evidence as PainEvidenceEntry[];
    expect(ev).toHaveLength(2);
    expect(ev[0]?.sourceRef).toBe('owner_message:2026-05-30T12:00:00Z');
    expect(ev[0]?.note).toBe('错了，重写');
    expect(ev[1]?.sourceRef).toBe('agent_turn:2026-05-30T12:00:05Z');
  });

  it('defaults evidence to empty array when not provided', async () => {
    const capturedTasks = new Map<string, TaskRecord>();
    const stateManager = makeMockStateManager(capturedTasks);
    const ledgerAdapter = makeMockLedgerAdapter();
    const runner = makeMockRunner();

    const bridge = new PainSignalBridge({
      stateManager,
      runner: runner,
      intakeService: undefined as never,
      ledgerAdapter,
      autoIntakeEnabled: false,
    });

    const painData: PainDetectedData = {
      painId: 'pain_no_evidence',
      painType: 'tool_failure',
      source: 'manual',
      reason: 'No evidence test',
      score: 40,
      sessionId: 'sess-noev',
      provenance: 'owner_reported_no_host_trace',
    };

    await bridge.onPainDetected(painData);

    const dj = getDiagnosticJson(capturedTasks, painData.painId);
    expect(Array.isArray(dj.evidence)).toBe(true);
    expect((dj.evidence as unknown[]).length).toBe(0);
  });

  it('respects MAX_EVIDENCE_ENTRIES constant', () => {
    // PRI-359: Increased from 4 to 8 to accommodate failed tool_calls evidence
    expect(MAX_EVIDENCE_ENTRIES).toBe(8);
  });

  it('respects MAX_EVIDENCE_NOTE_CHARS constant', () => {
    expect(MAX_EVIDENCE_NOTE_CHARS).toBe(200);
  });

  it('evidence entries have correct shape', async () => {
    const capturedTasks = new Map<string, TaskRecord>();
    const stateManager = makeMockStateManager(capturedTasks);
    const ledgerAdapter = makeMockLedgerAdapter();
    const runner = makeMockRunner();

    const bridge = new PainSignalBridge({
      stateManager,
      runner: runner,
      intakeService: undefined as never,
      ledgerAdapter,
      autoIntakeEnabled: false,
    });

    const longNote = 'A'.repeat(300);
    const evidence: PainEvidenceEntry[] = [
      { sourceRef: 'owner_message:2026-05-30T12:00:00Z', note: longNote },
    ];

    const painData: PainDetectedData = {
      painId: 'pain_long_note',
      painType: 'user_frustration',
      source: 'manual',
      reason: 'Long note test',
      score: 80,
      sessionId: 'sess-long',
      evidence,
    };

    await bridge.onPainDetected(painData);

    const dj = getDiagnosticJson(capturedTasks, painData.painId);
    const ev = dj.evidence as PainEvidenceEntry[];
    expect(ev[0]?.note).toBe(longNote);
  });
});
