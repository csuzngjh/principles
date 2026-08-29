/**
 * Attack-style E2E smoke tests for the full PD pipeline.
 *
 * PURPOSE: Discover hidden bugs by injecting LLM output failures at each
 * pipeline handoff point. These tests do NOT validate happy paths — they
 * attack the system's ability to degrade safely when LLM output is unreliable.
 *
 * Pipeline under test:
 *   PainSignalBridge → DiagnosticianRunner → CandidateIntakeService
 *   → InternalizationOrchestrator → DreamerRunner → RolloutReviewerRunner
 *   → ActivationDispatcher → RuleHostWriter → gate.ts
 *
 * Key attack surfaces:
 *   1. fetchAndParseOutput() uses `as` type assertions (no runtime validation)
 *   2. PITaskRecord hydration from JSON can silently fail
 *   3. LLM output can be malformed, partial, or semantically contradictory
 *   4. Pipeline can stall in blocked/retry_wait without alerting
 */
/* eslint-disable @typescript-eslint/class-methods-use-this */
/* eslint-disable @typescript-eslint/no-non-null-assertion */
/* eslint-disable @typescript-eslint/max-params */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { RuntimeStateManager } from '../store/runtime-state-manager.js';
import { SqliteContextAssembler } from '../store/context/sqlite-context-assembler.js';
import { SqliteHistoryQuery } from '../store/history/sqlite-history-query.js';
import type { StoreEventEmitter } from '../store/event-emitter.js';
import { SplitDiagnosticianRunner } from '../internalization/split-diagnostician-runner.js';
import { DiagRootCauseRunner } from '../internalization/diag-rootcause-runner.js';
import { DiagDistillerRunner } from '../internalization/diag-distiller-runner.js';
import { DiagRouterRunner } from '../internalization/diag-router-runner.js';
import { DefaultDiagRootCauseValidator } from '../diagnostician/diag-rootcause-output.js';
import { DefaultDiagDistillerValidator } from '../diagnostician/diag-distiller-output.js';
import { type DiagnosticianRunnerLike } from '../pain-signal-bridge.js';
import { SqliteDiagnosticianCommitter } from '../store/commit/diagnostician-committer.js';
import type { DiagnosticianOutputV1 } from '../diagnostician-output.js';
import type { PDRuntimeAdapter, RunHandle, RunStatus, StartRunInput, StructuredRunOutput, RuntimeKind, RuntimeCapabilities, RuntimeHealth, RuntimeArtifactRef, ContextItem } from '../runtime-protocol.js';
import { PainSignalBridge } from '../pain-signal-bridge.js';
import { CandidateIntakeService } from '../candidate-intake-service.js';
import type { LedgerAdapter, LedgerPrincipleEntry } from '../candidate-intake.js';
import { InternalizationOrchestrator } from '../internalization/internalization-orchestrator.js';
import { decideInternalizationRoute } from '../internalization/internalization-route.js';
import { computeBridgeDecision } from '../internalization/intake-to-internalization-bridge.js';
import { hydratePITaskRecord } from '../internalization/pitask-metadata.js';
import { createPITaskDiagnosticJson } from '../internalization/pitask-metadata.js';
import { validateCorrectionProposal } from '../internalization/correction-proposal.js';
import { PDRuntimeError } from '../error-categories.js';
import type { TaskRecord } from '../task-status.js';
import { SqliteConnection } from '../store/sqlite-connection.js';
import type { RetryPolicy } from '../store/lifecycle/retry-policy.js';

vi.mock('@earendil-works/pi-ai/compat', () => ({
  getModel: vi.fn(),
  getProviders: vi.fn(() => ['openrouter', 'anthropic', 'openai']),
  complete: vi.fn(),
}));

// Fast retry policy for tests — production DefaultRetryPolicy uses 30s base delay
// which causes test timeouts when sub-runners return 'retried'
const fastRetryPolicy: RetryPolicy = {
  calculateBackoff: () => 10, // 10ms — instant for tests
  shouldRetry: (task) => task.attemptCount < task.maxAttempts,
  markRetryWait: vi.fn(),
  markFailed: vi.fn(),
};

