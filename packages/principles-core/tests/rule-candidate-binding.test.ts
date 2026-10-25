import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { addPrincipleToLedger, appendReuseEvidence, loadLedger, saveLedger, saveLedgerAsync, updatePrinciple } from '../src/principle-tree-ledger.js';
import { PrincipleTreeLedgerAdapter } from '../src/runtime-v2/adapter/principle-tree-ledger-adapter.js';
import type { LedgerPrinciple } from '../src/runtime-v2/types/ledger-store.js';
import type { RuleCandidateBindingRequest, RuleCandidateMaterial } from '../src/runtime-v2/types/rule-candidate-binding.js';

const PID = '11111111-2222-4222-8222-222222222222';
const OTHER = '22222222-3333-4333-8333-333333333333';
const NOW = '2026-10-25T00:00:00.000Z';
function principle(id = PID): LedgerPrinciple {
  return { id, version: 1, text: 'Protect an explicitly approved scope.', triggerPattern: 'write', action: 'check', status: 'candidate', priority: 'P1', scope: 'general', evaluability: 'deterministic', valueScore: 0, adherenceRate: 0, painPreventedCount: 0, derivedFromPainIds: ['source'], ruleIds: [], conflictsWithPrincipleIds: [], createdAt: NOW, updatedAt: NOW };
}
function material(id: string, kind: 'rule' | 'principle'): RuleCandidateMaterial {
  const rec = JSON.stringify({ kind, description: 'Protect an explicitly approved scope.' });
  const output = JSON.stringify({ valid: true, diagnosisId: 'diagnosis', summary: 'Scope violation', rootCause: 'Design: missing scope check', confidence: 0.9, violatedPrinciples: [], evidence: [], recommendations: [JSON.parse(rec)] });
  return {
    candidate: { candidateId: id, taskId: 'diagnosis', sourceRunId: 'run', artifactId: 'artifact', rawRecommendationKind: kind, sourceRecommendationJson: rec },
    task: { taskId: 'diagnosis', taskKind: 'diagnostician', status: 'succeeded', inputRef: 'pain-original' },
    run: { runId: 'run', taskId: 'diagnosis', executionStatus: 'succeeded', outputPayload: output },
    artifact: { artifactId: 'artifact', taskId: 'diagnosis', runId: 'run', contentJson: output },
  };
}
describe('Owner rule-candidate binding uses the real append-only Ledger', () => {
  let dir: string;
  let materials: Map<string, RuleCandidateMaterial>;
  let adapter: PrincipleTreeLedgerAdapter;
  const owner = { actorId: 'owner', source: 'authenticated_console' as const };
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'pd-rule-binding-'));
    materials = new Map([['rule', material('rule', 'rule')], ['source', material('source', 'principle')]]);
    addPrincipleToLedger(dir, principle());
    adapter = new PrincipleTreeLedgerAdapter({ stateDir: dir, reviewSources: { loadCandidateMaterial: async id => materials.get(id) ?? null } });
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));
  const file = () => join(dir, 'principle_training_state.json');
  async function request(): Promise<Extract<RuleCandidateBindingRequest, { action: 'bind' }>> {
    const review = await adapter.createRuleCandidateBindingReview('rule');
    expect(review.ok).toBe(true);
    if (!review.ok || !review.eligibleTargets[0]) throw new Error('Expected real review material.');
    return { action: 'bind', principleId: PID, expectedRevision: review.currentRevision, expectedCandidateDigest: review.reviewedCandidateDigest, expectedPrincipleDigest: review.eligibleTargets[0].reviewedPrincipleDigest, reason: 'This candidate implements the selected principle.', requestId: 'request-1', resumeOnce: true };
  }
  async function bind() { return adapter.mutateRuleCandidateBinding({ candidateId: 'rule', request: await request(), owner }); }
  it.each(['candidate', 'probation', 'active'] as const)('binds a registered %s Principle without creating or approving one; restart reads the same identity', async status => {
    updatePrinciple(dir, PID, { status });
    expect(await bind()).toMatchObject({ ok: true, status: 'bound', runtimeDeactivated: false });
    expect(Object.keys(loadLedger(dir).tree.principles)).toEqual([PID]);
    expect(loadLedger(dir).tree.principles[PID]?.status).toBe(status);
    expect(new PrincipleTreeLedgerAdapter({ stateDir: dir }).resolveCandidatePrincipleIdentity('rule', 'rule')).toMatchObject({ status: 'resolved', basis: 'owner_rule_binding', principleId: PID, bindingRevision: 1 });
  });
  it('same pain and derived evidence never create rule identity without an Owner binding', () => {
    expect(adapter.resolveCandidatePrincipleIdentity('source', 'rule')).toMatchObject({ status: 'unresolved', reason: 'missing' });
  });
  it('replays the same request without rewriting bytes; changed request semantics conflict', async () => {
    const req = await request();
    const first = await adapter.mutateRuleCandidateBinding({ candidateId: 'rule', request: req, owner });
    const bytes = readFileSync(file(), 'utf8');
    expect(await adapter.mutateRuleCandidateBinding({ candidateId: 'rule', request: req, owner })).toMatchObject({ ok: true, status: 'already_bound' });
    expect(readFileSync(file(), 'utf8')).toBe(bytes);
    expect(await adapter.mutateRuleCandidateBinding({ candidateId: 'rule', request: { ...req, reason: 'different' }, owner })).toMatchObject({ ok: false, reason: 'idempotency_conflict' });
    expect(first.ok).toBe(true);
  });
  // Regression (PR review P1): a load→modify→save caller's stale snapshot must
  // not delete binding revisions appended after the snapshot was taken — a
  // lost revoke would silently re-activate a withdrawn binding.
  it.each([
    ['saveLedger', (store: ReturnType<typeof loadLedger>) => saveLedger(dir, store)],
    ['saveLedgerAsync', async (store: ReturnType<typeof loadLedger>) => { await saveLedgerAsync(dir, store); }],
  ])('a stale %s snapshot cannot overwrite a concurrently appended revoke', async (_name, save) => {
    expect(await bind()).toMatchObject({ status: 'bound' });
    // The caller's snapshot CARRIES the binding map (the clobbering shape).
    const snapshot = loadLedger(dir);
    expect(Object.hasOwn(snapshot.tree, 'ruleCandidateBindings')).toBe(true);
    // The Owner revokes while the caller is still holding its snapshot.
    const revoked = await adapter.mutateRuleCandidateBinding({ candidateId: 'rule', request: { action: 'revoke', expectedRevision: 1, reason: 'Withdraw before the stale save.', requestId: 'revoke-stale-save', resumeOnce: false }, owner });
    expect(revoked).toMatchObject({ ok: true, status: 'revoked' });
    snapshot.tree.principles[PID] = { ...snapshot.tree.principles[PID]!, text: 'Unrelated caller edit.' };
    await save(snapshot);
    const stored = loadLedger(dir);
    expect(stored.tree.ruleCandidateBindings?.rule?.revisions).toHaveLength(2);
    expect(stored.tree.ruleCandidateBindings?.rule?.revisions[1]?.action).toBe('revoke');
    expect(stored.tree.principles[PID]?.text).toBe('Unrelated caller edit.');
  });
  it('arbitrates concurrent independent adapters with one append and one stale result', async () => {
    const req = await request();
    const other = new PrincipleTreeLedgerAdapter({ stateDir: dir, reviewSources: { loadCandidateMaterial: async id => materials.get(id) ?? null } });
    const results = await Promise.all([adapter.mutateRuleCandidateBinding({ candidateId: 'rule', request: req, owner }), other.mutateRuleCandidateBinding({ candidateId: 'rule', request: { ...req, requestId: 'request-2' }, owner })]);
    expect(results.filter(r => r.ok)).toHaveLength(1);
    expect(results.find(r => !r.ok)).toMatchObject({ reason: 'stale_revision' });
    expect(loadLedger(dir).tree.ruleCandidateBindings?.rule?.revisions).toHaveLength(1);
  });
  it('changed candidate material or target version refuses without writing', async () => {
    const req = await request();
    materials.set('rule', { ...material('rule', 'rule'), candidate: { changed: true } });
    const bytes = readFileSync(file(), 'utf8');
    expect(await adapter.mutateRuleCandidateBinding({ candidateId: 'rule', request: req, owner })).toMatchObject({ ok: false });
    expect(readFileSync(file(), 'utf8')).toBe(bytes);
    materials.set('rule', material('rule', 'rule'));
    updatePrinciple(dir, PID, { version: 2 });
    expect(await adapter.mutateRuleCandidateBinding({ candidateId: 'rule', request: req, owner })).toMatchObject({ reason: 'stale_digest' });
  });
  it.each(['archived', 'deprecated'] as const)('cannot bind a %s target', async status => {
    updatePrinciple(dir, PID, { status });
    const review = await adapter.createRuleCandidateBindingReview('rule');
    expect(review).toMatchObject({ ok: true, eligibleTargets: [] });
  });
  it('revoke stays reachable with a deleted candidate and archived target and adds no Principle', async () => {
    await bind();
    materials.clear();
    updatePrinciple(dir, PID, { status: 'archived' });
    expect(await adapter.createRuleCandidateBindingReview('rule')).toMatchObject({ ok: true, currentRevision: 1, eligibleTargets: [] });
    expect(await adapter.mutateRuleCandidateBinding({ candidateId: 'rule', request: { action: 'revoke', expectedRevision: 1, reason: 'Withdraw this relation.', requestId: 'revoke-1', resumeOnce: false }, owner })).toMatchObject({ ok: true, status: 'revoked', runtimeDeactivated: false });
    expect(adapter.resolveCandidatePrincipleIdentity('rule', 'rule')).toMatchObject({ reason: 'binding_revoked' });
    expect(loadLedger(dir).tree.ruleCandidateBindings?.rule?.revisions).toHaveLength(2);
  });
  it('corrupt binding data cannot be treated as empty or overwritten by an ordinary writer', async () => {
    await bind();
    const parsed = JSON.parse(readFileSync(file(), 'utf8'));
    parsed._tree.ruleCandidateBindings.rule.revisions[0].revision = 99;
    const bytes = JSON.stringify(parsed);
    writeFileSync(file(), bytes);
    expect(adapter.resolveCandidatePrincipleIdentity('rule', 'rule')).toMatchObject({ reason: 'ledger_corrupt' });
    expect(() => updatePrinciple(dir, PID, { text: 'overwritten' })).toThrow();
    expect(readFileSync(file(), 'utf8')).toBe(bytes);
  });
  it('preserves new binding history and unknown tree fields through unrelated writes', async () => {
    await bind();
    const parsed = JSON.parse(readFileSync(file(), 'utf8'));
    parsed._tree.futureExtension = { preserved: true };
    writeFileSync(file(), JSON.stringify(parsed));
    updatePrinciple(dir, PID, { text: 'An ordinary update.' });
    const stored = JSON.parse(readFileSync(file(), 'utf8'));
    expect(stored._tree.futureExtension).toEqual({ preserved: true });
    expect(stored._tree.ruleCandidateBindings.rule.revisions).toHaveLength(1);
  });
  it('resolves explicit reuse, but refuses ambiguity/conflicting derivation across the full Ledger', () => {
    appendReuseEvidence(dir, PID, { candidateId: 'reused', painId: 'pain', decision: 'reuse', actor: { kind: 'owner', id: 'owner' }, reason: 'reuse', decidedAt: NOW });
    expect(adapter.resolveCandidatePrincipleIdentity('reused', 'principle')).toMatchObject({ status: 'resolved', basis: 'principle_reuse', principleId: PID });
    addPrincipleToLedger(dir, { ...principle(OTHER), derivedFromPainIds: ['reused'] });
    expect(adapter.resolveCandidatePrincipleIdentity('reused', 'principle')).toMatchObject({ status: 'unresolved', reason: 'conflicting_authorities' });
  });
  it('a candidateId-only reuse entry is corruption, not an Owner reuse decision', () => {
    const parsed = JSON.parse(readFileSync(file(), 'utf8'));
    parsed._tree.principles[PID].reuseEvidence = [{ candidateId: 'reused' }];
    const bytes = JSON.stringify(parsed);
    writeFileSync(file(), bytes);
    expect(adapter.resolveCandidatePrincipleIdentity('reused', 'principle')).toMatchObject({ status: 'unresolved', reason: 'ledger_corrupt' });
    expect(readFileSync(file(), 'utf8')).toBe(bytes);
  });
});
