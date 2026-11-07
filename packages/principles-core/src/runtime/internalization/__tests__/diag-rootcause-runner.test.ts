/**
 * DiagRootCauseRunner — Stage A V-slice tests (PRI-372).
 *
 * Stage-A evidence kept here:
 *   1. lease → succeed → writes PIArtifact
 *   2. lease → fail (validator seam) → no artifact written
 *   3. no dependency → runs standalone (first stage, contextAssembler path)
 *   4. runtime failure → no artifact, no markTaskSucceeded
 *   5. succeedTask ordering (updateRunOutput before markTaskSucceeded)
 *   6. PRI-442 Bug-B-005 "main" agentId pin — DO NOT MOVE
 *
 * Shared-template its (currentPhase transitions, wrong taskKind, taskId
 * integrity pair, storage-layer artifact write failure) were consolidated
 * into diag-runner-contract.test.ts (Test Diet Phase 2.2-B2); scaffold comes
 * from __fixtures__/diag-runner-harness.ts. Since Phase 2.2-B3-A the default
 * validator is the real TypeBox validator behind a spy; mock overrides here
 * remain only for failure injection.
 *
 * ERR entries considered:
 *   - ERR-001: Treat parsed JSON / LLM output as unknown — validator receives unknown
 *   - ERR-005: No `as` bypass — all mocks use vi.fn() with typed returns
 *   - ERR-009: Required fields fail loud — validator checks taskId match
 */
import type { vi } from 'vitest';
import { describe, it, expect } from 'vitest';
import type { RunStatus } from '../../runtime-protocol.js';
import {
  createDiagRunnerHarness,
  ROOTCAUSE_TASK_ID,
} from './__fixtures__/diag-runner-harness.js';

type MockFn = ReturnType<typeof vi.fn>;

