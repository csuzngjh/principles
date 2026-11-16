/**
 * Phase 7.2 B2 — Owner release of a persisted reuse park, through the REAL
 * `pd candidate review` handler (cli-7 wiring).
 *
 * Contract under test (LEDGER_WRITE_SAFETY_SPEC §4.2 / §4.4):
 *   - `pd candidate intake` (automatic path, real handler, gate NOT
 *     configured) REPLAYS a persisted park instead of creating — the park
 *     outlives both the gate configuration and the process that produced it;
 *   - `--decide reuse` releases the park with a durable audit (admission
 *     evaluation record carrying the VERIFIED Owner identity, reason, time
 *     and released-park context), clears processing, resolves via the
 *     existing reuseEvidence mechanism;
 *   - `--decide create` releases the park with the same audit and then
 *     creates the Principle (the Owner's explicit override);
 *   - re-running a completed decision is idempotent (single release record);
 *   - an unreadable admission document cannot smuggle a decision through:
 *     the write-gate pre-check refuses before anything is written.
 *
 * The park fixture is persisted DIRECTLY (updateAdmissionProcessing) — the
 * service-side park creation is covered by the principles-core
 * candidate-intake-park-persistence suite; no LLM is involved anywhere here.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { join } from 'path';
import { mkdirSync, rmSync, writeFileSync } from 'fs';
import { randomUUID } from 'crypto';
import Database from 'better-sqlite3';

const { mockResolveOwnerIdentity } = vi.hoisted(() => ({
  mockResolveOwnerIdentity: vi.fn(),
}));

vi.mock('@principles/core/runtime', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  resolveOwnerIdentity: mockResolveOwnerIdentity,
}));

import { handleCandidateReview, handleCandidateIntake } from '../../src/commands/candidate.js';
import { RuntimeStateManager, ADMISSION_POLICY_VERSION, fingerprintAdmissionMaterial } from '@principles/core/runtime';
import type { AdmissionEvaluationRecord } from '@principles/core/runtime';
import { addPrincipleToLedger, loadLedger } from '@principles/core/principle-tree-ledger';
import type { LedgerPrinciple } from '@principles/core/principle-tree-ledger';
import { REUSE_PARK_RELEASE_POLICY_VERSION } from '../../src/services/reuse-park-release.js';

let workspaceDir: string;
let stateManager: RuntimeStateManager;
let consoleLogSpy: ReturnType<typeof vi.spyOn>;
let consoleErrorSpy: ReturnType<typeof vi.spyOn>;
let exitSpy: ReturnType<typeof vi.spyOn>;

const CANDIDATE_TEXT = '任何结论必须由可观察证据背书，无查验则显式降级为推断。';

function makePrinciple(overrides: Partial<LedgerPrinciple> = {}): LedgerPrinciple {
  return {
    id: randomUUID(),
    version: 1,
    text: `${CANDIDATE_TEXT}（既有表述 ${randomUUID().slice(0, 8)}）`,
    triggerPattern: '在没有外部证据就做出确定性结论时',
    action: '先核验可观察状态再断言',
    status: 'active',
    priority: 'P1',
    scope: 'general',
    evaluability: 'manual_only',
    valueScore: 0.5,
    adherenceRate: 0.8,
    painPreventedCount: 0,
    derivedFromPainIds: [],
    ruleIds: [],
    conflictsWithPrincipleIds: [],
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    ...overrides,
  };
}

async function seedPrincipleCandidate(): Promise<string> {
  const candidateId = randomUUID();
  const artifactId = randomUUID();
  const taskId = randomUUID();
  const now = new Date().toISOString();
  const recommendation = {
    kind: 'principle' as const,
    recommendationRef: 'principle-1',
    description: CANDIDATE_TEXT,
    triggerPattern: '在没有外部证据就做出确定性结论时',
    action: '先核验可观察状态再断言',
  };
  const v2Output = {
    schemaVersion: 'diagnostician-output-v2' as const,
    valid: true,
    diagnosisId: `diag-${candidateId}`,
    summary: 'seeded diagnosis',
    rootCause: 'People: seeded',
    violatedPrinciples: [],
    evidence: [{ sourceRef: 'seed:trace-1', note: 'seeded output evidence' }],
    recommendations: [recommendation],
    confidence: 0.9,
  };
  await stateManager.taskStore.createTask({
    taskId,
    taskKind: 'diagnostician',
    status: 'succeeded',
    attemptCount: 1,
    maxAttempts: 3,
    leaseOwner: undefined,
    leaseExpiresAt: undefined,
    lastError: undefined,
    inputRef: `pain-seed-${candidateId}`,
    resultRef: '',
    diagnosticJson: JSON.stringify({
      sourcePainId: `pain-seed-${candidateId}`,
      reasonSummary: 'seeded',
      source: 'manual',
      severity: 'moderate',
      sessionIdHint: null,
      agentIdHint: null,
      provenance: 'owner_reported_no_host_trace',
      provenanceReason: 'seeded fixture',
      evidence: [{ sourceRef: 'seed:trace-1', note: 'seeded evidence entry' }],
      workspaceDir: null,
    }),
  });
  const runId = randomUUID();
  await stateManager.runStore.createRun({
    runId,
    taskId,
    runtimeKind: 'openclaw',
    attemptNumber: 1,
    executionStatus: 'succeeded',
    startedAt: now,
    endedAt: now,
    outputPayload: JSON.stringify(v2Output),
  });
  await stateManager.recordPainDiagnosis({
    painId: `pain-${candidateId}`,
    taskId,
    diagnosisId: `diag-${candidateId}`,
    category: 'People',
    rootCause: 'People: seeded diagnosis for reuse evidence',
    evidence: [],
    confidence: 0.9,
    artifactId,
  });
  const db = new Database(join(workspaceDir, '.pd', 'state.db'));
  try {
    db.prepare('INSERT INTO artifacts (artifact_id, run_id, task_id, artifact_kind, content_json, created_at) VALUES (?, ?, ?, ?, ?, ?)')
      .run(artifactId, runId, taskId, 'diagnostician_output', JSON.stringify({ ...v2Output, trustedContextReceipt: { schemaVersion: 'router-context-v2' } }), now);
    db.prepare(`INSERT INTO principle_candidates
      (candidate_id, artifact_id, task_id, source_run_id, title, description, confidence,
       source_recommendation_json, idempotency_key, status, created_at, recommendation_kind)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?, 'principle')`)
      .run(candidateId, artifactId, taskId, runId, '测试候选', CANDIDATE_TEXT, 0.9, JSON.stringify(recommendation), `${artifactId}::prompt`, now);
    db.prepare('INSERT INTO commits (commit_id, task_id, run_id, artifact_id, idempotency_key, status, created_at) VALUES (?, ?, ?, ?, ?, \'committed\', ?)')
      .run(randomUUID(), taskId, runId, artifactId, `seed-${artifactId}`, now);
  } finally {
    db.close();
  }
  return candidateId;
}

/**
 * Persist a production-shaped reuse park: an ADMITTED full-gate evaluation
 * (what the bridge writes before intake — the CLI write gate re-checks it)
 * followed by the awaiting_owner / reuse_pending_owner processing record.
 */
