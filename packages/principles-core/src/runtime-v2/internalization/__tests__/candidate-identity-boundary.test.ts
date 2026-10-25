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
});
