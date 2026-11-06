import { describe, expect, it } from 'vitest';
import type { TaskRecord } from '../../task-status.js';
import { createPITaskDiagnosticJson, type PITaskMetadata } from '../pitask-metadata.js';
import { HUMAN_REVIEW_REASON } from '../owner-review.js';
import {
  buildOwnerDecisionReview,
  type OwnerDecisionReviewStore,
} from '../owner-decision-review.js';

const EVALUATOR_ID = 'evaluator-review-1';
const ARTIFICER_TASK_ID = 'artificer-review-1';
const SCRIBE_TASK_ID = 'scribe-review-1';
const EVALUATOR_ARTIFACT_ID = 'pi-art-evaluator-review-1-run-1';
const ARTIFICER_ARTIFACT_ID = 'pi-art-artificer-review-1-run-1';
const SCRIBE_ARTIFACT_ID = 'pi-art-scribe-review-1-run-1';

function metadata(taskKind: 'evaluator' | 'artificer' | 'scribe'): PITaskMetadata {
  const dependencyTaskIds = taskKind === 'evaluator'
    ? [ARTIFICER_TASK_ID]
    : taskKind === 'artificer' ? [SCRIBE_TASK_ID] : [];
  return {
    dependencyTaskIds,
    channel: 'code_tool_hook',
    timeoutMs: 300_000,
    inputArtifactRefs: [],
    outputArtifactRefs: [],
    ...(taskKind === 'evaluator'
      ? {
          runnerDecision: 'needs_revision' as const,
          revisionCount: 0,
          completionIntent: {
            decision: 'needs_revision' as const,
            sourceRunId: 'run-1',
            revisionEpoch: 0,
            status: 'pending' as const,
          },
          humanReviewContext: {
            reasonCode: HUMAN_REVIEW_REASON.evaluatorRepairBudgetExhausted,
            sourceRunId: 'run-1',
            sourceArtifactId: EVALUATOR_ARTIFACT_ID,
            revisionEpoch: 0,
            createdAt: '2026-08-31T00:00:00.000Z',
          },
        }
      : {}),
  };
}

function task(taskId: string, taskKind: 'evaluator' | 'artificer' | 'scribe'): TaskRecord {
  return {
    taskId,
    taskKind,
    status: taskKind === 'evaluator' ? 'needs_human_review' : 'succeeded',
    attemptCount: 1,
    maxAttempts: 3,
    createdAt: '2026-08-31T00:00:00.000Z',
    updatedAt: '2026-08-31T00:05:00.000Z',
    diagnosticJson: createPITaskDiagnosticJson(metadata(taskKind)),
  };
}

function artifact(input: {
  artifactId: string;
  sourceTaskId: string;
  lineageArtifactIds: string[];
  content: unknown;
}) {
  return {
    artifactId: input.artifactId,
    artifactKind: 'principle',
    sourceTaskId: input.sourceTaskId,
    lineageArtifactIds: input.lineageArtifactIds,
    validationStatus: 'pending',
    contentJson: JSON.stringify(input.content),
    createdAt: '2026-08-31T00:00:00.000Z',
  };
}