class InMemoryLedgerAdapter implements LedgerAdapter {
  private readonly entries = new Map<string, LedgerPrincipleEntry>();
  writeProbationEntry(entry: LedgerPrincipleEntry): LedgerPrincipleEntry {
    const candidateId = InMemoryLedgerAdapter.extractCandidateId(entry.sourceRef);
    const existing = this.existsForCandidate(candidateId);
    if (existing) return existing;
    this.entries.set(candidateId, entry);
    return entry;
  }
  existsForCandidate(candidateId: string): LedgerPrincipleEntry | null {
    return this.entries.get(candidateId) ?? null;
  }
  private static extractCandidateId(sourceRef: string): string {
    return sourceRef.startsWith('candidate://') ? sourceRef.slice('candidate://'.length) : sourceRef;
  }
}

class MockRuntimeAdapter implements PDRuntimeAdapter {
  private runCounter = 0;
  private readonly runs = new Map<string, { status: RunStatus; output: StructuredRunOutput | null }>();
  public nextOutput: unknown = null;
  public stateManager?: RuntimeStateManager;
  public stageOutputs?: {
    rootcause?: unknown;
    distiller?: unknown;
    router?: unknown;
  };
  public shouldThrowOnStart = false;
  public shouldThrowOnFetch = false;

  kind(): RuntimeKind { return 'pi-ai'; }

  async getCapabilities(): Promise<RuntimeCapabilities> {
    return {
      supportsStructuredJsonOutput: true,
      supportsToolUse: true,
      supportsWorkingDirectory: true,
      supportsModelSelection: true,
      supportsLongRunningSessions: false,
      supportsCancellation: true,
      supportsArtifactWriteBack: false,
      supportsConcurrentRuns: false,
      supportsStreaming: false,
    };
  }

  async healthCheck(): Promise<RuntimeHealth> {
    return { healthy: true, degraded: false, warnings: [], lastCheckedAt: new Date().toISOString() };
  }

  async startRun(input: StartRunInput): Promise<RunHandle> {
    if (this.shouldThrowOnStart) {
      throw new PDRuntimeError('execution_failed', 'Mock: startRun failed');
    }
    const runId = `run-mock-${++this.runCounter}`;
    const status: RunStatus = { runId, status: 'succeeded', startedAt: new Date().toISOString() };

    const taskId = input.taskRef?.taskId ?? '';
    let payload = this.nextOutput;
    if (this.stageOutputs && (this.stageOutputs.rootcause || this.stageOutputs.distiller || this.stageOutputs.router)) {
      if (taskId.includes('diag_rootcause')) {
        payload = this.stageOutputs.rootcause;
      } else if (taskId.includes('diag_distiller')) {
        payload = this.stageOutputs.distiller;
      } else if (taskId.includes('diag_router')) {
        payload = this.stageOutputs.router;
      }
    } else if (payload !== null && payload !== undefined && typeof payload !== 'string') {
      // Fallback: if nextOutput is set and looks like a final router output, but we need
      // rootcause/distiller to succeed first, we can return valid dummy objects for rootcause/distiller.
      if (taskId.includes('diag_rootcause')) {
        payload = {
          valid: true,
          diagnosisId: 'diag-mock',
          taskId: taskId,
          summary: 'Mock rootcause summary',
          causalChain: [{ why: 1, statement: 'why', evidenceRefs: ['ref-1'] }],
          rootCause: 'Design: Mock rootcause',
          rootCauseCategory: 'Design',
          evidence: [{ sourceRef: 'ref-1', note: 'note' }],
          confidence: 0.9,
        };
      } else if (taskId.includes('diag_distiller')) {
        const parentTaskId = taskId.replace('diag_distiller-', '');
        const stageATaskId = `diag_rootcause-${parentTaskId}`;
        const artifacts = this.stateManager
          ? await this.stateManager.piArtifactStore.listBySourceTaskId(stageATaskId)
          : [];
        const sourceRootCauseArtifactId = artifacts[0]?.artifactId ?? 'art-rc';
        payload = {
          valid: true,
          taskId: taskId,
          sourceRootCauseArtifactId,
          abstractedPrinciple: 'Mock abstracted principle',
          rationale: 'Mock rationale',
          groundedOnCorePrincipleIds: ['T-01'],
          scope: 'domain',
          confidence: 0.9,
        };
      }
    }

    const output: StructuredRunOutput | null = payload
      ? { runId, payload }
      : null;
    this.runs.set(runId, { status, output });
    return { runId, runtimeKind: 'pi-ai', startedAt: new Date().toISOString() };
  }

  async pollRun(runId: string): Promise<RunStatus> {
    const run = this.runs.get(runId);
    return run?.status ?? { runId, status: 'failed' };
  }

