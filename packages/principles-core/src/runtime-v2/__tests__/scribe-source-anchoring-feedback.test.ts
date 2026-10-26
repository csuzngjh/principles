import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ScribeRunner } from '../internalization/scribe-runner.js';
import { DefaultScribeValidator, type ScribeOutputV1 } from '../internalization/scribe-output.js';
import { assessIntentBasis, collectUpstreamNormalisedText } from '../internalization/artificer-intent-preflight.js';
import { createPITaskDiagnosticJson, parseLastValidatorErrors } from '../internalization/pitask-metadata.js';
import { createRuntimeStateHandle, type RuntimeStateHandle } from '../runtime-state-handle.js';
import type { PDRuntimeAdapter } from '../runtime-protocol.js';

/**
 * SPEC-PRI-1047 R01: lock the real run4 shape ("Scribe success boundary accepts /
 * preflight rejects"), then verify the repaired loop - a wrong citation can no
 * longer be marked succeeded, the next real model call receives the field-level
 * anchoring error, a corrected span passes, success cleans the record, and the
 * original maxAttempts bound holds across epochs.
 */
const PHILOSOPHER_TASK_ID = 'philosopher-pri1047-001';
const SCRIBE_TASK_ID = 'scribe-pri1047-001';
const PHILOSOPHER_ARTIFACT_ID = 'pi-art-' + PHILOSOPHER_TASK_ID + '-run-1';

const OWNER_SENTENCE = '非简单行为变更先调查现状，交付SPEC和技术方案，明确调用链、输入输出、成本、失败处理、验收及回滚，经Owner确认后再编码；方向认可和操作权限不得替代设计确认。';
const OWNER_MATERIAL_NOTE = 'Owner原文引用："虽然AI写了SPEC，但没有在编码前交Owner审阅...测试通过不能替代设计批准...应改进：' + OWNER_SENTENCE + '"';

/** Production run4 bad textualBasis: label + quotes + ellipsis-omitted reconstruction. */
const RUN4_BAD_BASIS = 'Owner原文：‘非简单行为变更先调查现状，交付SPEC和技术方案……经Owner确认后再编码；方向认可和操作权限不得替代设计确认。’';

function makeScribeOutput(textualBasis: string | null): ScribeOutputV1 {
  return {
    taskId: SCRIBE_TASK_ID,
    sourcePhilosopherArtifactId: PHILOSOPHER_ARTIFACT_ID,
    principleDraft: {
      title: '设计确认门禁',
      statement: '高成本非简单变更必须先交付SPEC并获Owner设计批准后才编码；方向授权与测试通过不得替代设计批准。',
      rationale: '未经设计批准的实现偏离Owner意图并造成高成本返工。',
      applicability: ['高成本、有严重后果的非简单行为变更'],
      antiPatterns: ['以方向授权或操作权限替代设计确认', '编码前未交Owner审阅SPEC'],
      confidence: 0.9,
    },
    intentContract: {
      ownerIntent: 'Owner要求高成本非简单行为变更先提交SPEC并经显式批准后才编码。',
      targetBehavior: '编码前交付含调用链、输入输出、成本、失败处理、验收与回滚的SPEC并获得Owner设计批准。',
      forbiddenBehavior: '未经设计批准直接编码，或把方向认可、操作权限、测试通过当设计批准。',
      evidenceSource: 'the source diagnosis Owner evidence note',
      validationExpectation: '未经批准的非简单高成本变更在编码前被阻止。',
    },
    sourceTrace: { philosopherArtifactId: PHILOSOPHER_ARTIFACT_ID },
    risks: [],
    generatedAt: new Date().toISOString(),
    ...(textualBasis === null
      ? { executionConditions: { version: 1 as const, requiredFacts: [] } }
      : { executionConditions: { version: 1 as const, requiredFacts: [{ factKind: 'design_approval', required: true, textualBasis }] } }),
  };
}

