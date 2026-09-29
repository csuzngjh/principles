import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { join } from 'path';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { randomUUID } from 'crypto';
import Database from 'better-sqlite3';
import { RuntimeStateManager } from '../../store/runtime-state-manager.js';
import { PrincipleTreeLedgerAdapter } from '../../adapter/principle-tree-ledger-adapter.js';
import { addPrincipleToLedger, loadLedger } from '../../../principle-tree-ledger.js';
import type { LedgerPrinciple } from '../../../principle-tree-ledger.js';
import { CandidateIntakeService } from '../../candidate-intake-service.js';
import type { CandidateIntakeServiceOptions } from '../../candidate-intake-service.js';
import { INTAKE_ERROR_CODES } from '../../candidate-intake.js';
import type { ReuseDecision, ReuseProposal } from '../reuse-proposal.js';

/**
 * PRI-917 Slice 2 — the reuse gate inside `CandidateIntakeService.intake()`.
 *
 * The gate sits between "we know what the candidate claims" and "we mint a new
 * canonical identity". These tests drive the REAL service against a REAL
 * state.db and a REAL ledger document; only the decision function is injected.
 */

let workspaceDir: string;
let stateManager: RuntimeStateManager;

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

async function seedPrincipleCandidate(
  opts: { text?: string; trigger?: string; action?: string; kind?: string; painId?: string } = {},
): Promise<string> {
  const candidateId = randomUUID();
  const artifactId = randomUUID();
  const now = new Date().toISOString();

  // principle_candidates has real FKs on tasks and runs, so seed both.
  const taskId = randomUUID();
  if (opts.painId !== undefined) {
    // Real production write path (Pain Diagnosis Persistence SPEC): the reuse
    // evidence resolves its painId through this table (PR3B Phase 2).
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

  const db = new Database(join(workspaceDir, '.pd', 'state.db'));
  try {
    // `artifacts` is the table intake reads from and the one
    // principle_candidates has an FK on (not pi_artifacts).
    db.prepare(`
      INSERT INTO artifacts (artifact_id, run_id, task_id, artifact_kind, content_json, created_at)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run(
      artifactId,
      runId,
      taskId,
      'principle',
      JSON.stringify({
        principleId: candidateId,
        text: opts.text ?? CANDIDATE_TEXT,
        triggerPattern: opts.trigger ?? CANDIDATE_TRIGGER,
        action: opts.action ?? CANDIDATE_ACTION,
      }),
      now,
    );
    db.prepare(`
      INSERT INTO principle_candidates
        (candidate_id, artifact_id, task_id, source_run_id, title, description, confidence,
         source_recommendation_json, idempotency_key, status, created_at, recommendation_kind)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?, ?)
    `).run(
      candidateId,
      artifactId,
      taskId,
      runId,
      '测试候选',
      opts.text ?? CANDIDATE_TEXT,
      0.9,
      JSON.stringify({
        text: opts.text ?? CANDIDATE_TEXT,
        triggerPattern: opts.trigger ?? CANDIDATE_TRIGGER,
        action: opts.action ?? CANDIDATE_ACTION,
      }),
      `${artifactId}::prompt`,
      now,
      opts.kind ?? 'principle',
    );
  } finally {
    db.close();
  }
  return candidateId;
}

function service(opts: {
  decision?: (p: ReuseProposal) => ReuseDecision;
  stateDir?: string;
  /** Pass `false` to omit reuseStateDir entirely (partial configuration). */
  omitStateDir?: boolean;
} = {}): CandidateIntakeService {
  const adapter = new PrincipleTreeLedgerAdapter({ stateDir: join(workspaceDir, '.state') });
  return new CandidateIntakeService({
    stateManager,
    ledgerAdapter: adapter,
    ...(opts.decision ? { reuseDecision: opts.decision } : {}),
    ...(opts.omitStateDir ? {} : { reuseStateDir: opts.stateDir ?? join(workspaceDir, '.state') }),
  });
}


/**
 * A SPEC §11-shaped reuse decision (PR3B Phase 2): the verdict now carries the
 * accountability fields that are materialised verbatim into reuseEvidence.
 */
function reuseOf(
  principleId: string,
  overrides: Partial<Extract<ReuseDecision, { decision: 'reuse' }>> = {},
): ReuseDecision {
  return {
    decision: 'reuse',
    selectedPrincipleId: principleId,
    actor: { kind: 'owner', id: 'owner-1' },
    reason: 'existing principle already covers this behavioral demand',
    decidedAt: '2026-09-29T00:00:00.000Z',
    ...overrides,
  };
}

/** Answers `reuse` on the top proposal entry; throws if the proposal is empty. */
function reuseFirstProposal(p: ReuseProposal): ReuseDecision {
  const [first] = p.candidates;
  if (!first) throw new Error('expected at least one reuse candidate in the proposal');
  return reuseOf(first.principleId);
}

beforeEach(async () => {
  workspaceDir = join(process.env.TEMP ?? '.', `pd-reuse-pr2-${randomUUID()}`);
  mkdirSync(join(workspaceDir, '.pd'), { recursive: true });
  stateManager = new RuntimeStateManager({ workspaceDir });
  await stateManager.initialize();
});

afterEach(() => {
  try { stateManager.close(); } catch { /* best effort */ }
  try { rmSync(workspaceDir, { recursive: true, force: true }); } catch { /* best effort */ }
});

function ledgerEntryCount(): number {
  try {
    const raw = readFileSync(join(workspaceDir, '.state', 'principle_training_state.json'), 'utf-8');
    return Object.keys(JSON.parse(raw)._tree.principles).length;
  } catch {
    return 0;
  }
}

function ledgerPath(): string {
  return join(workspaceDir, '.state', 'principle_training_state.json');
}

function ledgerExists(): boolean {
  return existsSync(ledgerPath());
}

// ---------------------------------------------------------------------------
// T1 — no credible existing principle: intake proceeds to create
// ---------------------------------------------------------------------------

describe('T1 — no matching principle still creates', () => {
  it('writes exactly one new Principle when the ledger holds nothing credible', async () => {
    addPrincipleToLedger(join(workspaceDir, '.state'), makePrinciple({
      text: '视频导出后比对音轨波形峰值与时间轴偏移量。',
      triggerPattern: '渲染收尾阶段',
      action: '导出后统计偏移',
    }));
    const candidateId = await seedPrincipleCandidate();

    const result = await service({ decision: () => ({ decision: 'create' }) }).intake(candidateId);

    expect(result.outcome).toBe('ledger_entry');
    if (result.outcome !== 'ledger_entry') throw new Error('expected a ledger write');
    expect(result.written).toBe(true);
    expect(result.reuseCheck).toBe('no_candidates');
  });

  it('an empty ledger creates without ever asking for a decision', async () => {
    const candidateId = await seedPrincipleCandidate();
    let asked = false;
    const result = await service({
      decision: () => { asked = true; return { decision: 'create' }; },
    }).intake(candidateId);
    expect(asked).toBe(false);
    if (result.outcome !== 'ledger_entry') throw new Error('expected a ledger write');
    expect(result.reuseCheck).toBe('no_candidates');
  });
});

// ---------------------------------------------------------------------------
// T2 — a credible proposal is surfaced to the decision function
// ---------------------------------------------------------------------------

describe('T2 — the proposal is visible to the Owner', () => {
  it('presents a bounded, explainable proposal of existing principles', async () => {
    addPrincipleToLedger(join(workspaceDir, '.state'), makePrinciple());
    addPrincipleToLedger(join(workspaceDir, '.state'), makePrinciple());
    const candidateId = await seedPrincipleCandidate();

    const seen: ReuseProposal[] = [];
    await service({
      decision: (p) => { seen.push(p); return { decision: 'create' }; },
    }).intake(candidateId);

    expect(seen).toHaveLength(1);
    const [proposal] = seen;
    if (!proposal) throw new Error('expected the decision function to receive a proposal');
    expect(proposal.candidateId).toBe(candidateId);
    expect(proposal.status).toBe('pending');
    expect(proposal.candidates.length).toBeGreaterThan(0);
    expect(proposal.candidates.length).toBeLessThanOrEqual(3);
    for (const entry of proposal.candidates) {
      expect(entry.principleId).toMatch(/^[0-9a-f-]{36}$/);
      expect(entry.score).toBeGreaterThan(0);
      expect(entry.reasons.length).toBeGreaterThan(0);
    }
  });

  it('does not build a proposal at all when no decision function is injected (today\'s production shape)', async () => {
    addPrincipleToLedger(join(workspaceDir, '.state'), makePrinciple());
    const candidateId = await seedPrincipleCandidate();

    const result = await new CandidateIntakeService({
      stateManager,
      ledgerAdapter: new PrincipleTreeLedgerAdapter({ stateDir: join(workspaceDir, '.state') }),
    }).intake(candidateId);

    expect(result.outcome).toBe('ledger_entry');
    if (result.outcome !== 'ledger_entry') throw new Error('expected a ledger write');
    // Observable, so "no gate" can never be mistaken for "no duplicate found".
    expect(result.reuseCheck).toBe('not_configured');
  });
});

// ---------------------------------------------------------------------------
// T3 — Owner chooses create: behaviour identical to the old flow
// ---------------------------------------------------------------------------

describe('T3 — create decision matches the previous behaviour', () => {
  it('writes a new Principle and reports the decision explicitly', async () => {
    addPrincipleToLedger(join(workspaceDir, '.state'), makePrinciple());
    const candidateId = await seedPrincipleCandidate();

    const result = await service({ decision: () => ({ decision: 'create' }) }).intake(candidateId);

    expect(result.outcome).toBe('ledger_entry');
    if (result.outcome !== 'ledger_entry') throw new Error('expected a ledger write');
    expect(result.written).toBe(true);
    expect(result.reuseCheck).toBe('create_decided');
    // Same entry shape as before the gate existed.
    expect(result.entry.sourceRef).toBe(`candidate://${candidateId}`);
    expect(result.entry.status).toBe('probation');
  });
});

