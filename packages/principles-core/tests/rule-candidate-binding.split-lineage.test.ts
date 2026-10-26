import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { addPrincipleToLedger, loadLedger } from '../src/principle-tree-ledger.js';
import { PrincipleTreeLedgerAdapter } from '../src/runtime-v2/adapter/principle-tree-ledger-adapter.js';
import type { RuleCandidateMaterial, RuleCandidateBindingRequest } from '../src/runtime-v2/types/rule-candidate-binding.js';
import type { LedgerPrinciple } from '../src/runtime-v2/types/ledger-store.js';
const PID = '11111111-2222-4222-8222-222222222222';
function material(id: string, kind: 'rule' | 'principle') {
  const taskId = 'router-' + id, runId = 'run-' + id, artifactId = 'artifact-' + id;
  const recommendation = { kind, description: 'Protect the approved scope.' };
  const payload = JSON.stringify({ valid: true, diagnosisId: id, summary: 'Scope violation', rootCause: 'Design: scope check missing', confidence: 0.9, violatedPrinciples: [], evidence: [], recommendations: [recommendation] });
  return {
    candidate: { candidateId: id, taskId, sourceRunId: runId, artifactId, rawRecommendationKind: kind, sourceRecommendationJson: JSON.stringify(recommendation) },
    task: { taskId, taskKind: 'diag_router', status: 'succeeded', inputRef: 'parent-' + id },
    parentTask: { taskId: 'parent-' + id, taskKind: 'diagnostician', status: 'succeeded', inputRef: 'pain-' + id },
    run: { runId, taskId, executionStatus: 'succeeded', outputPayload: payload },
    artifact: { artifactId, taskId, runId, contentJson: payload },
  };
}
function principle(): LedgerPrinciple {
  return { id: PID, version: 1, text: 'Protect scope.', triggerPattern: 'write', action: 'check', status: 'candidate', priority: 'P1', scope: 'general', evaluability: 'deterministic', valueScore: 0, adherenceRate: 0, painPreventedCount: 0, derivedFromPainIds: ['source'], ruleIds: [], conflictsWithPrincipleIds: [], createdAt: '2026-10-25T00:00:00.000Z', updatedAt: '2026-10-25T00:00:00.000Z' };
}
describe('split diagnosis provenance through the public Ledger adapter', () => {
  let dir: string, adapter: PrincipleTreeLedgerAdapter;
  let materials: Map<string, RuleCandidateMaterial>;
  const owner = { actorId: 'fixture-owner', source: 'authenticated_console' as const };
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'pd-binding-split-'));
    materials = new Map([['rule', material('rule', 'rule')], ['source', material('source', 'principle')]]);
    addPrincipleToLedger(dir, principle());
    adapter = new PrincipleTreeLedgerAdapter({ stateDir: dir, reviewSources: { loadCandidateMaterial: async id => materials.get(id) ?? null } });
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));
  async function request(): Promise<Extract<RuleCandidateBindingRequest, { action: 'bind' }>> {
    const review = await adapter.createRuleCandidateBindingReview('rule');
    expect(review).toMatchObject({ ok: true, eligibleTargets: [{ principle: { id: PID } }] });
    if (!review.ok || !review.eligibleTargets[0]) throw new Error('Real split materials must be eligible.');
    return { action: 'bind', principleId: PID, expectedRevision: 0, expectedCandidateDigest: review.reviewedCandidateDigest, expectedPrincipleDigest: review.eligibleTargets[0].reviewedPrincipleDigest, requestId: 'split-bind', reason: 'This scope implements the selected principle.', resumeOnce: true };
  }
  it('binds a split rule to a split-derived principle without promoting the principle', async () => {
    expect(await adapter.mutateRuleCandidateBinding({ candidateId: 'rule', request: await request(), owner })).toMatchObject({ ok: true, status: 'bound', binding: { revision: 1 } });
    expect(adapter.resolveCandidatePrincipleIdentity('rule', 'rule')).toMatchObject({ status: 'resolved', principleId: PID });
    expect(loadLedger(dir).tree.principles[PID]?.status).toBe('candidate');
  });
  it.each(['rule', 'source'])('rejects broken parent, task type, run and payload provenance for %s without mutation', async id => {
    const req = await request();
    const original = material(id, id === 'rule' ? 'rule' : 'principle');
    const bytes = readFileSync(join(dir, 'principle_training_state.json'), 'utf8');
    const differentPayload = original.run.outputPayload.replace('Protect the approved scope.', 'Unrelated recommendation.');
    for (const patch of [
      { parentTask: undefined },
      { parentTask: { ...original.parentTask, taskId: 'another-parent' } },
      { parentTask: { ...original.parentTask, taskKind: 'dreamer' } },
      { parentTask: { ...original.parentTask, status: 'running' } },
      { parentTask: { ...original.parentTask, inputRef: '' } },
      { task: { ...original.task, taskKind: 'diag_rootcause' } },
      { run: { ...original.run, taskId: original.parentTask.taskId } },
      { artifact: { ...original.artifact, taskId: original.parentTask.taskId } },
      { run: { ...original.run, outputPayload: differentPayload } },
      { artifact: { ...original.artifact, contentJson: differentPayload } },
      { artifact: { ...original.artifact, contentJson: '{}' } },
    ]) {
      materials.set(id, { ...original, ...patch });
      expect(await adapter.mutateRuleCandidateBinding({ candidateId: 'rule', request: req, owner })).toMatchObject({ ok: false, reason: id === 'rule' ? 'candidate_ineligible' : 'target_ineligible' });
      expect(readFileSync(join(dir, 'principle_training_state.json'), 'utf8')).toBe(bytes);
    }
  });
});
