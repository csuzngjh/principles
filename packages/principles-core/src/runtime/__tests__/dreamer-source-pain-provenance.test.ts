/**
 * PRI-862 (CIL-006) — Dreamer sourcePainId provenance guard.
 *
 * The dreamer task seed (diagnostic_json.sourcePainId, written by the intake
 * bridge) is the ONLY authority for sourcePainId. The LLM echo is reconciled
 * against it before validation/persistence, on every runtime adapter:
 *
 *   A. seed present + fabricated echo   → overridden by seed (fabrication arm)
 *   A2. seed present + field omitted    → backfilled from seed (loss arm)
 *   B. no seed + fabricated echo        → dropped, observable (trust arm)
 *   C. seed present + faithful echo     → unchanged, no correction event
 *   D. identity                         → different seeds ⇒ different
 *      persisted artifact content (evidence changed ⇒ identity changed)
 *
 * @see docs/audit/PRI-862-source-pain-provenance-guard-audit.md
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { RuntimeStateManager } from '../store/runtime-state-manager.js';
import type { RunHandle } from '../runtime-protocol.js';
import type { StoreEventEmitter } from '../store/event-emitter.js';
import type { DreamerOutput, DreamerCandidate, DreamerValidator } from '../internalization/dreamer-output.js';
import type { TaskRecord } from '../task-status.js';
import { DreamerRunner } from '../internalization/dreamer-runner.js';
import { computeArtifactContentHash } from '../internalization/owner-review.js';
import { createMinimalPITaskRecord } from '../internalization/peer-runner-contracts.js';
import { MemoryPIArtifactStore } from '../internalization/pi-artifact-store.js';

const TASK_ID = 'task-dreamer-862';
const RUN_ID = 'run-dreamer-862';
const OWNER = 'test-pri862-owner';
const RUNTIME_KIND = 'test-double';

function makeDreamerCandidate(index: number): DreamerCandidate {
  return {
    candidateIndex: index,
    badDecision: `Test bad decision ${index}`,
    betterDecision: `Test better decision ${index}`,
    rationale: `Test rationale ${index}`,
    confidence: 0.8,
    riskLevel: 'low',
    strategicPerspective: 'conservative_fix',
  };
}

/** LLM output as produced BEFORE the guard — taskId echoed faithfully so any
 *  correction event isolates the sourcePainId arm. */
function makeLlmOutput(painEcho: string | undefined): Record<string, unknown> {
  const output: Record<string, unknown> = {
    valid: true,
    taskId: TASK_ID,
    candidates: [makeDreamerCandidate(0)],
    contextRefs: [],
    generatedAt: '2026-09-19T00:00:00Z',
  };
  if (painEcho !== undefined) {
    output.sourcePainId = painEcho;
  }
  return output;
}

function seedDiagnosticJson(seed: string | null | undefined): string {
  const record: Record<string, unknown> = { pi_metadata: { note: 'minimal envelope; hydration is not exercised by this guard' } };
  if (seed !== null && seed !== undefined) {
    record.sourcePainId = seed;
  }
  return JSON.stringify(record);
}

interface Harness {
  runner: DreamerRunner;
  artifactStore: MemoryPIArtifactStore;
  persistedRunOutput: () => Record<string, unknown>;
  storedArtifactContent: () => Promise<Record<string, unknown>>;
  storedArtifactContentJson: () => Promise<string>;
  echoCorrectedEvents: () => { correctedFields: unknown; seedPresent: unknown }[];
}