describe('DiagRootCauseRunner V-slice', () => {
  it('lease → succeed → writes PIArtifact', async () => {
    const h = createDiagRunnerHarness('rootcause');

    const result = await h.runner.run(ROOTCAUSE_TASK_ID);

    expect(result.status).toBe('succeeded');
    expect(result.taskId).toBe(ROOTCAUSE_TASK_ID);
    expect(result.artifactId).toBeDefined();

    // Verify PIArtifact was written
    const artifacts = await h.deps.artifactStore.listBySourceTaskId(ROOTCAUSE_TASK_ID);
    expect(artifacts).toHaveLength(1);
    expect(artifacts[0]?.artifactKind).toBe('principle');
    expect(artifacts[0]?.sourceTaskId).toBe(ROOTCAUSE_TASK_ID);

    // Verify markTaskSucceeded called with diag-rootcause:// resultRef
    expect(h.deps._stateManager.markTaskSucceeded).toHaveBeenCalledWith(
      ROOTCAUSE_TASK_ID,
      expect.stringContaining('diag-rootcause://'),
    );

    // Verify updateRunOutput called before markTaskSucceeded
    expect(h.deps._stateManager.updateRunOutput).toHaveBeenCalledWith(
      h.runId,
      expect.any(String),
    );
  });

  it('lease → fail → no artifact written', async () => {
    const h = createDiagRunnerHarness('rootcause');
    // Make validator reject the output
    (h.deps._validator.validate).mockResolvedValue({
      valid: false,
      errors: ['taskId mismatch'],
      errorCategory: 'output_invalid',
    });

    const result = await h.runner.run(ROOTCAUSE_TASK_ID);

    expect(result.status).toBe('failed');

    // No artifact written
    const artifacts = await h.deps.artifactStore.listBySourceTaskId(ROOTCAUSE_TASK_ID);
    expect(artifacts).toHaveLength(0);

    // No markTaskSucceeded
    expect(h.deps._stateManager.markTaskSucceeded).not.toHaveBeenCalled();

    // No updateRunOutput (validation failed before succeedTask)
    expect(h.deps._stateManager.updateRunOutput).not.toHaveBeenCalled();
  });

  it('PRI-1059: rejects a copied prompt example whose evidence refs are unbound', async () => {
    const h = createDiagRunnerHarness('rootcause');
    const forged = {
      ...h.makeOutput(),
      diagnosisId: 'example',
      summary: 'example',
      rootCause: 'People: Example root cause',
      rootCauseCategory: 'People',
      causalChain: [{ why: 1, statement: 'example', evidenceRefs: ['example'] }],
      evidence: [{ sourceRef: 'example', note: 'example' }],
      confidence: 0.5,
    };
    (h.deps._runtimeAdapter.fetchOutput as MockFn).mockResolvedValue({ payload: forged });

    const result = await h.runner.run(ROOTCAUSE_TASK_ID);

    expect(result.status).toBe('failed');
    expect(result.failureReason).toContain('evidence_ref_unbound');
    expect(result.failureReason).toContain('evidence[0].sourceRef');
    expect(h.deps._stateManager.markTaskSucceeded).not.toHaveBeenCalled();
    await expect(h.deps.artifactStore.listBySourceTaskId(ROOTCAUSE_TASK_ID)).resolves.toHaveLength(0);
  });

  it('PRI-1059: rejects a fabricated ref in causalChain even when evidence[] is real', async () => {
    const h = createDiagRunnerHarness('rootcause');
    const valid = h.makeOutput();
    const causalChain = (valid.causalChain as Record<string, unknown>[]).map((entry, index) => ({
      ...entry,
      evidenceRefs: index === 0 ? ['fabricated:ref'] : entry.evidenceRefs,
    }));
    (h.deps._runtimeAdapter.fetchOutput as MockFn).mockResolvedValue({
      payload: { ...valid, causalChain },
    });

    const result = await h.runner.run(ROOTCAUSE_TASK_ID);

    expect(result.status).toBe('failed');
    expect(result.failureReason).toContain('causalChain[0].evidenceRefs[0]');
    await expect(h.deps.artifactStore.listBySourceTaskId(ROOTCAUSE_TASK_ID)).resolves.toHaveLength(0);
  });

  it('PRI-1059: accepts owner_correction only when the context carries the Owner words', async () => {
    const h = createDiagRunnerHarness('rootcause');
    h.deps._contextAssembler.assemble.mockResolvedValue({
      sourceRefs: ['ref-1', 'ref-2'],
      conversationWindow: [],
      diagnosisTarget: { correctionEvidence: { text: 'Do not give me unverified answers' } },
    });
    const valid = h.makeOutput();
    const causalChain = (valid.causalChain as Record<string, unknown>[]).map((entry) => ({
      ...entry,
      evidenceRefs: ['owner_correction'],
    }));
    (h.deps._runtimeAdapter.fetchOutput as MockFn).mockResolvedValue({
      payload: {
        ...valid,
        causalChain,
        evidence: [{ sourceRef: 'owner_correction', note: 'Do not give me unverified answers' }],
      },
    });

    const result = await h.runner.run(ROOTCAUSE_TASK_ID);

    expect(result.status).toBe('succeeded');
    await expect(h.deps.artifactStore.listBySourceTaskId(ROOTCAUSE_TASK_ID)).resolves.toHaveLength(1);
  });

  it('no dependency → runs standalone (first stage)', async () => {
    // The default rootcause self task has no dependencies (first stage in pipeline)
    const h = createDiagRunnerHarness('rootcause');

    const result = await h.runner.run(ROOTCAUSE_TASK_ID);

    // Should succeed without needing predecessor artifacts
    expect(result.status).toBe('succeeded');
    expect(result.artifactId).toBeDefined();

    // ContextAssembler was called (rootcause uses it for pain context)
    expect(h.deps._contextAssembler.assemble).toHaveBeenCalledWith(ROOTCAUSE_TASK_ID);
  });

  it('runtime failure → no artifact, no markTaskSucceeded', async () => {
    const h = createDiagRunnerHarness('rootcause');
    // Make the runtime adapter return a failed status
    const failedStatus: RunStatus = { status: 'failed', runId: h.runId };
    (h.deps._runtimeAdapter.pollRun as MockFn).mockResolvedValue(failedStatus);

    const result = await h.runner.run(ROOTCAUSE_TASK_ID);

    expect(result.status).toBe('failed');

    // No artifact written
    const artifacts = await h.deps.artifactStore.listBySourceTaskId(ROOTCAUSE_TASK_ID);
    expect(artifacts).toHaveLength(0);

    // No markTaskSucceeded
    expect(h.deps._stateManager.markTaskSucceeded).not.toHaveBeenCalled();
  });

  it('succeedTask calls updateRunOutput before markTaskSucceeded', async () => {
    const h = createDiagRunnerHarness('rootcause');
    const callOrder: string[] = [];
    (h.deps._stateManager.updateRunOutput as MockFn).mockImplementation(() => {
      callOrder.push('updateRunOutput');
      return Promise.resolve();
    });
    (h.deps._stateManager.markTaskSucceeded as MockFn).mockImplementation(() => {
      callOrder.push('markTaskSucceeded');
      return Promise.resolve();
    });

    const result = await h.runner.run(ROOTCAUSE_TASK_ID);
    expect(result.status).toBe('succeeded');
    expect(callOrder).toEqual(['updateRunOutput', 'markTaskSucceeded']);
  });

  // PRI-442 Bug-B-005 (revised): split pipeline stages must use 'main' (the
  // default OpenClaw agent) as agentId, not the internal stage name nor the
  // PD-internal 'diagnostician' constant. The OpenClaw CLI rejects unknown
  // agent IDs with "Unknown agent id".
  it('PRI-442 Bug-B-005: uses "main" agentId for OpenClaw CLI (not internal stage name nor PD-internal "diagnostician")', async () => {
    const h = createDiagRunnerHarness('rootcause');

    await h.runner.run(ROOTCAUSE_TASK_ID);

    // startRun must be called with agentId 'main', NOT 'diag_rootcause' nor 'diagnostician'
    expect(h.deps._runtimeAdapter.startRun).toHaveBeenCalledTimes(1);
    const startRunCalls = (h.deps._runtimeAdapter.startRun as MockFn).mock.calls;
    expect(startRunCalls.length).toBeGreaterThan(0);
    const startRunCall = startRunCalls[0]?.[0] as { agentSpec: { agentId: string }; outputSchemaRef: string };
    expect(startRunCall.agentSpec.agentId).toBe('main');
    // outputSchemaRef still distinguishes the stage
    expect(startRunCall.outputSchemaRef).toBe('diag-rootcause-output-v1');
  });
});
