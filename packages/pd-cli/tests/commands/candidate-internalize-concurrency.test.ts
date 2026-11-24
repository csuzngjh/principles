/**
 * SPEC-PD-PIPELINE-SPINE-001 review round 2 (P1-3) — `pd candidate internalize`
 * under concurrency, against REAL state.
 *
 * Defect (round 1): the identity read, the admission read, the seed
 * suppression verdict and `createTask` were not serialized. An Owner reuse
 * completion landing between the identity read and the admission read left a
 * stale `derived_candidate` identity beside a cleared park — no suppression —
 * and an independent Dreamer task was created for a candidate the Owner had
 * just resolved onto an existing principle.
 *
 * Fix: the read-decide-write sequence runs under the per-candidate
 * cross-process coordination lock — the SAME lock the Owner decision
 * lifecycle holds (Phase A / Phase C). The critical section never prints or
 * exits; every outcome is reported after the lock is released.
 *
 * Real SQLite workspace, real handler, real file lock, real intake service,
 * real ledger. Only the LLM is absent (internalize never calls it).
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as os from 'node:os';
import * as path from 'node:path';
import * as fs from 'node:fs';
import {
  RuntimeStateManager,
  SqliteDiagnosticianCommitter,
  CandidateIntakeService,
  PrincipleTreeLedgerAdapter,
  persistPainDiagnosis,
  type DiagnosticianOutputV2,
} from '@principles/core/runtime';
import { handleCandidateInternalize } from '../../src/commands/candidate.js';
import { completeOwnerDecisionExecution, recordOwnerDecisionIntent } from '../../src/services/reuse-park-release.js';

const EXISTING_PRINCIPLE_ID = '11111111-2222-4111-8111-111111111111';
const OWNER = { ownerId: 'owner-concurrency-test', identitySource: 'concurrency-test' };

let workspace = '';
/** Handles a test opened; released before the temp tree is removed. */
const disposers: Array<() => Promise<void> | void> = [];

function makeWorkspace(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'pd-pri1291-concurrency-'));
}

/** A real principle already in the ledger, eligible as a reuse target. */
function writeLedgerWithExistingPrinciple(stateDir: string): void {
  fs.mkdirSync(stateDir, { recursive: true });
  fs.writeFileSync(path.join(stateDir, 'principle_training_state.json'), JSON.stringify({
    trainingStore: {},
    _tree: {
      principles: {
        [EXISTING_PRINCIPLE_ID]: {
          id: EXISTING_PRINCIPLE_ID,
          version: 1,
          text: 'Never skip the owner review gate for destructive actions',
          triggerPattern: '*',
          action: 'noop',
          status: 'active',
          priority: 'medium',
          scope: 'global',
          evaluability: 'manual_only',
          valueScore: 0,
          adherenceRate: 0,
          painPreventedCount: 0,
          derivedFromPainIds: ['pain-existing-1'],
          ruleIds: [],
          conflictsWithPrincipleIds: [],
          createdAt: '2026-01-01T00:00:00.000Z',
          updatedAt: '2026-01-01T00:00:00.000Z',
          reuseEvidence: [],
        },
      },
      rules: {},
      implementations: {},
      metrics: {},
      ruleCandidateBindings: {},
      lastUpdated: '2026-01-01T00:00:00.000Z',
    },
  }, null, 2));
}

function diagnosticJson(painId: string): string {
  return JSON.stringify({
    sourcePainId: painId,
    reasonSummary: 'Deviated from the owner-review contract',
    source: 'test',
    severity: 'high',
    sessionIdHint: null,
    agentIdHint: null,
    provenance: 'automatic_hook',
    provenanceReason: 'automatic hook',
    evidence: [{ sourceRef: 'session://test', note: 'deviated' }],
    workspaceDir: null,
  });
}

type Kind = 'principle' | 'rule';