  async fetchOutput(runId: string): Promise<StructuredRunOutput | null> {
    if (this.shouldThrowOnFetch) {
      throw new PDRuntimeError('output_invalid', 'Mock: fetchOutput failed');
    }
    const run = this.runs.get(runId);
    return run?.output ?? null;
  }

  async cancelRun(_runId: string): Promise<void> { void _runId; }
  async fetchArtifacts(_runId: string): Promise<RuntimeArtifactRef[]> { void _runId; return []; }
  async appendContext?(_runId: string, _items: ContextItem[]): Promise<void> { void _runId; void _items; }
}

function makeDiagnosticianOutput(overrides?: Partial<DiagnosticianOutputV1>): DiagnosticianOutputV1 {
  return {
    valid: true,
    diagnosisId: `diag-attack-${Date.now()}`,
    summary: 'Attack test diagnosis',
    rootCause: 'Attack test root cause',
    violatedPrinciples: [],
    evidence: [{ sourceRef: 'test', note: 'Attack test evidence' }],
    recommendations: [
      { kind: 'principle', description: 'Always validate inputs before processing', abstractedPrinciple: 'Always validate inputs before processing' },
    ],
    confidence: 0.9,
    ...overrides,
  };
}

function makeSplitRunner(
  stateManager: RuntimeStateManager,
  connection: SqliteConnection,
  mockAdapter: MockRuntimeAdapter,
  committer: SqliteDiagnosticianCommitter,
  options: { owner?: string; runtimeKind?: RuntimeKind; pollIntervalMs?: number; timeoutMs?: number } = {},
): DiagnosticianRunnerLike {
  const eventEmitter = { emitTelemetry: vi.fn() } as unknown as StoreEventEmitter;
  const contextAssembler = new SqliteContextAssembler(
    stateManager.taskStore,
    new SqliteHistoryQuery(connection),
    stateManager.runStore,
  );

  const rootCauseRunner = new DiagRootCauseRunner(
    {
      stateManager,
      runtimeAdapter: mockAdapter,
      eventEmitter,
      artifactStore: stateManager.piArtifactStore,
      validator: new DefaultDiagRootCauseValidator(),
      contextAssembler,
    },
    {
      owner: options.owner ?? 'attack-test',
      runtimeKind: options.runtimeKind ?? 'pi-ai',
      pollIntervalMs: options.pollIntervalMs ?? 10,
      timeoutMs: options.timeoutMs ?? 5000,
    },
  );

  const distillerRunner = new DiagDistillerRunner(
    {
      stateManager,
      runtimeAdapter: mockAdapter,
      eventEmitter,
      artifactStore: stateManager.piArtifactStore,
      validator: new DefaultDiagDistillerValidator(),
    },
    {
      owner: options.owner ?? 'attack-test',
      runtimeKind: options.runtimeKind ?? 'pi-ai',
      pollIntervalMs: options.pollIntervalMs ?? 10,
      timeoutMs: options.timeoutMs ?? 5000,
    },
  );

  const routerRunner = new DiagRouterRunner(
    {
      stateManager,
      runtimeAdapter: mockAdapter,
      eventEmitter,
      artifactStore: stateManager.piArtifactStore,
      committer,
    },
    {
      owner: options.owner ?? 'attack-test',
      runtimeKind: options.runtimeKind ?? 'pi-ai',
      pollIntervalMs: options.pollIntervalMs ?? 10,
      timeoutMs: options.timeoutMs ?? 5000,
    },
  );

  return new SplitDiagnosticianRunner({
    rootCauseRunner,
    distillerRunner,
    routerRunner,
    stateManager,
    committer,
    perStageTimeoutMs: options.timeoutMs ?? 5000,
    retryPolicy: fastRetryPolicy,
  });
}