async function parkCandidate(candidateId: string): Promise<void> {
  const materialFingerprint = fingerprintAdmissionMaterial([candidateId, 'park-fixture']);
  const gateEvaluation: AdmissionEvaluationRecord = {
    evaluationId: `ae_${fingerprintAdmissionMaterial([candidateId, materialFingerprint, ADMISSION_POLICY_VERSION]).slice(0, 16)}`,
    decision: 'admitted',
    reason: 'fixture: full admission gate admitted this candidate',
    nextAction: 'none',
    evaluatedAt: '2026-11-16T00:00:00.000Z',
    policyVersion: ADMISSION_POLICY_VERSION,
    provenance: 'fixture',
    inputEvidenceCount: 1,
    ownerStatementPresent: false,
    recommendationKind: 'principle',
    confidence: 0.9,
    materialFingerprint,
    materialSummary: { inputEvidenceCount: 1, outputEvidenceCount: 1, ownerStatementPresent: false },
  };
  const appended = await stateManager.appendAdmissionEvaluation(candidateId, gateEvaluation);
  if (appended.status === 'refused') throw new Error(`gate evaluation fixture failed: ${appended.reason}`);
  const ok = await stateManager.updateAdmissionProcessing(candidateId, {
    state: 'awaiting_owner',
    attempts: 0,
    blockedReason: 'reuse_pending_owner',
  });
  if (!ok) throw new Error('park fixture failed');
}

async function admissionOf(candidateId: string) {
  const doc = await stateManager.getAdmissionDocument(candidateId);
  if (!doc.ok) throw new Error(`admission document unreadable: ${doc.reason}`);
  return doc.document;
}

