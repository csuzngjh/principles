import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createServer, type Server } from 'node:http';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRuntimeStateHandle, createPITaskDiagnosticJson, SqliteDiagnosticianCommitter, hydratePITaskRecord, ScribeRunner, ArtificerRunner, DefaultScribeValidator, DefaultArtificerValidator, TestDoubleRuntimeAdapter, StoreEventEmitter, PrincipleTreeLedgerAdapter, type RuntimeStateHandle, type DiagnosticianOutputV1 } from '@principles/core/runtime-v2';
import { addPrincipleToLedger, loadLedger } from '@principles/core/principle-tree-ledger';
import { handleRuleCandidateBindingsRoute } from '../../../src/server/routes/rule-candidate-bindings.js';

const PID = '11111111-2222-4222-8222-222222222222';
const NOW = '2026-10-25T00:00:00.000Z';
function record(value: unknown): value is Record<string, unknown> { return typeof value === 'object' && value !== null && !Array.isArray(value); }
function data(value: unknown): Record<string, unknown> {
  if (!record(value) || value.success !== true || !record(value.data)) throw new Error(JSON.stringify(value));
  return value.data;
}
describe('authenticated binding route, real Ledger + real SQLite revision', () => {
  let workspaceDir: string;
  let handle: RuntimeStateHandle;
  let server: Server;
  let base: string;
  let candidateId: string;
  let authorized: boolean;
  const output: DiagnosticianOutputV1 = { valid: true, diagnosisId: 'diagnosis', summary: 'Scope violation', rootCause: 'Design: scope missing', violatedPrinciples: [], evidence: [], confidence: 0.9, recommendations: [{ kind: 'rule', description: 'Implement explicit scope checks.' }, { kind: 'principle', description: 'Protect the approved scope.' }] };
  beforeEach(async () => {
    workspaceDir = mkdtempSync(join(tmpdir(), 'pd-binding-route-'));
    handle = await createRuntimeStateHandle({ workspaceDir });
    await handle.stateManager.createTask({ taskId: 'diagnosis', taskKind: 'diagnostician', status: 'succeeded', inputRef: 'pain-original', attemptCount: 1, maxAttempts: 3 });
    await handle.stateManager.runStore.createRun({ runId: 'diagnosis-run', taskId: 'diagnosis', runtimeKind: 'test-double', startedAt: NOW, attemptNumber: 1, executionStatus: 'succeeded', outputPayload: JSON.stringify(output) });
    await new SqliteDiagnosticianCommitter(handle.stateManager.connection).commit({ taskId: 'diagnosis', runId: 'diagnosis-run', output, idempotencyKey: 'diagnosis-commit' });
    const candidates = await handle.stateManager.getCandidatesByTaskId('diagnosis');
    const rule = candidates.find(c => c.rawRecommendationKind === 'rule');
    const principle = candidates.find(c => c.rawRecommendationKind === 'principle');
    if (!rule || !principle) throw new Error('Real committer did not produce both candidates.');
    candidateId = rule.candidateId;
    addPrincipleToLedger(join(workspaceDir, '.state'), { id: PID, version: 1, text: principle.description, triggerPattern: 'write', action: 'check', status: 'candidate', priority: 'P1', scope: 'general', evaluability: 'deterministic', valueScore: 0, adherenceRate: 0, painPreventedCount: 0, derivedFromPainIds: [principle.candidateId], ruleIds: [], conflictsWithPrincipleIds: [], createdAt: NOW, updatedAt: NOW });
    for (const [taskId, taskKind, deps] of [['dreamer', 'dreamer', []], ['philosopher', 'philosopher', ['dreamer']], ['scribe', 'scribe', ['philosopher']]] satisfies Array<[string, string, string[]]>) {
      const metadata = createPITaskDiagnosticJson({ dependencyTaskIds: deps, channel: 'code_tool_hook', timeoutMs: 1000, inputArtifactRefs: [], outputArtifactRefs: [], pipelineMode: 'standard' });
      await handle.stateManager.createTask({ taskId, taskKind, status: 'succeeded', attemptCount: 1, maxAttempts: 3, diagnosticJson: taskKind === 'dreamer' ? JSON.stringify({ ...JSON.parse(metadata), candidateId }) : metadata });
    }
    authorized = true;
    server = createServer((req, res) => {
      const prefix = '/api/v1/governance/rule-candidate-bindings';
      const subPath = new URL(req.url ?? '/', 'http://localhost').pathname.slice(prefix.length);
      void handleRuleCandidateBindingsRoute(req, res, { workspaceDir, subPath, ownerIdentity: authorized ? { ownerId: 'server-owner', credentialId: 'credential' } : null });
    });
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('No test listener.');
    base = `http://127.0.0.1:${address.port}/api/v1/governance/rule-candidate-bindings/${candidateId}`;
  });
  afterEach(async () => { await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve())); await handle.close(); rmSync(workspaceDir, { recursive: true, force: true }); });
  async function bindBody() {
    const review = data(await (await fetch(`${base}/review`)).json());
    if (!Array.isArray(review.eligibleTargets) || !record(review.eligibleTargets[0])) throw new Error('Missing eligible target.');
    return { action: 'bind', principleId: PID, expectedRevision: review.currentRevision, expectedCandidateDigest: review.candidateDigest, expectedPrincipleDigest: review.eligibleTargets[0].reviewedPrincipleDigest ?? review.eligibleTargets[0].digest, reason: 'This rule implements the selected principle.', requestId: 'binding-request', resumeOnce: true };
  }
  async function post(body: unknown) { return fetch(base, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }); }
  it('GET queue returns the grouped projection contract: one row per candidate, counts, pain, stage, eligibility (PRI-1048)', async () => {
    const collection = base.replace(/\/[^/]*$/, '');
    const beforeBind = data(await (await fetch(collection)).json());
    expect(beforeBind.items.map((item: { candidateId: string }) => item.candidateId)).toEqual([candidateId]);
    expect(beforeBind.summary).toEqual({ painGroups: 1, candidates: 1, bound: 0, unlinked: 1, blocked: 0 });
    expect(beforeBind.truncated).toBe(false);
    const unlinked = beforeBind.items[0];
    expect(unlinked.binding).toEqual({ status: 'unlinked' });
    expect(unlinked.pain).toMatchObject({ painId: 'pain-original', text: null, source: 'unknown' });
    expect(unlinked.generation).toBeNull();
    expect(unlinked.resume).toBeNull();
    expect(unlinked.diagnosisStatus).toBe('succeeded');

    const result = await post(await bindBody());
    expect(result.status).toBe(200);
    const afterBind = data(await (await fetch(collection)).json());
    const bound = afterBind.items[0];
    expect(bound.binding).toMatchObject({ status: 'bound', principle: { principleId: PID, version: 1, revision: 1 } });
    expect(bound.generation).toMatchObject({ stage: 'in_progress', stageKind: 'scribe' });
    // The bind consumed the one bounded revision: eligibility must read refused.
    expect(bound.resume).toMatchObject({ status: 'refused', reason: 'revision_budget_exhausted', scribeTaskId: 'scribe' });
    expect(afterBind.summary).toEqual({ painGroups: 1, candidates: 1, bound: 1, unlinked: 0, blocked: 0 });
  });
  it('one bind request durably records authenticated identity and starts exactly one revision; replay cannot replenish budget', async () => {
    const body = await bindBody();
    const result = await post(body);
    expect(result.status).toBe(200);
    expect(data(await result.json())).toMatchObject({ status: 'bound', revision: { status: 'revision_started', scribeTaskId: 'scribe' } });
    const first = await handle.stateManager.getTask('scribe');
    expect(first).toMatchObject({ status: 'pending', attemptCount: 0, maxAttempts: 3 });
    expect(first && hydratePITaskRecord(first)?.revisionCount).toBe(1);
    expect(data(await (await post(body)).json())).toMatchObject({ status: 'already_bound', revision: { status: 'revision_already_started' } });
    const stored = loadLedger(join(workspaceDir, '.state'));
    expect(stored.tree.ruleCandidateBindings?.[candidateId]?.revisions).toHaveLength(1);
    expect(stored.tree.ruleCandidateBindings?.[candidateId]?.revisions[0]?.owner.actorId).toBe('server-owner');
    expect(Object.keys(stored.tree.principles)).toEqual([PID]);
  });
  it('authentication and injected authority fields are refused before mutation', async () => {
    const body = await bindBody();
    const before = readFileSync(join(workspaceDir, '.state', 'principle_training_state.json'), 'utf8');
    authorized = false;
    expect((await post(body)).status).toBe(403);
    authorized = true;
    expect((await post({ ...body, ownerId: 'forged', approved: true })).status).toBe(400);
    expect(readFileSync(join(workspaceDir, '.state', 'principle_training_state.json'), 'utf8')).toBe(before);
    expect(await handle.stateManager.getTask('scribe')).toMatchObject({ status: 'succeeded', attemptCount: 1 });
  });
  it('revocation is append-only, does not create another revision, and does not deactivate rules', async () => {
    await post(await bindBody());
    const result = await post({ action: 'revoke', expectedRevision: 1, reason: 'Withdraw relation.', requestId: 'revoke-request', resumeOnce: false });
    expect(result.status).toBe(200);
    expect(data(await result.json())).toMatchObject({ status: 'revoked', runtimeDeactivated: false, inFlightOperationsMayComplete: true });
    const task = await handle.stateManager.getTask('scribe');
    expect(task && hydratePITaskRecord(task)?.revisionCount).toBe(1);
  });
  it('real Scribe revision stamps a new artifact, preserves the old one, and Artificer reads the new successful run', async () => {
    const common = { artifactKind: 'principle' as const, lineageArtifactIds: [], validationStatus: 'validated' as const, createdAt: NOW, updatedAt: NOW };
    const store = handle.stateManager.piArtifactStore;
    await store.upsertArtifact({ ...common, artifactId: 'pi-art-dreamer-old', sourceTaskId: 'dreamer', contentJson: '{}' });
    await store.upsertArtifact({ ...common, artifactId: 'pi-art-philosopher-old', sourceTaskId: 'philosopher', contentJson: JSON.stringify({ sourceDreamerArtifactId: 'pi-art-dreamer-old', principleCandidates: [] }) });
    const old = await store.upsertArtifact({ ...common, artifactId: 'old-scribe-artifact', sourceTaskId: 'scribe', contentJson: JSON.stringify({ sourceTrace: { dreamerArtifactId: 'pi-art-dreamer-old' }, principleDraft: { statement: 'OLD UNLINKED TEXT' } }) });
    const body = await bindBody();
    expect((await post(body)).status).toBe(200);
    const adapter = new PrincipleTreeLedgerAdapter({ stateDir: join(workspaceDir, '.state') });
    const ledgerIdentity = { isAvailable: () => adapter.isAvailable(), hasPrinciple: (id: string) => adapter.hasPrinciple(id), listForCandidate: (id: string) => adapter.listForCandidate(id), resolveForCandidate: async (id: string) => adapter.resolveCandidatePrincipleIdentity(id, (await handle.stateManager.getCandidate(id))?.rawRecommendationKind) };
    const runtimeAdapter = new TestDoubleRuntimeAdapter({ onFetchOutput: () => ({ payload: {
      taskId: 'scribe', sourcePhilosopherArtifactId: 'pi-art-philosopher-old',
      principleDraft: { title: 'Scope', statement: 'NEW LINKED TEXT', rationale: 'Protect scope', applicability: ['writes'], antiPatterns: ['unscoped writes'], confidence: 0.9 },
      sourceTrace: { philosopherArtifactId: 'pi-art-philosopher-old', dreamerArtifactId: 'pi-art-dreamer-old' }, risks: [], generatedAt: NOW,
      intentContract: { ownerIntent: 'Protect scope', targetBehavior: 'Check scope', forbiddenBehavior: 'Unscoped writes', evidenceSource: 'philosopher', validationExpectation: 'Block out-of-scope writes' }, executionConditions: { version: 1, requiredFacts: [] },
    } }) });
    const deps = { stateManager: handle.stateManager, artifactStore: store, runtimeAdapter, eventEmitter: new StoreEventEmitter(), ledgerIdentity };
    const options = { owner: 'test', runtimeKind: 'test-double', timeoutMs: 1000 };
    const result = await new ScribeRunner({ ...deps, validator: new DefaultScribeValidator() }, options).run('scribe');
    expect(result.status).toBe('succeeded');
    if (!result.artifactId) throw new Error('No new Scribe artifact.');
    const fresh = await store.getArtifactById(result.artifactId);
    expect(fresh?.sourcePrincipleId).toBe(PID);
    expect(fresh && JSON.parse(fresh.contentJson).identityResolution).toMatchObject({ candidateId, basis: 'owner_rule_binding', bindingRevision: 1 });
    expect(await store.getArtifactById(old.artifactId)).toEqual(old);
    await handle.stateManager.createTask({ taskId: 'artificer', taskKind: 'artificer', status: 'pending', attemptCount: 0, maxAttempts: 3, diagnosticJson: createPITaskDiagnosticJson({ dependencyTaskIds: ['scribe'], channel: 'code_tool_hook', timeoutMs: 1000, inputArtifactRefs: [], outputArtifactRefs: [] }) });
    const runner = new ArtificerRunner({ ...deps, validator: new DefaultArtificerValidator() }, options);
    const context = await runner.buildContext('artificer');
    expect(context.sourceScribeArtifactId).toBe(result.artifactId);
    expect(context.scribeArtifact).toContain('NEW LINKED TEXT');
    expect(context.scribeArtifact).not.toContain('OLD UNLINKED TEXT');
  });
  it('SPEC-PRI-1047: authenticated source-correct-once consumes the one budget through the route; replay and unauthenticated calls refuse', async () => {
    // Post-run4 production shape: binding revision 1 consumed by a completed
    // scribe epoch; artificer parked at the textual_basis_unanchored NHR.
    const common = { artifactKind: 'principle' as const, lineageArtifactIds: [], validationStatus: 'validated' as const, createdAt: NOW, updatedAt: NOW };
    const store = handle.stateManager.piArtifactStore;
    await store.upsertArtifact({ ...common, artifactId: 'pi-art-dreamer-old', sourceTaskId: 'dreamer', contentJson: '{}' });
    await store.upsertArtifact({ ...common, artifactId: 'pi-art-philosopher-old', sourceTaskId: 'philosopher', contentJson: JSON.stringify({ sourceDreamerArtifactId: 'pi-art-dreamer-old', principleCandidates: [] }) });
    const body = await bindBody();
    expect((await post(body)).status).toBe(200); // real authenticated bind -> scribe revision epoch 1
    const scribeAfterBind = await handle.stateManager.getTask('scribe');
    const scribePi = hydratePITaskRecord(scribeAfterBind!);
    await store.upsertArtifact({ ...common, artifactId: 'pi-art-scribe-run4', sourceTaskId: 'scribe', validationStatus: 'pending' as never, contentJson: JSON.stringify({
      taskId: 'scribe', sourcePhilosopherArtifactId: 'pi-art-philosopher-old',
      principleDraft: { title: 't', statement: 'NEW LINKED TEXT', rationale: 'r', applicability: ['a'], antiPatterns: ['b'], confidence: 0.9 },
      sourceTrace: { philosopherArtifactId: 'pi-art-philosopher-old', dreamerArtifactId: 'pi-art-dreamer-old' }, risks: [], generatedAt: NOW,
      intentContract: { ownerIntent: 'o', targetBehavior: 't', forbiddenBehavior: 'f', evidenceSource: 'e', validationExpectation: 'v' },
      executionConditions: { version: 1, requiredFacts: [{ factKind: 'design_approval', required: true, textualBasis: 'Owner原文：‘……’' }] },
    }) });
    await handle.stateManager.updateTask('scribe', { status: 'succeeded', diagnosticJson: createPITaskDiagnosticJson({ ...scribePi!, revisionCount: 1 }) });
    await handle.stateManager.createTask({
      taskId: 'artificer', taskKind: 'artificer', status: 'needs_human_review', attemptCount: 0, maxAttempts: 6,
      diagnosticJson: (() => {
        const meta = JSON.parse(createPITaskDiagnosticJson({ dependencyTaskIds: ['scribe'], channel: 'code_tool_hook', timeoutMs: 1000, inputArtifactRefs: [], outputArtifactRefs: [] })) as { pi_metadata: Record<string, unknown> };
        meta.pi_metadata.humanReviewContext = { reasonCode: 'textual_basis_unanchored', sourceRunId: 'intent-preflight', revisionEpoch: 0, detail: 'unanchored textualBasis', createdAt: NOW };
        return JSON.stringify(meta);
      })(),
    });
    const [current] = await store.listBySourceTaskId('scribe');
    if (!current) throw new Error('current scribe artifact missing');
    const { createHash } = await import('node:crypto');
    const digest = 'sha256:' + createHash('sha256').update(current.contentJson, 'utf8').digest('hex');
    const request = { expectedBindingRevision: 1, expectedScribeTaskId: 'scribe', expectedArtificerTaskId: 'artificer', expectedScribeArtifactDigest: digest, reason: 'Owner source correction for the unanchored citation.', requestId: 'sc-req-1' };

    // Unauthenticated calls never mutate.
    const before = await handle.stateManager.getTask('scribe');
    authorized = false;
    expect((await fetch(`${base}/source-correct-once`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(request) })).status).toBe(403);
    const after403 = await handle.stateManager.getTask('scribe');
    expect(after403?.status).toBe(before?.status);
    expect(after403?.diagnosticJson).toBe(before?.diagnosticJson); // zero mutation
    authorized = true;
    // Injected authority fields are refused.
    expect((await fetch(`${base}/source-correct-once`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ ...request, approved: true }) })).status).toBe(400);

    const first = await fetch(`${base}/source-correct-once`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(request) });
    expect(first.status).toBe(200);
    expect(data(await first.json())).toMatchObject({ status: 'revision_started', scribeTaskId: 'scribe', artificerTaskId: 'artificer' });
    const reopened = await handle.stateManager.getTask('scribe');
    const reopenedPi = hydratePITaskRecord(reopened!);
    expect(reopened).toMatchObject({ status: 'pending', attemptCount: 0, maxAttempts: 3 });
    expect(reopenedPi?.sourceCorrectionReceipt).toMatchObject({ actor: 'server-owner', requestId: 'sc-req-1', status: 'consumed', bindingRevision: 1 });
    expect(reopenedPi?.revisionCount).toBe(2);
    // Replay with a different requestId is idempotent — never a second budget.
    const replay = await fetch(`${base}/source-correct-once`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ ...request, requestId: 'sc-req-2' }) });
    expect(data(await replay.json())).toMatchObject({ status: 'revision_already_started' });
    expect(hydratePITaskRecord((await handle.stateManager.getTask('scribe'))!)?.revisionCount).toBe(2);
  });
  it('an unbound rule stops before the first model request and consumes no execution attempt', async () => {
    const common = { artifactKind: 'principle' as const, lineageArtifactIds: [], validationStatus: 'validated' as const, createdAt: NOW, updatedAt: NOW };
    const store = handle.stateManager.piArtifactStore;
    await store.upsertArtifact({ ...common, artifactId: 'pi-art-dreamer-old', sourceTaskId: 'dreamer', contentJson: '{}' });
    await store.upsertArtifact({ ...common, artifactId: 'pi-art-philosopher-old', sourceTaskId: 'philosopher', contentJson: JSON.stringify({ sourceDreamerArtifactId: 'pi-art-dreamer-old', principleCandidates: [] }) });
    await handle.stateManager.updateTask('scribe', { status: 'pending', attemptCount: 0 });
    const adapter = new PrincipleTreeLedgerAdapter({ stateDir: join(workspaceDir, '.state') });
    const ledgerIdentity = { isAvailable: () => adapter.isAvailable(), listForCandidate: (id: string) => adapter.listForCandidate(id), resolveForCandidate: async (id: string) => adapter.resolveCandidatePrincipleIdentity(id, (await handle.stateManager.getCandidate(id))?.rawRecommendationKind) };
    const runtimeAdapter = new TestDoubleRuntimeAdapter();
    const start = vi.spyOn(runtimeAdapter, 'startRun');
    const runner = new ScribeRunner({ stateManager: handle.stateManager, artifactStore: store, runtimeAdapter, eventEmitter: new StoreEventEmitter(), ledgerIdentity, validator: new DefaultScribeValidator() }, { owner: 'test', runtimeKind: 'test-double', timeoutMs: 1000 });
    expect(await runner.run('scribe')).toMatchObject({ status: 'failed', failureReason: 'awaiting_owner_binding:missing' });
    expect(start).not.toHaveBeenCalled();
    expect(await handle.stateManager.getTask('scribe')).toMatchObject({ status: 'needs_human_review', attemptCount: 0 });
    expect(await store.listBySourceTaskId('scribe')).toEqual([]);
  });
});
