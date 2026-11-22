/**
 * PRI-1283 review round 2 (directive D): a historical `admitted` verdict is
 * NOT a permanent grant.
 *
 * Coverage:
 *  - the admission re-verification refuses a diagnosis whose ingress ORIGIN
 *    host (painIngress.origin.kind='host_hook') has revoked consent — even
 *    AFTER the R3 sweep emptied the evidence refs (origin metadata is what
 *    survives the sweep and still attributes the material);
 *  - an OWNER-MANUAL origin (explicit Owner submission) passes the origin
 *    gate — the Owner act is not governed by the conversation-ingestion
 *    ledger (directive B);
 *  - a re-granted host passes again (revocation is not permanent either);
 *  - the internalization orchestrator's historical-admitted fast path routes
 *    through the same re-verification and surfaces the refusal at claim time.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { RuntimeStateManager } from '../store/runtime-state-manager.js';
import { SqliteConnection } from '../store/sqlite-connection.js';
import { SqliteDiagnosticianCommitter } from '../store/commit/diagnostician-committer.js';
import { evaluateAndPersistAdmissionFromStore } from '../pain-signal-bridge.js';
import { InternalizationOrchestrator } from '../internalization/internalization-orchestrator.js';
import type { SourceMaterialAuthorizationPort } from '../source-material-authorization.js';
import type { DiagnosticianOutputV2 } from '../diagnostician-output.js';

const NOW = '2026-11-22T10:00:00.000Z';
const REAL_SQLITE_TIMEOUT_MS = 30_000;

const denyCodex: SourceMaterialAuthorizationPort = {
  isHostSourceMaterialAuthorized: (host) => (host === 'codex'
    ? { authorized: false, reason: 'consent_revoked' }
    : { authorized: true }),
};

const allowAll: SourceMaterialAuthorizationPort = {
  isHostSourceMaterialAuthorized: () => ({ authorized: true }),
};

function roundOutput(): DiagnosticianOutputV2 {
  return {
    schemaVersion: 'diagnostician-output-v2',
    valid: true,
    diagnosisId: 'diag-r1',
    summary: 'summary r1',
    rootCause: 'root cause r1',
    violatedPrinciples: [],
    // NOT governance-governed refs — the origin check must be the only
    // trigger (this is exactly the post-sweep shape: refs already purged).
    evidence: [{ sourceRef: 'trace-r1', note: 'evidence r1' }],
    recommendations: [{ kind: 'principle', description: 'P', abstractedPrinciple: 'P', recommendationRef: 'principle-r1' }],
    confidence: 0.9,
  };
}

interface Workspace {
  workspaceDir: string;
  manager: RuntimeStateManager;
}

const workspaces: Workspace[] = [];

async function realWorkspace(): Promise<Workspace> {
  const workspaceDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pd-pri1283-d-'));
  const manager = new RuntimeStateManager({ workspaceDir });
  await manager.initialize();
  const ws = { workspaceDir, manager };
  workspaces.push(ws);
  return ws;
}

/** Seed a split diagnosis chain with the given ingress origin shape. */
async function seedSplitDiagnosis(ws: Workspace, args: { origin: Record<string, unknown>; provenance: string }): Promise<{ candidateId: string; routerTaskId: string }> {
  const parent = 'pain_parent_d';
  const router = 'diag_router_d';
  const runId = 'run-d-1';
  await ws.manager.createTask({
    taskId: parent,
    taskKind: 'diagnostician',
    inputRef: 'pain_d',
    status: 'succeeded',
    attemptCount: 1,
    maxAttempts: 3,
    diagnosticJson: JSON.stringify({
      sourcePainId: 'pain_d',
      reasonSummary: 'original pain input',
      source: 'user_correction',
      severity: 'moderate',
      sessionIdHint: null,
      provenance: args.provenance,
      // Post-sweep shape: the governance evidence entries are GONE; only the
      // origin metadata still attributes the material to its host.
      evidence: [{ sourceRef: 'owner_reported:cli', note: 'kept' }],
      painIngress: {
        version: 'v1',
        origin: args.origin,
        correlation: { status: 'bound', hostKind: 'codex', rootSessionId: 'rs1', rolloutIdentity: 'r1', logicalObservationKey: 'codex|r|t|user', hostTurnId: 't1' },
        evidenceClass: { status: 'available', entryCount: 1 },
      },
      workspaceDir: null,
    }),
  });
  await ws.manager.createTask({
    taskId: router,
    taskKind: 'diag_router',
    inputRef: parent,
    status: 'succeeded',
    attemptCount: 1,
    maxAttempts: 3,
  });
  await ws.manager.runStore.createRun({
    runId,
    taskId: router,
    runtimeKind: 'pi-ai',
    attemptNumber: 1,
    executionStatus: 'succeeded',
    startedAt: NOW,
    endedAt: NOW,
    outputPayload: JSON.stringify(roundOutput()),
  });
  const connection = new SqliteConnection(ws.workspaceDir);
  try {
    const committer = new SqliteDiagnosticianCommitter(connection);
    await committer.commit({
      runId,
      taskId: router,
      output: roundOutput(),
      idempotencyKey: `${router}:${runId}`,
      contentJson: JSON.stringify({ text: 'P', triggerPattern: 'tp', action: 'act' }),
    });
    const candidates = await ws.manager.getCandidatesByTaskId(parent);
    const candidate = candidates.find((c) => c.sourceRunId === runId);
    if (candidate === undefined) throw new Error('expected seeded candidate');
    return { candidateId: candidate.candidateId, routerTaskId: router };
  } finally {
    connection.close();
  }
}