// ---------------------------------------------------------------------------
// T4 — Owner chooses reuse: no new Principle is created
// ---------------------------------------------------------------------------

describe('T4 — reuse decision creates nothing', () => {
  it('returns an explicit reuse refusal and writes no ledger entry', async () => {
    const existing = makePrinciple();
    addPrincipleToLedger(join(workspaceDir, '.state'), existing);
    const before = ledgerEntryCount();
    const candidateId = await seedPrincipleCandidate({ painId: 'pain-t4' });

    const result = await service({
      decision: (p) => {
        const [first] = p.candidates;
        if (!first) throw new Error('expected at least one reuse candidate');
        return reuseOf(first.principleId);
      },
    }).intake(candidateId);

    expect(result.outcome).toBe('refused');
    if (result.outcome !== 'refused') throw new Error('expected a reuse refusal');
    expect(result.reason).toBe('reuse_selected');
    expect(result.selectedPrincipleId).toBe(existing.id);
    expect(result.reuseProposal?.status).toBe('pending');
    expect(result.message).toContain(existing.id);
    // PR3B Phase 2: the verdict is durably materialised as evidence.
    expect(result.reuseEvidence).toMatchObject({ candidateId, decision: 'reuse' });

    // The ledger is untouched — no new UUID, no new entry.
    expect(ledgerEntryCount()).toBe(before);
  });

  it('fails closed when the decision selects a principle outside the proposal (never degrades to create)', async () => {
    addPrincipleToLedger(join(workspaceDir, '.state'), makePrinciple());
    const candidateId = await seedPrincipleCandidate();
    const before = ledgerEntryCount();

    await expect(
      service({ decision: () => reuseOf(randomUUID()) }).intake(candidateId),
    ).rejects.toMatchObject({
      code: INTAKE_ERROR_CODES.REUSE_CHECK_FAILED,
      context: { reason: 'selected_principle_not_in_proposal' },
    });

    expect(ledgerEntryCount()).toBe(before);
  });
});

