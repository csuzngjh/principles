/**
 * PRI-917 PR3A — `pd candidate review` real-stack CLI tests (cli-7).
 *
 * These drive the REAL handlers against a REAL workspace: real state.db
 * (RuntimeStateManager + seeded candidate rows), real ledger document, real
 * CandidateIntakeService → reuse gate → appendReuseEvidence chain. Only the
 * Owner-identity resolver is stubbed — identity is an environment input (it
 * would otherwise depend on the machine's ~/.pd/owner.json), and its own
 * resolution behaviour is covered by the PRI-578 tests.
 *
 * Covers the surface-audit acceptance matrix:
 *   1. read-only review shows the Top-K proposal (score/reasons/shared terms
 *      + existing Principle text/triggerPattern/action/status);
 *   2. --decide reuse → exit 0, candidate consumed, reuseEvidence persisted
 *      with the full §11 field set, resolution printed;
 *   3. --decide create → unchanged create behaviour (new ledger entry, consumed);
 *   4. missing Owner identity → fail closed, nothing written;
 *   5. --json output is pure JSON (cli-1);
 *   6. second reuse decision → INV-R07 replay: no duplicate evidence, no new
 *      Principle, replayed flag reported.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { join } from 'path';
import * as path from 'path';
import { mkdirSync, readFileSync, rmSync, existsSync, writeFileSync } from 'fs';
import * as yaml from 'js-yaml';
import { randomUUID } from 'crypto';
import Database from 'better-sqlite3';

const { mockResolveOwnerIdentity, mockResolveRuntimeAdapter, evaluationScript } = vi.hoisted(() => ({
  mockResolveOwnerIdentity: vi.fn(),
  mockResolveRuntimeAdapter: vi.fn(),
  evaluationScript: { outcomes: [] as unknown[] },
}));

vi.mock('@principles/core/runtime-v2', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  resolveOwnerIdentity: mockResolveOwnerIdentity,
}));

// The evaluation capability reaches its LLM ONLY through the resolver-provided
// PDRuntimeAdapter — mocking the resolver therefore mocks the entire evaluation
// execution while the review surface, the intake chain, and the ledger stay real.
vi.mock('../../src/services/runtime-adapter-resolver.js', () => ({
  resolveRuntimeAdapterFromConfig: mockResolveRuntimeAdapter,
}));

import type { PDRuntimeAdapter, RunHandle, RunStatus, RuntimeCapabilities, RuntimeArtifactRef, RuntimeHealth, StartRunInput, StructuredRunOutput } from '@principles/core/runtime-v2';
import { handleCandidateReview, handleCandidateIntake } from '../../src/commands/candidate.js';
import { RuntimeStateManager } from '@principles/core/runtime-v2';
import { addPrincipleToLedger, loadLedger } from '@principles/core/principle-tree-ledger';
import type { LedgerPrinciple } from '@principles/core/principle-tree-ledger';

let workspaceDir: string;
let stateManager: RuntimeStateManager;
let consoleLogSpy: ReturnType<typeof vi.spyOn>;
let consoleErrorSpy: ReturnType<typeof vi.spyOn>;
let exitSpy: ReturnType<typeof vi.spyOn>;

const CANDIDATE_TEXT = '任何结论必须由可观察证据背书，无查验则显式降级为推断。';
const CANDIDATE_TRIGGER = '在没有外部证据就做出确定性结论时';
const CANDIDATE_ACTION = '先核验可观察状态再断言';

function makePrinciple(overrides: Partial<LedgerPrinciple> = {}): LedgerPrinciple {
  return {
    id: randomUUID(),
    version: 1,
    text: CANDIDATE_TEXT,
    triggerPattern: CANDIDATE_TRIGGER,
    action: CANDIDATE_ACTION,
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

async function seedPrincipleCandidate(opts: { painId?: string } = {}): Promise<string> {
  const candidateId = randomUUID();
  const artifactId = randomUUID();
  const now = new Date().toISOString();

  const taskId = randomUUID();
  await stateManager.taskStore.createTask({
    taskId,
    taskKind: 'diagnostician',
    status: 'pending',
    attemptCount: 0,
    maxAttempts: 3,
    leaseOwner: undefined,
    leaseExpiresAt: undefined,
    lastError: undefined,
    inputRef: '',
    resultRef: '',
    diagnosticJson: undefined,
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
  });
  if (opts.painId !== undefined) {
    // Real pain_diagnoses write — the reuse evidence resolves its painId here.
    await stateManager.recordPainDiagnosis({
      painId: opts.painId,
      taskId,
      diagnosisId: `diag-${candidateId}`,
      category: 'People',
      rootCause: 'People: seeded diagnosis for reuse evidence',
      evidence: [],
      confidence: 0.9,
      artifactId,
    });
  }

  const db = new Database(join(workspaceDir, '.pd', 'state.db'));
  try {
    db.prepare(`
      INSERT INTO artifacts (artifact_id, run_id, task_id, artifact_kind, content_json, created_at)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run(
      artifactId,
      runId,
      taskId,
      'principle',
      JSON.stringify({
        text: CANDIDATE_TEXT,
        triggerPattern: CANDIDATE_TRIGGER,
        action: CANDIDATE_ACTION,
      }),
      now,
    );
    db.prepare(`
      INSERT INTO principle_candidates
        (candidate_id, artifact_id, task_id, source_run_id, title, description, confidence,
         source_recommendation_json, idempotency_key, status, created_at, recommendation_kind)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?, 'principle')
    `).run(
      candidateId,
      artifactId,
      taskId,
      runId,
      '测试候选',
      CANDIDATE_TEXT,
      0.9,
      JSON.stringify({
        text: CANDIDATE_TEXT,
        triggerPattern: CANDIDATE_TRIGGER,
        action: CANDIDATE_ACTION,
      }),
      `${artifactId}::prompt`,
      now,
    );
  } finally {
    db.close();
  }
  return candidateId;
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

function printedStdout(): string {
  return consoleLogSpy.mock.calls.map((args) => args.map(String).join(' ')).join('\n');
}

function printedJson(): unknown {
  return JSON.parse(printedStdout());
}

beforeEach(async () => {
  workspaceDir = join(process.env.TEMP ?? '.', `pd-review-pr3a-${randomUUID()}`);
  mkdirSync(join(workspaceDir, '.pd'), { recursive: true });
  stateManager = new RuntimeStateManager({ workspaceDir });
  await stateManager.initialize();

  consoleLogSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
  consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
  exitSpy = vi.spyOn(process, 'exit').mockImplementation((() => undefined) as () => never);
  // Default: an Owner IS registered (file source). Scenario 4 overrides this.
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

// ── Phase 3C-4: the semantic evaluation on the review surface ────────────────

interface ScriptedOutcome {
  payload?: unknown;
  failRun?: string;
}

class ScriptedEvaluationAdapter implements PDRuntimeAdapter {
  readonly startedRuns: StartRunInput[] = [];

  // eslint-disable-next-line @typescript-eslint/class-methods-use-this
  kind(): 'test-double' {
    return 'test-double';
  }

  // eslint-disable-next-line @typescript-eslint/class-methods-use-this
  async getCapabilities(): Promise<RuntimeCapabilities> {
    return {
      supportsStructuredJsonOutput: true,
      supportsToolUse: false,
      supportsWorkingDirectory: false,
      supportsModelSelection: false,
      supportsLongRunningSessions: false,
      supportsCancellation: true,
      supportsArtifactWriteBack: false,
      supportsConcurrentRuns: false,
      supportsStreaming: false,
    };
  }

  // eslint-disable-next-line @typescript-eslint/class-methods-use-this
  async healthCheck(): Promise<RuntimeHealth> {
    return { healthy: true, degraded: false, warnings: [], lastCheckedAt: '2026-09-29T00:00:00.000Z' };
  }

  async startRun(input: StartRunInput): Promise<RunHandle> {
    this.startedRuns.push(input);
    return { runId: `run-${this.startedRuns.length}`, runtimeKind: 'test-double', startedAt: '2026-09-29T00:00:00.000Z' };
  }

  async pollRun(runId: string): Promise<RunStatus> {
    const outcome = evaluationScript.outcomes[0] as ScriptedOutcome | undefined;
    if (outcome?.failRun) {
      return { runId, status: 'failed', reason: outcome.failRun };
    }
    return { runId, status: 'succeeded' };
  }

  async fetchOutput(runId: string): Promise<StructuredRunOutput | null> {
    const outcome = evaluationScript.outcomes.shift() as ScriptedOutcome | undefined;
    if (!outcome || outcome.failRun || outcome.payload === undefined) {
      return null;
    }
    return { runId, payload: outcome.payload };
  }

  // eslint-disable-next-line @typescript-eslint/class-methods-use-this
  async cancelRun(runId: string): Promise<void> {
    void runId;
  }

  // eslint-disable-next-line @typescript-eslint/class-methods-use-this
  async fetchArtifacts(runId: string): Promise<RuntimeArtifactRef[]> {
    void runId;
    return [];
  }
}

function scriptEvaluation(outcomes: unknown[]): void {
  evaluationScript.outcomes = outcomes;
  mockResolveRuntimeAdapter.mockImplementation(() => new ScriptedEvaluationAdapter());
}

function makeResolverThrow(): void {
  mockResolveRuntimeAdapter.mockImplementation(() => {
    throw new Error('auth_missing: reuse evaluation profile has no API key');
  });
}

/** Write a workspace config that enables the evaluation capability on pd.custom. */
function writeEvaluationConfig(workspace: string): void {
  writeFileSync(
    path.join(workspace, '.pd', 'config.yaml'),
    yaml.dump({
      version: 1,
      features: {
        prompt: { category: 'core', enabled: true },
        code_tool_hook: { category: 'core', enabled: true },
        defer_archive: { category: 'core', enabled: true },
      },
      runtimeProfiles: {
        'openclaw.default': { type: 'openclaw', source: 'default' },
        'pd.custom': { type: 'pi-ai', provider: 'test', model: 'test-model', apiKeyEnv: 'PD_TEST_EVAL_KEY' },
      },
      internalAgents: { defaultRuntime: 'pd.custom', agents: { diagnostician: { enabled: true } } },
      reuseEvaluation: { enabled: true, runtimeProfile: 'pd.custom', timeoutMs: 5000 },
    }),
    'utf8',
  );
  process.env.PD_TEST_EVAL_KEY = 'test-key';
}

