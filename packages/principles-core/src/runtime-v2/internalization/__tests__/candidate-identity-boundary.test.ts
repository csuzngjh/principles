import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRuntimeStateHandle, type RuntimeStateHandle } from '../../runtime-state-handle.js';
import { MemoryPIArtifactStore } from '../pi-artifact-store.js';
import { TestDoubleRuntimeAdapter } from '../../adapter/test-double-runtime-adapter.js';
import { StoreEventEmitter } from '../../store/event-emitter.js';
import { ArtificerRunner } from '../artificer-runner.js';
import { EvaluatorRunner } from '../evaluator-runner.js';
import { ScribeRunner } from '../scribe-runner.js';
import { DefaultScribeValidator } from '../scribe-output.js';
import { createPITaskDiagnosticJson } from '../pitask-metadata.js';
import { DefaultArtificerValidator } from '../artificer-output.js';
import { DefaultEvaluatorValidator } from '../evaluator-output.js';
import { verifyArtifactCandidateIdentity } from '../candidate-identity.js';
import type { CandidatePrincipleIdentityResolution } from '../../types/rule-candidate-binding.js';

const PID = '11111111-2222-4222-8222-222222222222';
const identity = { status: 'resolved', candidateId: 'candidate', principleId: PID, basis: 'owner_rule_binding', bindingRevision: 1, decisionId: 'decision', checkedAt: '2026-10-25T00:00:00.000Z' } satisfies CandidatePrincipleIdentityResolution;
describe('candidate identity is verified before expensive model work', () => {
  let dir: string;
  let handle: RuntimeStateHandle;
  let artifacts: MemoryPIArtifactStore;
  let current: CandidatePrincipleIdentityResolution;
  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), 'pd-identity-boundary-'));
    handle = await createRuntimeStateHandle({ workspaceDir: dir });
    artifacts = new MemoryPIArtifactStore();
    current = identity;
    await handle.stateManager.createTask({ taskId: 'dreamer-task', taskKind: 'dreamer', status: 'succeeded', attemptCount: 1, maxAttempts: 3, diagnosticJson: JSON.stringify({ candidateId: 'candidate' }) });
    const common = { lineageArtifactIds: [], validationStatus: 'pending' as const, createdAt: identity.checkedAt, updatedAt: identity.checkedAt };
    await artifacts.upsertArtifact({ ...common, artifactId: 'pi-dreamer-source', artifactKind: 'principle', sourceTaskId: 'dreamer-task', contentJson: '{}' });
    await artifacts.upsertArtifact({ ...common, artifactId: 'scribe-source', artifactKind: 'principle', sourceTaskId: 'scribe-task', sourcePrincipleId: PID, contentJson: JSON.stringify({ sourceTrace: { dreamerArtifactId: 'pi-dreamer-source' }, identityResolution: identity }) });
  });
  afterEach(async () => { await handle.close(); rmSync(dir, { recursive: true, force: true }); });
  const ledger = () => ({ resolveForCandidate: async () => current, isAvailable: () => true, hasPrinciple: () => true });
  async function verify() {
    const source = await artifacts.getArtifactById('scribe-source');
    if (!source) throw new Error('Missing test source.');
    return verifyArtifactCandidateIdentity(source, { ledger: ledger(), getArtifactById: id => artifacts.getArtifactById(id), getTaskDiagnosticJson: async id => (await handle.stateManager.getTask(id))?.diagnosticJson ?? null });
  }
  it('accepts the exact system receipt and refuses after revocation or rebinding', async () => {
    expect(await verify()).toMatchObject({ principleId: PID, bindingRevision: 1 });
    current = { status: 'unresolved', reason: 'binding_revoked', nextAction: 'Review binding.' };
    await expect(verify()).rejects.toThrow('binding_revoked');
    current = { ...identity, bindingRevision: 3, decisionId: 'new-decision' };
    await expect(verify()).rejects.toThrow('identity_receipt_stale_or_missing');
  });
  it('a copied UUID without the binding receipt is not enough', async () => {
    const source = await artifacts.getArtifactById('scribe-source');
    if (!source) throw new Error('Missing test source.');
    await artifacts.upsertArtifact({ ...source, contentJson: JSON.stringify({ sourceTrace: { dreamerArtifactId: 'pi-dreamer-source' } }) });
    await expect(verify()).rejects.toThrow('identity_receipt_stale_or_missing');
  });
  it('Artificer and Evaluator refuse stale authority before issuing any model request', async () => {
    current = { status: 'unresolved', reason: 'binding_revoked', nextAction: 'Review binding.' };
    const runtimeAdapter = new TestDoubleRuntimeAdapter();
    const start = vi.spyOn(runtimeAdapter, 'startRun');
    const deps = { stateManager: handle.stateManager, artifactStore: artifacts, eventEmitter: new StoreEventEmitter(), runtimeAdapter, ledgerIdentity: ledger() };
    const options = { owner: 'test', runtimeKind: 'test-double', timeoutMs: 1000 };
    const artificer = new ArtificerRunner({ ...deps, validator: new DefaultArtificerValidator() }, options);
    const evaluator = new EvaluatorRunner({ ...deps, validator: new DefaultEvaluatorValidator() }, options);
    await expect(artificer.invokeRuntime('artificer', { contextHash: 'test', scribeArtifact: '{}', sourceScribeArtifactId: 'scribe-source', scribeDependencyTaskIds: [], channel: 'code_tool_hook', adversarialFeedback: null, repairFeedback: null })).rejects.toThrow('binding_revoked');
    await expect(evaluator.invokeRuntime('evaluator', { contextHash: 'test', scribeArtifact: '{}', sourceScribeArtifactId: 'scribe-source', artificerArtifact: '{}', sourceArtificerArtifactId: 'artificer-source' })).rejects.toThrow('binding_revoked');
    expect(start).not.toHaveBeenCalled();
  });
  async function scribeScenario(changeDuringModel = false) {
    for (const [taskId, taskKind, dependencies] of [['philosopher-task', 'philosopher', ['dreamer-task']], ['new-scribe', 'scribe', ['philosopher-task']]] satisfies [string, string, string[]][]) {
      await handle.stateManager.createTask({ taskId, taskKind, status: taskKind === 'scribe' ? 'pending' : 'succeeded', attemptCount: 0, maxAttempts: 3, diagnosticJson: createPITaskDiagnosticJson({ dependencyTaskIds: dependencies, channel: 'code_tool_hook', timeoutMs: 1000, inputArtifactRefs: [], outputArtifactRefs: [] }) });
    }
    const store = handle.stateManager.piArtifactStore;
    const common = { artifactKind: 'principle' as const, lineageArtifactIds: [], validationStatus: 'pending' as const, createdAt: identity.checkedAt, updatedAt: identity.checkedAt };
    await store.upsertArtifact({ ...common, artifactId: 'pi-dreamer-source', sourceTaskId: 'dreamer-task', contentJson: '{}' });
    await store.upsertArtifact({ ...common, artifactId: 'philosopher-source', sourceTaskId: 'philosopher-task', contentJson: JSON.stringify({ sourceDreamerArtifactId: 'pi-dreamer-source', principleCandidates: [] }) });
    const runtimeAdapter = new TestDoubleRuntimeAdapter({ onFetchOutput: () => {
      if (changeDuringModel) current = { ...identity, bindingRevision: 3, decisionId: 'new-decision' };
      return { payload: {
        taskId: 'new-scribe', sourcePhilosopherArtifactId: 'philosopher-source',
        principleDraft: { title: 'Scope', statement: 'Protect the approved scope.', rationale: 'Avoid unscoped writes.', applicability: ['writes'], antiPatterns: ['unscoped writes'], confidence: 0.9 },
        sourceTrace: { philosopherArtifactId: 'philosopher-source', dreamerArtifactId: 'pi-dreamer-source' }, risks: [], generatedAt: identity.checkedAt,
        intentContract: { ownerIntent: 'Protect scope', targetBehavior: 'Check scope', forbiddenBehavior: 'Unscoped writes', evidenceSource: 'philosopher', validationExpectation: 'Block out-of-scope writes' }, executionConditions: { version: 1, requiredFacts: [] },
        identityResolution: { ...identity, candidateId: 'model-forged', principleId: 'model-title' },
      } };
    } });
    const start = vi.spyOn(runtimeAdapter, 'startRun');
    const runner = new ScribeRunner({ stateManager: handle.stateManager, artifactStore: store, eventEmitter: new StoreEventEmitter(), runtimeAdapter, validator: new DefaultScribeValidator(), ledgerIdentity: { ...ledger(), listForCandidate: () => [] } }, { owner: 'test', runtimeKind: 'test-double', timeoutMs: 1000 });
    return { runner, start, store };
  }
  it('Scribe defers an unbound rule without spending a model attempt', async () => {
    current = { status: 'unresolved', reason: 'missing', nextAction: 'Owner must bind this candidate.' };
    const { runner, start, store } = await scribeScenario();
    expect(await runner.run('new-scribe')).toMatchObject({ status: 'failed', failureReason: 'awaiting_owner_binding:missing' });
    expect(start).not.toHaveBeenCalled();
    expect(await handle.stateManager.getTask('new-scribe')).toMatchObject({ status: 'needs_human_review', attemptCount: 0 });
    expect(await store.listBySourceTaskId('new-scribe')).toEqual([]);
  });
  it('Scribe overwrites a model-forged identity with the system Ledger receipt', async () => {
    const { runner, start, store } = await scribeScenario();
    const result = await runner.run('new-scribe');
    expect(result.status).toBe('succeeded');
    expect(start).toHaveBeenCalledOnce();
    const [artifact] = await store.listBySourceTaskId('new-scribe');
    expect(artifact?.sourcePrincipleId).toBe(PID);
    expect(artifact && JSON.parse(artifact.contentJson).identityResolution).toEqual({ candidateId: 'candidate', basis: 'owner_rule_binding', principleId: PID, bindingRevision: 1, decisionId: 'decision' });
  });
  it('a binding changed during Scribe generation cannot stamp the new target onto old model work', async () => {
    const { runner, start, store } = await scribeScenario(true);
    expect(await runner.run('new-scribe')).toMatchObject({ status: 'failed', failureReason: 'identity_changed_during_generation' });
    expect(start).toHaveBeenCalledOnce();
    expect(await handle.stateManager.getTask('new-scribe')).toMatchObject({ status: 'needs_human_review', attemptCount: 1 });
    expect(await store.listBySourceTaskId('new-scribe')).toEqual([]);
  });
});