// ---------------------------------------------------------------------------
// T5 — a failed reuse check must not silently create
// ---------------------------------------------------------------------------

describe('T5 — retrieval failure never manufactures a duplicate', () => {
  it('throws reuse_check_failed instead of writing when the ledger cannot be read', async () => {
    const candidateId = await seedPrincipleCandidate();
    // A CORRUPT ledger is the real unavailability case: the corpus exists but
    // cannot be read, so "no candidates" would be a lie.
    mkdirSync(join(workspaceDir, '.state'), { recursive: true });
    writeFileSync(ledgerPath(), '{ this is not json', 'utf8');

    await expect(
      service({ decision: () => ({ decision: 'create' }) }).intake(candidateId),
    ).rejects.toMatchObject({ code: INTAKE_ERROR_CODES.REUSE_CHECK_FAILED });
  });

  it('writes nothing after a failed check — the ledger is unchanged', async () => {
    const candidateId = await seedPrincipleCandidate();
    const corrupt = '{ this is not json';
    mkdirSync(join(workspaceDir, '.state'), { recursive: true });
    writeFileSync(ledgerPath(), corrupt, 'utf8');
    await expect(
      service({ decision: () => ({ decision: 'create' }) }).intake(candidateId),
    ).rejects.toMatchObject({ code: INTAKE_ERROR_CODES.REUSE_CHECK_FAILED });
    // Untouched: the failed check neither repaired nor extended the ledger.
    expect(readFileSync(ledgerPath(), 'utf8')).toBe(corrupt);
  });

  it('treats a MISSING ledger as an empty corpus, not a failure (nothing to reuse → create)', async () => {
    const candidateId = await seedPrincipleCandidate();
    expect(ledgerExists()).toBe(false);
    const result = await service({ decision: () => ({ decision: 'create' }) }).intake(candidateId);
    expect(result.outcome).toBe('ledger_entry');
    if (result.outcome !== 'ledger_entry') throw new Error('expected a ledger write');
    expect(result.reuseCheck).toBe('no_candidates');
  });
});