function printedStdout(): string {
  return consoleLogSpy.mock.calls.map((args) => args.map(String).join(' ')).join('\n');
}

function printedJson(): unknown {
  return JSON.parse(printedStdout());
}

function candidateStatus(candidateId: string): string | null {
  const db = new Database(join(workspaceDir, '.pd', 'state.db'));
  try {
    const row = db.prepare('SELECT status FROM principle_candidates WHERE candidate_id = ?').get(candidateId) as { status: string } | undefined;
    return row?.status ?? null;
  } finally {
    db.close();
  }
}

describe('Phase 7.2 B2 — persisted reuse park: automatic replay + Owner release', () => {
  beforeEach(async () => {
    workspaceDir = join(process.env.TEMP ?? '.', `pd-park-release-${randomUUID()}`);
    mkdirSync(join(workspaceDir, '.pd'), { recursive: true });
    stateManager = new RuntimeStateManager({ workspaceDir });
    await stateManager.initialize();
    consoleLogSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    exitSpy = vi.spyOn(process, 'exit').mockImplementation((() => undefined) as () => never);
    mockResolveOwnerIdentity.mockReturnValue({ ownerId: 'owner-1', credentialId: 'cred-1', source: 'file' });
  });

  afterEach(() => {
    consoleLogSpy.mockRestore();
    consoleErrorSpy.mockRestore();
    exitSpy.mockRestore();
    try { stateManager.close(); } catch { /* best effort */ }
    try { rmSync(workspaceDir, { recursive: true, force: true }); } catch { /* best effort */ }
    mockResolveOwnerIdentity.mockReset();
  });

  it('the REAL intake handler replays a persisted park — no create even with the gate unconfigured', async () => {
    const candidateId = await seedPrincipleCandidate();
    await parkCandidate(candidateId);

    await handleCandidateIntake({ candidateId, workspace: workspaceDir, json: true });

    expect(exitSpy).not.toHaveBeenCalled();
    const parsed = printedJson() as { status: string; reason: string; nextAction: string };
    expect(parsed.status).toBe('review_required');
    expect(parsed.reason).toBe('reuse_review_required');
    expect(parsed.nextAction).toContain('pd candidate review --candidate-id');

    // Nothing was created, nothing consumed, the park survived verbatim.
    expect(candidateStatus(candidateId)).toBe('pending');
    const principles = loadLedger(join(workspaceDir, '.state')).tree.principles;
    expect(Object.keys(principles)).toHaveLength(0);
    expect((await admissionOf(candidateId))?.processing).toMatchObject({
      state: 'awaiting_owner',
      blockedReason: 'reuse_pending_owner',
    });
  });

  it('T-P5a: --decide reuse releases the park with a durable audit and resolves via reuseEvidence', async () => {
    const existing = makePrinciple();
    addPrincipleToLedger(join(workspaceDir, '.state'), existing);
    const candidateId = await seedPrincipleCandidate();
    await parkCandidate(candidateId);

    await handleCandidateReview({
      candidateId,
      workspace: workspaceDir,
      decide: 'reuse',
      principleId: existing.id,
      reason: 'owner confirms the duplicate mapping',
      json: true,
    });

    expect(exitSpy).not.toHaveBeenCalled();

    // 1. The release audit is durable and identifies the real operator.
    const doc = await admissionOf(candidateId);
    const release = doc?.evaluations.find((e) => e.policyVersion === REUSE_PARK_RELEASE_POLICY_VERSION);
    expect(release).toBeDefined();
    expect(release?.decision).toBe('admitted');
    expect(release?.provenance).toContain('owner=owner-1');
    expect(release?.provenance).toContain('source=file');
    expect(release?.reason).toContain('owner confirms the duplicate mapping');

    // 2. The park is cleared (processing terminal).
    expect(doc?.processing?.state).toBe('complete');

    // 3. The resolution is the standard reuseEvidence mechanism.
    const stored = loadLedger(join(workspaceDir, '.state')).tree.principles[existing.id];
    expect(stored?.reuseEvidence).toHaveLength(1);
    expect(stored?.reuseEvidence?.[0]).toMatchObject({
      candidateId,
      decision: 'reuse',
      actor: { kind: 'owner', id: 'owner-1' },
    });
    expect(candidateStatus(candidateId)).toBe('consumed');
    expect(Object.keys(loadLedger(join(workspaceDir, '.state')).tree.principles)).toHaveLength(1);
  });

  it('T-P5b: --decide create releases the park with the same audit and creates the Principle', async () => {
    const candidateId = await seedPrincipleCandidate();
    await parkCandidate(candidateId);

    await handleCandidateReview({
      candidateId,
      workspace: workspaceDir,
      decide: 'create',
      reason: 'owner judges this a distinct principle',
      json: true,
    });

    expect(exitSpy).not.toHaveBeenCalled();

    const doc = await admissionOf(candidateId);
    const release = doc?.evaluations.find((e) => e.policyVersion === REUSE_PARK_RELEASE_POLICY_VERSION);
    expect(release?.decision).toBe('admitted');
    expect(release?.reason).toContain('reuse-park release (create)');
    expect(doc?.processing?.state).toBe('complete');

    const principles = loadLedger(join(workspaceDir, '.state')).tree.principles;
    expect(Object.keys(principles)).toHaveLength(1);
    expect(candidateStatus(candidateId)).toBe('consumed');
  });

  it('re-running a completed create decision is idempotent — exactly ONE release record', async () => {
    const candidateId = await seedPrincipleCandidate();
    await parkCandidate(candidateId);

    await handleCandidateReview({ candidateId, workspace: workspaceDir, decide: 'create', reason: 'owner decision', json: true });
    consoleLogSpy.mockClear();

    await handleCandidateReview({ candidateId, workspace: workspaceDir, decide: 'create', reason: 'owner decision', json: true });

    expect(exitSpy).not.toHaveBeenCalled();
    const parsed = printedJson() as { status: string };
    expect(parsed.status).toBe('already_consumed');

    const doc = await admissionOf(candidateId);
    const releases = doc?.evaluations.filter((e) => e.policyVersion === REUSE_PARK_RELEASE_POLICY_VERSION) ?? [];
    expect(releases).toHaveLength(1);
    // Second run: no park to release (processing already complete) — no_park.
    expect(doc?.processing?.state).toBe('complete');
    const principles = loadLedger(join(workspaceDir, '.state')).tree.principles;
    expect(Object.keys(principles)).toHaveLength(1);
  });

  it('B2.5 interplay: an Owner create on a byte-identical text resolves via the B1 guard and seeds NO independent chain', async () => {
    // The existing principle carries EXACTLY the candidate's text: the Owner
    // says create, but the write layer's exact-duplicate guard resolves the
    // candidate onto the existing principle (durable via reuseEvidence), and
    // the seed helper suppresses the independent Dreamer chain.
    const existing = makePrinciple({ text: CANDIDATE_TEXT });
    addPrincipleToLedger(join(workspaceDir, '.state'), existing);
    const candidateId = await seedPrincipleCandidate();
    await parkCandidate(candidateId);

    await handleCandidateReview({
      candidateId,
      workspace: workspaceDir,
      decide: 'create',
      reason: 'owner attempted an explicit create',
      json: true,
    });

    expect(exitSpy).not.toHaveBeenCalled();

    // The release audit landed and the park is cleared.
    const doc = await admissionOf(candidateId);
    expect(doc?.evaluations.some((e) => e.policyVersion === REUSE_PARK_RELEASE_POLICY_VERSION)).toBe(true);
    expect(doc?.processing?.state).toBe('complete');

    // B1: exactly ONE principle; the resolution is audited on it.
    const principles = loadLedger(join(workspaceDir, '.state')).tree.principles;
    expect(Object.keys(principles)).toHaveLength(1);
    expect(principles[existing.id]?.reuseEvidence?.[0]).toMatchObject({
      candidateId,
      actor: { kind: 'ai_owner', id: 'exact-dedupe-guard' },
    });
    expect(candidateStatus(candidateId)).toBe('consumed');

    // B2.5: no independent Dreamer chain; the suppression is reported.
    const parsed = printedJson() as { status: string; dreamerStatus?: string; dreamerReason?: string };
    expect(parsed.dreamerStatus).toBe('not_seeded');
    expect(parsed.dreamerReason).toContain('dreamer_seed_suppressed');
    const db = new Database(join(workspaceDir, '.pd', 'state.db'));
    try {
      const dreamerCount = db.prepare("SELECT COUNT(*) AS n FROM tasks WHERE task_kind = 'dreamer'").get() as { n: number };
      expect(dreamerCount.n).toBe(0);
    } finally {
      db.close();
    }
  });

  it('an unreadable admission document cannot smuggle a decision — the write gate refuses first', async () => {
    const candidateId = await seedPrincipleCandidate();
    await parkCandidate(candidateId);
    const db = new Database(join(workspaceDir, '.pd', 'state.db'));
    try {
      db.prepare('UPDATE principle_candidates SET admission_json = ? WHERE candidate_id = ?').run('{corrupt', candidateId);
    } finally {
      db.close();
    }

    await handleCandidateReview({ candidateId, workspace: workspaceDir, decide: 'create', reason: 'owner decision', json: true });

    expect(exitSpy).toHaveBeenCalled();
    expect(candidateStatus(candidateId)).toBe('pending');
    expect(Object.keys(loadLedger(join(workspaceDir, '.state')).tree.principles)).toHaveLength(0);
  });
});