// ── 1. read-only review ──────────────────────────────────────────────────────

describe('review (read-only) — the proposal is visible to the Owner', () => {
  it('shows candidate, Top-K proposal with score/reasons, and the existing Principle content', async () => {
    const existing = makePrinciple();
    addPrincipleToLedger(join(workspaceDir, '.state'), existing);
    const candidateId = await seedPrincipleCandidate({ painId: 'pain-review-1' });

    await handleCandidateReview({ candidateId, workspace: workspaceDir });

    const out = printedStdout();
    expect(out).toContain('Principle Candidate Review');
    expect(out).toContain(existing.id);
    expect(out).toContain('score');
    expect(out).toContain(existing.text);
    expect(out).toContain(CANDIDATE_TRIGGER);
    expect(out).toContain('reuse');
    // Read-only: nothing was persisted.
    expect(candidateStatus(candidateId)).toBe('pending');
    const stored = loadLedger(join(workspaceDir, '.state')).tree.principles[existing.id];
    expect(stored?.reuseEvidence).toBeUndefined();
  });

  it('--json emits pure, parseable JSON with the enriched proposal (cli-1)', async () => {
    const existing = makePrinciple();
    addPrincipleToLedger(join(workspaceDir, '.state'), existing);
    const candidateId = await seedPrincipleCandidate({ painId: 'pain-review-2' });

    await handleCandidateReview({ candidateId, workspace: workspaceDir, json: true });

    const parsed = printedJson() as {
      candidateId: string;
      status: string;
      taskId: string;
      recommendationKindEligible: boolean;
      proposal: { status: string; candidates: Array<{ principleId: string; score: number; reasons: string[]; existingPrinciple: { text: string; status: string } }> };
    };
    expect(parsed.candidateId).toBe(candidateId);
    expect(parsed.status).toBe('pending');
    expect(parsed.taskId).toBeTruthy();
    expect(parsed.recommendationKindEligible).toBe(true);
    expect(parsed.proposal.status).toBe('pending');
    expect(parsed.proposal.candidates.length).toBeGreaterThan(0);
    const [first] = parsed.proposal.candidates;
    if (!first) throw new Error('expected a proposal entry');
    expect(first.principleId).toBe(existing.id);
    expect(first.score).toBeGreaterThan(0);
    expect(first.reasons.length).toBeGreaterThan(0);
    expect(first.existingPrinciple.text).toBe(CANDIDATE_TEXT);
    expect(first.existingPrinciple.status).toBe('active');
  });

  it('a non-principle candidate has no proposal (fail-closed kind view)', async () => {
    const candidateId = await seedPrincipleCandidate();
    const db = new Database(join(workspaceDir, '.pd', 'state.db'));
    try {
      db.prepare("UPDATE principle_candidates SET recommendation_kind = 'rule' WHERE candidate_id = ?").run(candidateId);
    } finally {
      db.close();
    }

    await handleCandidateReview({ candidateId, workspace: workspaceDir, json: true });

    const parsed = printedJson() as { recommendationKindEligible: boolean; rawRecommendationKind: string };
    expect(parsed.recommendationKindEligible).toBe(false);
    expect(parsed.rawRecommendationKind).toBe('rule');
  });
});

