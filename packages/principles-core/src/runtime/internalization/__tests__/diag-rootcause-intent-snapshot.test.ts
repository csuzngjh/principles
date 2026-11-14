/**
 * DiagRootCauseRunner — IntentSnapshot persistence & retry consistency.
 *
 * SPEC-PD-STRATEGIC-INTENT-ANCHORING-001 v1.2 §6.2 / §6.3 / §6.6 and
 * TECH-PD-STRATEGIC-INTENT-ANCHORING-001 v1.1 §3.3 / §3.4 / §3.5 / §5.4.
 *
 * The contract under test:
 *   capture → persist to task input (CAS) → THEN call the model
 *   retry    → reuse the persisted snapshot, never re-read INTENT.md
 *   artifact → `intentSnapshot` sibling key, server hash is authoritative
 *   corrupt  → fail closed; flag off → nothing is read and nothing is written
 *
 * These are runner-level tests with a runtime double: the model is NOT real,
 * so they prove wiring/ordering, not model behaviour (that distinction is
 * recorded in the phase report; real-host acceptance is Phase 4).
 */
import { describe, it, expect, vi } from 'vitest';
import type { Mock } from 'vitest';
import { DiagRootCauseRunner } from '../diag-rootcause-runner.js';
import type { DiagRootCauseRunnerDeps } from '../diag-rootcause-runner.js';
import type { DiagRootCauseOutputV1 } from '../../diagnostician/diag-rootcause-output.js';
import type { IntentDocReader } from '../../intent/intent-doc-reader-port.js';
import { MemoryPIArtifactStore } from '../pi-artifact-store.js';
import { fencedStateManager } from '../../__tests__/fixtures/fenced-state-manager.js';
import type { RunHandle, RunStatus } from '../../runtime-protocol.js';
import type { TaskRecord } from '../../task-status.js';
import { createPITaskDiagnosticJson } from '../pitask-metadata.js';
import { MOCK_ROOT_CAUSE_OUTPUTS } from '../../adapter/split-pipeline-fixtures.js';
import type { EffectivePdConfig } from '../../config/pd-config-types.js';
import { getDefaultPdConfig } from '../../config/pd-config-defaults.js';
import { resolveProfile } from '../../config/pd-profile-constants.js';
import { buildIntentSnapshot, type IntentSnapshot } from '../../intent/intent-snapshot.js';
import { Value } from '@sinclair/typebox/value';
import { DiagRootCauseOutputV1Schema } from '../../diagnostician/diag-rootcause-output.js';

// ── Fixtures ─────────────────────────────────────────────────────────────────

const TASK_ID = 'diag_rootcause-snapshot-001';
const RUN_ID = 'run-snapshot-001';
const OWNER = 'test-snapshot-owner';
const RUNTIME_KIND = 'test-double';

const INTENT_A = `# INTENT.md

## 1. Why
Owner trust is the long-term asset.

## 2. Desired Outcome
Every principle is traceable to its strategic basis.

## 3. Non-negotiables
No unverified claims.

## 4. Stop / Escalation
Stop on unresolved conflict.

## 5. Current Strategic Focus
Close the intent → principle loop.
`;

const INTENT_B = `# INTENT.md

## 1. Why
A completely different strategy the Owner wrote AFTER the failure.

## 2. Desired Outcome
Ship faster, skip traceability.

## 3. Non-negotiables
Speed over evidence.

## 4. Stop / Escalation
Never stop.

## 5. Current Strategic Focus
Deprecate the intent loop.
`;

const HASH_A = 'sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
const HASH_B = 'sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb';
const HASH_WINNER = 'sha256:cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc';

function makeEffectiveConfig(intentEngineering: boolean): EffectivePdConfig {
  const base = getDefaultPdConfig();
  return {
    config: {
      ...base,
      features: {
        ...base.features,
        intent_engineering: { category: 'quiet', enabled: intentEngineering },
      },
    },
    source: 'user_config',
    warnings: [],
    featuresChangedFromDefault: intentEngineering ? ['intent_engineering'] : [],
    resolvedProfile: resolveProfile({}),
    resolvedContextInjection: { thinkingOs: false, projectFocus: 'off' },
  };
}