function makeStore(options: {
  adversarialPassed?: boolean;
  codeBearingArtificer?: boolean;
  includeScribe?: boolean;
  concern?: string;
  evaluatorExtra?: Record<string, unknown>;
  artificerExtra?: Record<string, unknown>;
  scribeExtra?: Record<string, unknown>;
  /** PRI-858: scribe's own lineage ids (real scribe artifacts echo upstream evidence). */
  scribeLineageIds?: string[];
  /** PRI-858: upstream formation rows (dreamer / diagnostic stages) for the evidence chain. */
  extraTasks?: TaskRecord[];
  extraArtifacts?: ReturnType<typeof artifact>[];
  includeOlderRepair?: boolean;
} = {}): OwnerDecisionReviewStore {
  const oldArtificerArtifactId = 'pi-art-artificer-review-old-run-1';
  const oldScribeArtifactId = 'pi-art-scribe-review-old-run-1';
  const records = [
    ...(options.includeOlderRepair ? [
      artifact({ artifactId: oldScribeArtifactId, sourceTaskId: 'scribe-review-old', lineageArtifactIds: [], content: {
        principleDraft: { statement: 'OLD principle must not be shown.' },
      }}),
      artifact({ artifactId: oldArtificerArtifactId, sourceTaskId: 'artificer-review-old', lineageArtifactIds: [oldScribeArtifactId], content: {
        sourceScribeArtifactId: oldScribeArtifactId,
        sourceTrace: { scribeArtifactId: oldScribeArtifactId },
        implementationSummary: 'OLD implementation must not be shown.',
      }}),
    ] : []),
    artifact({ artifactId: SCRIBE_ARTIFACT_ID, sourceTaskId: SCRIBE_TASK_ID, lineageArtifactIds: options.scribeLineageIds ?? [], content: {
      principleDraft: {
        title: 'Confirm destructive changes',
        statement: 'Before destructive changes, confirm the exact target with the Owner.',
        rationale: 'Prevents irreversible work against an ambiguous target.',
        applicability: ['filesystem writes'],
        antiPatterns: ['guessing the target'],
      },
      ...options.scribeExtra,
    }}),
    artifact({ artifactId: ARTIFICER_ARTIFACT_ID, sourceTaskId: ARTIFICER_TASK_ID, lineageArtifactIds: [SCRIBE_ARTIFACT_ID], content: {
      ...(options.codeBearingArtificer
        ? {
            taskId: ARTIFICER_TASK_ID,
            implementationCode: 'export function confirmTarget() { return true; }',
            goldenTraceCases: [
              {
                caseId: 'allows-confirmed-target',
                kind: 'positive',
                toolName: 'write_file',
                params: { confirmed: true },
                expectedDecision: 'allow',
              },
              {
                caseId: 'blocks-unconfirmed-target',
                kind: 'negative',
                toolName: 'write_file',
                params: { confirmed: false },
                expectedDecision: 'block',
              },
            ],
            generatedAt: '2026-08-31T00:00:00.000Z',
          }
        : {}),
      sourceScribeArtifactId: SCRIBE_ARTIFACT_ID,
      sourceTrace: { scribeArtifactId: SCRIBE_ARTIFACT_ID },
      implementationSummary: 'Adds a confirmation gate before destructive writes.',
      affectedTools: ['write_file', 'apply_patch'],
      risks: ['May add one interaction before a destructive action.'],
      ...options.artificerExtra,
    }}),
    artifact({ artifactId: EVALUATOR_ARTIFACT_ID, sourceTaskId: EVALUATOR_ID, lineageArtifactIds: [
      ...(options.includeOlderRepair ? [oldArtificerArtifactId] : []),
      ARTIFICER_ARTIFACT_ID,
    ], content: {
      sourceArtificerArtifactId: ARTIFICER_ARTIFACT_ID,
      sourceTrace: { artificerArtifactId: ARTIFICER_ARTIFACT_ID },
      evaluation: {
        decision: 'needs_revision',
        score: 0.72,
        strengths: ['The target check is deterministic.'],
        concerns: [options.concern ?? 'The confirmation copy is ambiguous.'],
        requiredChanges: ['Clarify the confirmation copy.'],
      },
      ...(options.adversarialPassed === undefined
        ? {}
        : { adversarialResult: { passed: options.adversarialPassed, failedCases: [] } }),
      ...options.evaluatorExtra,
    }}),
  ].filter((record) => options.includeScribe !== false || record.artifactId !== SCRIBE_ARTIFACT_ID);
  const tasks: TaskRecord[] = [
    task(EVALUATOR_ID, 'evaluator'),
    ...(options.includeOlderRepair ? [
      task('artificer-review-old', 'artificer'),
      task('scribe-review-old', 'scribe'),
    ] : []),
    task(ARTIFICER_TASK_ID, 'artificer'),
    ...(options.includeScribe === false ? [] : [task(SCRIBE_TASK_ID, 'scribe')]),
    ...(options.extraTasks ?? []),
  ];
  const recordsAll = [...records, ...(options.extraArtifacts ?? [])];
  return {
    getTask: async (id) => tasks.find((entry) => entry.taskId === id) ?? null,
    listArtifactsBySourceTask: async (id) => recordsAll.filter((entry) => entry.sourceTaskId === id),
    getArtifactById: async (id) => recordsAll.find((entry) => entry.artifactId === id) ?? null,
  };
}

