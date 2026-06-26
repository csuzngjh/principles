/**
 * DiagRootCauseRunner — PRI-468 INTENT.md injection integration tests.
 *
 * Verifies that Stage A correctly:
 *   1. Does NOT inject INTENT.md when intent_engineering flag is off (byte-identical)
 *   2. Injects INTENT.md when flag is on AND reader returns ok
 *   3. Degrades gracefully (no INTENT, emits telemetry) when reader returns not_found
 *   4. Degrades gracefully when reader returns flag_disabled
 *   5. Behaves as before when no intentDocReader is provided (backward compat)
 *
 * ERR entries considered:
 *   - EP-01 / ERR-001: readResult treated as unknown, fields checked via Object.hasOwn
 *   - EP-02 / ERR-025: production path; no plugin imports in core test
 *   - EP-03 / ERR-002: every degraded path emits telemetry with reason + nextAction
 *   - EP-09: tests use mock readers with structured returns (no real fs in core tests)
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { DiagRootCauseRunner } from '../diag-rootcause-runner.js';
import type { DiagRootCauseRunnerDeps } from '../diag-rootcause-runner.js';
import type { DiagRootCauseOutputV1 } from '../../diagnostician/diag-rootcause-output.js';
import type { IntentDocReader, IntentDocReadResult } from '../../intent/intent-doc-reader-port.js';
import { MemoryPIArtifactStore } from '../pi-artifact-store.js';
import type { RuntimeStateManager } from '../../store/runtime-state-manager.js';
import type { RunHandle, RunStatus } from '../../runtime-protocol.js';
import type { StoreEventEmitter } from '../../store/event-emitter.js';
import type { TaskRecord } from '../../task-status.js';
import { createPITaskDiagnosticJson } from '../pitask-metadata.js';
import { MOCK_ROOT_CAUSE_OUTPUTS } from './__fixtures__/split-pipeline-mock-outputs.js';
import type { EffectivePdConfig } from '../../config/pd-config-types.js';
import { getDefaultPdConfig } from '../../config/pd-config-defaults.js';

// ── Test fixtures ────────────────────────────────────────────────────────────

const ROOTCAUSE_TASK_ID = 'diag_rootcause-001';
const RUN_ID = 'run-rootcause-001';
const OWNER = 'test-intent-owner';
const RUNTIME_KIND = 'test-double';

const INTENT_RAW = `# INTENT.md

## 1. Why
Validate the smallest Pain → Principle loop before scaling.

## 2. Desired Outcome
One real Pain Case reviewed by Owner within 5 minutes.

## 3. Non-negotiables
No premature dashboards.

## 4. Stop / Escalation
Stop if review burden increases.

## 5. Current Strategic Focus
Tighten the learning loop.
`;
const INTENT_CONTENT_HASH = 'sha256:test-intent-hash-abc123';
const INTENT_PATH = '/workspace/.principles/INTENT.md';

function makeRootCauseTask(overrides: Partial<TaskRecord> = {}): TaskRecord {
  return {
    taskId: ROOTCAUSE_TASK_ID,
    taskKind: 'diag_rootcause',
    status: 'pending',
    attemptCount: 0,
    maxAttempts: 3,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    diagnosticJson: createPITaskDiagnosticJson({
      dependencyTaskIds: [],
      channel: 'prompt',
      timeoutMs: 300_000,
      inputArtifactRefs: [],
      outputArtifactRefs: [],
    }),
    ...overrides,
  };
}

function makeRootCauseOutput(): DiagRootCauseOutputV1 {
  return {
    ...MOCK_ROOT_CAUSE_OUTPUTS.R6,
    diagnosisId: 'diag-001',
    taskId: ROOTCAUSE_TASK_ID,
  };
}

function makeContextPayload() {
  return {
    sourceRefs: ['ref-1', 'ref-2'],
    conversationWindow: [],
    trajectorySummary: '',
    painSignal: { painId: 'pain-001', painType: 'tool_failure', source: 'test', reason: 'test reason', score: 70 },
  };
}

/** Build an EffectivePdConfig with intent_engineering flag on or off. */
function makeEffectiveConfig(opts: { intentEngineering?: boolean; coreGrounding?: boolean }): EffectivePdConfig {
  const base = getDefaultPdConfig();
  return {
    config: {
      ...base,
      features: {
        ...base.features,
        intent_engineering: {
          category: 'quiet',
          enabled: opts.intentEngineering === true,
        },
        ...(opts.coreGrounding !== undefined
          ? { diagnostician_core_grounding: { category: 'quiet', enabled: opts.coreGrounding } }
          : {}),
      },
    },
    source: 'user_config',
    warnings: [],
    featuresChangedFromDefault: opts.intentEngineering ? ['intent_engineering'] : [],
  };
}