function makeOutput(overrides: Partial<DiagRootCauseOutputV1> = {}): DiagRootCauseOutputV1 {
  return {
    ...MOCK_ROOT_CAUSE_OUTPUTS.R6,
    diagnosisId: 'diag-snapshot-001',
    taskId: TASK_ID,
    ...overrides,
  };
}

interface Harness {
  runner: DiagRootCauseRunner;
  stateManager: Record<string, unknown>;
  runtimeAdapter: { startRun: Mock };
  eventEmitter: { emitTelemetry: Mock };
  artifactStore: MemoryPIArtifactStore;
  reader: { readIntentDoc: Mock };
  currentTask: () => TaskRecord;
  setDiagnosticJson: (json: string) => void;
  setAttempt: (attemptCount: number) => void;
  setRunStatus: (status: 'succeeded' | 'failed') => void;
  persistedSnapshot: () => unknown;
}

interface HarnessOptions {
  intentEngineering?: boolean;
  reader?: IntentDocReader;
  output?: DiagRootCauseOutputV1;
  /** Losing-CAS simulation: the winner's persisted snapshot hash. */
  casWinnerHash?: string;
  /** Skip the fixture CAS double and supply our own. */
  initialDiagnosticJson?: string;
  attemptCount?: number;
}

function createHarness(options: HarnessOptions = {}): Harness {
  let currentTask: TaskRecord = {
    taskId: TASK_ID,
    taskKind: 'diag_rootcause',
    status: 'pending',
    attemptCount: options.attemptCount ?? 1,
    maxAttempts: 3,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    diagnosticJson: options.initialDiagnosticJson ?? createPITaskDiagnosticJson({
      dependencyTaskIds: [],
      channel: 'prompt',
      timeoutMs: 300_000,
      inputArtifactRefs: [],
      outputArtifactRefs: [],
    }),
  };

  const reader = {
    readIntentDoc: vi.fn(options.reader?.readIntentDoc ?? (() => ({
      ok: true,
      found: true,
      flagEnabled: true,
      doc: { raw: INTENT_A, contentHash: HASH_A, path: '/ws/.principles/INTENT.zh-CN.md' },
    }))),
  };

  const stateManager: Record<string, unknown> = {
    acquireLease: async () => currentTask,
    getTask: async () => currentTask,
    getRunsByTask: async () => [{ runId: RUN_ID, taskId: TASK_ID }],
    getValidRunsByTaskTolerant: async () => ({ runs: [{ runId: RUN_ID, taskId: TASK_ID }], degradedRuns: [] }),
    updateRunOutput: async () => undefined,
    markTaskSucceeded: async () => undefined,
    markTaskFailed: async () => undefined,
    markTaskRetryWait: async () => undefined,
    getRetryPolicy: () => ({ shouldRetry: () => true }),
  };

  const fencedState = fencedStateManager(stateManager);

  // The fixture's CAS applies to its private entry row; this harness keeps one
  // mutable task row so the NEXT attempt observes exactly what was persisted.
  let casCalls = 0;
  (stateManager).updateTaskIfDiagnosticJsonUnchanged = async (
    _taskId: string,
    expected: string | null,
    patch: Record<string, unknown>,
  ): Promise<TaskRecord | null> => {
    casCalls += 1;
    if (options.casWinnerHash !== undefined && casCalls === 1) {
      // A concurrent writer won: persist the winner's snapshot, then report null.
      const winner = buildIntentSnapshot({
        raw: INTENT_B,
        contentHash: options.casWinnerHash,
        capturedAt: '2026-11-14T09:00:00.000Z',
        lang: 'zh-CN',
      });
      currentTask = { ...currentTask, ...patch, diagnosticJson: JSON.stringify({
        pi_metadata: {
          ...JSON.parse(expected ?? '{}').pi_metadata,
          intentSnapshot: winner,
        },
      }) };
      return null;
    }
    if ((currentTask.diagnosticJson ?? null) !== expected) return null;
    currentTask = { ...currentTask, ...patch };
    return currentTask;
  };

  const startRun = vi.fn(async (): Promise<RunHandle> => ({
    runId: RUN_ID,
    runtimeKind: RUNTIME_KIND,
    startedAt: new Date().toISOString(),
  }));
  let nextStatus: RunStatus = { status: 'succeeded', runId: RUN_ID };
  const runtimeAdapter = {
    kind: () => RUNTIME_KIND,
    getCapabilities: vi.fn(),
    healthCheck: vi.fn(),
    startRun,
    pollRun: vi.fn(async () => nextStatus),
    fetchOutput: vi.fn(async () => ({ payload: options.output ?? makeOutput() })),
    cancelRun: vi.fn(async () => undefined),
    fetchArtifacts: vi.fn(),
  };

  const eventEmitter = { emitTelemetry: vi.fn() };
  const artifactStore = new MemoryPIArtifactStore();

  const deps: DiagRootCauseRunnerDeps = {
     
    stateManager: fencedState,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- test double for the adapter surface
    runtimeAdapter: runtimeAdapter as any,
     
    eventEmitter: eventEmitter,
    artifactStore,
    validator: { validate: async () => ({ valid: true, errors: [] }) },
     
    contextAssembler: { assemble: async () => ({
      sourceRefs: ['owner_reported:cli'],
      conversationWindow: [],
      trajectorySummary: '',
      painSignal: { painId: 'pain-001', painType: 'tool_failure', source: 'test', reason: 'test', score: 70 },
    }) } as unknown as DiagRootCauseRunnerDeps['contextAssembler'],
    intentDocReader: reader,
  };

  const runner = new DiagRootCauseRunner(deps, {
    owner: OWNER,
    runtimeKind: RUNTIME_KIND,
    pollIntervalMs: 1,
    timeoutMs: 1000,
    ...(options.intentEngineering !== undefined
      ? { effectiveConfig: makeEffectiveConfig(options.intentEngineering) }
      : {}),
  });

  return {
    runner,
    stateManager,
    runtimeAdapter: runtimeAdapter,
    eventEmitter,
    artifactStore,
    reader: reader,
    currentTask: () => currentTask,
    setDiagnosticJson: (json: string) => { currentTask = { ...currentTask, diagnosticJson: json }; },
    setAttempt: (attemptCount: number) => { currentTask = { ...currentTask, attemptCount }; },
    setRunStatus: (status: 'succeeded' | 'failed') => {
      nextStatus = status === 'succeeded'
        ? { status: 'succeeded', runId: RUN_ID }
        : { status: 'failed', runId: RUN_ID, reason: 'model_or_runtime_error' };
    },
    persistedSnapshot: () => {
      const json = currentTask.diagnosticJson;
      if (!json) return undefined;
      return (JSON.parse(json) as { pi_metadata?: { intentSnapshot?: unknown } }).pi_metadata?.intentSnapshot;
    },
  };
}