function outputFor(painId: string, kind: Kind): DiagnosticianOutputV2 {
  return {
    valid: true,
    diagnosisId: `diag-${painId}`,
    summary: 'Deviation observed',
    // categorized: a persisted pain_diagnoses row is derived from it
    rootCause: 'Design: Agent skipped the owner review',
    violatedPrinciples: [],
    evidence: [{ sourceRef: 'session://test', note: 'deviated' }],
    recommendations: [{
      kind,
      description: kind === 'rule' ? 'Require pattern check before rm' : 'Require owner review before destructive actions',
      ...(kind === 'rule'
        ? {
            triggerPattern: 'rm\\s+-rf',
            action: 'require explicit owner confirmation',
            principleAssociation: { status: 'unresolved', reason: 'no_supported_target' },
          }
        : { abstractedPrinciple: 'Never skip the owner review gate for destructive actions' }),
      recommendationRef: `${kind}-1`,
    }],
    confidence: 0.9,
    schemaVersion: 'diagnostician-output-v2',
  } as DiagnosticianOutputV2;
}

/** A real diagnosis commit producing one candidate row (+ its pain_diagnoses row). */
async function seedCandidate(
  sm: RuntimeStateManager,
  painId: string,
  kind: Kind,
): Promise<{ candidateId: string; taskId: string; artifactId: string }> {
  const taskId = `diagnostician-${painId}`;
  await sm.createTask({
    taskId,
    taskKind: 'diagnostician',
    inputRef: painId,
    status: 'pending',
    attemptCount: 0,
    maxAttempts: 3,
    diagnosticJson: diagnosticJson(painId),
  });
  const committer = new SqliteDiagnosticianCommitter(sm.connection);
  const lease = await sm.acquireLeaseDetailed({ taskId, owner: 'concurrency-test', durationMs: 60_000, runtimeKind: 'openclaw' });
  const fence = { taskId, owner: 'concurrency-test', leaseGeneration: lease.leaseGeneration };
  const output = outputFor(painId, kind);
  const committed = await committer.commit({ runId: lease.runId, taskId, output, idempotencyKey: `idem-${taskId}` });
  await sm.markTaskSucceeded(taskId, `artifact://${committed.artifactId}`, fence, lease.runId);
  await sm.updateRunOutput(lease.runId, JSON.stringify(output));
  // the Owner reuse execution requires the persisted diagnosis of this pain
  await persistPainDiagnosis({ stateManager: sm }, { painId, taskId, diagnosticianOutput: output, artifactId: committed.artifactId });
  const candidates = await sm.getCandidatesByTaskId(taskId);
  const candidate = candidates[0];
  if (candidate === undefined) throw new Error(`no candidate produced for ${painId}`);
  return { candidateId: candidate.candidateId, taskId, artifactId: committed.artifactId };
}

async function dreamerTaskCount(candidateId: string): Promise<number> {
  const sm = new RuntimeStateManager({ workspaceDir: workspace });
  await sm.initialize();
  try {
    const tasks = await sm.listTasks();
    return tasks.filter((task) => task.taskKind === 'dreamer' && task.taskId.includes(candidateId)).length;
  } finally {
    await sm.close();
  }
}

interface InternalizeJson { candidateId: string; status: string; reason?: string; taskId?: string }

function jsonLinesOf(spy: ReturnType<typeof vi.spyOn>): InternalizeJson[] {
  return spy.mock.calls
    .map((call) => String(call[0]))
    .filter((line) => line.trim().startsWith('{'))
    .map((line) => JSON.parse(line) as InternalizeJson);
}

/** The per-candidate lock is held while its coordination file exists. */
function lockHeld(candidateId: string): boolean {
  const dir = path.join(workspace, '.state', 'candidate-coordination');
  if (!fs.existsSync(dir)) return false;
  return fs.readdirSync(dir).some((name) => name.startsWith(candidateId));
}

beforeEach(() => {
  workspace = makeWorkspace();
});

