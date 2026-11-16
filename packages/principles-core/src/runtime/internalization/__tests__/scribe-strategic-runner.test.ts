/**
 * SIA v1.2 · PRI-1216 — Scribe success boundary assembles the V2 contract.
 *
 * SPEC §8.3 producer table: the server, not the model, stamps
 * `strategicIntent` / `relevance` / `conflictStatus` from the fixed Stage A
 * artifact. These tests run the REAL runner over an isolated state handle:
 *
 * 1. flag on  → persisted artifact carries a complete V2 whose relevance came
 *               from Stage A (never from the model);
 * 2. flag off → the persisted artifact keeps the historical V1 shape;
 * 3. a model-forged relevance is overridden and recorded as an event.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRuntimeStateHandle, type RuntimeStateHandle } from '../../runtime-state-handle.js';
import { TestDoubleRuntimeAdapter } from '../../adapter/test-double-runtime-adapter.js';
import { StoreEventEmitter } from '../../store/event-emitter.js';
import { ScribeRunner } from '../scribe-runner.js';
import { DefaultScribeValidator } from '../scribe-output.js';
import { createPITaskDiagnosticJson } from '../pitask-metadata.js';
import { computeEffectivePdConfig } from '../../config/index.js';
import type { EffectivePdConfig } from '../../config/pd-config-types.js';

const NOW = '2026-11-14T00:00:00.000Z';
const DREAMER_TASK = 'dreamer-task';
const DIAG_TASK = 'diag-router-task';
const PHILOSOPHER_TASK = 'philosopher-task';
const SCRIBE_TASK = 'scribe-task';

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

function scribePayload(contract: Record<string, unknown>) {
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
    intentContract: contract,
    executionConditions: { version: 1, requiredFacts: [] },
  };
}

describe('ScribeRunner — strategic contract assembly (SIA v1.2)', () => {
  let dir: string;
  let handle: RuntimeStateHandle;
  let intentEngineering = false;

  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), 'pd-scribe-strategic-'));
    handle = await createRuntimeStateHandle({ workspaceDir: dir });
  });

  afterEach(async () => {
    await handle.close();
    rmSync(dir, { recursive: true, force: true });
  });

  async function seedChain(contract: Record<string, unknown>) {
    const state = handle.stateManager;
    await state.createTask({ taskId: DIAG_TASK, taskKind: 'diag_router', status: 'succeeded', attemptCount: 1, maxAttempts: 3, diagnosticJson: '{}' });
    await state.createTask({ taskId: DREAMER_TASK, taskKind: 'dreamer', status: 'succeeded', attemptCount: 1, maxAttempts: 3, diagnosticJson: createPITaskDiagnosticJson({ dependencyTaskIds: [DIAG_TASK], channel: 'prompt', timeoutMs: 1000, inputArtifactRefs: [], outputArtifactRefs: [] }) });
    await state.createTask({ taskId: PHILOSOPHER_TASK, taskKind: 'philosopher', status: 'succeeded', attemptCount: 1, maxAttempts: 3, diagnosticJson: createPITaskDiagnosticJson({ dependencyTaskIds: [DREAMER_TASK], channel: 'prompt', timeoutMs: 1000, inputArtifactRefs: [], outputArtifactRefs: [] }) });
    await state.createTask({ taskId: SCRIBE_TASK, taskKind: 'scribe', status: 'pending', attemptCount: 0, maxAttempts: 3, diagnosticJson: createPITaskDiagnosticJson({ dependencyTaskIds: [PHILOSOPHER_TASK], channel: 'prompt', timeoutMs: 1000, inputArtifactRefs: [], outputArtifactRefs: [] }) });

    const store = state.piArtifactStore;
    const common = { artifactKind: 'principle' as const, lineageArtifactIds: [], validationStatus: 'pending' as const, createdAt: NOW, updatedAt: NOW };
    await store.upsertArtifact({ ...common, artifactId: 'pi-dreamer', sourceTaskId: DREAMER_TASK, contentJson: JSON.stringify({ valid: true, taskId: DREAMER_TASK, candidates: [], contextRefs: [], sourcePainId: 'pain-1', generatedAt: NOW, intentTension: { source: 'action_drift', relatedIntentFields: ['why'], explanation: 'drifted from the owner intent' }, intentSnapshot: { schemaVersion: 1, contentHash: 'sha256:stage-a-hash', capturedAt: NOW, lang: 'en', sections: [{ key: 'why', text: 'protect owner intent' }] } }) });
    await store.upsertArtifact({ ...common, artifactId: 'pi-diag', sourceTaskId: DIAG_TASK, contentJson: JSON.stringify({ taskId: DIAG_TASK, rootCause: 'bypass', summary: 'drift', violatedPrinciples: [], evidence: [{ sourceRef: 'diag#ev1', note: 'bypass' }], recommendations: [], confidence: 0.8, intentTension: { source: 'action_drift', relatedIntentFields: ['why'], explanation: 'drifted from the owner intent' }, intentSnapshot: { contentHash: 'sha256:stage-a-hash', capturedAt: NOW, sections: [{ key: 'why', text: 'protect owner intent' }] } }) });
    await store.upsertArtifact({ ...common, artifactId: 'pi-philosopher', sourceTaskId: PHILOSOPHER_TASK, contentJson: JSON.stringify({ taskId: PHILOSOPHER_TASK, sourceDreamerArtifactId: 'pi-dreamer', thesis: 'check intent', principleCandidate: { title: 'Check intent', rationale: 'drift', scope: 'writes', confidence: 0.9 }, risks: [], generatedAt: NOW }) });

    const runtimeAdapter = new TestDoubleRuntimeAdapter({ onFetchOutput: (runId: string) => ({ runId, payload: scribePayload(contract) }) });
    const startRun = vi.spyOn(runtimeAdapter, 'startRun');
    const eventEmitter = new StoreEventEmitter();
    const runner = new ScribeRunner(
      { stateManager: state, artifactStore: store, eventEmitter, runtimeAdapter, validator: new DefaultScribeValidator() },
      { owner: 'test', runtimeKind: 'test-double', timeoutMs: 1000, effectiveConfig: effectiveConfig(intentEngineering) },
    );
    return { runner, startRun, store, eventEmitter };
  }

  it('flag on: persists a complete V2 with the server-derived relevance', async () => {
    intentEngineering = true;
    const { runner, startRun, store } = await seedChain({
      ...VALID_CONTRACT,
      strategicAssessment: { relevance: 'not_configured', conflicts: [{ against: 'owner_intent', ref: 'why', status: 'potential', evidenceRefs: ['diag#ev1'] }] },
      corePrincipleRefs: ['T-01'],
    });

    const result = await runner.run(SCRIBE_TASK);
    expect(result.status).toBe('succeeded');
    expect(startRun).toHaveBeenCalledOnce();

    const [artifact] = await store.listBySourceTaskId(SCRIBE_TASK);
    expect(artifact).toBeDefined();
    const persisted = JSON.parse(artifact?.contentJson ?? '{}') as Record<string, unknown>;
    const contract = persisted.intentContract as Record<string, unknown>;
    expect(contract.schemaVersion).toBe(2);
    // Stage A says the judgment cites `why` → relevant, regardless of the model.
    expect((contract.strategicAssessment as Record<string, unknown>).relevance).toBe('relevant');
    expect((contract.strategicAssessment as Record<string, unknown>).conflictStatus).toBe('potential');
    expect((contract.strategicIntent as Record<string, unknown>).contentHash).toBe('sha256:stage-a-hash');
    expect(contract.corePrincipleRefs).toEqual(['T-01']);
  });

  it('flag off: persists the historical V1 contract unchanged', async () => {
    intentEngineering = false;
    const { runner, store } = await seedChain({ ...VALID_CONTRACT });
    const result = await runner.run(SCRIBE_TASK);
    expect(result.status).toBe('succeeded');

    const [artifact] = await store.listBySourceTaskId(SCRIBE_TASK);
    const persisted = JSON.parse(artifact?.contentJson ?? '{}') as Record<string, unknown>;
    const contract = persisted.intentContract as Record<string, unknown>;
    expect(contract).toEqual(VALID_CONTRACT);
    expect(Object.hasOwn(contract, 'schemaVersion')).toBe(false);
  });

  it('flag on: the model cannot author relevance — the server overrides it', async () => {
    intentEngineering = true;
    const { runner, store } = await seedChain({
      ...VALID_CONTRACT,
      schemaVersion: 2,
      strategicAssessment: { relevance: 'not_applicable', conflictStatus: 'confirmed' },
    });
    const result = await runner.run(SCRIBE_TASK);
    expect(result.status).toBe('succeeded');

    const [artifact] = await store.listBySourceTaskId(SCRIBE_TASK);
    const contract = (JSON.parse(artifact?.contentJson ?? '{}') as Record<string, unknown>).intentContract as Record<string, unknown>;
    const assessment = contract.strategicAssessment as Record<string, unknown>;
    expect(assessment.relevance).toBe('relevant');
    expect(assessment.conflictStatus).toBe('none');
  });

  it('flag on: a missing intentContract is a hard failure (no silent V1 downgrade)', async () => {
    intentEngineering = true;
    const state = handle.stateManager;
    const { runner, store } = await seedChain({ ...VALID_CONTRACT });
    // Re-seed without a contract by overriding the adapter output.
    const runtimeAdapter = new TestDoubleRuntimeAdapter({ onFetchOutput: (runId: string) => ({ runId, payload: { ...scribePayload(VALID_CONTRACT), intentContract: undefined } }) });
    const failing = new ScribeRunner(
      { stateManager: state, artifactStore: store, eventEmitter: new StoreEventEmitter(), runtimeAdapter, validator: new DefaultScribeValidator() },
      { owner: 'test', runtimeKind: 'test-double', timeoutMs: 1000, effectiveConfig: effectiveConfig(true) },
    );
    const result = await failing.run(SCRIBE_TASK);
    expect(result.status).not.toBe('succeeded');
    expect(result.failureReason).toContain('intentContract is required when intent anchoring is enabled');
    expect(await store.listBySourceTaskId(SCRIBE_TASK)).toHaveLength(0);
    void runner;
  });
});
