import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { join } from 'path';
import { existsSync, mkdirSync, readFileSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { randomUUID } from 'crypto';
import Database from 'better-sqlite3';
import { RuntimeStateManager } from '../store/runtime-state-manager.js';
import { PrincipleTreeLedgerAdapter } from '../adapter/principle-tree-ledger-adapter.js';
import { addPrincipleToLedger } from '../../principle-tree-ledger.js';
import { CandidateIntakeService } from '../candidate-intake-service.js';
import type { CandidateIntakeResult } from '../candidate-intake-service.js';
import { CandidateIntakeError, INTAKE_ERROR_CODES } from '../candidate-intake.js';
import { readDiagnosticianOutputFromEnvelope, type DiagnosticianOutputV2 } from '../diagnostician-output.js';
import type { RunExecutionStatus } from '../runtime-protocol.js';

/**
 * PRI-1146 / SPEC-PD-RULE-ASSOCIATION-005 v0.6 §4 — Diagnostician V2 Only.
 *
 * These tests drive the REAL `CandidateIntakeService.intake()` against a REAL
 * SQLite state.db and a REAL ledger document. They do not exercise a standalone
 * parser: every matrix row below goes through the production intake entry point,
 * which is where the V1 compatibility entrance was closed.
 *
 * Matrix (directive §4.4):
 *   - legal V2 Diagnostician            → PASS
 *   - V1 run.outputPayload              → REJECT
 *   - V1 artifact.contentJson           → REJECT
 *   - V1 sourceRecommendationJson       → REJECT
 *   - V1 description→text normalization → REJECT
 *   - recommendationRef not found       → REJECT
 *   - duplicate recommendationRef       → REJECT
 *   - run/artifact lineage mismatch     → REJECT
 *   - other legitimate historical source→ unchanged (legacy) behavior
 *   - every rejection                   → NO new ledger write, candidate preserved
 */

let workspaceDir: string;
let stateManager: RuntimeStateManager;

const V2_TEXT = '证据不足时必须显式降级为推断，不得输出确定性结论。';
const V2_TRIGGER = '在没有外部证据时下确定性结论';
const V2_ACTION = '先核验可观察证据再断言';
const CANDIDATE_DESCRIPTION = '候选人描述（不得被用于构造 Ledger 正文）';
const LEGACY_TEXT = '历史非 Diagnostician 来源的推荐正文';

type V2Rec = DiagnosticianOutputV2['recommendations'][number];

function makeV2Rec(overrides: Partial<V2Rec> = {}): V2Rec {
  return {
    kind: 'principle',
    description: V2_TEXT,
    // P1-3: kind:"principle" requires abstractedPrinciple structurally.
    abstractedPrinciple: V2_TEXT,
    triggerPattern: V2_TRIGGER,
    action: V2_ACTION,
    recommendationRef: 'principle-1',
    ...overrides,
  } as V2Rec;
}

function makeV2Output(overrides: Partial<DiagnosticianOutputV2> = {}): DiagnosticianOutputV2 {
  return {
    schemaVersion: 'diagnostician-output-v2',
    valid: true,
    diagnosisId: randomUUID(),
    summary: 'V2 provenance integration test',
    rootCause: 'People: evidence was ignored',
    violatedPrinciples: [],
    evidence: [{ sourceRef: 'input', note: 'owner evidence' }],
    confidence: 0.9,
    recommendations: [makeV2Rec()],
    ...overrides,
  };
}

/** The router artifact envelope: V2 output + the receipt keys the reader strips. */
function routerEnvelope(output: DiagnosticianOutputV2): Record<string, unknown> {
  return {
    ...output,
    trustedContextReceipt: { schemaVersion: 'router-context-v2' },
    associationValidation: { results: [] },
  };
}

interface SeedSpec {
  taskKind?: string;
  runStatus?: RunExecutionStatus;
  /** Serialized verbatim into runs.output_payload (omit for no payload). */
  runOutput?: unknown;
  runOutputRaw?: string;
  /** Serialized into artifacts.content_json (default: base output's router envelope). */
  artifactContent?: unknown;
  artifactContentRaw?: string;
  /** Point the artifact at another (FK-valid) task/run pair. */
  artifactTaskId?: string;
  artifactRunId?: string;
  /** Serialized into principle_candidates.source_recommendation_json. */
  sourceRec?: unknown;
  sourceRecRaw?: string;
  rawRecommendationKind?: string;
}

interface SeededCandidate {
  candidateId: string;
  taskId: string;
  runId: string;
  artifactId: string;
}

async function createTaskAndRun(
  taskKind: string,
  runStatus: RunExecutionStatus,
  outputPayload?: string,
): Promise<{ taskId: string; runId: string }> {
  const taskId = randomUUID();
  const runId = randomUUID();
  const now = new Date().toISOString();
  await stateManager.taskStore.createTask({
    taskId,
    taskKind,
    status: 'succeeded',
    attemptCount: 1,
    maxAttempts: 3,
    leaseOwner: undefined,
    leaseExpiresAt: undefined,
    lastError: undefined,
    inputRef: '',
    resultRef: '',
    diagnosticJson: undefined,
  });
  await stateManager.runStore.createRun({
    runId,
    taskId,
    runtimeKind: 'openclaw',
    attemptNumber: 1,
    executionStatus: runStatus,
    startedAt: now,
    endedAt: now,
    ...(outputPayload !== undefined ? { outputPayload } : {}),
  });
  return { taskId, runId };
}

async function seedCandidate(spec: SeedSpec = {}): Promise<SeededCandidate> {
  const candidateId = randomUUID();
  const artifactId = randomUUID();
  const now = new Date().toISOString();
  const baseOutput = makeV2Output();
  // A candidate's default artifact + source recommendation must describe the
  // SAME output the owning run persisted — otherwise a test that overrides only
  // runOutput would legitimately trip run_artifact_content_mismatch first.
  let runOutputValue: unknown;
  if (spec.runOutputRaw !== undefined) {
    try { runOutputValue = JSON.parse(spec.runOutputRaw); } catch { runOutputValue = undefined; }
  } else if (spec.runOutput !== undefined) {
    runOutputValue = spec.runOutput;
  }
  const owningOutput = readDiagnosticianOutputFromEnvelope(runOutputValue) ?? baseOutput;
  const owningRec = owningOutput.recommendations[0] ?? baseOutput.recommendations[0];

  const outputPayload = spec.runOutputRaw !== undefined
    ? spec.runOutputRaw
    : spec.runOutput !== undefined
      ? JSON.stringify(spec.runOutput)
      : undefined;
  const primary = await createTaskAndRun(
    spec.taskKind ?? 'diagnostician',
    spec.runStatus ?? 'succeeded',
    outputPayload,
  );

  const artifactContent = spec.artifactContentRaw !== undefined
    ? spec.artifactContentRaw
    : JSON.stringify(spec.artifactContent !== undefined ? spec.artifactContent : routerEnvelope(owningOutput));
  const sourceRec = spec.sourceRecRaw !== undefined
    ? spec.sourceRecRaw
    : JSON.stringify(spec.sourceRec !== undefined ? spec.sourceRec : owningRec);

  const db = new Database(join(workspaceDir, '.pd', 'state.db'));
  try {
    db.prepare(`
      INSERT INTO artifacts (artifact_id, run_id, task_id, artifact_kind, content_json, created_at)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run(
      artifactId,
      spec.artifactRunId ?? primary.runId,
      spec.artifactTaskId ?? primary.taskId,
      'diagnostician_output',
      artifactContent,
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
      primary.taskId,
      primary.runId,
      'PRI-1146 V2 provenance candidate',
      CANDIDATE_DESCRIPTION,
      0.9,
      sourceRec,
      `${artifactId}::v2-provenance`,
      now,
      spec.rawRecommendationKind ?? 'principle',
    );
  } finally {
    db.close();
  }
  return { candidateId, taskId: primary.taskId, runId: primary.runId, artifactId };
}

function service(): CandidateIntakeService {
  return new CandidateIntakeService({
    stateManager,
    ledgerAdapter: new PrincipleTreeLedgerAdapter({ stateDir: join(workspaceDir, '.state') }),
  });
}

function ledgerEntryCount(): number {
  const ledgerPath = join(workspaceDir, '.state', 'principle_training_state.json');
  if (!existsSync(ledgerPath)) return 0;
  const raw = JSON.parse(readFileSync(ledgerPath, 'utf-8')) as { _tree?: { principles?: Record<string, unknown> } };
  return Object.keys(raw._tree?.principles ?? {}).length;
}

function readCandidateRow(candidateId: string): { status: string; source_recommendation_json: string; description: string } {
  const db = new Database(join(workspaceDir, '.pd', 'state.db'), { readonly: true });
  try {
    const row = db.prepare(
      'SELECT status, source_recommendation_json, description FROM principle_candidates WHERE candidate_id = ?',
    ).get(candidateId) as { status: string; source_recommendation_json: string; description: string } | undefined;
    if (!row) throw new Error(`candidate ${candidateId} disappeared`);
    return row;
  } finally {
    db.close();
  }
}

/**
 * Assert intake rejected the candidate at the provenance gate, BEFORE any
 * ledger write, and that the candidate's audit record is untouched.
 */
async function expectProvenanceRejection(
  candidateId: string,
  reason: string,
  ledgerCountBefore: number,
): Promise<void> {
  const before = readCandidateRow(candidateId);

  let caught: unknown;
  try {
    await service().intake(candidateId);
  } catch (err: unknown) {
    caught = err;
  }
  expect(caught).toBeInstanceOf(CandidateIntakeError);
  const err = caught as CandidateIntakeError;
  expect(err.code).toBe(INTAKE_ERROR_CODES.INPUT_INVALID);
  expect(err.context).toMatchObject({ reason, candidateId });
  expect(typeof err.context?.nextAction).toBe('string');
  expect(String(err.context?.nextAction).length).toBeGreaterThan(0);
  expect(err.message).toContain(reason);
  // rc-9: the rejection says what did NOT happen and what to do next.
  expect(err.message).toContain('No Principle Ledger entry was written');
  expect(err.message).toContain('nextAction:');

  // Ledger untouched.
  expect(ledgerEntryCount()).toBe(ledgerCountBefore);
  // Candidate preserved and unmodified (no silent deletion / mutation).
  const after = readCandidateRow(candidateId);
  expect(after).toEqual(before);
  expect(after.status).toBe('pending');
}

beforeEach(async () => {
  workspaceDir = join(tmpdir(), `pd-intake-v2-${randomUUID()}`);
  mkdirSync(join(workspaceDir, '.pd'), { recursive: true });
  stateManager = new RuntimeStateManager({ workspaceDir });
  await stateManager.initialize();
  // Seed the ledger so "no new write" is observable against a real document.
  addPrincipleToLedger(join(workspaceDir, '.state'), {
    id: randomUUID(),
    version: 1,
    text: '既有的无关原则（仅用于观察 Ledger 是否增长）。',
    triggerPattern: '无关场景',
    action: '无需动作',
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
  });
});

afterEach(() => {
  try { stateManager.close(); } catch { /* best effort */ }
  try { rmSync(workspaceDir, { recursive: true, force: true }); } catch { /* best effort */ }
});

describe('PRI-1146 P1-03 — legal V2 Diagnostician provenance', () => {
  it('writes the Principle from the verified V2 recommendation (run payload + router envelope + exact source rec)', async () => {
    const output = makeV2Output();
    const seed = await seedCandidate({
      runOutput: output,
      artifactContent: routerEnvelope(output),
      sourceRec: output.recommendations[0],
    });
    const ledgerBefore = ledgerEntryCount();

    const result: CandidateIntakeResult = await service().intake(seed.candidateId);

    expect(result.outcome).toBe('ledger_entry');
    if (result.outcome !== 'ledger_entry') throw new Error('expected a ledger write');
    expect(result.written).toBe(true);
    // The Ledger body comes from the V2 recommendation, never from the
    // candidate description (which differs on purpose).
    expect(result.entry.text).toBe(V2_TEXT);
    expect(result.entry.text).not.toBe(CANDIDATE_DESCRIPTION);
    expect(result.entry.triggerPattern).toBe(V2_TRIGGER);
    expect(result.entry.action).toBe(V2_ACTION);
    expect(ledgerEntryCount()).toBe(ledgerBefore + 1);
  });

  it('accepts a bare V2 artifact (committer row without the router envelope)', async () => {
    const output = makeV2Output();
    const seed = await seedCandidate({
      runOutput: output,
      artifactContent: output,
      sourceRec: output.recommendations[0],
    });

    const result = await service().intake(seed.candidateId);
    expect(result.outcome).toBe('ledger_entry');
  });

  it('accepts a production-shaped diag_router task', async () => {
    const output = makeV2Output();
    const seed = await seedCandidate({
      taskKind: 'diag_router',
      runOutput: output,
      artifactContent: routerEnvelope(output),
      sourceRec: output.recommendations[0],
    });

    const result = await service().intake(seed.candidateId);
    expect(result.outcome).toBe('ledger_entry');
  });
});

describe('PRI-1146 P1-03 — V1 entrances are closed', () => {
  it('rejects a V1 run.outputPayload', async () => {
    const seed = await seedCandidate({
      runOutput: {
        schemaVersion: 'diagnostician-output-v1',
        diagnosisId: randomUUID(),
        summary: 'v1',
        rootCause: 'People: v1',
        evidence: [],
        recommendations: [{ text: V2_TEXT, triggerPattern: V2_TRIGGER, action: V2_ACTION }],
      },
      artifactContent: makeV2Output(),
    });
    await expectProvenanceRejection(seed.candidateId, 'owning_output_not_v2', ledgerEntryCount());
  });

  it('rejects a V1 artifact.contentJson', async () => {
    const output = makeV2Output();
    const seed = await seedCandidate({
      runOutput: output,
      artifactContent: { recommendation: { title: 'V1', text: V2_TEXT, triggerPattern: V2_TRIGGER, action: V2_ACTION } },
    });
    await expectProvenanceRejection(seed.candidateId, 'artifact_not_v2_envelope', ledgerEntryCount());
  });

  it('rejects a V1 sourceRecommendationJson (no recommendationRef)', async () => {
    const output = makeV2Output();
    const seed = await seedCandidate({
      runOutput: output,
      sourceRec: { title: 'V1', text: V2_TEXT, triggerPattern: V2_TRIGGER, action: V2_ACTION },
    });
    await expectProvenanceRejection(seed.candidateId, 'recommendation_ref_missing', ledgerEntryCount());
  });

  it('rejects a V1 recommendation that would previously pass via description→text normalization', async () => {
    const output = makeV2Output();
    const seed = await seedCandidate({
      runOutput: output,
      sourceRec: { description: V2_TEXT, triggerPattern: V2_TRIGGER, action: V2_ACTION },
    });
    await expectProvenanceRejection(seed.candidateId, 'recommendation_ref_missing', ledgerEntryCount());
  });
});

describe('PRI-1146 P1-03 — candidate must match the owning V2 output', () => {
  it('rejects a recommendationRef that does not exist in the owning output', async () => {
    const output = makeV2Output();
    const seed = await seedCandidate({
      runOutput: output,
      sourceRec: makeV2Rec({ recommendationRef: 'principle-does-not-exist' }),
    });
    await expectProvenanceRejection(seed.candidateId, 'recommendation_ref_not_found', ledgerEntryCount());
  });

  it('rejects a duplicate recommendationRef in the owning output', async () => {
    const first = makeV2Rec();
    const duplicate = makeV2Rec({ description: '第二条同 ref 的推荐（歧义映射）' });
    const output = makeV2Output({ recommendations: [first, duplicate] });
    const seed = await seedCandidate({
      runOutput: output,
      artifactContent: routerEnvelope(output),
      sourceRec: first,
    });
    await expectProvenanceRejection(seed.candidateId, 'recommendation_ref_duplicate', ledgerEntryCount());
  });

  it('rejects a tampered sourceRecommendation (same ref, different content)', async () => {
    const output = makeV2Output();
    const seed = await seedCandidate({
      runOutput: output,
      sourceRec: makeV2Rec({ description: '被改写的推荐正文' }),
    });
    await expectProvenanceRejection(seed.candidateId, 'source_recommendation_mismatch', ledgerEntryCount());
  });
});

describe('PRI-1146 P1-03 — lineage and run state', () => {
  it('rejects an artifact owned by another task/run (lineage mismatch)', async () => {
    const output = makeV2Output();
    const foreign = await createTaskAndRun('diagnostician', 'succeeded', JSON.stringify(output));
    const seed = await seedCandidate({
      runOutput: output,
      artifactTaskId: foreign.taskId,
      artifactRunId: foreign.runId,
      sourceRec: output.recommendations[0],
    });
    await expectProvenanceRejection(seed.candidateId, 'lineage_mismatch', ledgerEntryCount());
  });

  it('rejects a run/artifact content mismatch (both sides V2, different outputs)', async () => {
    const runOutput = makeV2Output({ summary: 'run-side output' });
    const artifactOutput = makeV2Output({ summary: 'artifact-side output' });
    const seed = await seedCandidate({ runOutput, artifactContent: routerEnvelope(artifactOutput) });
    await expectProvenanceRejection(seed.candidateId, 'run_artifact_content_mismatch', ledgerEntryCount());
  });

  it('rejects a non-succeeded owning run', async () => {
    const output = makeV2Output();
    const seed = await seedCandidate({ runOutput: output, runStatus: 'failed' });
    await expectProvenanceRejection(seed.candidateId, 'owning_run_not_succeeded', ledgerEntryCount());
  });

  it('rejects an owning run without an output payload', async () => {
    const seed = await seedCandidate({});
    await expectProvenanceRejection(seed.candidateId, 'owning_output_missing', ledgerEntryCount());
  });
});

describe('PRI-1146 P1-03 — other legitimate historical sources keep the legacy behavior', () => {
  it('a non-Diagnostician source still intakes via the historical extraction (no V2 lineage required)', async () => {
    const seed = await seedCandidate({
      taskKind: 'dreamer',
      // Legacy V1-shaped evidence: no run output, V1 artifact wrapper, V1 source rec.
      artifactContent: { recommendation: { title: '历史推荐', text: LEGACY_TEXT, triggerPattern: '历史触发', action: '历史动作' } },
      sourceRec: { text: LEGACY_TEXT, triggerPattern: '历史触发', action: '历史动作' },
    });
    const ledgerBefore = ledgerEntryCount();

    const result = await service().intake(seed.candidateId);

    expect(result.outcome).toBe('ledger_entry');
    if (result.outcome !== 'ledger_entry') throw new Error('expected a ledger write');
    expect(result.entry.text).toBe(LEGACY_TEXT);
    expect(ledgerEntryCount()).toBe(ledgerBefore + 1);
  });
});