function createHarness(opts: {
  seed: string | null;
  llmPainEcho: string | undefined;
}): Harness {
  const taskRecord: TaskRecord = {
    ...createMinimalPITaskRecord(TASK_ID, 'dreamer', 'prompt'),
    status: 'leased',
    leaseOwner: OWNER,
    leaseExpiresAt: '2026-05-01T01:00:00Z',
    attemptCount: 1,
    maxAttempts: 3,
    diagnosticJson: seedDiagnosticJson(opts.seed),
  };

  const runHandle: RunHandle = { runId: RUN_ID, runtimeKind: RUNTIME_KIND, startedAt: '2026-05-01T00:00:00Z' };
  const llmOutput = makeLlmOutput(opts.llmPainEcho);

  const stateManager = {
    acquireLease: vi.fn().mockResolvedValue(taskRecord),
    markTaskSucceeded: vi.fn().mockResolvedValue(taskRecord),
    markTaskFailed: vi.fn().mockResolvedValue(taskRecord),
    markTaskRetryWait: vi.fn().mockResolvedValue(taskRecord),
    updateRunOutput: vi.fn().mockResolvedValue({}),
    getRetryPolicy: vi.fn().mockReturnValue({
      calculateBackoff: vi.fn().mockReturnValue(30_000),
      shouldRetry: vi.fn().mockReturnValue(true),
    }),
    getRunsByTask: vi.fn().mockResolvedValue([{ runId: RUN_ID, taskId: TASK_ID }]),
    getValidRunsByTaskTolerant: vi.fn().mockResolvedValue({
      runs: [{ runId: RUN_ID, taskId: TASK_ID }],
      degradedRuns: [],
    }),
    getTask: vi.fn().mockResolvedValue(taskRecord),
  };

  const runtimeAdapter = {
    kind: vi.fn().mockReturnValue(RUNTIME_KIND),
    getCapabilities: vi.fn(),
    healthCheck: vi.fn(),
    startRun: vi.fn().mockResolvedValue(runHandle),
    pollRun: vi.fn().mockResolvedValue({ runId: RUN_ID, status: 'succeeded' }),
    cancelRun: vi.fn().mockResolvedValue(undefined),
    // Fresh copy per run invocation — mirrors adapters returning a new object.
    fetchOutput: vi.fn().mockImplementation(async () => ({ runId: RUN_ID, payload: structuredClone(llmOutput) })),
    fetchArtifacts: vi.fn(),
  };

  const validator: DreamerValidator = {
    validate: vi.fn().mockImplementation(async (output: unknown) => ({
      valid: true,
      errors: [],
      output: output as DreamerOutput,
    })),
  };

  const telemetryCalls: { eventType: string; payload: Record<string, unknown> }[] = [];
  const eventEmitter = {
    emitTelemetry: vi.fn().mockImplementation((event: { eventType: string; payload: Record<string, unknown> }) => {
      telemetryCalls.push(event);
      return true;
    }),
    on: vi.fn(),
    emit: vi.fn(),
  };

  const artifactStore = new MemoryPIArtifactStore();
  const runner = new DreamerRunner(
    {
      stateManager: stateManager as unknown as RuntimeStateManager,
      runtimeAdapter: runtimeAdapter,
      eventEmitter: eventEmitter as unknown as StoreEventEmitter,
      validator,
      artifactStore,
    },
    { owner: OWNER, runtimeKind: RUNTIME_KIND, pollIntervalMs: 10, timeoutMs: 1000 },
  );

  async function storedContentJson(): Promise<string> {
    const artifacts = await artifactStore.listBySourceTaskId(TASK_ID);
    expect(artifacts).toHaveLength(1);
    const [artifact] = artifacts;
    expect(artifact).toBeDefined();
    return artifact?.contentJson ?? '{}';
  }

  return {
    runner,
    artifactStore,
    persistedRunOutput: () => {
      const {calls} = stateManager.updateRunOutput.mock;
      return JSON.parse(String(calls[0]?.[1])) as Record<string, unknown>;
    },
    storedArtifactContent: async () => JSON.parse(await storedContentJson()) as Record<string, unknown>,
    storedArtifactContentJson: storedContentJson,
    echoCorrectedEvents: () => telemetryCalls
      .filter((evt) => evt.eventType === 'dreamer_lineage_echo_corrected')
      .map((evt) => evt.payload as { correctedFields: unknown; seedPresent: unknown }),
  };
}