// ── Telemetry mock helper ───────────────────────────────────────────────────
// `noUncheckedIndexedAccess` makes Record<string, X>[key] return X | undefined,
// and `unknown` has no `.eventType`. This helper narrows mock call args safely
// (test-only — mirrors the pattern in diag-distiller-runner.test.ts).
type TelemetryCallArg = { eventType: string; payload?: Record<string, unknown> };
function telemetryEventType(call: readonly unknown[]): string | undefined {
  const event = call[0] as TelemetryCallArg | undefined;
  return event?.eventType;
}
function telemetryPayload(call: readonly unknown[]): Record<string, unknown> | undefined {
  const event = call[0] as TelemetryCallArg | undefined;
  return event?.payload;
}

/** Create a mock IntentDocReader that returns the given result. */
function makeIntentDocReader(result: IntentDocReadResult): IntentDocReader {
  return {
    readIntentDoc: vi.fn().mockReturnValue(result),
  };
}

// ── Mock factory ─────────────────────────────────────────────────────────────

function createMockDeps(overrides: Partial<DiagRootCauseRunnerDeps> = {}): DiagRootCauseRunnerDeps & {
  _stateManager: Record<string, ReturnType<typeof vi.fn>>;
  _runtimeAdapter: Record<string, ReturnType<typeof vi.fn>>;
  _validator: Record<string, ReturnType<typeof vi.fn>>;
  _contextAssembler: Record<string, ReturnType<typeof vi.fn>>;
  _eventEmitter: { emitTelemetry: ReturnType<typeof vi.fn> };
} {
  const taskRecord = makeRootCauseTask();
  const output = makeRootCauseOutput();

  const _stateManager = {
    acquireLease: vi.fn().mockResolvedValue(taskRecord),
    getTask: vi.fn().mockResolvedValue(taskRecord),
    getRunsByTask: vi.fn().mockResolvedValue([{ runId: RUN_ID, taskId: ROOTCAUSE_TASK_ID }]),
    getValidRunsByTaskTolerant: vi.fn().mockResolvedValue({
      runs: [{ runId: RUN_ID, taskId: ROOTCAUSE_TASK_ID }],
      degradedRuns: [],
    }),
    updateRunOutput: vi.fn().mockResolvedValue(undefined),
    markTaskSucceeded: vi.fn().mockResolvedValue(undefined),
    markTaskFailed: vi.fn().mockResolvedValue(undefined),
    markTaskRetryWait: vi.fn().mockResolvedValue(undefined),
    getRetryPolicy: vi.fn().mockReturnValue({ shouldRetry: () => false }),
  };

  const runHandle: RunHandle = { runId: RUN_ID, runtimeKind: RUNTIME_KIND, startedAt: new Date().toISOString() };
  const succeededStatus: RunStatus = { status: 'succeeded', runId: RUN_ID };

  const _runtimeAdapter = {
    kind: vi.fn().mockReturnValue(RUNTIME_KIND),
    getCapabilities: vi.fn(),
    healthCheck: vi.fn(),
    startRun: vi.fn().mockResolvedValue(runHandle),
    pollRun: vi.fn().mockResolvedValue(succeededStatus),
    fetchOutput: vi.fn().mockResolvedValue({ payload: output }),
    cancelRun: vi.fn().mockResolvedValue(undefined),
    fetchArtifacts: vi.fn(),
  };

  const _validator = {
    validate: vi.fn().mockResolvedValue({ valid: true, errors: [] }),
  };

  const _contextAssembler = {
    assemble: vi.fn().mockResolvedValue(makeContextPayload()),
  };

  const _eventEmitter = {
    emitTelemetry: vi.fn(),
    on: vi.fn(),
    emit: vi.fn(),
  };

  return {
    stateManager: _stateManager as unknown as RuntimeStateManager,
    runtimeAdapter: _runtimeAdapter,
    eventEmitter: _eventEmitter as unknown as StoreEventEmitter,
    artifactStore: new MemoryPIArtifactStore(),
    validator: _validator,
    contextAssembler: _contextAssembler,
    _stateManager,
    _runtimeAdapter,
    _validator,
    _contextAssembler,
    _eventEmitter,
    ...overrides,
  };
}

// ── Tests ────────────────────────────────────────────────────────────────────

