/**
 * DiagDistillerRunner — Stage B V-slice tests (PRI-372).
 *
 * Stage-B evidence kept here:
 *   1. lease → succeed → writes PIArtifact with groundedOnCorePrincipleIds
 *   2. fabricated axiom ID (T-99) rejected by the real validator → task fails
 *   3. core grounding flag off → groundedOnCorePrincipleIds empty (still valid)
 *   4. dependency not succeeded → blocked
 *   5. no predecessor dependency → fails (requires rootcause artifact)
 *   6. EP-07 sourceRootCauseArtifactId lineage integrity violation — DO NOT MOVE
 *
 * Shared-template its (currentPhase transitions, wrong taskKind, taskId
 * integrity pair, storage-layer artifact write failure, EP-01 corrupted
 * predecessor) were consolidated into diag-runner-contract.test.ts
 * (Test Diet Phase 2.2-B2); scaffold comes from
 * __fixtures__/diag-runner-harness.ts. Since Phase 2.2-B3-A the default
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
import { createPITaskDiagnosticJson } from '../pitask-metadata.js';
import {
  createDiagRunnerHarness,
  makeDistillerOutput,
  makePredecessorStore,
  makeRootCausePredecessorTask,
  DISTILLER_TASK_ID,
  DISTILLER_ROOTCAUSE_ARTIFACT_ID,
  ROOTCAUSE_TASK_ID,
} from './__fixtures__/diag-runner-harness.js';

type MockFn = ReturnType<typeof vi.fn>;

describe('DiagDistillerRunner V-slice', () => {
  it('lease → succeed → writes PIArtifact with groundedOnCorePrincipleIds', async () => {
    const h = createDiagRunnerHarness('distiller');

    const result = await h.runner.run(DISTILLER_TASK_ID);

    expect(result.status).toBe('succeeded');
    expect(result.taskId).toBe(DISTILLER_TASK_ID);
    expect(result.artifactId).toBeDefined();

    // Verify PIArtifact was written
    const artifacts = await h.deps.artifactStore.listBySourceTaskId(DISTILLER_TASK_ID);
    expect(artifacts).toHaveLength(1);
    expect(artifacts[0]?.artifactKind).toBe('principle');
    expect(artifacts[0]?.sourceTaskId).toBe(DISTILLER_TASK_ID);

    // Verify artifact content contains groundedOnCorePrincipleIds
    const contentJson = artifacts[0]?.contentJson;
    expect(contentJson).toBeDefined();
    if (contentJson) {
      const parsed = JSON.parse(contentJson) as Record<string, unknown>;
      expect(parsed.groundedOnCorePrincipleIds).toEqual(['T-01', 'T-07']);
    }

    // Verify markTaskSucceeded called with diag-distiller:// resultRef
    expect(h.deps._stateManager.markTaskSucceeded).toHaveBeenCalledWith(
      DISTILLER_TASK_ID,
      expect.stringContaining('diag-distiller'),
    );
  });

  it('fabricated axiom ID (T-99) rejected by validator → task fails', async () => {
    // Use the real DefaultDiagDistillerValidator which checks isCorePrincipleId
    const { DefaultDiagDistillerValidator } = await import('../../diagnostician/diag-distiller-output.js');
    const h = createDiagRunnerHarness('distiller', { validator: new DefaultDiagDistillerValidator() });

    // Output with fabricated T-99 axiom ID
    const fabricatedOutput = makeDistillerOutput({ groundedOnCorePrincipleIds: ['T-99'] });
    (h.deps._runtimeAdapter.fetchOutput as MockFn).mockResolvedValue({ payload: fabricatedOutput });

    const result = await h.runner.run(DISTILLER_TASK_ID);

    // Validation should fail because T-99 is not in the registry
    expect(result.status).toBe('failed');

    // No artifact written for the distiller task
    const artifacts = await h.deps.artifactStore.listBySourceTaskId(DISTILLER_TASK_ID);
    expect(artifacts).toHaveLength(0);

    // No markTaskSucceeded
    expect(h.deps._stateManager.markTaskSucceeded).not.toHaveBeenCalled();
  });

  it('core grounding flag off → groundedOnCorePrincipleIds empty', async () => {
    const h = createDiagRunnerHarness('distiller');
    // Output with empty groundedOnCorePrincipleIds (flag off scenario)
    const noGroundingOutput = h.makeOutput({ groundedOnCorePrincipleIds: [] });
    (h.deps._runtimeAdapter.fetchOutput as MockFn).mockResolvedValue({ payload: noGroundingOutput });

    const result = await h.runner.run(DISTILLER_TASK_ID);

    // Empty groundedOnCorePrincipleIds is valid (flag off = no grounding)
    expect(result.status).toBe('succeeded');
    expect(result.artifactId).toBeDefined();

    // Verify artifact content has empty grounding
    const artifacts = await h.deps.artifactStore.listBySourceTaskId(DISTILLER_TASK_ID);
    expect(artifacts).toHaveLength(1);
    const contentJson = artifacts[0]?.contentJson;
    if (contentJson) {
      const parsed = JSON.parse(contentJson) as Record<string, unknown>;
      expect(parsed.groundedOnCorePrincipleIds).toEqual([]);
    }
  });

  it('dependency not succeeded → blocked', async () => {
    // Empty artifact store — no rootcause artifact yet
    const h = createDiagRunnerHarness('distiller', {
      artifactStore: makePredecessorStore({}),
    });
    // Make the rootcause task still pending (not succeeded)
    const pendingRootCauseTask = makeRootCausePredecessorTask({ status: 'pending', resultRef: undefined });
    (h.deps._stateManager.getTask as MockFn).mockImplementation((id: string) => {
      if (id === DISTILLER_TASK_ID) return Promise.resolve(h.makeTask());
      if (id === ROOTCAUSE_TASK_ID) return Promise.resolve(pendingRootCauseTask);
      return Promise.resolve(undefined);
    });

    const result = await h.runner.run(DISTILLER_TASK_ID);

    // Should fail because predecessor artifact is missing
    expect(result.status).toBe('failed');
  });

  it('no predecessor dependency → fails (requires rootcause artifact)', async () => {
    const h = createDiagRunnerHarness('distiller');
    // Create a distiller task with no dependencies
    const noDepTask = h.makeTask({
      diagnosticJson: createPITaskDiagnosticJson({
        dependencyTaskIds: [],
        channel: 'prompt',
        timeoutMs: 300_000,
        inputArtifactRefs: [],
        outputArtifactRefs: [],
      }),
    });
    (h.deps._stateManager.acquireLease as MockFn).mockResolvedValue(noDepTask);
    (h.deps._stateManager.getTask as MockFn).mockImplementation((id: string) => {
      if (id === DISTILLER_TASK_ID) return Promise.resolve(noDepTask);
      return Promise.resolve(undefined);
    });

    const result = await h.runner.run(DISTILLER_TASK_ID);

    // Should fail because no predecessor dependency
    expect(result.status).toBe('failed');
  });

  it('sourceRootCauseArtifactId mismatch triggers lineage integrity violation (EP-07)', async () => {
    const h = createDiagRunnerHarness('distiller');
    // Output with wrong sourceRootCauseArtifactId — should trigger checkLineageIntegrity
    const mismatchedOutput = h.makeOutput({
      sourceRootCauseArtifactId: 'pi-art-FABRICATED-WRONG-ID',
    });
    (h.deps._runtimeAdapter.fetchOutput as MockFn).mockResolvedValue({ payload: mismatchedOutput });

    const result = await h.runner.run(DISTILLER_TASK_ID);

    // checkLineageIntegrity throws PDRuntimeError('output_invalid'), caught by base class.
    // output_invalid is not in permanentErrorCategories, so the runner retries and
    // eventually exhausts attempts → max_attempts_exceeded.
    expect(result.status).toBe('failed');
    expect(result.errorCategory).toBe('max_attempts_exceeded');

    // Verify lineage_integrity_violation telemetry was emitted
    const emitTelemetry = h.deps._eventEmitter.emitTelemetry as MockFn;
    const violationEvent = emitTelemetry.mock.calls.find(
      (call: unknown[]) => {
        const event = call[0] as Record<string, unknown> | undefined;
        return event?.eventType === 'diag_distiller_lineage_integrity_violation';
      },
    );
    expect(violationEvent).toBeDefined();
    // Verify the event payload contains both artifact IDs
    // Type narrowing: after toBeDefined, violationEvent is guaranteed to exist
    const foundEvent = violationEvent as unknown[];
    const payload = (foundEvent[0] as Record<string, unknown>).payload as Record<string, unknown>;
    expect(payload.expectedArtifactId).toBe(DISTILLER_ROOTCAUSE_ARTIFACT_ID);
    expect(payload.actualArtifactId).toBe('pi-art-FABRICATED-WRONG-ID');
  });
});