describe('PRI-862 dreamer sourcePainId provenance guard', () => {
  beforeEach(() => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('A: canonical seed overrides a fabricated LLM sourcePainId', async () => {
    const harness = createHarness({ seed: 'pain-canonical-1', llmPainEcho: 'pain-null-crash' });
    const result = await harness.runner.run(TASK_ID);

    expect(result.status).toBe('succeeded');
    const persisted = harness.persistedRunOutput();
    expect(persisted.sourcePainId).toBe('pain-canonical-1');
    const content = await harness.storedArtifactContent();
    expect(content.sourcePainId).toBe('pain-canonical-1');
    expect(harness.echoCorrectedEvents().some(
      (p) => Array.isArray(p.correctedFields) && p.correctedFields.includes('sourcePainId') && p.seedPresent === true,
    )).toBe(true);
  });

  it('A2: seed present + LLM omitted the field → backfilled from seed (pi-ai loss arm)', async () => {
    const harness = createHarness({ seed: 'pain-canonical-1', llmPainEcho: undefined });
    const result = await harness.runner.run(TASK_ID);

    expect(result.status).toBe('succeeded');
    const content = await harness.storedArtifactContent();
    expect(content.sourcePainId).toBe('pain-canonical-1');
  });

  it('B: no seed → LLM string is dropped, degradation is observable (rc-9)', async () => {
    const harness = createHarness({ seed: null, llmPainEcho: 'pain-invented' });
    const result = await harness.runner.run(TASK_ID);

    expect(result.status).toBe('succeeded');
    const persisted = harness.persistedRunOutput();
    expect(Object.hasOwn(persisted, 'sourcePainId')).toBe(false);
    const content = await harness.storedArtifactContent();
    expect(Object.hasOwn(content, 'sourcePainId')).toBe(false);
    expect(harness.echoCorrectedEvents().some(
      (p) => Array.isArray(p.correctedFields) && p.correctedFields.includes('sourcePainId') && p.seedPresent === false,
    )).toBe(true);
  });

  it('C: faithful echo equal to seed is preserved without a correction event', async () => {
    const harness = createHarness({ seed: 'pain-canonical-1', llmPainEcho: 'pain-canonical-1' });
    const result = await harness.runner.run(TASK_ID);

    expect(result.status).toBe('succeeded');
    const content = await harness.storedArtifactContent();
    expect(content.sourcePainId).toBe('pain-canonical-1');
    expect(harness.echoCorrectedEvents()).toHaveLength(0);
  });

  it('D: different seeds produce different persisted artifact content identity (evidence ⇒ identity)', async () => {
    const first = createHarness({ seed: 'pain-alpha', llmPainEcho: undefined });
    const second = createHarness({ seed: 'pain-beta', llmPainEcho: undefined });
    await first.runner.run(TASK_ID);
    await second.runner.run(TASK_ID);

    const firstRaw = await first.storedArtifactContentJson();
    const secondRaw = await second.storedArtifactContentJson();
    expect(JSON.parse(firstRaw).sourcePainId).toBe('pain-alpha');
    expect(JSON.parse(secondRaw).sourcePainId).toBe('pain-beta');
    // Real downstream identity function (owner-review replay/stale guard):
    // sha256 over the persisted contentJson — evidence changed ⇒ hash changed.
    expect(computeArtifactContentHash(firstRaw)).not.toBe(computeArtifactContentHash(secondRaw));
  });

  it('B2: no seed + no echo (legacy shape) succeeds with no event — backward compatible', async () => {
    const harness = createHarness({ seed: null, llmPainEcho: undefined });
    const result = await harness.runner.run(TASK_ID);

    expect(result.status).toBe('succeeded');
    const content = await harness.storedArtifactContent();
    expect(Object.hasOwn(content, 'sourcePainId')).toBe(false);
    expect(harness.echoCorrectedEvents()).toHaveLength(0);
  });
});