describe('DiagRootCauseRunner — PRI-468 INTENT.md injection', () => {
  beforeEach(() => {
    // No global setup needed — each test creates its own deps
  });

  it('flag off → does NOT inject INTENT.md (byte-identical to pre-PRI-468)', async () => {
    const reader = makeIntentDocReader({
      ok: false, found: false, flagEnabled: false, reason: 'flag_disabled',
    });
    const deps = createMockDeps({ intentDocReader: reader });
    const runner = new DiagRootCauseRunner(deps, {
      owner: OWNER,
      runtimeKind: RUNTIME_KIND,
      pollIntervalMs: 10,
      timeoutMs: 1000,
      effectiveConfig: makeEffectiveConfig({ intentEngineering: false }),
    });

    await runner.run(ROOTCAUSE_TASK_ID);

    // Reader should NOT have been called (flag off → short-circuit)
    expect(reader.readIntentDoc).not.toHaveBeenCalled();

    // Verify the prompt message does NOT contain intentDoc or PHASE 3.6
    const startRunCall = deps._runtimeAdapter.startRun?.mock.calls[0];
    const message = startRunCall?.[0]?.inputPayload as string;
    expect(message).not.toContain('intentDoc');
    expect(message).not.toContain('PHASE 3.6');
    expect(message).not.toContain('Intent Tension Check');
  });

  it('flag on + reader ok → injects INTENT.md and PHASE 3.6', async () => {
    const reader = makeIntentDocReader({
      ok: true,
      found: true,
      flagEnabled: true,
      doc: {
        raw: INTENT_RAW,
        contentHash: INTENT_CONTENT_HASH,
        path: INTENT_PATH,
      },
    });
    const deps = createMockDeps({ intentDocReader: reader });
    const runner = new DiagRootCauseRunner(deps, {
      owner: OWNER,
      runtimeKind: RUNTIME_KIND,
      pollIntervalMs: 10,
      timeoutMs: 1000,
      effectiveConfig: makeEffectiveConfig({ intentEngineering: true }),
    });

    await runner.run(ROOTCAUSE_TASK_ID);

    // Reader was called
    expect(reader.readIntentDoc).toHaveBeenCalledTimes(1);

    // Verify the prompt message contains intentDoc and PHASE 3.6
    const startRunCall = deps._runtimeAdapter.startRun?.mock.calls[0];
    const message = startRunCall?.[0]?.inputPayload as string;
    const parsed = JSON.parse(message) as Record<string, unknown>;

    expect(parsed).toHaveProperty('intentDoc');
    const intentDoc = parsed.intentDoc as Record<string, unknown>;
    expect(intentDoc.raw).toBe(INTENT_RAW);
    expect(intentDoc.contentHash).toBe(INTENT_CONTENT_HASH);
    expect(intentDoc.path).toBe(INTENT_PATH);

    // PHASE 3.6 should be in the diagnosticInstruction
    const instruction = parsed.diagnosticInstruction as string;
    expect(instruction).toContain('PHASE 3.6');
    expect(instruction).toContain('Intent Tension Check');
  });

  it('flag on + reader returns not_found → degrades gracefully with telemetry', async () => {
    const reader = makeIntentDocReader({
      ok: false,
      found: false,
      flagEnabled: true,
      reason: 'not_found',
      nextAction: 'Create .principles/INTENT.md using "pd intent init".',
    });
    const deps = createMockDeps({ intentDocReader: reader });
    const runner = new DiagRootCauseRunner(deps, {
      owner: OWNER,
      runtimeKind: RUNTIME_KIND,
      pollIntervalMs: 10,
      timeoutMs: 1000,
      effectiveConfig: makeEffectiveConfig({ intentEngineering: true }),
    });

    await runner.run(ROOTCAUSE_TASK_ID);

    // Reader was called
    expect(reader.readIntentDoc).toHaveBeenCalledTimes(1);

    // Telemetry emitted with reason + nextAction (EP-03 / ERR-002)
    const telemetryCall = deps._eventEmitter.emitTelemetry.mock.calls.find(
      (call: readonly unknown[]) => telemetryEventType(call) === 'diag_rootcause_intent_doc_read_failed',
    );
    expect(telemetryCall).toBeDefined();
    if (!telemetryCall) return; // type narrowing after assertion
    const tp = telemetryPayload(telemetryCall);
    expect(tp?.reason).toBe('not_found');
    expect(tp?.nextAction).toContain('pd intent init');

    // Prompt does NOT contain intentDoc or PHASE 3.6
    const startRunMock = deps._runtimeAdapter.startRun;
    if (!startRunMock) throw new Error('startRun mock not configured');
    const [startRunCall] = startRunMock.mock.calls;
    const message = startRunCall?.[0]?.inputPayload as string;
    const parsed = JSON.parse(message) as Record<string, unknown>;
    expect(parsed).not.toHaveProperty('intentDoc');
    const instruction = parsed.diagnosticInstruction as string;
    expect(instruction).not.toContain('PHASE 3.6');
  });

  it('flag on + reader returns oversized → degrades gracefully with telemetry', async () => {
    const reader = makeIntentDocReader({
      ok: false,
      found: true,
      flagEnabled: true,
      reason: 'oversized',
      nextAction: 'INTENT.md exceeds 32KB. Reduce content.',
    });
    const deps = createMockDeps({ intentDocReader: reader });
    const runner = new DiagRootCauseRunner(deps, {
      owner: OWNER,
      runtimeKind: RUNTIME_KIND,
      pollIntervalMs: 10,
      timeoutMs: 1000,
      effectiveConfig: makeEffectiveConfig({ intentEngineering: true }),
    });

    await runner.run(ROOTCAUSE_TASK_ID);

    // Telemetry emitted with reason='oversized'
    const telemetryCall = deps._eventEmitter.emitTelemetry.mock.calls.find(
      (call: readonly unknown[]) => telemetryEventType(call) === 'diag_rootcause_intent_doc_read_failed',
    );
    expect(telemetryCall).toBeDefined();
    if (!telemetryCall) return; // type narrowing after assertion
    const tp = telemetryPayload(telemetryCall);
    expect(tp?.reason).toBe('oversized');

    // Prompt does NOT contain intentDoc
    const startRunMock = deps._runtimeAdapter.startRun;
    if (!startRunMock) throw new Error('startRun mock not configured');
    const [startRunCall] = startRunMock.mock.calls;
    const message = startRunCall?.[0]?.inputPayload as string;
    const parsed = JSON.parse(message) as Record<string, unknown>;
    expect(parsed).not.toHaveProperty('intentDoc');
  });

  it('no intentDocReader provided → behaves as before (backward compat)', async () => {
    // No intentDocReader in deps
    const deps = createMockDeps();
    const runner = new DiagRootCauseRunner(deps, {
      owner: OWNER,
      runtimeKind: RUNTIME_KIND,
      pollIntervalMs: 10,
      timeoutMs: 1000,
      effectiveConfig: makeEffectiveConfig({ intentEngineering: true }),
    });

    await runner.run(ROOTCAUSE_TASK_ID);

    // Prompt does NOT contain intentDoc (no reader → no injection)
    const startRunMock = deps._runtimeAdapter.startRun;
    if (!startRunMock) throw new Error('startRun mock not configured');
    const [startRunCall] = startRunMock.mock.calls;
    const message = startRunCall?.[0]?.inputPayload as string;
    const parsed = JSON.parse(message) as Record<string, unknown>;
    expect(parsed).not.toHaveProperty('intentDoc');

    // PHASE 3.6 NOT injected (intentGrounding downgraded to false because no reader)
    const instruction = parsed.diagnosticInstruction as string;
    expect(instruction).not.toContain('PHASE 3.6');

    // No intent_doc_read_failed telemetry (we didn't even try to read)
    const telemetryCall = deps._eventEmitter.emitTelemetry.mock.calls.find(
      (call: readonly unknown[]) => telemetryEventType(call) === 'diag_rootcause_intent_doc_read_failed',
    );
    expect(telemetryCall).toBeUndefined();
  });

  it('no effectiveConfig → flag off behavior, no reader call', async () => {
    const reader = makeIntentDocReader({
      ok: true,
      found: true,
      flagEnabled: true,
      doc: { raw: INTENT_RAW, contentHash: INTENT_CONTENT_HASH, path: INTENT_PATH },
    });
    const deps = createMockDeps({ intentDocReader: reader });
    // No effectiveConfig → flag resolution skipped, intentGrounding stays false
    const runner = new DiagRootCauseRunner(deps, {
      owner: OWNER,
      runtimeKind: RUNTIME_KIND,
      pollIntervalMs: 10,
      timeoutMs: 1000,
    });

    await runner.run(ROOTCAUSE_TASK_ID);

    // Reader NOT called (no effectiveConfig → flag not read → intentGrounding false)
    expect(reader.readIntentDoc).not.toHaveBeenCalled();

    const startRunMock = deps._runtimeAdapter.startRun;
    if (!startRunMock) throw new Error('startRun mock not configured');
    const [startRunCall] = startRunMock.mock.calls;
    const message = startRunCall?.[0]?.inputPayload as string;
    const parsed = JSON.parse(message) as Record<string, unknown>;
    expect(parsed).not.toHaveProperty('intentDoc');
  });
});