// ── 2/4/6. decide reuse ─────────────────────────────────────────────────────

describe('review --decide reuse — the verdict is durably recorded', () => {
  it('writes the §11 evidence via the intake chain, consumes the candidate, and reports the resolution', async () => {
    const existing = makePrinciple();
    addPrincipleToLedger(join(workspaceDir, '.state'), existing);
    const candidateId = await seedPrincipleCandidate({ painId: 'pain-decide-1' });

    await handleCandidateReview({
      candidateId,
      workspace: workspaceDir,
      decide: 'reuse',
      principleId: existing.id,
      reason: '已有原则已覆盖该行为要求',
      json: true,
    });

    expect(exitSpy).not.toHaveBeenCalled();
    const parsed = printedJson() as {
      status: string; selectedPrincipleId: string; replayed: boolean; candidateStatus: string;
      reuseEvidence: { painId: string; candidateId: string; decision: string; actor: { kind: string; id: string }; reason: string; decidedAt: string };
    };
    expect(parsed.status).toBe('reused');
    expect(parsed.selectedPrincipleId).toBe(existing.id);
    expect(parsed.replayed).toBe(false);
    expect(parsed.candidateStatus).toBe('consumed');
    // C2: the candidate reached consumed, through the guarded mechanism.
    expect(candidateStatus(candidateId)).toBe('consumed');
    // The §11 field set, verbatim on the Principle.
    const stored = loadLedger(join(workspaceDir, '.state')).tree.principles[existing.id];
    expect(stored?.reuseEvidence).toHaveLength(1);
    const evidence = stored?.reuseEvidence?.[0];
    expect(evidence).toMatchObject({
      painId: 'pain-decide-1',
      candidateId,
      decision: 'reuse',
      actor: { kind: 'owner', id: 'owner-1' },
      reason: '已有原则已覆盖该行为要求',
    });
    expect(typeof evidence?.decidedAt).toBe('string');
    expect(Number.isNaN(Date.parse(evidence?.decidedAt ?? ''))).toBe(false);
    // Exactly one ledger principle — reuse created nothing.
    expect(Object.keys(loadLedger(join(workspaceDir, '.state')).tree.principles)).toHaveLength(1);
  });

  it('fails closed when the Owner identity is unresolvable — nothing is written', async () => {
    const existing = makePrinciple();
    addPrincipleToLedger(join(workspaceDir, '.state'), existing);
    const candidateId = await seedPrincipleCandidate({ painId: 'pain-decide-2' });
    mockResolveOwnerIdentity.mockReturnValue({ ownerId: null, credentialId: null, source: 'none' });

    await handleCandidateReview({
      candidateId,
      workspace: workspaceDir,
      decide: 'reuse',
      principleId: existing.id,
      reason: 'r',
      json: true,
    });

    expect(exitSpy).toHaveBeenCalledWith(1);
    const parsed = printedJson() as { status: string; error: string; nextAction: string };
    expect(parsed.status).toBe('refused');
    expect(parsed.error).toContain('Owner identity');
    expect(parsed.nextAction).toBeTruthy();
    // Nothing decided, nothing persisted.
    expect(candidateStatus(candidateId)).toBe('pending');
    const stored = loadLedger(join(workspaceDir, '.state')).tree.principles[existing.id];
    expect(stored?.reuseEvidence).toBeUndefined();
  });

  it('replaying the same reuse decision returns the recorded resolution without duplicating anything (INV-R07)', async () => {
    const existing = makePrinciple();
    addPrincipleToLedger(join(workspaceDir, '.state'), existing);
    const candidateId = await seedPrincipleCandidate({ painId: 'pain-decide-3' });

    await handleCandidateReview({
      candidateId, workspace: workspaceDir, decide: 'reuse', principleId: existing.id, reason: 'first verdict', json: true,
    });

    // Second decision run for the SAME candidate: intake step 2b short-circuits.
    consoleLogSpy.mockClear();
    exitSpy.mockClear();
    await handleCandidateReview({
      candidateId, workspace: workspaceDir, decide: 'reuse', principleId: existing.id, reason: 'second wording', json: true,
    });

    expect(exitSpy).not.toHaveBeenCalled();
    const parsed = printedJson() as { status: string; replayed: boolean; reuseEvidence: { reason: string } };
    expect(parsed.status).toBe('reused');
    expect(parsed.replayed).toBe(true);
    // The FIRST wording is preserved — a replay never overwrites the record.
    expect(parsed.reuseEvidence.reason).toBe('first verdict');
    const stored = loadLedger(join(workspaceDir, '.state')).tree.principles[existing.id];
    expect(stored?.reuseEvidence).toHaveLength(1);
    expect(Object.keys(loadLedger(join(workspaceDir, '.state')).tree.principles)).toHaveLength(1);
  });
});