afterEach(async () => {
  vi.restoreAllMocks();
  // release every SQLite handle BEFORE the temp tree is removed (Windows
  // keeps the files locked through open handles)
  for (const dispose of disposers.splice(0).reverse()) {
    await dispose().catch(() => undefined);
  }
  fs.rmSync(workspace, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
});

describe('P1-3 — pd candidate internalize under concurrency (real lock, real SQLite)', () => {
  it('six concurrent internalize requests for ONE candidate create exactly one Dreamer task', async () => {
    const sm = new RuntimeStateManager({ workspaceDir: workspace });
    await sm.initialize();
    const { candidateId } = await seedCandidate(sm, 'pain-concurrent-1', 'rule');
    await sm.close();
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    vi.spyOn(process, 'exit').mockImplementation((() => undefined) as () => never);

    await Promise.all(Array.from({ length: 6 }, () => handleCandidateInternalize({ candidateId, workspace, json: true })));

    const statuses = jsonLinesOf(logSpy).map((line) => line.status).sort();
    expect(statuses).toEqual(['created', 'existing', 'existing', 'existing', 'existing', 'existing']);
    // the database, not the return values, carries the proof
    expect(await dreamerTaskCount(candidateId)).toBe(1);
    expect(lockHeld(candidateId)).toBe(false);
  }, 60_000);

  it('Owner reuse completion racing with internalize: serialized by the same lock — internalize decides on ONE consistent snapshot', async () => {
    const stateDir = path.join(workspace, '.state');
    writeLedgerWithExistingPrinciple(stateDir);
    const sm = new RuntimeStateManager({ workspaceDir: workspace });
    await sm.initialize();
    disposers.push(() => sm.close());
    const ledgerAdapter = new PrincipleTreeLedgerAdapter({ stateDir });
    const { candidateId } = await seedCandidate(sm, 'pain-reuse-race', 'principle');

    // The real reuse-review state: the candidate is parked as a suspected
    // duplicate (no ledger entry of its own yet) and the Owner has RECORDED
    // a `reuse` verdict whose execution — Phase B (ledger evidence) and
    // Phase C (finalization under the candidate lock) — has not run yet.
    await sm.updateAdmissionProcessing(candidateId, { state: 'awaiting_owner', attempts: 0, blockedReason: 'reuse_pending_owner' });
    const intent = await recordOwnerDecisionIntent({
      stateManager: sm,
      executionProbe: ledgerAdapter,
      coordination: ledgerAdapter,
      candidateId,
      decide: 'reuse',
      reason: 'duplicate of the existing principle',
      ...OWNER,
      rawRecommendationKind: 'principle',
      selectedPrincipleId: EXISTING_PRINCIPLE_ID,
    });
    if (intent.status !== 'recorded') throw new Error(`intent not recorded: ${JSON.stringify(intent)}`);
    const decision = intent.decision;

    // Interpose on the admission read INSIDE internalize's critical section
    // (the candidate lock is held at that moment) and hold it open.
    const realGetAdmissionDocument = RuntimeStateManager.prototype.getAdmissionDocument;
    let paused = false;
    let release: () => void = () => undefined;
    let reached: () => void = () => undefined;
    const reachedPromise = new Promise<void>((resolve) => { reached = resolve; });
    const gate = new Promise<void>((resolve) => { release = resolve; });
    vi.spyOn(RuntimeStateManager.prototype, 'getAdmissionDocument').mockImplementation(async function (
      this: RuntimeStateManager,
      id: string,
    ) {
      if (!paused && id === candidateId && lockHeld(candidateId)) {
        paused = true;
        reached();
        await gate;
      }
      return realGetAdmissionDocument.call(this, id);
    });
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    vi.spyOn(process, 'exit').mockImplementation((() => undefined) as () => never);

    const internalize = handleCandidateInternalize({ candidateId, workspace, json: true });
    try {
      const pauseOrExit = await Promise.race([
        reachedPromise.then(() => 'reached' as const),
        internalize.then(() => 'completed' as const),
      ]);
      if (pauseOrExit !== 'reached') {
        throw new Error('internalize completed before reaching the in-lock admission pause');
      }

      // While internalize is inside its critical section, the Owner's reuse
      // decision runs to completion on the real production path — as ONE
      // chain, exactly as `pd candidate review --decide reuse` drives it:
      // Phase B executes the reuse (ledger evidence, under the candidate
      // lock inside the intake service) and Phase C finalizes the decision
      // (under the same lock).
      let ownerCompletionSettled = false;
      let signalPhaseBAttempted: () => void = () => undefined;
      const phaseBAttempted = new Promise<void>((resolve) => { signalPhaseBAttempted = resolve; });
      const originalCoordination = ledgerAdapter.withCandidateCoordination.bind(ledgerAdapter);
      ledgerAdapter.withCandidateCoordination = async (id, operation) => {
        if (id === candidateId) signalPhaseBAttempted();
        return originalCoordination(id, operation);
      };
      const ownerCompletion = (async (): Promise<{ phaseB: string; phaseC: string }> => {
        // the reuse evidence needs the Pain that re-validated the principle:
        // this fixture has no pain_diagnoses row, so the authoritative pain
        // context is supplied explicitly (the bridge passes the same hint)
        const phaseB = await new CandidateIntakeService({ stateManager: sm, ledgerAdapter, reuseStateDir: stateDir })
          .intake(candidateId, { ownerDecision: { decisionId: decision.decisionId }, painIdHint: 'pain-reuse-race' });
        if (phaseB.outcome !== 'refused' || phaseB.reason !== 'reuse_selected') {
          throw new Error(`Phase B did not execute the reuse: ${JSON.stringify(phaseB)}`);
        }
        const phaseC = await completeOwnerDecisionExecution({
          stateManager: sm,
          coordination: ledgerAdapter,
          candidateId,
          decision,
          resultingPrincipleId: EXISTING_PRINCIPLE_ID,
          ...OWNER,
          rawRecommendationKind: 'principle',
        });
        ownerCompletionSettled = true;
        return { phaseB: phaseB.reason, phaseC: phaseC.status };
      })();

      // The Owner Phase B has actually attempted the same candidate lock and
      // is waiting behind internalize. Before release, it must not have
      // written reuse evidence or completed either phase.
      await phaseBAttempted;
      await new Promise<void>((resolve) => setTimeout(resolve, 50));
      expect(ownerCompletionSettled).toBe(false);
      const ledgerBeforeRelease = JSON.parse(fs.readFileSync(path.join(stateDir, 'principle_training_state.json'), 'utf8')) as {
        _tree: { principles: Record<string, { reuseEvidence?: unknown[] }> };
      };
      expect(ledgerBeforeRelease._tree.principles[EXISTING_PRINCIPLE_ID]?.reuseEvidence ?? []).toEqual([]);

      release();
      const [, ownerOutcome] = await Promise.all([internalize, ownerCompletion]);
      expect(ownerCompletionSettled).toBe(true);
      // once the lock is free the Owner completion goes through in full
      expect(ownerOutcome.phaseB).toBe('reuse_selected');
      expect(ownerOutcome.phaseC).toBe('completed');
    } finally {
      release();
    }

    // internalize decided on ONE consistent snapshot: the Owner decision was
    // still pending at its read → no independent Dreamer chain, with the
    // structured reason (never the misleading `candidate_not_in_ledger`).
    const outcomes = jsonLinesOf(logSpy);
    expect(outcomes).toHaveLength(1);
    expect(outcomes[0]?.status).toBe('refused');
    expect(outcomes[0]?.reason).toContain('dreamer_seed_suppressed');
    expect(await dreamerTaskCount(candidateId)).toBe(0);
    expect(lockHeld(candidateId)).toBe(false);
  }, 60_000);
});
