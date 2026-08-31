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
  includeScribe?: boolean;
  concern?: string;
} = {}): OwnerDecisionReviewStore {
  const records = [
    artifact({ artifactId: SCRIBE_ARTIFACT_ID, sourceTaskId: SCRIBE_TASK_ID, lineageArtifactIds: [], content: {
      principleDraft: {
        title: 'Confirm destructive changes',
        statement: 'Before destructive changes, confirm the exact target with the Owner.',
        rationale: 'Prevents irreversible work against an ambiguous target.',
        applicability: ['filesystem writes'],
        antiPatterns: ['guessing the target'],
      },
    }}),
    artifact({ artifactId: ARTIFICER_ARTIFACT_ID, sourceTaskId: ARTIFICER_TASK_ID, lineageArtifactIds: [SCRIBE_ARTIFACT_ID], content: {
      implementationSummary: 'Adds a confirmation gate before destructive writes.',
      affectedTools: ['write_file', 'apply_patch'],
      risks: ['May add one interaction before a destructive action.'],
    }}),
    artifact({ artifactId: EVALUATOR_ARTIFACT_ID, sourceTaskId: EVALUATOR_ID, lineageArtifactIds: [ARTIFICER_ARTIFACT_ID], content: {
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
    }}),
  ].filter((record) => options.includeScribe !== false || record.artifactId !== SCRIBE_ARTIFACT_ID);
  const tasks = [
    task(EVALUATOR_ID, 'evaluator'),
    task(ARTIFICER_TASK_ID, 'artificer'),
    ...(options.includeScribe === false ? [] : [task(SCRIBE_TASK_ID, 'scribe')]),
  ];
  return {
    getTask: async (id) => tasks.find((entry) => entry.taskId === id) ?? null,
    listArtifactsBySourceTask: async (id) => records.filter((entry) => entry.sourceTaskId === id),
    getArtifactById: async (id) => records.find((entry) => entry.artifactId === id) ?? null,
  };
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