// ---------------------------------------------------------------------------
// PRI-917 hardening: the decision boundary and the configuration boundary
// must both fail closed. Every case below previously either wrote a duplicate
// or reported a disabled gate while running one.
// ---------------------------------------------------------------------------

describe('H1 — a malformed decision never becomes a create', () => {
  const malformed: [string, unknown][] = [
    ['null', null],
    ['undefined', undefined],
    ['empty object', {}],
    ['bare string', 'create'],
    ['wrong-cased value', { decision: 'REUSE' }],
    ['unknown decision', { decision: 'maybe' }],
    ['reuse without id', { decision: 'reuse' }],
    ['reuse with non-string id', { decision: 'reuse', selectedPrincipleId: 42 }],
    ['reuse without actor', { decision: 'reuse', selectedPrincipleId: 'some-id' }],
    ['reuse with invalid actor kind', { decision: 'reuse', selectedPrincipleId: 'some-id', actor: { kind: 'robot', id: 'x' } }],
    ['reuse without reason', { decision: 'reuse', selectedPrincipleId: 'some-id', actor: { kind: 'owner', id: 'o' } }],
    ['reuse with unparsable decidedAt', { decision: 'reuse', selectedPrincipleId: 'some-id', actor: { kind: 'owner', id: 'o' }, reason: 'r', decidedAt: 'not-a-date' }],
    ['array', []],
  ];

  it.each(malformed)('rejects %s with reuse_check_failed and writes nothing', async (_label, value) => {
    const existing = makePrinciple();
    addPrincipleToLedger(join(workspaceDir, '.state'), existing);
    const candidateId = await seedPrincipleCandidate();
    const before = ledgerEntryCount();

    await expect(
      service({ decision: () => value as ReuseDecision }).intake(candidateId),
    ).rejects.toMatchObject({ code: INTAKE_ERROR_CODES.REUSE_CHECK_FAILED });

    // The whole point: no new Principle, and the existing one untouched.
    expect(ledgerEntryCount()).toBe(before);
  });

  it('wraps a throwing decision function as reuse_check_failed', async () => {
    addPrincipleToLedger(join(workspaceDir, '.state'), makePrinciple());
    const candidateId = await seedPrincipleCandidate();
    const before = ledgerEntryCount();

    await expect(
      service({
        decision: () => { throw new Error('AI Owner timeout'); },
      }).intake(candidateId),
    ).rejects.toMatchObject({ code: INTAKE_ERROR_CODES.REUSE_CHECK_FAILED });

    expect(ledgerEntryCount()).toBe(before);
  });
});