afterEach(async () => {
  for (const ws of workspaces.splice(0)) {
    await ws.manager.close().catch(() => undefined);
    try {
      fs.rmSync(ws.workspaceDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
    } catch {
      // Windows can hold files briefly; the temp root is disposable.
    }
  }
}, REAL_SQLITE_TIMEOUT_MS);

describe('PRI-1283 r2 D — admission re-verification refuses revoked-source lineage (real SQLite)', () => {
  it('an automatic_hook ingress origin of a revoked host is refused even after the sweep purged the evidence refs', async () => {
    const ws = await realWorkspace();
    const { candidateId, routerTaskId } = await seedSplitDiagnosis(ws, { origin: { kind: 'automatic_hook', source: 'codex:user_prompt' }, provenance: 'automatic_hook' });
    const result = await evaluateAndPersistAdmissionFromStore(ws.manager, [candidateId], {
      taskId: routerTaskId,
      sourceMaterialAuthorization: denyCodex,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toContain('source_authorization_revoked');
      expect(result.reason).toContain('ingress_origin_host_codex');
      expect(result.nextAction).toContain('no longer granted');
    }
  }, REAL_SQLITE_TIMEOUT_MS);

  it('an owner_manual ingress origin (explicit Owner submission) passes the origin gate under the same denial', async () => {
    const ws = await realWorkspace();
    const { candidateId, routerTaskId } = await seedSplitDiagnosis(ws, { origin: { kind: 'owner_manual', channel: 'codex_explicit_prefix' }, provenance: 'host_context_bound' });
    const result = await evaluateAndPersistAdmissionFromStore(ws.manager, [candidateId], {
      taskId: routerTaskId,
      sourceMaterialAuthorization: denyCodex,
    });
    // The Owner act is not governed — admission proceeds on its own merits.
    expect(result.ok).toBe(true);
  }, REAL_SQLITE_TIMEOUT_MS);

  it('a re-granted host passes the origin gate again (revocation is not permanent)', async () => {
    const ws = await realWorkspace();
    const { candidateId, routerTaskId } = await seedSplitDiagnosis(ws, { origin: { kind: 'automatic_hook', source: 'codex:user_prompt' }, provenance: 'automatic_hook' });
    const refused = await evaluateAndPersistAdmissionFromStore(ws.manager, [candidateId], { taskId: routerTaskId, sourceMaterialAuthorization: denyCodex });
    expect(refused.ok).toBe(false);
    const regranted = await evaluateAndPersistAdmissionFromStore(ws.manager, [candidateId], { taskId: routerTaskId, sourceMaterialAuthorization: allowAll });
    expect(regranted.ok).toBe(true);
  }, REAL_SQLITE_TIMEOUT_MS);
});

describe('PRI-1283 r2 D — orchestrator historical-admitted fast path re-verifies (wiring)', () => {
  it('a queued dreamer task whose candidate holds a historical admitted verdict is refused when the source is revoked', async () => {
    const candidateId = '12345678-1234-5678-1234-123456789abc';
    const dreamerTaskId = `dreamer-${candidateId}-r1`;
    const rawDreamerTask = {
      taskId: dreamerTaskId,
      taskKind: 'dreamer',
      status: 'pending',
      attemptCount: 0,
      maxAttempts: 3,
      createdAt: NOW,
      updatedAt: NOW,
      diagnosticJson: JSON.stringify({
        pi_metadata: {
          dependencyTaskIds: [],
          channel: 'prompt',
          timeoutMs: 60000,
          inputArtifactRefs: [],
          outputArtifactRefs: [],
        },
      }),
    };
    const mockStateManager = {
      listTasks: vi.fn()
        .mockResolvedValueOnce([rawDreamerTask])
        .mockResolvedValueOnce([]),
      getTask: vi.fn().mockResolvedValue({
        taskId: 'diag-task-1',
        taskKind: 'diagnostician',
        inputRef: 'pain_1',
        status: 'succeeded',
        attemptCount: 1,
        maxAttempts: 3,
        // Evidence refs of the revoked source → the shared evaluator refuses
        // with source_authorization_revoked and the orchestrator surfaces it.
        diagnosticJson: JSON.stringify({
          sourcePainId: 'pain_1',
          reasonSummary: 'r',
          source: 'user_correction',
          severity: 'severe',
          sessionIdHint: null,
          provenance: 'host_context_bound',
          evidence: [{ sourceRef: 'governance_observation:codex|r|t|user', note: 'excerpt' }],
          workspaceDir: null,
        }),
      }),
      acquireLease: vi.fn(),
      getAdmissionDocument: vi.fn().mockResolvedValue({
        ok: true,
        document: {
          schemaVersion: 1,
          currentEvaluationId: 'eval-1',
          evaluations: [{ evaluationId: 'eval-1', evaluatedAt: NOW, decision: 'admitted', reason: 'evidence threshold met', nextAction: '', policyVersion: 'v1', materialFingerprint: 'fp' }],
          processing: { status: 'idle' },
        },
      }),
      getCandidate: vi.fn().mockResolvedValue({ candidateId, taskId: 'diag-task-1', sourceRunId: 'run-1', recommendationKind: 'principle', confidence: 0.9 }),
    };
    const orchestrator = new InternalizationOrchestrator(
      { stateManager: mockStateManager as unknown as RuntimeStateManager, sourceMaterialAuthorization: denyCodex },
      { owner: 'test-owner', runtimeKind: 'dreamer' },
    );
    const result = await orchestrator.wakeOnce();
    // The claim-time admission refusal must surface (not leased, refusal recorded).
    const refused = result as unknown as { decision: string; reason?: string; admissionRefusals?: { candidateId: string; decision: string; reason: string }[] };
    expect(refused.decision).toBe('no_ready_tasks');
    expect(refused.reason).toBe('all_admission_refused');
    expect(mockStateManager.acquireLease).not.toHaveBeenCalled();
    expect(refused.admissionRefusals?.[0]?.decision).toBe('source_authorization_revoked');
    expect(refused.admissionRefusals?.[0]?.reason).toContain('source_authorization_revoked');
  });
});
