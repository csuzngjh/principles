/**
 * SIA v1.2 · P1-2 — `intent_engineering` closes the WHOLE chain, at the RUNNER
 * boundary.
 *
 * Prompt-builder unit tests cannot prove this: each runner reads the flag
 * itself and decides what reaches the runtime. This file therefore drives the
 * REAL DreamerRunner → PhilosopherRunner → ScribeRunner sequence over one
 * SQLite-backed state handle:
 *
 *   1. Stage A captured a snapshot (persisted in the diagnosis artifact);
 *   2. the flag is OFF for the whole run;
 *   3. every prompt payload is inspected at `startRun`;
 *   4. Scribe still emits V1, never V2;
 *   5. the persisted snapshot is untouched, and re-enabling the flag reuses it.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRuntimeStateHandle, type RuntimeStateHandle } from '../../runtime-state-handle.js';
import { TestDoubleRuntimeAdapter } from '../../adapter/test-double-runtime-adapter.js';
import { StoreEventEmitter } from '../../store/event-emitter.js';
import { DreamerRunner } from '../dreamer-runner.js';
import { DefaultDreamerValidator } from '../dreamer-output.js';
import { PhilosopherRunner } from '../philosopher-runner.js';
import { DefaultPhilosopherValidator } from '../philosopher-output.js';
import { ScribeRunner } from '../scribe-runner.js';
import { DefaultScribeValidator } from '../scribe-output.js';
import { createPITaskDiagnosticJson } from '../pitask-metadata.js';
import { computeEffectivePdConfig } from '../../config/index.js';
import type { EffectivePdConfig } from '../../config/pd-config-types.js';

const NOW = '2026-11-14T00:00:00.000Z';
const DIAG_TASK = 'diag-router-task';
const DREAMER_TASK = 'dreamer-task';
const PHILOSOPHER_TASK = 'philosopher-task';
const SCRIBE_TASK = 'scribe-task';
const SCRIBE_TASK_FLAG_ON = 'scribe-task-flag-on';

const SNAPSHOT = {
  contentHash: 'sha256:stage-a-hash',
  capturedAt: NOW,
  lang: 'en',
  sections: [{ key: 'why', text: 'protect owner intent' }],
};

const VALID_CONTRACT = {
  ownerIntent: 'protect the authoritative state before merging',
  targetBehavior: 'verify the authoritative source before any state merge',
  forbiddenBehavior: 'merging stale entries without verification',
  evidenceSource: 'manual_evidence_001',
  validationExpectation: 'block merge-shaped writes with no prior verification',
};

function effectiveConfig(intentEngineering: boolean): EffectivePdConfig {
  const base = computeEffectivePdConfig(null);
  return {
    ...base,
    config: {
      ...base.config,
      features: {
        ...base.config.features,
        intent_engineering: { category: 'quiet', enabled: intentEngineering },
      },
    },
  };
}

function diagContent(): Record<string, unknown> {
  return {
    taskId: DIAG_TASK,
    rootCause: 'the merge bypassed the authoritative source check',
    summary: 'drift',
    violatedPrinciples: [],
    evidence: [{ sourceRef: 'diag#ev1', note: 'observed bypass' }],
    recommendations: ['verify before merging'],
    confidence: 0.8,
    intentTension: {
      source: 'action_drift',
      evidenceStrength: 'strong',
      relatedIntentFields: ['why'],
      evidence: ['diag#ev1'],
      explanation: 'drifted from the owner intent',
    },
    intentSnapshot: SNAPSHOT,
  };
}

function dreamerPayload(): Record<string, unknown> {
  return {
    valid: true,
    taskId: DREAMER_TASK,
    candidates: [{
      candidateIndex: 0,
      badDecision: 'merge without verification',
      betterDecision: 'verify the authoritative source first',
      rationale: 'the bypass caused the drift',
      confidence: 0.8,
      riskLevel: 'low',
      strategicPerspective: 'serves the owner intent by checking why before merging',
    }],
    contextRefs: [],
    generatedAt: NOW,
  };
}

function philosopherPayload(sourceDreamerArtifactId: string): Record<string, unknown> {
  return {
    taskId: PHILOSOPHER_TASK,
    sourceDreamerArtifactId,
    thesis: 'verify before merging',
    principleCandidate: {
      title: 'Verify the authoritative source',
      rationale: 'the bypass caused the drift',
      scope: 'state merges',
      confidence: 0.9,
    },
    risks: [],
    generatedAt: NOW,
  };
}

function scribePayload(): Record<string, unknown> {
  return {
    taskId: SCRIBE_TASK,
    sourcePhilosopherArtifactId: 'pi-philosopher',
    principleDraft: {
      title: 'Verify before merge',
      statement: 'Verify the authoritative source before merging.',
      rationale: 'Ordering constraint was missing.',
      applicability: ['state file sync'],
      antiPatterns: ['verify-after-merge'],
      confidence: 0.9,
    },
    sourceTrace: { philosopherArtifactId: 'pi-philosopher', dreamerArtifactId: 'pi-dreamer' },
    risks: [],
    generatedAt: NOW,
    intentContract: { ...VALID_CONTRACT },
    executionConditions: { version: 1, requiredFacts: [] },
  };
}

describe('intent_engineering flag — whole-chain shutdown (P1-2)', () => {
  let dir: string;
  let handle: RuntimeStateHandle;

  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), 'pd-intent-flag-chain-'));
    handle = await createRuntimeStateHandle({ workspaceDir: dir });
  });

  afterEach(async () => {
    await handle.close();
    rmSync(dir, { recursive: true, force: true });
  });

  async function seedChain(): Promise<void> {
    const state = handle.stateManager;
    await state.createTask({ taskId: DIAG_TASK, taskKind: 'diag_router', status: 'succeeded', attemptCount: 1, maxAttempts: 3, diagnosticJson: '{}' });
    await state.createTask({
      taskId: DREAMER_TASK, taskKind: 'dreamer', status: 'pending', attemptCount: 0, maxAttempts: 3,
      diagnosticJson: createPITaskDiagnosticJson({ dependencyTaskIds: [DIAG_TASK], channel: 'prompt', timeoutMs: 1000, inputArtifactRefs: [], outputArtifactRefs: [] }),
    });
    await state.createTask({
      taskId: PHILOSOPHER_TASK, taskKind: 'philosopher', status: 'pending', attemptCount: 0, maxAttempts: 3,
      diagnosticJson: createPITaskDiagnosticJson({ dependencyTaskIds: [DREAMER_TASK], channel: 'prompt', timeoutMs: 1000, inputArtifactRefs: [], outputArtifactRefs: [] }),
    });
    await state.createTask({
      taskId: SCRIBE_TASK, taskKind: 'scribe', status: 'pending', attemptCount: 0, maxAttempts: 3,
      diagnosticJson: createPITaskDiagnosticJson({ dependencyTaskIds: [PHILOSOPHER_TASK], channel: 'prompt', timeoutMs: 1000, inputArtifactRefs: [], outputArtifactRefs: [] }),
    });
    await state.piArtifactStore.upsertArtifact({
      artifactId: 'pi-diag',
      artifactKind: 'principle',
      sourceTaskId: DIAG_TASK,
      lineageArtifactIds: [],
      validationStatus: 'pending',
      contentJson: JSON.stringify(diagContent()),
      createdAt: NOW,
      updatedAt: NOW,
    });
  }

  interface CapturedRunner<T> {
    readonly runner: T;
    readonly prompt: () => string;
  }

  function dreamer(intentEngineering: boolean): CapturedRunner<DreamerRunner> {
    const adapter = new TestDoubleRuntimeAdapter({ onFetchOutput: (runId: string) => ({ runId, payload: dreamerPayload() }) });
    const startRun = vi.spyOn(adapter, 'startRun');
    const runner = new DreamerRunner(
      { stateManager: handle.stateManager, artifactStore: handle.stateManager.piArtifactStore, eventEmitter: new StoreEventEmitter(), runtimeAdapter: adapter, validator: new DefaultDreamerValidator() },
      { owner: 'test', runtimeKind: 'test-double', timeoutMs: 1000, effectiveConfig: effectiveConfig(intentEngineering) },
    );
    return {
      runner,
      prompt: () => {
        const call = startRun.mock.calls.at(-1)?.[0];
        return typeof call?.inputPayload === 'string' ? call.inputPayload : JSON.stringify(call?.inputPayload ?? '');
      },
    };
  }

  async function philosopher(intentEngineering: boolean, sourceDreamerArtifactId: string): Promise<CapturedRunner<PhilosopherRunner>> {
    const adapter = new TestDoubleRuntimeAdapter({ onFetchOutput: (runId: string) => ({ runId, payload: philosopherPayload(sourceDreamerArtifactId) }) });
    const startRun = vi.spyOn(adapter, 'startRun');
    const runner = new PhilosopherRunner(
      { stateManager: handle.stateManager, artifactStore: handle.stateManager.piArtifactStore, eventEmitter: new StoreEventEmitter(), runtimeAdapter: adapter, validator: new DefaultPhilosopherValidator() },
      { owner: 'test', runtimeKind: 'test-double', timeoutMs: 1000, effectiveConfig: effectiveConfig(intentEngineering) },
    );
    return {
      runner,
      prompt: () => {
        const call = startRun.mock.calls.at(-1)?.[0];
        return typeof call?.inputPayload === 'string' ? call.inputPayload : JSON.stringify(call?.inputPayload ?? '');
      },
    };
  }

  function scribe(intentEngineering: boolean, taskId = SCRIBE_TASK): CapturedRunner<ScribeRunner> {
    const adapter = new TestDoubleRuntimeAdapter({
      onFetchOutput: (runId: string) => ({ runId, payload: { ...scribePayload(), taskId } }),
    });
    const startRun = vi.spyOn(adapter, 'startRun');
    const runner = new ScribeRunner(
      { stateManager: handle.stateManager, artifactStore: handle.stateManager.piArtifactStore, eventEmitter: new StoreEventEmitter(), runtimeAdapter: adapter, validator: new DefaultScribeValidator() },
      { owner: 'test', runtimeKind: 'test-double', timeoutMs: 1000, effectiveConfig: effectiveConfig(intentEngineering) },
    );
    return {
      runner,
      prompt: () => {
        const call = startRun.mock.calls.at(-1)?.[0];
        return typeof call?.inputPayload === 'string' ? call.inputPayload : JSON.stringify(call?.inputPayload ?? '');
      },
    };
  }

  it('flag off: no strategic field reaches Dreamer / Philosopher / Scribe, and Scribe stays V1', async () => {
    await seedChain();

    // ── Dreamer ───────────────────────────────────────────────────────────────
    const dreamerRun = dreamer(false);
    const dreamerResult = await dreamerRun.runner.run(DREAMER_TASK);
    expect(dreamerResult.status).toBe('succeeded');
    const dreamerPrompt = dreamerRun.prompt();
    expect(dreamerPrompt).not.toContain('intentSnapshot');
    expect(dreamerPrompt).not.toContain('intentTension');
    expect(dreamerPrompt).not.toContain('protect owner intent');
    // Ordinary diagnosis material still reaches the prompt.
    expect(dreamerPrompt).toContain('bypassed the authoritative source check');
    expect(dreamerPrompt).toContain('diag#ev1');

    const [dreamerArtifact] = await handle.stateManager.piArtifactStore.listBySourceTaskId(DREAMER_TASK);
    expect(dreamerArtifact).toBeDefined();

    // ── Philosopher ───────────────────────────────────────────────────────────
    const philosopherRun = await philosopher(false, dreamerArtifact?.artifactId ?? '');
    const philosopherResult = await philosopherRun.runner.run(PHILOSOPHER_TASK);
    expect(philosopherResult.status).toBe('succeeded');
    const philosopherPrompt = philosopherRun.prompt();
    expect(philosopherPrompt).not.toContain('intentSnapshot');
    expect(philosopherPrompt).not.toContain('intentTension');
    expect(philosopherPrompt).not.toContain('protect owner intent');
    expect(philosopherPrompt).toContain('bypassed the authoritative source check');
    expect(philosopherPrompt).toContain('diag#ev1');

    // ── Scribe ────────────────────────────────────────────────────────────────
    const scribeRun = scribe(false);
    const scribeResult = await scribeRun.runner.run(SCRIBE_TASK);
    expect(scribeResult.status).toBe('succeeded');
    const scribePrompt = scribeRun.prompt();
    expect(scribePrompt).not.toContain('intentSnapshot');
    expect(scribePrompt).not.toContain('intentTension');
    expect(scribePrompt).not.toContain('strategicIntent');
    expect(scribePrompt).not.toContain('protect owner intent');
    // Root cause / evidence / dreamer proposals are still present.
    expect(scribePrompt).toContain('bypassed the authoritative source check');
    expect(scribePrompt).toContain('diag#ev1');
    expect(scribePrompt).toContain('merge without verification');

    const [scribeArtifact] = await handle.stateManager.piArtifactStore.listBySourceTaskId(SCRIBE_TASK);
    const contract = (JSON.parse(scribeArtifact?.contentJson ?? '{}') as Record<string, unknown>).intentContract as Record<string, unknown>;
    expect(contract).toEqual(VALID_CONTRACT);
    expect(Object.hasOwn(contract, 'schemaVersion')).toBe(false);
    expect(Object.hasOwn(contract, 'strategicAssessment')).toBe(false);

    // ── The persisted Stage A snapshot is untouched ───────────────────────────
    const persistedDiag = await handle.stateManager.piArtifactStore.getArtifactById('pi-diag');
    const diag = JSON.parse(persistedDiag?.contentJson ?? '{}') as Record<string, unknown>;
    expect(diag.intentSnapshot).toEqual(SNAPSHOT);
    expect(diag.intentTension).toBeDefined();

    // ── Re-enabling the flag reuses the ORIGINAL snapshot ─────────────────────
    await handle.stateManager.createTask({
      taskId: SCRIBE_TASK_FLAG_ON, taskKind: 'scribe', status: 'pending', attemptCount: 0, maxAttempts: 3,
      diagnosticJson: createPITaskDiagnosticJson({ dependencyTaskIds: [PHILOSOPHER_TASK], channel: 'prompt', timeoutMs: 1000, inputArtifactRefs: [], outputArtifactRefs: [] }),
    });
    const scribeFlagOn = scribe(true, SCRIBE_TASK_FLAG_ON);
    const flagOnResult = await scribeFlagOn.runner.run(SCRIBE_TASK_FLAG_ON);
    expect(flagOnResult.status).toBe('succeeded');
    expect(scribeFlagOn.prompt()).toContain('protect owner intent');

    const [flagOnArtifact] = await handle.stateManager.piArtifactStore.listBySourceTaskId(SCRIBE_TASK_FLAG_ON);
    const flagOnContract = (JSON.parse(flagOnArtifact?.contentJson ?? '{}') as Record<string, unknown>).intentContract as Record<string, unknown>;
    expect(flagOnContract.schemaVersion).toBe(2);
    expect((flagOnContract.strategicIntent as Record<string, unknown>).contentHash).toBe('sha256:stage-a-hash');
    expect((flagOnContract.strategicAssessment as Record<string, unknown>).relevance).toBe('relevant');
  }, 60000);
});