/** PRI-858: a runner task row carrying PI dependency metadata. */
function formationTask(
  taskId: string,
  taskKind: 'dreamer' | 'diag_router' | 'diag_distiller' | 'philosopher',
  dependencyTaskIds: string[],
): TaskRecord {
  return {
    taskId,
    taskKind,
    status: 'succeeded',
    attemptCount: 1,
    maxAttempts: 3,
    createdAt: '2026-08-31T00:00:00.000Z',
    updatedAt: '2026-08-31T00:05:00.000Z',
    diagnosticJson: createPITaskDiagnosticJson({
      dependencyTaskIds,
      channel: 'code_tool_hook',
      timeoutMs: 300_000,
      inputArtifactRefs: [],
      outputArtifactRefs: [],
    }),
  };
}

/**
 * PRI-858 fixture: the formation chain that PRODUCED the standard scribe
 * artifact — pain → diag_router → dreamer → (philosopher) → scribe. All PI
 * artifacts are written with artifactKind 'principle'; stage identity lives on
 * the task row (which is exactly why the resolver needs a task lookup).
 */
const DIAG_TASK_ID = 'diag-review-1';
const DREAMER_TASK_ID = 'dreamer-review-1';
const DIAG_ARTIFACT_ID = 'pi-art-diag-review-1-run-1';
const DREAMER_ARTIFACT_ID = 'pi-art-dreamer-review-1-run-1';

function formationFixture(options: {
  diagStatus?: TaskRecord['status'];
  includeDiagArtifact?: boolean;
  includeDreamerArtifact?: boolean;
  diagContent?: Record<string, unknown>;
  dreamerContent?: Record<string, unknown>;
} = {}) {
  const diagArtifact = artifact({
    artifactId: DIAG_ARTIFACT_ID,
    sourceTaskId: DIAG_TASK_ID,
    lineageArtifactIds: [],
    content: options.diagContent ?? {
      rootCause: 'Agent edits destructive targets without an explicit confirmation step.',
      summary: 'Repeated destructive-write misses on ambiguous targets.',
      violatedPrinciples: [{
        principleId: 'P-1',
        title: 'Confirm before destructive change',
        rationale: 'Target ambiguity was resolved by guessing.',
      }],
      evidence: [{ sourceRef: 'pain-42', note: 'Wrote over an unconfirmed target twice.' }],
      recommendations: [{ kind: 'principle', description: 'Require explicit target confirmation.' }],
      confidence: 0.81,
    },
  });
  const dreamerArtifact = artifact({
    artifactId: DREAMER_ARTIFACT_ID,
    sourceTaskId: DREAMER_TASK_ID,
    lineageArtifactIds: [DIAG_ARTIFACT_ID],
    content: options.dreamerContent ?? {
      sourcePainId: 'pain-42',
      contextRefs: ['pain-42'],
      candidates: [{
        candidateIndex: 0,
        badDecision: 'Proceed on the inferred target.',
        betterDecision: 'Confirm the exact target before a destructive write.',
        rationale: 'Removes irreversible work on an ambiguous target.',
        confidence: 0.7,
        riskLevel: 'low',
      }],
    },
  });
  const diagTask = formationTask(DIAG_TASK_ID, 'diag_router', []);
  return {
    extraTasks: [
      options.diagStatus ? { ...diagTask, status: options.diagStatus } : diagTask,
      formationTask(DREAMER_TASK_ID, 'dreamer', [DIAG_TASK_ID]),
    ],
    extraArtifacts: [
      ...(options.includeDiagArtifact === false ? [] : [diagArtifact]),
      ...(options.includeDreamerArtifact === false ? [] : [dreamerArtifact]),
    ],
    scribeLineageIds: [DREAMER_ARTIFACT_ID],
    scribeExtra: { sourceTrace: { dreamerArtifactId: DREAMER_ARTIFACT_ID } },
  };
}

/** Spread a formation fixture into makeStore options. */
function formationStoreOptions(fixture: ReturnType<typeof formationFixture>): Parameters<typeof makeStore>[0] {
  return {
    extraTasks: fixture.extraTasks,
    extraArtifacts: fixture.extraArtifacts,
    scribeLineageIds: fixture.scribeLineageIds,
    scribeExtra: fixture.scribeExtra,
  };
}