async function artifactContent(store: MemoryPIArtifactStore, taskId = TASK_ID): Promise<Record<string, unknown> | null> {
  const record = await store.getArtifactById(`pi-art-${taskId}-${RUN_ID}`);
  if (!record) return null;
  return JSON.parse(record.contentJson) as Record<string, unknown>;
}

function emittedEvents(emitter: Harness['eventEmitter']): string[] {
  return emitter.emitTelemetry.mock.calls.map((call) => (call[0] as { eventType?: string }).eventType ?? '');
}

// ── Tests ────────────────────────────────────────────────────────────────────

describe('DiagRootCauseRunner — IntentSnapshot persistence', () => {
  it('captures and persists the snapshot before invoking the model', async () => {
    const harness = createHarness({ intentEngineering: true });

    const result = await harness.runner.run(TASK_ID);

    expect(result.status).toBe('succeeded');
    expect(harness.reader.readIntentDoc).toHaveBeenCalledTimes(1);

    const persisted = harness.persistedSnapshot() as IntentSnapshot | undefined;
    expect(persisted?.contentHash).toBe(HASH_A);
    expect(persisted?.sections.find((s) => s.key === 'why')?.text).toBe('Owner trust is the long-term asset.');

    const content = await artifactContent(harness.artifactStore);
    expect(content).not.toBeNull();
    const snapshot = content?.intentSnapshot as IntentSnapshot;
    expect(snapshot.contentHash).toBe(HASH_A);
    expect(snapshot.sections.map((s) => s.key)).toHaveLength(5);

    // The prompt carried the snapshot's hash and rebuilt document.
    const startRunArg = harness.runtimeAdapter.startRun.mock.calls[0]?.[0] as { inputPayload: string };
    expect(startRunArg.inputPayload).toContain(HASH_A);
    expect(startRunArg.inputPayload).toContain('Owner trust is the long-term asset.');
  });

  it('retry after a failure reuses the FIRST snapshot even when INTENT.md changed', async () => {
    let readerRaw = INTENT_A;
    let readerHash = HASH_A;
    const harness = createHarness({
      intentEngineering: true,
      reader: {
        readIntentDoc: () => ({
          ok: true,
          found: true,
          flagEnabled: true,
          doc: { raw: readerRaw, contentHash: readerHash, path: '/ws/.principles/INTENT.zh-CN.md' },
        }),
      },
    });

    // Attempt 1 — model/runtime failure AFTER the snapshot was persisted.
    harness.setRunStatus('failed');
    const first = await harness.runner.run(TASK_ID);
    expect(first.status).not.toBe('succeeded');
    const persistedAfterFailure = harness.persistedSnapshot() as IntentSnapshot | undefined;
    expect(persistedAfterFailure?.contentHash).toBe(HASH_A);

    // Owner edits INTENT.md to B between attempts.
    readerRaw = INTENT_B;
    readerHash = HASH_B;
    harness.setAttempt(2);
    harness.setRunStatus('succeeded');

    const second = await harness.runner.run(TASK_ID);

    expect(second.status).toBe('succeeded');
    // The retry must NOT touch INTENT.md again.
    expect(harness.reader.readIntentDoc).toHaveBeenCalledTimes(1);

    const content = await artifactContent(harness.artifactStore);
    const snapshot = content?.intentSnapshot as IntentSnapshot;
    expect(snapshot.contentHash).toBe(HASH_A);
    expect(snapshot.sections.find((s) => s.key === 'why')?.text).toBe('Owner trust is the long-term asset.');

    const retryPrompt = harness.runtimeAdapter.startRun.mock.calls[1]?.[0] as { inputPayload: string };
    expect(retryPrompt.inputPayload).toContain(HASH_A);
    expect(retryPrompt.inputPayload).not.toContain('completely different strategy');
  });

  it('losing the first-capture CAS adopts the winner snapshot instead of calling the model twice', async () => {
    const harness = createHarness({ intentEngineering: true, casWinnerHash: HASH_WINNER });

    const result = await harness.runner.run(TASK_ID);

    expect(result.status).toBe('succeeded');
    expect(harness.reader.readIntentDoc).toHaveBeenCalledTimes(1);

    const content = await artifactContent(harness.artifactStore);
    const snapshot = content?.intentSnapshot as IntentSnapshot;
    expect(snapshot.contentHash).toBe(HASH_WINNER);
    expect(emittedEvents(harness.eventEmitter)).toContain('diag_rootcause_intent_snapshot_cas_conflict');
  });

  it('a deleted INTENT.md does not affect a task whose snapshot is already persisted', async () => {
    const persisted = buildIntentSnapshot({
      raw: INTENT_A,
      contentHash: HASH_A,
      capturedAt: '2026-11-14T08:00:00.000Z',
      lang: 'zh-CN',
    });
    const harness = createHarness({
      intentEngineering: true,
      initialDiagnosticJson: createPITaskDiagnosticJson({
        dependencyTaskIds: [],
        channel: 'prompt',
        timeoutMs: 300_000,
        inputArtifactRefs: [],
        outputArtifactRefs: [],
        intentSnapshot: persisted,
      }),
      reader: {
        readIntentDoc: () => ({
          ok: false,
          found: false,
          flagEnabled: true,
          reason: 'not_found',
          nextAction: 'Create .principles/INTENT.zh-CN.md',
        }),
      },
    });

    const result = await harness.runner.run(TASK_ID);

    expect(result.status).toBe('succeeded');
    expect(harness.reader.readIntentDoc).not.toHaveBeenCalled();
    const content = await artifactContent(harness.artifactStore);
    expect((content?.intentSnapshot as IntentSnapshot).contentHash).toBe(HASH_A);
  });

  it('keeps the server-computed hash when the model reports a different one', async () => {
    const harness = createHarness({
      intentEngineering: true,
      output: makeOutput({
        intentTension: {
          source: 'action_drift',
          evidenceStrength: 'moderate',
          relatedIntentFields: ['current_strategic_focus'],
          evidence: ['owner_reported:cli'],
          explanation: 'The action drifted from the stated focus.',
          suggestedOwnerAction: 'observe',
          intentDocHash: 'sha256:model-reported-value',
        },
      }),
    });

    const result = await harness.runner.run(TASK_ID);

    expect(result.status).toBe('succeeded');
    const content = await artifactContent(harness.artifactStore);
    const tension = content?.intentTension as { intentDocHash?: string; relatedIntentFields: string[] };
    expect(tension.intentDocHash).toBe(HASH_A);
    // Declared relevance narrows the stored sections (SPEC §6.3).
    const snapshot = content?.intentSnapshot as IntentSnapshot;
    expect(snapshot.sections.map((s) => s.key)).toEqual(['current_strategic_focus']);
    expect(emittedEvents(harness.eventEmitter)).toContain('diag_rootcause_intent_hash_mismatch');
  });

  it('fails closed on a corrupted persisted snapshot without invoking the model', async () => {
    const harness = createHarness({
      intentEngineering: true,
      initialDiagnosticJson: JSON.stringify({
        pi_metadata: {
          dependencyTaskIds: [],
          channel: 'prompt',
          timeoutMs: 300_000,
          inputArtifactRefs: [],
          outputArtifactRefs: [],
          intentSnapshot: { schemaVersion: 1, contentHash: 'not-a-sha256', capturedAt: '', lang: 'zh-CN', sections: [] },
        },
      }),
    });

    const result = await harness.runner.run(TASK_ID);

    expect(result.status).toBe('failed');
    expect(result.errorCategory).toBe('input_invalid');
    expect(harness.runtimeAdapter.startRun).not.toHaveBeenCalled();
    expect(harness.reader.readIntentDoc).not.toHaveBeenCalled();
  });

  it('Stage C artifact validation accepts the server-authored sibling key', () => {
    // Stage C re-validates the Stage A artifact content against this schema
    // (diag-router-runner.ts buildContext). The schema is permissive about
    // extra keys, so adding `intentSnapshot` cannot break A→B→C.
    const content = { ...makeOutput(), intentSnapshot: buildIntentSnapshot({
      raw: INTENT_A,
      contentHash: HASH_A,
      capturedAt: '2026-11-14T08:00:00.000Z',
      lang: 'zh-CN',
    }) };
    expect(Value.Check(DiagRootCauseOutputV1Schema, content)).toBe(true);
  });

  it('flag off: does not read INTENT.md and writes no snapshot', async () => {
    const harness = createHarness({ intentEngineering: false });

    const result = await harness.runner.run(TASK_ID);

    expect(result.status).toBe('succeeded');
    expect(harness.reader.readIntentDoc).not.toHaveBeenCalled();
    expect(harness.persistedSnapshot()).toBeUndefined();

    const content = await artifactContent(harness.artifactStore);
    expect(content).not.toBeNull();
    expect(content).not.toHaveProperty('intentSnapshot');

    const startRunArg = harness.runtimeAdapter.startRun.mock.calls[0]?.[0] as { inputPayload: string; systemPrompt?: string };
    expect(startRunArg.inputPayload).not.toContain('intentDoc');
    expect(startRunArg.systemPrompt ?? '').not.toContain('PHASE 3.6');
  });
});
