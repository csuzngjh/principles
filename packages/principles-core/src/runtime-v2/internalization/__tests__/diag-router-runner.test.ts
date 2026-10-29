/**
 * DiagRouterRunner — Stage C V-slice tests (PRI-372).
 *
 * Router-only evidence kept here:
 *   1. lease → succeed → commits candidates via DiagnosticianCommitter
 *   2. PRI-667 pi_artifacts dual-write (success + failure) — DO NOT MOVE
 *   3. dependency not succeeded → blocked
 *   4. requires both rootcause and distiller predecessor dependencies
 *   5. commit failure (committer layer) → task fails, no markTaskSucceeded
 *   6. invalid output fails the REAL TypeBox schema validation
 *   7. succeedTask ordering (updateRunOutput before commit)
 *
 * Shared-template lifecycle its (currentPhase transitions, wrong taskKind,
 * EP-01 corrupted-predecessor ×2) were consolidated into
 * diag-runner-contract.test.ts (Test Diet Phase 2.2-B2); scaffold comes from
 * __fixtures__/diag-runner-harness.ts. The router's validation path stays the
 * real TypeBox pipeline — never lower it to a mock validator.
 *
 * ERR entries considered:
 *   - ERR-001: Treat parsed JSON / LLM output as unknown
 *   - ERR-004: Lineage fields must be internally consistent
 *   - ERR-009: Required fields fail loud — TypeBox schema + semantic checks
 */
import { createHash } from 'node:crypto';
import { readRouterContextReceipt, verifyRouterContextReceipt } from '../router-context-evidence.js';
import { Value } from '@sinclair/typebox/value';
import { DiagnosticianOutputV1Schema } from '../../diagnostician-output.js';
import type { vi } from 'vitest';
import { describe, it, expect } from 'vitest';
import type { MemoryPIArtifactStore } from '../pi-artifact-store.js';
import type { TaskRecord } from '../../task-status.js';
import { createPITaskDiagnosticJson } from '../pitask-metadata.js';
import {
  createDiagRunnerHarness,
  makePredecessorStore,
  makeRootCausePredecessorTask,
  makeDistillerPredecessorTask,
  ROUTER_TASK_ID,
  ROUTER_RUN_ID,
  ROOTCAUSE_TASK_ID,
  DISTILLER_TASK_ID,
} from './__fixtures__/diag-runner-harness.js';

type MockFn = ReturnType<typeof vi.fn>;