function evaluatorBrief(snapshot: Awaited<ReturnType<typeof buildOwnerDecisionReview>>) {
  expect(snapshot?.brief.kind).toBe('evaluator');
  if (snapshot?.brief.kind !== 'evaluator') throw new Error('expected evaluator brief');
  return snapshot.brief;
}

describe('Owner Decision Review Snapshot', () => {
  it('builds a distinct evidence-rich evaluator brief and reports an absent adversarial result as not_run', async () => {
    const snapshot = await buildOwnerDecisionReview(makeStore(), EVALUATOR_ID);

    expect(snapshot?.brief.kind).toBe('evaluator');
    if (snapshot?.brief.kind !== 'evaluator') throw new Error('expected evaluator brief');
    expect(snapshot.brief.principle.statement).toContain('confirm the exact target');
    expect(snapshot.brief.implementation.summary).toContain('confirmation gate');
    expect(snapshot.brief.implementation.affectedTools).toEqual(['write_file', 'apply_patch']);
    expect(snapshot.brief.concerns).toEqual(['The confirmation copy is ambiguous.']);
    expect(snapshot.evidence.deterministicChecks).toEqual([
      { check: 'adversarial_hard_gate', status: 'not_run' },
    ]);
    expect(snapshot.evidence.completeness).toBe('complete');
  });

  it('derives the 5-item quality checklist; boundary passes via antiPatterns on the standard fixture', async () => {
    const snapshot = await buildOwnerDecisionReview(makeStore(), EVALUATOR_ID);
    expect(snapshot?.brief.kind).toBe('evaluator');
    if (snapshot?.brief.kind !== 'evaluator') throw new Error('expected evaluator brief');
    const checklist = snapshot.brief.qualityChecklist;
    expect(checklist).toBeDefined();
    expect(checklist?.schemaVersion).toBe(1);
    expect(checklist?.items.map((item) => item.id)).toEqual([
      'understandability', 'evidence', 'actionability', 'generalization', 'boundary',
    ]);
    const byId = new Map(checklist?.items.map((item) => [item.id, item] as const));
    expect(byId.get('understandability')?.pass).toBe(true);
    expect(byId.get('boundary')?.pass).toBe(true);
    expect(byId.get('boundary')?.note).toContain('anti-pattern');
    // 标准单上下文 fixture：generalization 必须 fail（over-fitting 信号）
    expect(byId.get('generalization')?.pass).toBe(false);
  });

  it('boundary: intent-contract forbiddenBehavior is the ONLY accepted fallback — ownerIntent (a goal) must not count (评审 P1)', async () => {
    const draftWithoutAntiPatterns = {
      title: 'Confirm destructive changes',
      statement: 'Before destructive changes, confirm the exact target with the Owner.',
      rationale: 'Prevents irreversible work against an ambiguous target.',
      applicability: ['filesystem writes', 'shell commands'],
    };
    const boundaryItem = async (options: Parameters<typeof makeStore>[0]): Promise<{ pass?: boolean; note?: string } | undefined> => {
      const snapshot = await buildOwnerDecisionReview(makeStore(options), EVALUATOR_ID);
      expect(snapshot?.brief.kind).toBe('evaluator');
      if (snapshot?.brief.kind !== 'evaluator') throw new Error('expected evaluator brief');
      return snapshot.brief.qualityChecklist?.items.find((item) => item.id === 'boundary');
    };
    // forbiddenBehavior present → boundary pass even without antiPatterns
    const forbiddenItem = await boundaryItem({
      scribeExtra: {
        principleDraft: draftWithoutAntiPatterns,
        intentContract: {
          ownerIntent: 'prevent ambiguous destructive targets',
          targetBehavior: 'confirm the exact target before destructive writes',
          forbiddenBehavior: 'guessing or inferring the target without confirmation',
          evidenceSource: 'pain destructive-write misses',
          validationExpectation: 'unconfirmed targets are blocked',
        },
      },
    });
    expect(forbiddenItem?.pass).toBe(true);
    expect(forbiddenItem?.note).toContain('forbiddenBehavior');

    // ownerIntent present but forbiddenBehavior EMPTY → boundary must FAIL
    // (回归：旧实现误把 intentOwner 当 forbidden 证据)
    const ownerOnlyItem = await boundaryItem({
      scribeExtra: {
        principleDraft: draftWithoutAntiPatterns,
        intentContract: {
          ownerIntent: 'prevent ambiguous destructive targets',
          forbiddenBehavior: '',
        },
      },
    });
    expect(ownerOnlyItem?.pass).toBe(false);
    expect(ownerOnlyItem?.note).toContain('no antiPatterns and no intent-contract forbiddenBehavior present');
  });

  it('R3: evidence item binds to resolvable ancestors beyond scribe; generalization dedups applicability (评审探针正式化)', async () => {
    // 标准链只有 evaluator→artificer→scribe，无 philosopher/dreamer/diag
    // 祖先 —— evidence 项必须 fail（不得宣称 "evidence-derived"）。
    const standard = await buildOwnerDecisionReview(makeStore(), EVALUATOR_ID);
    const stdChecklist = standard?.brief.kind === 'evaluator' ? standard.brief.qualityChecklist : undefined;
    const stdEvidence = stdChecklist?.items.find((item) => item.id === 'evidence');
    expect(stdEvidence?.pass).toBe(false);
    expect(stdEvidence?.note).toContain('no ancestor artifact resolvable beyond scribe');

    // 重复同一文件不得计为多上下文：generalization 按去重计数。
    const dupStore = makeStore({
      scribeExtra: {
        principleDraft: {
          title: 'x',
          statement: 'Only patch /tmp/a.ts',
          rationale: 'x',
          applicability: ['/tmp/a.ts', '/tmp/a.ts'],
          antiPatterns: ['x'],
        },
      },
    });
    const dup = await buildOwnerDecisionReview(dupStore, EVALUATOR_ID);
    const dupChecklist = dup?.brief.kind === 'evaluator' ? dup.brief.qualityChecklist : undefined;
    const dupGeneralization = dupChecklist?.items.find((item) => item.id === 'generalization');
    expect(dupGeneralization?.pass).toBe(false);
    expect(dupGeneralization?.note).toContain('distinct applicability entries: 1');
  });

  it('requires acknowledgement for a partial but still identifiable review', async () => {
    const snapshot = await buildOwnerDecisionReview(
      makeStore({ includeScribe: false }),
      EVALUATOR_ID,
    );

    expect(snapshot?.evidence.completeness).toBe('partial');
    expect(snapshot?.capability.acceptRequirement).toEqual({
      kind: 'acknowledge_partial_evidence',
    });
    expect(snapshot?.capability.finalOfferedActions).toContain('accept_current');
  });

  it('forbids accept when the deterministic adversarial hard gate explicitly failed', async () => {
    const snapshot = await buildOwnerDecisionReview(
      makeStore({ adversarialPassed: false }),
      EVALUATOR_ID,
    );

    expect(snapshot?.evidence.deterministicChecks).toEqual([
      { check: 'adversarial_hard_gate', status: 'failed' },
    ]);
    expect(snapshot?.capability.finalOfferedActions).not.toContain('accept_current');
    expect(snapshot?.capability.acceptRequirement).toEqual({
      kind: 'forbidden',
      reasonCode: 'adversarial_hard_gate_failed',
    });
  });

  it('forbids accept when a validated code-bearing Artificer output has not passed the hard gate', async () => {
    const snapshot = await buildOwnerDecisionReview(
      makeStore({ codeBearingArtificer: true }),
      EVALUATOR_ID,
    );

    expect(snapshot?.evidence.deterministicChecks[0]?.status).toBe('not_run');
    expect(snapshot?.capability.finalOfferedActions).not.toContain('accept_current');
    expect(snapshot?.capability.acceptRequirement).toEqual({
      kind: 'forbidden',
      reasonCode: 'adversarial_hard_gate_not_passed',
    });
  });

  it('uses the canonical code-bearing assessment when affectedTools is omitted', async () => {
    const snapshot = await buildOwnerDecisionReview(
      makeStore({
        codeBearingArtificer: true,
        artificerExtra: { affectedTools: undefined },
      }),
      EVALUATOR_ID,
    );

    expect(snapshot?.evidence.deterministicChecks[0]?.status).toBe('not_run');
    expect(snapshot?.capability.finalOfferedActions).not.toContain('accept_current');
    expect(snapshot?.capability.acceptRequirement).toEqual({
      kind: 'forbidden',
      reasonCode: 'adversarial_hard_gate_not_passed',
    });
  });

  it('keeps legacy compatibility when the Artificer artifact is not a validated code-bearing output', async () => {
    const snapshot = await buildOwnerDecisionReview(makeStore(), EVALUATOR_ID);
    expect(snapshot?.capability.finalOfferedActions).toContain('accept_current');
  });

  it('uses the evaluator-declared repair lineage instead of the first reachable artificer', async () => {
    const snapshot = await buildOwnerDecisionReview(
      makeStore({ includeOlderRepair: true }),
      EVALUATOR_ID,
    );

    expect(snapshot?.brief.kind).toBe('evaluator');
    if (snapshot?.brief.kind !== 'evaluator') throw new Error('expected evaluator brief');
    expect(snapshot.brief.principle.statement).toContain('confirm the exact target');
    expect(snapshot.brief.implementation.summary).toContain('confirmation gate');
    expect(snapshot.evidence.manifest.sources.map((source) => source.stableId))
      .not.toContain('pi-art-artificer-review-old-run-1');
  });

  it('changes the evidence digest when visible decision semantics change', async () => {
    const first = await buildOwnerDecisionReview(
      makeStore({ concern: 'Concern A' }),
      EVALUATOR_ID,
    );
    const second = await buildOwnerDecisionReview(
      makeStore({ concern: 'Concern B' }),
      EVALUATOR_ID,
    );

    expect(first?.evidence.digest).toMatch(/^[a-f0-9]{64}$/);
    expect(second?.evidence.digest).not.toBe(first?.evidence.digest);
  });
});