describe('Attack E2E: LLM output unreliability across pipeline handoffs', () => {
  let tmpDir = '';
  let stateManager: RuntimeStateManager = null!;
  let mockAdapter: MockRuntimeAdapter = null!;
  let ledgerAdapter: InMemoryLedgerAdapter = null!;
  let connection: SqliteConnection = null!;
  let committer: SqliteDiagnosticianCommitter = null!;

  beforeEach(async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pd-attack-e2e-'));
    stateManager = new RuntimeStateManager({ workspaceDir: tmpDir });
    await stateManager.initialize();
    mockAdapter = new MockRuntimeAdapter();
    mockAdapter.stateManager = stateManager;
    ledgerAdapter = new InMemoryLedgerAdapter();
    connection = new SqliteConnection(tmpDir);
    committer = new SqliteDiagnosticianCommitter(connection);
  });

  afterEach(async () => {
    try {
      await stateManager.close?.();
      connection.close();
    } catch (e) { void e; }
    try {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    } catch (e) { void e; }
  });

  it('ATTACK-1: LLM returns malformed JSON — diagnostician must fail loud, not stall', async () => {
    mockAdapter.nextOutput = 'this is not json at all';

    const runner = makeSplitRunner(stateManager, connection, mockAdapter, committer, { owner: 'attack-test', runtimeKind: 'pi-ai', pollIntervalMs: 10, timeoutMs: 5000 });

    const taskId = 'attack_malformed_json';
    await stateManager.createTask({
      taskId,
      taskKind: 'diagnostician',
      inputRef: 'pain_attack_1',
      status: 'pending',
      attemptCount: 0,
      maxAttempts: 1,
    });

    const result = await runner.run(taskId);

    expect(result.status).not.toBe('succeeded');
    expect(result.status).toMatch(/^(failed|retried)$/);

    const task = await stateManager.getTask(taskId);
    expect(task).toBeDefined();
    if (task) {
      expect(task.status).not.toBe('leased');
    }
  });

  it('ATTACK-2: LLM returns valid JSON but missing required fields — validator must reject', async () => {
    mockAdapter.nextOutput = {
      valid: true,
      diagnosisId: 'diag-incomplete',
    };

    const runner = makeSplitRunner(stateManager, connection, mockAdapter, committer, { owner: 'attack-test', runtimeKind: 'pi-ai', pollIntervalMs: 10, timeoutMs: 5000 });

    const taskId = 'attack_missing_fields';
    await stateManager.createTask({
      taskId,
      taskKind: 'diagnostician',
      inputRef: 'pain_attack_2',
      status: 'pending',
      attemptCount: 0,
      maxAttempts: 1,
    });

    const result = await runner.run(taskId);

    expect(result.status).not.toBe('succeeded');
  });

  it('ATTACK-3: LLM returns kind=rule without triggerPattern — route must mark not_ready', () => {
    const recommendation = {
      kind: 'rule' as const,
      description: 'A rule without trigger or action',
    };

    const routeDecision = decideInternalizationRoute(recommendation);

    expect(routeDecision.ready).toBe(false);
    expect(routeDecision.missingFields).toContain('triggerPattern');
    expect(routeDecision.missingFields).toContain('action');
    expect(routeDecision.route).toBe('rule-candidate');
  });

  it('ATTACK-4: PITask diagnosticJson with partial metadata — orchestrator must not stall', async () => {
    const taskId = 'attack_bad_hydration';
    const badDiagnosticJson = JSON.stringify({
      pi_metadata: {
        dependencyTaskIds: [],
        channel: 'prompt',
        timeoutMs: 60000,
        inputArtifactRefs: [],
        outputArtifactRefs: [],
      },
      candidateId: 'cand_attack_4',
    });

    await stateManager.createTask({
      taskId,
      taskKind: 'dreamer',
      inputRef: 'pain_attack_4',
      status: 'pending',
      attemptCount: 0,
      maxAttempts: 3,
      diagnosticJson: badDiagnosticJson,
    });

    const task = await stateManager.getTask(taskId);
    if (!task) { expect.unreachable('task should exist'); return; }
    const piTask = hydratePITaskRecord(task);

    expect(piTask).not.toBeNull();
    if (piTask) {
      expect(piTask.channel).toBe('prompt');
    }

    const orchestrator = new InternalizationOrchestrator(
      { stateManager },
      { owner: 'attack-test', runtimeKind: 'pi-ai' },
    );

    const result = await orchestrator.wakeOnce();

    expect(result.decision).toMatch(/^(leased|no_ready_tasks|blocked)$/);
  });

  it('ATTACK-5: correctionProposal semantic contradiction — correctedFields vs proposedParams mismatch', () => {
    const proposal = {
      proposedParams: { content: 'fixed' },
      correctedFields: [
        { field: 'content', original: 'broken', proposed: 'fixed', reason: 'fix' },
        { field: 'file_path', original: '/old/path', proposed: '/new/path', reason: 'fix path' },
      ],
      applicationMode: 'live' as const,
      confidence: 0.9,
      ruleId: 'R_attack_5',
      notifyAgent: false,
    };

    const validation = validateCorrectionProposal(proposal);

    expect(validation.valid).toBe(false);
    expect(validation.errors.some((e: string) => e.includes('file_path'))).toBe(true);
  });

  it('ATTACK-6: LLM returns empty recommendations — bridge must report failure, not silent success', async () => {
    mockAdapter.nextOutput = makeDiagnosticianOutput({
      recommendations: [],
    });

    const runner = makeSplitRunner(stateManager, connection, mockAdapter, committer, { owner: 'attack-test', runtimeKind: 'pi-ai', pollIntervalMs: 10, timeoutMs: 5000 });

    const intakeService = new CandidateIntakeService({
      stateManager,
      ledgerAdapter,
    });

    const bridge = new PainSignalBridge({
      stateManager,
      runner,
      intakeService,
      ledgerAdapter,
      autoIntakeEnabled: true,
    });

    const result = await bridge.onPainDetected({
      painId: 'pain_attack_6',
      painType: 'tool_failure',
      source: 'write',
      reason: 'Attack test: empty recommendations',
      evidence: [{ sourceRef: 'test', note: 'Attack test evidence' }],
    });

    expect(result.status).toMatch(/^(failed|retried)$/);
    expect(result.candidateIds).toEqual([]);
  });

  it('ATTACK-7: LLM returns unknown recommendation kind — route must defer safely', () => {
    const recommendation = {
      kind: 'unknown_kind' as 'prompt' | 'principle' | 'rule' | 'implementation' | 'defer',
      description: 'An unknown recommendation type',
    };

    const routeDecision = decideInternalizationRoute(recommendation);

    expect(routeDecision.ready).toBe(false);
    expect(routeDecision.route).toBe('deferred');
    expect(routeDecision.reason).toContain('Unrecognized');
  });

  it('ATTACK-8: PITask with missing channel — hydration must fail, not produce invalid record', () => {
    const badDiagnosticJson = JSON.stringify({
      dependencyTaskIds: [],
      timeoutMs: 60000,
      inputArtifactRefs: [],
      outputArtifactRefs: [],
      rejectionCount: 0,
    });

    const task: TaskRecord = {
      taskId: 'task_missing_channel',
      taskKind: 'dreamer',
      status: 'pending',
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      attemptCount: 0,
      maxAttempts: 3,
      diagnosticJson: badDiagnosticJson,
    };

    const piTask = hydratePITaskRecord(task);

    expect(piTask).toBeNull();
  });

  it('ATTACK-9: Concurrent pain signals — same painId twice must not create duplicate tasks', async () => {
    mockAdapter.nextOutput = makeDiagnosticianOutput();

    const runner = makeSplitRunner(stateManager, connection, mockAdapter, committer, { owner: 'attack-test', runtimeKind: 'pi-ai', pollIntervalMs: 10, timeoutMs: 5000 });

    const intakeService = new CandidateIntakeService({
      stateManager,
      ledgerAdapter,
    });

    const bridge = new PainSignalBridge({
      stateManager,
      runner,
      intakeService,
      ledgerAdapter,
      autoIntakeEnabled: true,
    });

    const painData = {
      painId: 'pain_duplicate_9',
      painType: 'tool_failure' as const,
      source: 'write',
      reason: 'Duplicate pain test',
      evidence: [{ sourceRef: 'attack-test', note: 'Attack test evidence entry' }],
    };

    await bridge.onPainDetected(painData);

    mockAdapter.nextOutput = makeDiagnosticianOutput();
    const result2 = await bridge.onPainDetected(painData);

    expect(result2.status).toMatch(/^(succeeded|skipped)$/);
    if (result2.status === 'succeeded') {
      expect(result2.message).toContain('already succeeded');
    }
  });

  it('ATTACK-10: LLM returns oversized output — system must not OOM or hang', async () => {
    const hugeRecommendations = Array.from({ length: 500 }, (_, i) => ({
      kind: 'principle' as const,
      description: `Principle ${i}: `.repeat(20),
    }));

    mockAdapter.nextOutput = makeDiagnosticianOutput({
      recommendations: hugeRecommendations,
    });

    const runner = makeSplitRunner(stateManager, connection, mockAdapter, committer, { owner: 'attack-test', runtimeKind: 'pi-ai', pollIntervalMs: 10, timeoutMs: 5000 });

    const taskId = 'attack_oversized';
    await stateManager.createTask({
      taskId,
      taskKind: 'diagnostician',
      inputRef: 'pain_attack_10',
      status: 'pending',
      attemptCount: 0,
      maxAttempts: 1,
    });

    const result = await runner.run(taskId);

    expect(result.status).toMatch(/^(succeeded|failed|retried)$/);

    const task = await stateManager.getTask(taskId);
    expect(task).toBeDefined();
    if (task) {
      expect(task.status).not.toBe('leased');
    }
  });

  it('ATTACK-11: fetchOutput throws — runner must transition task out of leased', async () => {
    mockAdapter.shouldThrowOnFetch = true;
    mockAdapter.nextOutput = makeDiagnosticianOutput();

    const runner = makeSplitRunner(stateManager, connection, mockAdapter, committer, { owner: 'attack-test', runtimeKind: 'pi-ai', pollIntervalMs: 10, timeoutMs: 5000 });

    const taskId = 'attack_fetch_throws';
    await stateManager.createTask({
      taskId,
      taskKind: 'diagnostician',
      inputRef: 'pain_attack_11',
      status: 'pending',
      attemptCount: 0,
      maxAttempts: 1,
    });

    const result = await runner.run(taskId);

    expect(result.status).not.toBe('succeeded');

    const task = await stateManager.getTask(taskId);
    expect(task).toBeDefined();
    if (task) {
      expect(task.status).not.toBe('leased');
    }
  });

  it('ATTACK-12: LLM returns non-object payload — runner must reject, not crash', async () => {
    mockAdapter.nextOutput = 'just a string';

    const runner = makeSplitRunner(stateManager, connection, mockAdapter, committer, { owner: 'attack-test', runtimeKind: 'pi-ai', pollIntervalMs: 10, timeoutMs: 5000 });

    const taskId = 'attack_non_object';
    await stateManager.createTask({
      taskId,
      taskKind: 'diagnostician',
      inputRef: 'pain_attack_12',
      status: 'pending',
      attemptCount: 0,
      maxAttempts: 1,
    });

    const result = await runner.run(taskId);

    expect(result.status).not.toBe('succeeded');

    const task = await stateManager.getTask(taskId);
    expect(task).toBeDefined();
    if (task) {
      expect(task.status).not.toBe('leased');
    }
  });

  it('ATTACK-13: LLM returns null payload — runner must fail loud', async () => {
    mockAdapter.nextOutput = null;

    const runner = makeSplitRunner(stateManager, connection, mockAdapter, committer, { owner: 'attack-test', runtimeKind: 'pi-ai', pollIntervalMs: 10, timeoutMs: 5000 });

    const taskId = 'attack_null_payload';
    await stateManager.createTask({
      taskId,
      taskKind: 'diagnostician',
      inputRef: 'pain_attack_13',
      status: 'pending',
      attemptCount: 0,
      maxAttempts: 1,
    });

    const result = await runner.run(taskId);

    expect(result.status).not.toBe('succeeded');
  });

  it('ATTACK-14: IntakeToInternalizationBridge — unknown route must not enter pipeline', () => {
    const decision = computeBridgeDecision({
      candidateId: 'cand_attack_14',
      recommendationKind: 'unknown_kind',
      route: 'deferred',
      ready: true,
    });

    expect(decision.decision).toBe('not_internalizable');
    if (decision.decision === 'not_internalizable') {
      expect(decision.reason).toContain('deferred');
    }
  });

  it('ATTACK-15: PITask with wrong taskKind — hydration rejects non-peer-runner kinds (bug fixed)', () => {
    const task: TaskRecord = {
      taskId: 'task_wrong_kind',
      taskKind: 'diagnostician',
      status: 'pending',
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      attemptCount: 0,
      maxAttempts: 3,
      diagnosticJson: createPITaskDiagnosticJson({
        dependencyTaskIds: [],
        channel: 'prompt',
        timeoutMs: 60000,
        inputArtifactRefs: [],
        outputArtifactRefs: [],
      }),
    };

    const piTask = hydratePITaskRecord(task);

    // hydratePITaskRecord now rejects non-peer-runner task kinds at the hydration
    // boundary, closing the gap where a diagnostician task with valid pi_metadata
    // could be treated as a PITaskRecord by the InternalizationOrchestrator.
    expect(piTask).toBeNull();
  });
});