// ── 3. decide create ─────────────────────────────────────────────────────────

describe('review --decide create — unchanged create behaviour', () => {
  it('creates a new Principle through the existing path and consumes the candidate', async () => {
    const existing = makePrinciple({
      text: '视频导出后比对音轨波形峰值与时间轴偏移量。',
      triggerPattern: '渲染收尾阶段',
      action: '导出后统计偏移',
    });
    addPrincipleToLedger(join(workspaceDir, '.state'), existing);
    const candidateId = await seedPrincipleCandidate({ painId: 'pain-create-1' });

    await handleCandidateReview({
      candidateId, workspace: workspaceDir, decide: 'create', reason: '现有原则不覆盖此场景', json: true,
    });

    expect(exitSpy).not.toHaveBeenCalled();
    const parsed = printedJson() as { decision: string; ledgerEntryId: string; status: string };
    expect(parsed.decision).toBe('create');
    expect(parsed.status).toBe('consumed');
    expect(candidateStatus(candidateId)).toBe('consumed');
    // A NEW principle was created; the existing one untouched, no evidence.
    const principles = loadLedger(join(workspaceDir, '.state')).tree.principles;
    expect(Object.keys(principles)).toHaveLength(2);
    expect(principles[existing.id]?.reuseEvidence).toBeUndefined();
    const created = Object.values(principles).find((p) => p.id !== existing.id);
    expect(created?.derivedFromPainIds).toContain(candidateId);
  });
});