// ── PRI-858: formation evidence surfaced on the Owner decision snapshot ──────

describe('Owner Decision Review formation evidence (PRI-858)', () => {
  it('surfaces the source diagnosis and pain provenance when the formation chain is persisted', async () => {
    const snapshot = await buildOwnerDecisionReview(
      makeStore(formationStoreOptions(formationFixture())),
      EVALUATOR_ID,
    );
    const brief = evaluatorBrief(snapshot);

    expect(brief.formationEvidence).toBeDefined();
    expect(brief.formationEvidence?.version).toBe('formation-context.v1');
    expect(brief.formationEvidence?.sourcePainId).toBe('pain-42');
    expect(brief.formationEvidence?.diagnosis?.rootCause)
      .toContain('without an explicit confirmation step');
    expect(brief.formationEvidence?.diagnosis?.stage).toBe('diag_router');
    expect(brief.formationEvidence?.diagnosis?.evidence).toEqual([
      { sourceRef: 'pain-42', note: 'Wrote over an unconfirmed target twice.' },
    ]);
    expect(brief.formationEvidence?.provenance).toEqual({
      sourceDreamerArtifactId: DREAMER_ARTIFACT_ID,
      sourceDiagnosisArtifactId: DIAG_ARTIFACT_ID,
      sourceDiagnosisTaskId: DIAG_TASK_ID,
    });
    // The lineage reference survives as an id, never as a dump.
    expect(JSON.stringify(brief.formationEvidence)).not.toContain('contentJson');
    expect(JSON.stringify(brief.formationEvidence)).not.toContain('lineageArtifactIds');
    // Consistency, not authority: the deterministic checklist fact and the new
    // projection now agree that a real pain/diagnosis source exists.
    expect(brief.qualityChecklist?.items.find((item) => item.id === 'evidence')?.pass).toBe(true);
  });

  it('is governance-neutral: only visibility changes, authority and state machine do not', async () => {
    const without = await buildOwnerDecisionReview(makeStore(), EVALUATOR_ID);
    const withEvidence = await buildOwnerDecisionReview(
      makeStore(formationStoreOptions(formationFixture())),
      EVALUATOR_ID,
    );

    // Same durable decision facts → same capability, same completeness, same
    // deterministic gates. The ONLY difference is the projected evidence.
    expect(withEvidence?.capability).toEqual(without?.capability);
    expect(withEvidence?.evidence.completeness).toBe(without?.evidence.completeness);
    expect(withEvidence?.evidence.deterministicChecks).toEqual(without?.evidence.deterministicChecks);
    expect(withEvidence?.reasonCode).toBe(without?.reasonCode);
    expect(withEvidence?.legacy).toBe(without?.legacy);
    expect(withEvidence?.staleBinding.expectedRevisionEpoch).toBe(without?.staleBinding.expectedRevisionEpoch);
    expect(evaluatorBrief(without).formationEvidence).toBeUndefined();
  });

  it('does not reuse the old identity: new evidence changes the evidence digest', async () => {
    const without = await buildOwnerDecisionReview(makeStore(), EVALUATOR_ID);
    const withEvidence = await buildOwnerDecisionReview(
      makeStore(formationStoreOptions(formationFixture())),
      EVALUATOR_ID,
    );

    expect(withEvidence?.evidence.digest).not.toBe(without?.evidence.digest);
    expect(withEvidence?.staleBinding.expectedEvidenceDigest).toBe(withEvidence?.evidence.digest);
    expect(withEvidence?.evidence.manifest.semanticFacts.briefSemanticHash)
      .not.toBe(without?.evidence.manifest.semanticFacts.briefSemanticHash);
    // Authority facts stay outside the semantic evidence they must not affect.
    expect(withEvidence?.evidence.manifest.semanticFacts.acceptRequirement)
      .toBe(without?.evidence.manifest.semanticFacts.acceptRequirement);
    expect(withEvidence?.evidence.manifest.semanticFacts.offeredActions)
      .toEqual(without?.evidence.manifest.semanticFacts.offeredActions);
  });

  it('omits the field for a legacy scribe artifact with no dreamer lineage id', async () => {
    const snapshot = await buildOwnerDecisionReview(makeStore(), EVALUATOR_ID);

    expect(evaluatorBrief(snapshot).formationEvidence).toBeUndefined();
    expect(snapshot).not.toBeNull();
    expect(snapshot?.capability.finalOfferedActions).toContain('accept_current');
  });

  it('reports evidence unavailable with a reason instead of failing the review', async () => {
    const fixture = formationFixture({ includeDreamerArtifact: false });
    const snapshot = await buildOwnerDecisionReview(makeStore(formationStoreOptions(fixture)), EVALUATOR_ID);
    const evidence = evaluatorBrief(snapshot).formationEvidence;

    expect(evidence).toBeDefined();
    expect(evidence?.diagnosis).toBeUndefined();
    expect(evidence?.notes.join(' ')).toContain('formation_dreamer_artifact_missing');
    // Degraded evidence must not block or reshape the decision.
    expect(snapshot?.capability.finalOfferedActions).toContain('accept_current');
    expect(snapshot?.capability.acceptRequirement).toEqual({ kind: 'none' });
  });

  it('records an unconfirmed diagnosis stage as an observable note', async () => {
    const fixture = formationFixture({ diagStatus: 'pending' });
    const snapshot = await buildOwnerDecisionReview(makeStore(formationStoreOptions(fixture)), EVALUATOR_ID);
    const evidence = evaluatorBrief(snapshot).formationEvidence;

    expect(evidence?.diagnosis).toBeUndefined();
    expect(evidence?.notes.join(' ')).toContain('no diagnostic stage found');
    expect(snapshot?.capability.finalOfferedActions).toContain('accept_current');
  });

  it('keeps the projection bounded under oversized evidence', async () => {
    const fixture = formationFixture({
      diagContent: {
        rootCause: 'x'.repeat(5000),
        summary: 'y'.repeat(5000),
        violatedPrinciples: Array.from({ length: 40 }, (_unused, index) => ({
          principleId: `P-${index}`,
          rationale: 'r'.repeat(500),
        })),
        evidence: Array.from({ length: 40 }, (_unused, index) => ({
          sourceRef: `pain-${index}`,
          note: 'n'.repeat(500),
        })),
        recommendations: Array.from({ length: 40 }, () => ({
          kind: 'principle',
          description: 'd'.repeat(500),
        })),
        confidence: 0.9,
      },
    });
    const snapshot = await buildOwnerDecisionReview(makeStore(formationStoreOptions(fixture)), EVALUATOR_ID);
    const evidence = evaluatorBrief(snapshot).formationEvidence;

    expect(evidence?.diagnosis?.rootCause?.length ?? 0).toBeLessThanOrEqual(400);
    expect((evidence?.diagnosis?.evidence.length ?? 0) <= 8).toBe(true);
    expect((evidence?.diagnosis?.recommendations.length ?? 0) <= 5).toBe(true);
    expect(evidence?.notes.length).toBeLessThanOrEqual(8);
    expect(JSON.stringify(evidence ?? {}).length).toBeLessThan(8000);
  });
});