describe('H2 — a half-configured gate is a configuration error, not a disabled one', () => {
  it('refuses when a decision function is supplied without a state dir', async () => {
    const existing = makePrinciple();
    addPrincipleToLedger(join(workspaceDir, '.state'), existing);
    const candidateId = await seedPrincipleCandidate();
    const before = ledgerEntryCount();

    await expect(
      service({ decision: () => ({ decision: 'create' }), omitStateDir: true }).intake(candidateId),
    ).rejects.toMatchObject({ code: INTAKE_ERROR_CODES.REUSE_CHECK_FAILED, context: { reason: 'reuse_gate_misconfigured' } });

    expect(ledgerEntryCount()).toBe(before);
  });

  it('still reports not_configured when the gate is genuinely absent', async () => {
    addPrincipleToLedger(join(workspaceDir, '.state'), makePrinciple());
    const candidateId = await seedPrincipleCandidate();

    const bare = new CandidateIntakeService({
      stateManager,
      ledgerAdapter: new PrincipleTreeLedgerAdapter({ stateDir: join(workspaceDir, '.state') }),
    });
    const result = await bare.intake(candidateId);
    expect(result.outcome).toBe('ledger_entry');
    if (result.outcome !== 'ledger_entry') throw new Error('expected the unchanged path');
    expect(result.reuseCheck).toBe('not_configured');
  });
});

describe('H3 — the reuse refusal tells the operator the truth', () => {
  it('never claims the candidate does not target the Principle Ledger', async () => {
    const existing = makePrinciple();
    addPrincipleToLedger(join(workspaceDir, '.state'), existing);
    const candidateId = await seedPrincipleCandidate({ painId: 'pain-h3' });

    const result = await service({
      decision: (p) => {
        const [first] = p.candidates;
        if (!first) throw new Error('expected a proposal');
        return reuseOf(first.principleId);
      },
    }).intake(candidateId);

    expect(result.outcome).toBe('refused');
    if (result.outcome !== 'refused') throw new Error('expected a reuse refusal');
    expect(result.reason).toBe('reuse_selected');
    expect(result.rawRecommendationKind).toBe('principle');
    // The decision is valid, so nothing is thrown and nothing is written.
    const lower = result.message.toLowerCase();
    expect(lower).not.toContain('does not target');
    expect(lower).not.toContain('non principle kind');
    expect(lower).toContain('no new principle was created');
    expect(result.message).toContain(existing.id);
  });

  it('reads the kind from the persisted candidate, not from caller configuration', async () => {
    // The service exposes NO reuseRecommendationKind option any more: a caller
    // cannot inject a second, drifting notion of the candidate's kind.
    const opts: CandidateIntakeServiceOptions = {
      stateManager,
      ledgerAdapter: new PrincipleTreeLedgerAdapter({ stateDir: join(workspaceDir, '.state') }),
      reuseDecision: () => ({ decision: 'create' }),
      reuseStateDir: join(workspaceDir, '.state'),
    };
    expect(Object.keys(opts)).not.toContain('reuseRecommendationKind');

    // ...and the gate still runs for a genuine principle candidate.
    const existing = makePrinciple();
    addPrincipleToLedger(join(workspaceDir, '.state'), existing);
    const candidateId = await seedPrincipleCandidate();
    const result = await new CandidateIntakeService(opts).intake(candidateId);
    expect(result.outcome).toBe('ledger_entry');
    if (result.outcome !== 'ledger_entry') throw new Error('expected a ledger write');
    expect(result.reuseCheck).toBe('create_decided');
  });
});

// ---------------------------------------------------------------------------
// PRI-917 PR3B Phase 2 — the reuse verdict is durable evidence
// ---------------------------------------------------------------------------