// ── C1: plain intake honours an already-recorded resolution ─────────────────

describe('pd candidate intake after a reuse resolution (C1/C2 replay)', () => {
  it('reports the resolution with exit 0 and does NOT misreport it as a refused write', async () => {
    const existing = makePrinciple();
    addPrincipleToLedger(join(workspaceDir, '.state'), existing);
    const candidateId = await seedPrincipleCandidate({ painId: 'pain-intake-replay-1' });

    await handleCandidateReview({
      candidateId, workspace: workspaceDir, decide: 'reuse', principleId: existing.id, reason: 'resolved via review', json: true,
    });
    consoleLogSpy.mockClear();
    exitSpy.mockClear();

    // Gate-less intake on the resolved candidate: step 2b returns the resolution.
    await handleCandidateIntake({ candidateId, workspace: workspaceDir, json: true });

    expect(exitSpy).not.toHaveBeenCalled();
    const out = printedStdout();
    expect(out).not.toContain('write refused');
    expect(out).not.toContain('input_invalid');
    const parsed = JSON.parse(out) as { status: string; replayed: boolean; selectedPrincipleId: string };
    expect(parsed.status).toBe('reused');
    expect(parsed.replayed).toBe(true);
    expect(parsed.selectedPrincipleId).toBe(existing.id);
    const stored = loadLedger(join(workspaceDir, '.state')).tree.principles[existing.id];
    expect(stored?.reuseEvidence).toHaveLength(1);
  });
});