/** Programmable fake adapter: returns payloads in sequence, captures every real startRun input. */
function makeSequencedAdapter(payloads: unknown[]): PDRuntimeAdapter & { startRunInputs: string[] } {
  let invocation = 0;
  const startRunInputs: string[] = [];
  const runIdFor = () => {
    const seq = invocation;
    invocation += 1;
    return 'run-seq-' + seq;
  };
  return {
    startRunInputs,
    kind: () => 'test-double',
    startRun: async (input: { inputPayload: unknown }) => {
      startRunInputs.push(String(input.inputPayload));
      const runId = runIdFor();
      return { runId, runtimeKind: 'test-double' as const, startedAt: new Date().toISOString() };
    },
    pollRun: async (runId: string) => ({ status: 'succeeded' as const, runId }),
    fetchOutput: async (runId: string) => {
      const suffix = runId.slice('run-seq-'.length);
      const index = Number.parseInt(suffix, 10);
      return { runId, payload: payloads[index] };
    },
    cancelRun: async () => undefined,
    getCapabilities: async () => ({}),
    healthCheck: async () => ({ healthy: true }),
    fetchArtifacts: async () => [],
  } as unknown as PDRuntimeAdapter & { startRunInputs: string[] };
}
describe('SPEC-PRI-1047 R01 - scribe source-anchoring success boundary + validator feedback loop', () => {
  let workspaceDir: string;
  let handle: RuntimeStateHandle;

  beforeEach(async () => {
    workspaceDir = mkdtempSync(join(tmpdir(), 'pd-pri1047-r01-'));
    handle = await createRuntimeStateHandle({ workspaceDir });
    const now = new Date().toISOString();
    await handle.stateManager.createTask({
      taskId: PHILOSOPHER_TASK_ID, taskKind: 'philosopher', status: 'succeeded',
      attemptCount: 1, maxAttempts: 3, resultRef: 'philosopher://run-1',
      diagnosticJson: createPITaskDiagnosticJson({
        dependencyTaskIds: [], channel: 'code_tool_hook', timeoutMs: 300_000,
        inputArtifactRefs: [], outputArtifactRefs: [], pipelineMode: 'standard',
      }),
    });
    await handle.stateManager.piArtifactStore.upsertArtifact({
      artifactId: PHILOSOPHER_ARTIFACT_ID, artifactKind: 'principle', sourceTaskId: PHILOSOPHER_TASK_ID,
      lineageArtifactIds: [], validationStatus: 'validated',
      contentJson: JSON.stringify({ taskId: PHILOSOPHER_TASK_ID, analysis: OWNER_MATERIAL_NOTE, thesis: '', risks: [] }),
      createdAt: now, updatedAt: now,
    });
    await handle.stateManager.createTask({
      taskId: SCRIBE_TASK_ID, taskKind: 'scribe', status: 'pending',
      attemptCount: 0, maxAttempts: 3,
      diagnosticJson: createPITaskDiagnosticJson({
        dependencyTaskIds: [PHILOSOPHER_TASK_ID], channel: 'code_tool_hook', timeoutMs: 300_000,
        inputArtifactRefs: [], outputArtifactRefs: [], pipelineMode: 'standard',
      }),
    });
  });

  afterEach(async () => {
    await handle.close().catch(() => undefined);
    rmSync(workspaceDir, { recursive: true, force: true });
  });

  function makeRunner(adapter: PDRuntimeAdapter): ScribeRunner {
    return new ScribeRunner({
      stateManager: handle.stateManager,
      runtimeAdapter: adapter,
      eventEmitter: { emitTelemetry: () => undefined } as never,
      artifactStore: handle.stateManager.piArtifactStore,
      validator: new DefaultScribeValidator({ requireRuleCodeContracts: true }),
    }, { owner: 'pri1047-test', runtimeKind: 'test-double', pollIntervalMs: 5, timeoutMs: 5_000 });
  }

  it('locks the pre-fix contradiction: structural validator valid=true while preflight says textual_basis_unanchored', async () => {
    const badOutput = makeScribeOutput(RUN4_BAD_BASIS);
    const legacyValidator = new DefaultScribeValidator({ requireRuleCodeContracts: true });
    const legacy = await legacyValidator.validate(badOutput, SCRIBE_TASK_ID, PHILOSOPHER_ARTIFACT_ID);
    expect(legacy.valid).toBe(true); // pre-fix: the scribe success boundary accepted - circuit front half

    const upstream = await collectUpstreamNormalisedText(
      (id) => handle.stateManager.getTask(id),
      (sourceTaskId) => handle.stateManager.piArtifactStore.listBySourceTaskId(sourceTaskId),
      { scribeDependencyTaskIds: [PHILOSOPHER_TASK_ID] },
    );
    expect(upstream).not.toBeNull();
    const assessment = assessIntentBasis({
      scribeArtifact: { artifactId: 'pi-art-scribe-run4', contentJson: JSON.stringify(badOutput) },
      upstreamMaterial: upstream,
      taskId: 'artificer-001',
    });
    expect(assessment.status).toBe('intent_unverified'); // circuit back half
    if (assessment.status !== 'executable') expect(assessment.reasonCode).toBe('textual_basis_unanchored');
  });

  it('R01 main loop: bad citation rejected unpersisted; second real model call receives the field-level error; corrected span succeeds and cleans up', async () => {
    const adapter = makeSequencedAdapter([
      makeScribeOutput(RUN4_BAD_BASIS),   // attempt 1: production run4 bad citation
      makeScribeOutput(OWNER_SENTENCE),   // attempt 2: corrected continuous original sentence
    ]);
    const runner = makeRunner(adapter);

    const first = await runner.run(SCRIBE_TASK_ID);
    expect(first.status).toBe('retried');                       // never marked succeeded (EP-03)
    expect(first.errorCategory).toBe('output_invalid');
    const afterFirst = await handle.stateManager.getTask(SCRIBE_TASK_ID);
    expect(afterFirst?.status).toBe('retry_wait');
    const artifactsAfterFirst = await handle.stateManager.piArtifactStore.listBySourceTaskId(SCRIBE_TASK_ID);
    expect(artifactsAfterFirst).toHaveLength(0);                // no consumable artifact
    const recorded = parseLastValidatorErrors(afterFirst?.diagnosticJson);
    expect(recorded).not.toBeNull();
    expect(recorded?.errors.some((e) => e.includes("factKind 'design_approval'") && e.includes('continuous verbatim span'))).toBe(true);
    expect(adapter.startRunInputs[0]).not.toContain('previous_validation_errors'); // first round carries no stale errors

    // Wake-up expiry (test re-pends the task, equivalent to backoff expiry re-lease).
    await handle.stateManager.updateTask(SCRIBE_TASK_ID, { status: 'pending' });

    const second = await runner.run(SCRIBE_TASK_ID);
    expect(second.status).toBe('succeeded');                    // corrected span passes
    // The second real model call MUST receive the latest field-level errors (the
    // no-feedback old implementation fails right here).
    const [firstPrompt, secondPrompt] = adapter.startRunInputs;
    expect(secondPrompt).toContain('<previous_validation_errors>');
    expect(secondPrompt).toContain("factKind 'design_approval'");
    expect(secondPrompt).toContain('continuous verbatim span');
    const afterSecond = await handle.stateManager.getTask(SCRIBE_TASK_ID);
    expect(afterSecond?.status).toBe('succeeded');
    expect(parseLastValidatorErrors(afterSecond?.diagnosticJson)).toBeNull(); // cleanup after success
    const artifacts = await handle.stateManager.piArtifactStore.listBySourceTaskId(SCRIBE_TASK_ID);
    expect(artifacts).toHaveLength(1);
    const [persistedArtifact] = artifacts;
    if (persistedArtifact === undefined) throw new Error('fixture: persisted artifact missing');
    const persisted = JSON.parse(persistedArtifact.contentJson) as ScribeOutputV1;
    const persistedBasis = persisted.executionConditions?.requiredFacts[0]?.textualBasis;
    expect(persistedBasis).toBe(OWNER_SENTENCE);
    expect(firstPrompt).not.toBe(secondPrompt);
  });

  it('bounded by the ORIGINAL maxAttempts: persistent bad citations end in the structured terminal, never an extra attempt', async () => {
    await handle.stateManager.updateTask(SCRIBE_TASK_ID, { maxAttempts: 2 });
    const adapter = makeSequencedAdapter([
      makeScribeOutput(RUN4_BAD_BASIS),
      makeScribeOutput(RUN4_BAD_BASIS),
    ]);
    const runner = makeRunner(adapter);
    const first = await runner.run(SCRIBE_TASK_ID);
    expect(first.status).toBe('retried');
    await handle.stateManager.updateTask(SCRIBE_TASK_ID, { status: 'pending' });
    const second = await runner.run(SCRIBE_TASK_ID);
    expect(second.status).toBe('failed');                       // exhaustion = structured terminal
    expect(second.attemptCount).toBeLessThanOrEqual(2);
    const finalTask = await handle.stateManager.getTask(SCRIBE_TASK_ID);
    expect(finalTask?.status).toBe('failed');
    expect(adapter.startRunInputs).toHaveLength(2);             // no third model call
  });

  it('cross-epoch freshness: a stale record from a previous epoch never re-enters the new round', async () => {
    const task = await handle.stateManager.getTask(SCRIBE_TASK_ID);
    if (task === null) throw new Error('fixture: scribe task missing');
    const stale = JSON.parse(task.diagnosticJson ?? '{}') as Record<string, unknown>;
    stale.lastValidatorErrors = {
      recordedAt: '2026-10-25T00:00:00.000Z', errorCategory: 'output_invalid',
      errors: ['STALE-ERROR-must-not-reenter'], sourceAttemptCount: 9,
    };
    await handle.stateManager.updateTask(SCRIBE_TASK_ID, { diagnosticJson: JSON.stringify(stale) });

    const adapter = makeSequencedAdapter([makeScribeOutput(OWNER_SENTENCE)]);
    const runner = makeRunner(adapter);
    const result = await runner.run(SCRIBE_TASK_ID);
    expect(result.status).toBe('succeeded');
    expect(adapter.startRunInputs[0]).not.toContain('STALE-ERROR-must-not-reenter');
    expect(adapter.startRunInputs[0]).not.toContain('<previous_validation_errors>');
  });
});