describe('PR3B Phase 2 — reuse_selected writes durable evidence', () => {
  it('Pain → candidate → REUSE: the evidence entry lands on the selected Principle', async () => {
    const existing = makePrinciple();
    addPrincipleToLedger(join(workspaceDir, '.state'), existing);
    const before = ledgerEntryCount();
    const candidateId = await seedPrincipleCandidate({ painId: 'pain-phase2-1' });

    const result = await service({ decision: reuseFirstProposal }).intake(candidateId);

    expect(result.outcome).toBe('refused');
    if (result.outcome !== 'refused' || result.reason !== 'reuse_selected') throw new Error('expected a reuse refusal');
    expect(result.reuseEvidence).toEqual({
      painId: 'pain-phase2-1',
      candidateId,
      decision: 'reuse',
      actor: { kind: 'owner', id: 'owner-1' },
      reason: 'existing principle already covers this behavioral demand',
      decidedAt: '2026-09-29T00:00:00.000Z',
    });

    // Persisted on the Principle, exactly as returned.
    const stored = loadLedger(join(workspaceDir, '.state')).tree.principles[existing.id];
    expect(stored?.reuseEvidence).toHaveLength(1);
    expect(stored?.reuseEvidence?.[0]).toEqual(result.reuseEvidence);
    // No new Principle, and the corpus itself unchanged in size.
    expect(ledgerEntryCount()).toBe(before);
  });

  it('replaying the same candidate returns the recorded resolution without re-asking the decision', async () => {
    const existing = makePrinciple();
    addPrincipleToLedger(join(workspaceDir, '.state'), existing);
    const candidateId = await seedPrincipleCandidate({ painId: 'pain-phase2-2' });

    let decisions = 0;
    const decisionService = service({
      decision: (p) => {
        decisions += 1;
        return reuseFirstProposal(p);
      },
    });

    const first = await decisionService.intake(candidateId);
    expect(decisions).toBe(1);
    if (first.outcome !== 'refused' || first.reason !== 'reuse_selected') throw new Error('expected a reuse refusal');

    const replay = await decisionService.intake(candidateId);
    // The decision function was NOT consulted again (INV-R07).
    expect(decisions).toBe(1);
    expect(replay.outcome).toBe('refused');
    if (replay.outcome !== 'refused' || replay.reason !== 'reuse_selected') throw new Error('expected a reuse refusal');
    expect(replay.selectedPrincipleId).toBe(existing.id);
    expect(replay.reuseEvidence).toEqual(first.reuseEvidence);
    expect(replay.message).toContain('INV-R07 replay');

    // Still exactly one evidence entry — the replay appended nothing.
    const stored = loadLedger(join(workspaceDir, '.state')).tree.principles[existing.id];
    expect(stored?.reuseEvidence).toHaveLength(1);
  });

  it('a replay is honoured even when the gate is not configured (no duplicate create)', async () => {
    const existing = makePrinciple();
    addPrincipleToLedger(join(workspaceDir, '.state'), existing);
    const candidateId = await seedPrincipleCandidate({ painId: 'pain-phase2-3' });

    const first = await service({ decision: reuseFirstProposal }).intake(candidateId);
    if (first.outcome !== 'refused') throw new Error('expected the first intake to resolve by reuse');

    // Gate absent entirely — the resolution is durable state, so the replay
    // must still return it instead of silently creating a Principle.
    const bare = new CandidateIntakeService({
      stateManager,
      ledgerAdapter: new PrincipleTreeLedgerAdapter({ stateDir: join(workspaceDir, '.state') }),
    });
    const replay = await bare.intake(candidateId);

    expect(replay.outcome).toBe('refused');
    if (replay.outcome !== 'refused' || replay.reason !== 'reuse_selected') throw new Error('expected a reuse replay');
    expect(replay.selectedPrincipleId).toBe(existing.id);
    expect(ledgerEntryCount()).toBe(1);
  });

  it('a different candidate reusing the same Principle appends a second evidence entry', async () => {
    const existing = makePrinciple();
    addPrincipleToLedger(join(workspaceDir, '.state'), existing);
    const candidate1 = await seedPrincipleCandidate({ painId: 'pain-phase2-4' });
    const candidate2 = await seedPrincipleCandidate({ painId: 'pain-phase2-5' });

    await service({ decision: reuseFirstProposal }).intake(candidate1);
    await service({ decision: reuseFirstProposal }).intake(candidate2);

    const stored = loadLedger(join(workspaceDir, '.state')).tree.principles[existing.id];
    expect(stored?.reuseEvidence).toHaveLength(2);
    expect(stored?.reuseEvidence?.map((e) => e.candidateId)).toEqual([candidate1, candidate2]);
    expect(stored?.reuseEvidence?.map((e) => e.painId)).toEqual(['pain-phase2-4', 'pain-phase2-5']);
  });

  it('reuse evidence never touches derivedFromPainIds (SPEC v0.2.1 §12)', async () => {
    const existing = makePrinciple({ derivedFromPainIds: ['untouched-provenance-candidate'] });
    addPrincipleToLedger(join(workspaceDir, '.state'), existing);
    const candidateId = await seedPrincipleCandidate({ painId: 'pain-phase2-6' });

    await service({ decision: reuseFirstProposal }).intake(candidateId);

    const stored = loadLedger(join(workspaceDir, '.state')).tree.principles[existing.id];
    expect(stored?.derivedFromPainIds).toEqual(['untouched-provenance-candidate']);
    // And no ledger principle claimed this candidate through the create-path
    // idempotency field either.
    const ledger = loadLedger(join(workspaceDir, '.state'));
    for (const principle of Object.values(ledger.tree.principles)) {
      expect(principle.derivedFromPainIds).not.toContain(candidateId);
    }
  });

  it('fails closed when the candidate has no persisted pain diagnosis (no fabricated painId)', async () => {
    const existing = makePrinciple();
    addPrincipleToLedger(join(workspaceDir, '.state'), existing);
    const before = ledgerEntryCount();
    const candidateId = await seedPrincipleCandidate(); // NO painId seeded

    await expect(
      service({ decision: reuseFirstProposal }).intake(candidateId),
    ).rejects.toMatchObject({
      code: INTAKE_ERROR_CODES.REUSE_CHECK_FAILED,
      context: { reason: 'reuse_pain_unresolvable' },
    });

    // Nothing recorded, nothing created.
    const stored = loadLedger(join(workspaceDir, '.state')).tree.principles[existing.id];
    expect(stored?.reuseEvidence).toBeUndefined();
    expect(ledgerEntryCount()).toBe(before);
  });

  it('an append failure at write time surfaces as reuse_check_failed and never repairs a corrupt file', async () => {
    const existing = makePrinciple();
    addPrincipleToLedger(join(workspaceDir, '.state'), existing);
    const candidateId = await seedPrincipleCandidate({ painId: 'pain-phase2-7' });

    // Sabotage the ledger at append time only (proposal and retrieval already
    // succeeded against the readable file): the append must fail loud, the
    // candidate must stay pending, and the corrupt file must NOT be replaced
    // by a near-empty ledger write.
    const ledgerFile = join(workspaceDir, '.state', 'principle_training_state.json');
    const realAdapter = new PrincipleTreeLedgerAdapter({ stateDir: join(workspaceDir, '.state') });
    const sabotagingService = new CandidateIntakeService({
      stateManager,
      ledgerAdapter: {
        writeProbationEntry: (entry) => realAdapter.writeProbationEntry(entry),
        existsForCandidate: (id) => realAdapter.existsForCandidate(id),
        findReuseResolutionForCandidate: (id) => realAdapter.findReuseResolutionForCandidate(id),
        appendReuseEvidence: (principleId, entry) => {
          writeFileSync(ledgerFile, '{ corrupt after proposal', 'utf8');
          return realAdapter.appendReuseEvidence(principleId, entry);
        },
      },
      reuseDecision: reuseFirstProposal,
      reuseStateDir: join(workspaceDir, '.state'),
    });

    await expect(sabotagingService.intake(candidateId)).rejects.toMatchObject({
      code: INTAKE_ERROR_CODES.REUSE_CHECK_FAILED,
    });
    expect(readFileSync(ledgerFile, 'utf8')).toBe('{ corrupt after proposal');
  });
});