// ── guard: no ledger file is fabricated by a decision on a missing workspace ─

describe('review decision on an empty workspace', () => {
  it('fails loudly when the candidate does not exist', async () => {
    await handleCandidateReview({ candidateId: 'no-such-candidate', workspace: workspaceDir });
    expect(exitSpy).toHaveBeenCalledWith(1);
    expect(consoleErrorSpy.mock.calls.map((a) => String(a)).join('\n')).toContain('Candidate not found');
    expect(existsSync(join(workspaceDir, '.state', 'principle_training_state.json'))).toBe(false);
  });
});

// ── PRI-917 v0.3.2 Phase 3C-4 — semantic evaluation on the review surface ────

function ledgerBytes(): string {
  return readFileSync(join(workspaceDir, '.state', 'principle_training_state.json'), 'utf8');
}

describe('Phase 3C-4 — semantic evaluation on the review surface', () => {
  it('shows the recommendation/rationale/confidence next to the lexical proposal (judge=reuse)', async () => {
    const existing = makePrinciple();
    addPrincipleToLedger(join(workspaceDir, '.state'), existing);
    const candidateId = await seedPrincipleCandidate({ painId: 'pain-3c4-1' });
    writeEvaluationConfig(workspaceDir);
    scriptEvaluation([
      { payload: { recommendation: 'reuse', selectedPrincipleId: existing.id, rationale: 'same experience, different wording', confidence: 0.88 } },
    ]);

    await handleCandidateReview({ candidateId, workspace: workspaceDir, json: true });

    const parsed = printedJson() as {
      evaluation: { status: string; recommendation: string; selectedPrincipleId: string; rationale: string; confidence: number };
      proposal: { candidates: Array<{ principleId: string; semanticMatch: boolean }> };
    };
    expect(parsed.evaluation).toEqual({
      status: 'recommended',
      recommendation: 'reuse',
      selectedPrincipleId: existing.id,
      rationale: 'same experience, different wording',
      confidence: 0.88,
    });
    const matched = parsed.proposal.candidates.find((c) => c.semanticMatch);
    expect(matched?.principleId).toBe(existing.id);
    // T7: the read-only review NEVER writes.
    const stored = loadLedger(join(workspaceDir, '.state')).tree.principles[existing.id];
    expect(stored?.reuseEvidence).toBeUndefined();
    expect(candidateStatus(candidateId)).toBe('pending');
  });

  it('T4 (Owner override create): evaluation recommends reuse, the Owner decides create — the Owner wins', async () => {
    const existing = makePrinciple();
    addPrincipleToLedger(join(workspaceDir, '.state'), existing);
    const candidateId = await seedPrincipleCandidate({ painId: 'pain-3c4-t4a' });
    writeEvaluationConfig(workspaceDir);
    scriptEvaluation([
      { payload: { recommendation: 'reuse', selectedPrincipleId: existing.id, rationale: 'judge says reuse', confidence: 0.95 } },
    ]);
    await handleCandidateReview({ candidateId, workspace: workspaceDir, json: true });
    consoleLogSpy.mockClear();

    // The Owner explicitly overrides with create.
    await handleCandidateReview({
      candidateId, workspace: workspaceDir, decide: 'create', reason: 'owner disagrees with the evaluation', json: true,
    });

    expect(exitSpy).not.toHaveBeenCalled();
    const parsed = printedJson() as { decision: string; status: string };
    expect(parsed.decision).toBe('create');
    expect(parsed.status).toBe('consumed');
    // A NEW principle exists; the evaluation's proposed target has NO evidence.
    const principles = loadLedger(join(workspaceDir, '.state')).tree.principles;
    expect(Object.keys(principles)).toHaveLength(2);
    expect(principles[existing.id]?.reuseEvidence).toBeUndefined();
    expect(candidateStatus(candidateId)).toBe('consumed');
  });

  it('T4 (Owner override reuse): evaluation recommends create, the Owner decides reuse — the Owner wins', async () => {
    const existing = makePrinciple();
    addPrincipleToLedger(join(workspaceDir, '.state'), existing);
    const candidateId = await seedPrincipleCandidate({ painId: 'pain-3c4-t4b' });
    writeEvaluationConfig(workspaceDir);
    scriptEvaluation([
      { payload: { recommendation: 'create', rationale: 'judge says create', confidence: 0.7 } },
    ]);
    await handleCandidateReview({ candidateId, workspace: workspaceDir, json: true });
    consoleLogSpy.mockClear();

    await handleCandidateReview({
      candidateId, workspace: workspaceDir, decide: 'reuse', principleId: existing.id, reason: 'owner sees the coverage', json: true,
    });

    expect(exitSpy).not.toHaveBeenCalled();
    const parsed = printedJson() as { status: string; selectedPrincipleId: string };
    expect(parsed.status).toBe('reused');
    expect(parsed.selectedPrincipleId).toBe(existing.id);
    const stored = loadLedger(join(workspaceDir, '.state')).tree.principles[existing.id];
    expect(stored?.reuseEvidence).toHaveLength(1);
    expect(candidateStatus(candidateId)).toBe('consumed');
  });

  it('T5: evaluation unavailable degrades observably and the CREATE capability is untouched', async () => {
    // Same wording as the candidate so the LEXICAL shortlist is non-empty —
    // the judge must actually be reached (and fail) for this scenario.
    const existing = makePrinciple();
    addPrincipleToLedger(join(workspaceDir, '.state'), existing);
    const candidateId = await seedPrincipleCandidate({ painId: 'pain-3c4-t5' });
    writeEvaluationConfig(workspaceDir);
    makeResolverThrow();

    await handleCandidateReview({ candidateId, workspace: workspaceDir, json: true });

    expect(exitSpy).not.toHaveBeenCalled();
    const parsed = printedJson() as {
      evaluation: { status: string; reason: string };
      proposal: { candidates: unknown[] };
    };
    expect(parsed.evaluation.status).toBe('unavailable');
    expect(parsed.evaluation.reason).toContain('auth_missing');
    expect(parsed.proposal.candidates.length).toBeGreaterThan(0);
    const before = ledgerBytes();

    // SPEC §9 cuts both ways: a failed evaluation must not silently BLOCK
    // creation either — the create capability stays fully intact.
    consoleLogSpy.mockClear();
    await handleCandidateIntake({ candidateId, workspace: workspaceDir, json: true });
    expect(exitSpy).not.toHaveBeenCalled();
    const intake = JSON.parse(printedStdout()) as { status: string };
    expect(['consumed', 'reused']).toContain(intake.status);
    expect(candidateStatus(candidateId)).toBe('consumed');
    expect(ledgerBytes()).not.toBe(before);
  });

  it('T7: review leaves the ledger byte-identical whether the judge succeeds or fails', async () => {
    const existing = makePrinciple();
    addPrincipleToLedger(join(workspaceDir, '.state'), existing);
    const candidateId = await seedPrincipleCandidate({ painId: 'pain-3c4-t7' });
    writeEvaluationConfig(workspaceDir);
    const before = ledgerBytes();

    scriptEvaluation([
      { payload: { recommendation: 'reuse', selectedPrincipleId: existing.id, rationale: 'r', confidence: 0.9 } },
    ]);
    await handleCandidateReview({ candidateId, workspace: workspaceDir, json: true });
    expect(ledgerBytes()).toBe(before);

    makeResolverThrow();
    await handleCandidateReview({ candidateId, workspace: workspaceDir, json: true });
    expect(ledgerBytes()).toBe(before);
  });
});