describe('Phase 7.2 B2 — releaseReusePark unit contract (T-P6 audit failure + retry)', () => {
  it('no park → no_park (read-only)', async () => {
    const { releaseReusePark } = await import('../../src/services/reuse-park-release.js');
    const stateManagerStub = {
      getAdmissionDocument: vi.fn().mockResolvedValue({ ok: true, document: null }),
      appendAdmissionEvaluation: vi.fn(),
      updateAdmissionProcessing: vi.fn(),
    };
    const outcome = await releaseReusePark({
      stateManager: stateManagerStub as unknown as RuntimeStateManager,
      candidateId: 'c1',
      decide: 'create',
      reason: 'r',
      ownerId: 'owner-1',
      identitySource: 'file',
      rawRecommendationKind: 'principle',
    });
    expect(outcome).toEqual({ status: 'no_park' });
    expect(stateManagerStub.appendAdmissionEvaluation).not.toHaveBeenCalled();
  });

  it('audit append refused → failed, park intact, verdict must not proceed', async () => {
    const { releaseReusePark } = await import('../../src/services/reuse-park-release.js');
    const stateManagerStub = {
      getAdmissionDocument: vi.fn().mockResolvedValue({
        ok: true,
        document: { processing: { state: 'awaiting_owner', blockedReason: 'reuse_pending_owner' } },
      }),
      appendAdmissionEvaluation: vi.fn().mockResolvedValue({ status: 'refused', reason: 'admission_history_exceeded' }),
      updateAdmissionProcessing: vi.fn(),
    };
    const outcome = await releaseReusePark({
      stateManager: stateManagerStub as unknown as RuntimeStateManager,
      candidateId: 'c1',
      decide: 'create',
      reason: 'r',
      ownerId: 'owner-1',
      identitySource: 'env',
      rawRecommendationKind: 'principle',
    });
    expect(outcome).toMatchObject({ status: 'failed' });
    expect(stateManagerStub.updateAdmissionProcessing).not.toHaveBeenCalled();
  });

  it('audit persisted but park clear failed → failed (audit stays durable); retry reuses the entry and completes', async () => {
    const { releaseReusePark } = await import('../../src/services/reuse-park-release.js');
    const document = { processing: { state: 'awaiting_owner', blockedReason: 'reuse_pending_owner' } };
    let clearSucceeds = false;
    const appendedEntries: unknown[] = [];
    const stateManagerStub = {
      // The park is STILL persisted while the clear keeps failing — exactly
      // the partial-failure state the retry must recover from.
      getAdmissionDocument: vi.fn().mockResolvedValue({ ok: true, document }),
      appendAdmissionEvaluation: vi.fn().mockImplementation(async (_id: string, evaluation: { evaluationId: string }) => {
        appendedEntries.push(evaluation);
        return { status: 'appended', document: { currentEvaluationId: evaluation.evaluationId } };
      }),
      updateAdmissionProcessing: vi.fn().mockImplementation(async () => clearSucceeds),
    };
    const args = {
      stateManager: stateManagerStub as unknown as RuntimeStateManager,
      candidateId: 'c1',
      decide: 'create',
      reason: 'same owner reason',
      ownerId: 'owner-1',
      identitySource: 'env',
      rawRecommendationKind: 'principle',
    };

    const first = await releaseReusePark(args);
    expect(first).toMatchObject({ status: 'failed' }); // clear failed, audit durable

    clearSucceeds = true;
    const retry = await releaseReusePark(args);
    expect(retry).toMatchObject({ status: 'released' });
    expect(appendedEntries).toHaveLength(2); // audit re-attempted; same fingerprint → idempotent semantics upstream
  });
});