describe('DiagRouterRunner V-slice', () => {
  it('persists system invocation evidence, survives serialization, and refuses foreign lineage', async () => {
    const h = createDiagRunnerHarness('router');
    expect((await h.runner.run(ROUTER_TASK_ID)).status).toBe('succeeded');
    const [artifact] = await h.deps.artifactStore.listBySourceTaskId(ROUTER_TASK_ID);
    if (!artifact) throw new Error('missing persisted router artifact');
    const envelope: unknown = JSON.parse(artifact.contentJson);
    expect(Value.Check(DiagnosticianOutputV1Schema, envelope)).toBe(true);
    const restored = readRouterContextReceipt(envelope, { taskId: ROUTER_TASK_ID, runId: ROUTER_RUN_ID });
    expect(restored.status).toBe('available');
    if (restored.status !== 'available') throw new Error('receipt unavailable');
    const invocation: unknown = h.deps._runtimeAdapter.startRun?.mock.calls[0]?.[0];
    if (invocation === null || typeof invocation !== 'object') throw new Error('missing actual invocation');
    const message: unknown = Reflect.get(invocation, 'inputPayload');
    const systemPrompt: unknown = Reflect.get(invocation, 'systemPrompt');
    if (typeof message !== 'string' || typeof systemPrompt !== 'string') throw new Error('invalid actual prompt');
    expect(restored.receipt.messageDigest).toBe(createHash('sha256').update(message).digest('hex'));
    expect(restored.receipt.systemPromptDigest).toBe(createHash('sha256').update(systemPrompt).digest('hex'));
    expect(restored.receipt.canonicalPrinciples.status).toBe('unavailable');
    const predecessors = [];
    for (const source of restored.receipt.predecessorDigests) {
      const sourceArtifact = await h.deps.artifactStore.getArtifactById(source.artifactId);
      if (!sourceArtifact) throw new Error('missing source artifact');
      predecessors.push({ artifactId: source.artifactId, content: JSON.parse(sourceArtifact.contentJson) });
    }
    const expected = { taskId: ROUTER_TASK_ID, runId: ROUTER_RUN_ID, message, systemPrompt, predecessors };
    expect(verifyRouterContextReceipt(JSON.parse(JSON.stringify(envelope)), expected).status).toBe('available');
    expect(verifyRouterContextReceipt(envelope, { ...expected, message: message + ' changed' })).toMatchObject({ status: 'unavailable', reason: 'context_receipt_source_mismatch' });
    expect(verifyRouterContextReceipt(envelope, { ...expected, predecessors: predecessors.map(source => ({ ...source, content: {} })) })).toMatchObject({ status: 'unavailable', reason: 'context_receipt_source_mismatch' });
    expect(readRouterContextReceipt(envelope, { taskId: 'foreign', runId: ROUTER_RUN_ID })).toMatchObject({ status: 'unavailable', reason: 'context_receipt_lineage_mismatch' });
    expect(readRouterContextReceipt(envelope, { taskId: ROUTER_TASK_ID, runId: 'foreign' })).toMatchObject({ status: 'unavailable', reason: 'context_receipt_lineage_mismatch' });
    expect(readRouterContextReceipt({}, { taskId: ROUTER_TASK_ID, runId: ROUTER_RUN_ID })).toMatchObject({ status: 'unavailable', reason: 'context_receipt_missing' });
    expect(readRouterContextReceipt({ trustedContextReceipt: { ...restored.receipt, messageDigest: 'broken' } }, { taskId: ROUTER_TASK_ID, runId: ROUTER_RUN_ID })).toMatchObject({ status: 'unavailable', reason: 'context_receipt_invalid' });
    const commit = h.deps._committer.commit.mock.calls[0]?.[0];
    expect(commit?.contentJson).toBe(artifact.contentJson);
  });

  it('changes evidence when predecessor contents change even with the same source identity', async () => {
    const first = createDiagRunnerHarness('router');
    const second = createDiagRunnerHarness('router');
    const [predecessor] = await second.deps.artifactStore.listBySourceTaskId(ROOTCAUSE_TASK_ID);
    if (!predecessor) throw new Error('missing predecessor');
    const parsed: unknown = JSON.parse(predecessor.contentJson);
    if (parsed === null || typeof parsed !== 'object') throw new Error('invalid predecessor');
    await second.deps.artifactStore.upsertArtifact({ ...predecessor, contentJson: JSON.stringify({ ...parsed, summary: 'Changed source diagnosis' }) });
    await first.runner.run(ROUTER_TASK_ID);
    await second.runner.run(ROUTER_TASK_ID);
    const extract = async (h: typeof first) => {
      const [artifact] = await h.deps.artifactStore.listBySourceTaskId(ROUTER_TASK_ID);
      if (!artifact) throw new Error('missing persisted artifact');
      const result = readRouterContextReceipt(JSON.parse(artifact.contentJson), { taskId: ROUTER_TASK_ID, runId: ROUTER_RUN_ID });
      if (result.status !== 'available') throw new Error('invalid receipt');
      return result.receipt;
    };
    const a = await extract(first);
    const b = await extract(second);
    expect(a.predecessorDigests[0]?.artifactId).toBe(b.predecessorDigests[0]?.artifactId);
    expect(a.predecessorDigests[0]?.contentDigest).not.toBe(b.predecessorDigests[0]?.contentDigest);
    expect(a.messageDigest).not.toBe(b.messageDigest);
  });
  it('lease → succeed → commits candidates via DiagnosticianCommitter', async () => {
    const h = createDiagRunnerHarness('router');

    const result = await h.runner.run(ROUTER_TASK_ID);

    expect(result.status).toBe('succeeded');
    expect(result.taskId).toBe(ROUTER_TASK_ID);

    // Verify committer was called
    expect(h.deps._committer.commit).toHaveBeenCalledWith(
      expect.objectContaining({
        runId: ROUTER_RUN_ID,
        taskId: ROUTER_TASK_ID,
      }),
    );

    // Verify markTaskSucceeded called with commit:// resultRef
    expect(h.deps._stateManager.markTaskSucceeded).toHaveBeenCalledWith(
      ROUTER_TASK_ID,
      expect.stringContaining('commit://'),
    );
  });

  it('PRI-667: succeed → dual-writes the DiagnosticianOutputV1 into pi_artifacts (tier2 lineage source)', async () => {
    const h = createDiagRunnerHarness('router');

    const result = await h.runner.run(ROUTER_TASK_ID);
    expect(result.status).toBe('succeeded');

    // The pi_artifacts row downstream internalization runners resolve their
    // predecessor artifacts from — previously missing entirely
    // (committer writes only the legacy `artifacts` table).
    const artifacts = await h.deps.artifactStore.listBySourceTaskId(ROUTER_TASK_ID);
    expect(artifacts.length).toBe(1);
    const piArtifact = artifacts[0] as unknown as { artifactKind: string; contentJson: string };
    expect(piArtifact.artifactKind).toBe('principle');
    const parsed = JSON.parse(piArtifact.contentJson) as Record<string, unknown>;
    // Layer-0 envelope: top-level evidence survives for readRawField(['evidence'])
    expect(Object.hasOwn(parsed, 'evidence')).toBe(true);
    // recommendation payload survives for candidate-intake parity with the legacy row
    expect(Object.hasOwn(parsed, 'recommendations')).toBe(true);
  });

  it('PRI-667: pi_artifacts dual-write failure → task fails (no silent split-brain between the two stores)', async () => {
    const h = createDiagRunnerHarness('router');
    // Poison the pi store after predecessors are populated
    const failingStore = h.deps.artifactStore as unknown as MemoryPIArtifactStore;
    failingStore.upsertArtifact = async () => {
      throw new Error('pi store exploded');
    };

    const result = await h.runner.run(ROUTER_TASK_ID);
    expect(result.status).toBe('failed');
    // legacy commit DID happen but the task must NOT read as succeeded while
    // the lineage-visible copy is missing — the evaluator would then hang on
    // evidence that will never exist.
    expect(h.deps._stateManager.markTaskSucceeded).not.toHaveBeenCalled();
  });

  it('dependency not succeeded → blocked', async () => {
    // Store without the distiller artifact — only rootcause is present
    const h = createDiagRunnerHarness('router', {
      artifactStore: makePredecessorStore({ rootcause: 'valid' }),
    });
    // Distiller task still pending (not succeeded)
    const pendingDistillerTask = makeDistillerPredecessorTask({ status: 'pending', resultRef: undefined });
    (h.deps._stateManager.getTask as MockFn).mockImplementation((id: string) => {
      if (id === ROUTER_TASK_ID) return Promise.resolve(h.makeTask());
      if (id === ROOTCAUSE_TASK_ID) return Promise.resolve(makeRootCausePredecessorTask());
      if (id === DISTILLER_TASK_ID) return Promise.resolve(pendingDistillerTask);
      return Promise.resolve(undefined);
    });

    const result = await h.runner.run(ROUTER_TASK_ID);

    // Should fail because distiller artifact is missing
    expect(result.status).toBe('failed');
  });

  it('requires both rootcause and distiller predecessor dependencies', async () => {
    const h = createDiagRunnerHarness('router');
    // Create a router task with only one dependency
    const singleDepTask: TaskRecord = h.makeTask({
      diagnosticJson: createPITaskDiagnosticJson({
        dependencyTaskIds: [ROOTCAUSE_TASK_ID],
        channel: 'prompt',
        timeoutMs: 300_000,
        inputArtifactRefs: [],
        outputArtifactRefs: [],
      }),
    });
    (h.deps._stateManager.acquireLease as MockFn).mockResolvedValue(singleDepTask);
    (h.deps._stateManager.getTask as MockFn).mockImplementation((id: string) => {
      if (id === ROUTER_TASK_ID) return Promise.resolve(singleDepTask);
      if (id === ROOTCAUSE_TASK_ID) return Promise.resolve(makeRootCausePredecessorTask());
      return Promise.resolve(undefined);
    });

    const result = await h.runner.run(ROUTER_TASK_ID);

    // Should fail because only one predecessor dependency
    expect(result.status).toBe('failed');
  });

  it('commit failure → task fails, no markTaskSucceeded', async () => {
    const h = createDiagRunnerHarness('router');
    (h.deps._committer.commit).mockRejectedValue(new Error('Commit failed: DB error'));

    const result = await h.runner.run(ROUTER_TASK_ID);

    expect(result.status).toBe('failed');
    expect(h.deps._stateManager.markTaskSucceeded).not.toHaveBeenCalled();
  });

  it('invalid output fails TypeBox schema validation', async () => {
    const h = createDiagRunnerHarness('router');
    // Return invalid output that fails TypeBox validation (real pipeline —
    // DiagRouterRunner has no injectable validator)
    (h.deps._runtimeAdapter.fetchOutput as MockFn).mockResolvedValue({
      payload: { invalid: true },
    });

    const result = await h.runner.run(ROUTER_TASK_ID);
    expect(result.status).toBe('failed');
  });

  it('succeedTask calls updateRunOutput before commit', async () => {
    const h = createDiagRunnerHarness('router');
    const callOrder: string[] = [];
    (h.deps._stateManager.updateRunOutput as MockFn).mockImplementation(() => {
      callOrder.push('updateRunOutput');
      return Promise.resolve();
    });
    (h.deps._committer.commit).mockImplementation(() => {
      callOrder.push('commit');
      return Promise.resolve({ commitId: 'commit-001', artifactId: 'art-001', candidateCount: 1 });
    });

    const result = await h.runner.run(ROUTER_TASK_ID);
    expect(result.status).toBe('succeeded');
    expect(callOrder.indexOf('updateRunOutput')).toBeLessThan(callOrder.indexOf('commit'));
  });
});
