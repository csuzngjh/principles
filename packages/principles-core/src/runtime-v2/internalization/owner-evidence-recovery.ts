/**
 * owner-evidence-recovery.ts — Owner evidence attach/resume (B1, PRI-983).
 *
 * SPEC-PD-IAER-001 FR-03 (persist the Owner's evidence selection with
 * revision/digest/provenance) and FR-06 (query → attach → atomic resume).
 * This module is the ONE recovery sequence for evidence-waiting tasks;
 * both CLI entries (`pd runtime internalization evidence attach|resume|list`)
 * and any future Console face drive it — no logic is duplicated at the
 * callers (same rule owner-retry.ts established for the NHR out-edge).
 *
 * Composition with existing authorities (P2/P4 — nothing new is invented):
 *   - selection shape + readiness judgment: evidence-readiness.ts (A2);
 *   - persisted location: `pi_metadata.ownerEvidenceSelection` inside
 *     diagnosticJson (A2 field; B1 adds the provenance fields INSIDE the
 *     selection object — pitask-metadata carries the object opaquely, the
 *     shared shape authority validates the extended shape, ABSENT = legacy);
 *   - the resume state transition itself: `ownerRetryNeedsHumanReviewTask`
 *     (owner-retry.ts), called with the new optional CAS precondition —
 *     the single recovery authority is reused, never copied;
 *   - digest authority: `computeBehaviorExamplePackDigest` (same bytes the
 *     readiness verdict hashes);
 *   - audit: `.state/recovery_actions.jsonl` append family
 *     (appendOwnerEvidenceAction);
 *   - telemetry: `artificer_owner_evidence_attached` /
 *     `artificer_owner_evidence_resumed` (FR-08, bounded payloads, rc-8),
 *     both carrying the unified FR-08 run-correlation block (PRI-984,
 *     artificer-run-correlation.ts); persistentRunId is semantically absent —
 *     recovery runs against an NHR task / a pending requeue where no run row
 *     exists yet.
 *
 * Contract decisions pinned here:
 *   - attach NEVER unblocks: the task stays `needs_human_review`; only the
 *     explicit `resume` authority reset returns it to pending (FR-06 6/7).
 *   - resume re-assembles and compares digests: a mismatch refuses with
 *     `owner_behavior_examples_stale` — a silently stale evidence reference
 *     can never re-enter the model (FR-03).
 *   - FR-06 budget semantics: the authority reset zeroes attemptCount. That
 *     is an EXPLICIT, `--confirm`-gated, digest-verified, audited operator
 *     action — not the forbidden "background silently clears history
 *     attemptCount": previousAttemptCount is recorded in the audit record
 *     and the run history / humanReviewContext stay in place (nothing is
 *     deleted; T05 asserts run rows are preserved).
 *   - concurrency (T06): the reset runs as ONE conditional UPDATE
 *     (`updateTaskIfDiagnosticJsonUnchanged` via the CAS option). Two
 *     concurrent resumes → at most one `resumed`; the loser gets a
 *     structured `conflict` refusal with zero mutation.
 *   - authorization expression (notes §8 reality): confirm-level command +
 *     explicit decidedBy label + append-only audit + revision/digest
 *     provenance. No new authentication mechanism is invented here.
 *
 * rc-1/rc-2: the stored selection arrives from parsed diagnosticJson and is
 * re-validated by the shared shape authority before any use. rc-3: required
 * preconditions fail loudly with stable reasons + nextAction (rc-9). rc-8:
 * telemetry payloads carry bounded references only.
 *
 * Spec: docs/specs/SPEC-PD-IAER-001-v1.0.md §5 FR-03, FR-06, §6.1-§6.3
 */
import type { StoreEventEmitter } from '../store/event-emitter.js';
import type { RuntimeStateManager } from '../store/runtime-state-manager.js';
import type { TaskRecord } from '../task-status.js';
import type { PITaskRecord } from './peer-runner-contracts.js';
import { PDRuntimeError } from '../error-categories.js';
import {
  createPITaskDiagnosticJson,
  hydratePITaskRecord,
  mergePITaskMetadata,
} from './pitask-metadata.js';
import {
  assessEvidenceReadiness,
  validateOwnerEvidenceSelectionShape,
  type OwnerEvidenceReasonCode,
  type OwnerEvidenceSelection,
} from './evidence-readiness.js';
import { resolveArtificerCanonicalPainId, type BehaviorEvidencePort } from './consumer-evidence-preflight.js';
import { buildArtificerRunCorrelation } from './artificer-run-correlation.js';
import { ownerRetryNeedsHumanReviewTask } from './owner-retry.js';
import { appendOwnerEvidenceAction } from '../recovery-actions-log.js';

// ── evidence-waiting task identification (FR-06 1/2) ────────────────────────

/**
 * FR-04: a task is "waiting for Owner evidence" iff it sits in
 * needs_human_review with one of the four stable reason codes in its
 * humanReviewContext. Other NHR tasks (verdict reviews etc.) are NOT
 * evidence-waiting and are never touched by this module.
 */
export const EVIDENCE_WAIT_REASON_CODES: ReadonlySet<string> = new Set([
  'owner_behavior_examples_required',
  'owner_behavior_examples_invalid',
  'owner_behavior_examples_stale',
  'owner_behavior_examples_scope_mismatch',
]);

/** Field names whose absence the readiness gate reports (FR-06 2). */
const SELECTION_FIELD_NAMES: readonly string[] = [
  'sourcePainId',
  'sourceNegativeToolCallId',
  'positiveToolCallIds',
  'ownerDesiredOutcome',
];

function nextActionForReasonCode(reasonCode: string): string {
  switch (reasonCode) {
    case 'owner_behavior_examples_required':
      return 'Attach evidence (dry-run by default): pd runtime internalization evidence attach --task <taskId> --pain <canonicalPainId> --negative <toolCallId> --positive <id>... --outcome "<desired behavior>" — then resume with evidence resume --confirm.';
    case 'owner_behavior_examples_invalid':
      return 'The stored selection failed validation; re-attach a corrected selection with evidence attach --confirm (revision increments), then resume.';
    case 'owner_behavior_examples_stale':
      return 'The referenced trajectory changed or was cleaned; re-attach fresh examples with evidence attach --confirm, then resume (resume refuses stale digests).';
    case 'owner_behavior_examples_scope_mismatch':
      return 'The selection references another pain/session; re-attach examples that belong to the referenced pain session, then resume.';
    default:
      return 'Inspect the task: pd runtime internalization queue --json';
  }
}

export interface EvidenceWaitingTaskSummary {
  readonly taskId: string;
  readonly channel: string;
  /** The attached selection's pain id; null while nothing is attached. */
  readonly painId: string | null;
  readonly reasonCode: string;
  readonly missingFields: readonly string[];
  readonly nextAction: string;
  readonly attemptCount: number;
  readonly maxAttempts: number;
  /** Attach revision of the stored selection; 0 = nothing attached. */
  readonly evidenceRevision: number;
}

/**
 * FR-06 1/2: list Artificer tasks waiting for Owner evidence. Read-only;
 * non-artificer or non-evidence NHR tasks are not listed. Hydration
 * failures are skipped (the task is not listable as evidence-waiting —
 * `pd runtime internalization integrity` is the surface for those).
 */
// ── shared helpers ──────────────────────────────────────────────────────────

function hydrateOrNull(task: TaskRecord): PITaskRecord | null {
  return hydratePITaskRecord(task);
}

function readDiagnosticJson(task: TaskRecord): string | null {
  const raw = task.diagnosticJson;
  return typeof raw === 'string' && raw.trim() !== '' ? raw : null;
}

export async function listEvidenceWaitingTasks(
  stateManager: RuntimeStateManager,
): Promise<EvidenceWaitingTaskSummary[]> {
  const tasks = await stateManager.listTasks({ status: 'needs_human_review', taskKind: 'artificer' });
  const summaries: EvidenceWaitingTaskSummary[] = [];
  for (const task of tasks) {
    const piTask = hydrateOrNull(task);
    if (!piTask) continue;
    const context = piTask.humanReviewContext;
    if (!context || !EVIDENCE_WAIT_REASON_CODES.has(context.reasonCode)) continue;
    const selection = piTask.ownerEvidenceSelection;
    summaries.push({
      taskId: task.taskId,
      channel: piTask.channel,
      painId: selection?.sourcePainId ?? null,
      reasonCode: context.reasonCode,
      missingFields: context.reasonCode === 'owner_behavior_examples_required'
        ? SELECTION_FIELD_NAMES
        : [],
      nextAction: nextActionForReasonCode(context.reasonCode),
      attemptCount: task.attemptCount,
      maxAttempts: task.maxAttempts,
      evidenceRevision: selection?.revision ?? 0,
    });
  }
  return summaries;
}

// ── attach (FR-03 / FR-06 3-6) ──────────────────────────────────────────────

export interface AttachOwnerEvidenceInput {
  readonly taskId: string;
  /** The Owner-provided selection (base contract fields only). */
  readonly selection: Pick<OwnerEvidenceSelection, 'sourcePainId' | 'sourceNegativeToolCallId' | 'positiveToolCallIds' | 'ownerDesiredOutcome'>;
  /** Operator label (`--decidedBy`); recorded in provenance + audit. */
  readonly decidedBy?: string;
  readonly mode: 'dry_run' | 'confirm';
  /** Injected assembly (production: BehaviorExamplePackAssembler port). */
  readonly assemble: BehaviorEvidencePort;
  /** Workspace root — audit log location. */
  readonly workspaceDir: string;
  readonly eventEmitter: StoreEventEmitter;
  /** Session label for telemetry (e.g. 'pd-cli:evidence'). */
  readonly owner: string;
}

export type OwnerEvidenceAttachOutcome =
  | {
      readonly status: 'dry_run';
      readonly taskId: string;
      /** The selection summary that WOULD be persisted (not written). */
      readonly wouldPersist: {
        readonly revision: number;
        readonly contentDigest: string;
        readonly ownerOperation: string;
        readonly attachedAt: string;
      };
      readonly painId: string;
      readonly nextAction: string;
    }
  | {
      readonly status: 'attached';
      readonly taskId: string;
      readonly revision: number;
      readonly contentDigest: string;
      readonly ownerOperation: string;
      readonly attachedAt: string;
      /** false = attach landed but the task still blocks (always — attach never unblocks). */
      readonly taskStillNeedsHumanReview: true;
      readonly nextAction: string;
    }
  | {
      readonly status: 'refused';
      readonly taskId: string;
      /** Stable reason: FR-04 code or a structural refusal id. */
      readonly reason: string;
      readonly detail?: string;
      readonly missingFields?: readonly string[];
      readonly nextAction: string;
    }
  | {
      readonly status: 'conflict';
      readonly taskId: string;
      readonly nextAction: string;
    };

function ownerOperationLabel(decidedBy: string | undefined): string {
  return decidedBy !== undefined && decidedBy.trim() !== '' ? `cli:attach:${decidedBy.trim()}` : 'cli:attach';
}

async function loadEvidenceTask(
  stateManager: RuntimeStateManager,
  taskId: string,
): Promise<{ ok: true; task: TaskRecord; piTask: PITaskRecord } | { ok: false; refusal: OwnerEvidenceAttachRefusal | OwnerEvidenceResumeRefusal }> {
  const task = await stateManager.getTask(taskId);
  if (!task) {
    return { ok: false, refusal: { status: 'refused', taskId, reason: 'task_not_found', nextAction: 'Verify the task id and workspace (pd runtime internalization queue --json).' } };
  }
  if (task.status !== 'needs_human_review') {
    return {
      ok: false,
      refusal: {
        status: 'refused',
        taskId,
        reason: 'task_not_needs_human_review',
        // PRI-980 review P2-2: name the REAL out-chain — a terminal-failed
        // task (e.g. the run-once input_invalid landing) must first be
        // recovered to pending before the consumer preflight can park it
        // here for evidence attach.
        nextAction: 'Only needs_human_review tasks waiting for Owner evidence accept this operation (pd runtime internalization evidence list). '
          + 'A failed task returns to pending via pd runtime recovery failed-tasks --confirm; the consumer evidence preflight then parks it in needs_human_review for evidence attach.',
      },
    };
  }
  const piTask = hydrateOrNull(task);
  if (!piTask) {
    return {
      ok: false,
      refusal: {
        status: 'refused',
        taskId,
        reason: 'metadata_invalid',
        nextAction: 'Task metadata failed PI hydration; inspect with pd runtime internalization integrity --json before any owner action.',
      },
    };
  }
  const context = piTask.humanReviewContext;
  if (!context || !EVIDENCE_WAIT_REASON_CODES.has(context.reasonCode)) {
    return {
      ok: false,
      refusal: {
        status: 'refused',
        taskId,
        reason: 'not_evidence_review',
        nextAction: 'This needs_human_review task is not an evidence review (verdict/decision tasks use the governance focus or pd runtime internalization retry).',
      },
    };
  }
  return { ok: true, task, piTask };
}

type OwnerEvidenceAttachRefusal = Extract<OwnerEvidenceAttachOutcome, { status: 'refused' }>;
type OwnerEvidenceResumeRefusal = Extract<OwnerEvidenceResumeOutcome, { status: 'refused' }>;

/**
 * FR-03/FR-06 3-6: assemble + validate the Owner selection, then persist it
 * (with revision/contentDigest/ownerOperation/attachedAt) into
 * `pi_metadata.ownerEvidenceSelection` via the narrow diagnosticJson CAS.
 * Dry-run assembles and reports without writing ANY state (cli-5); failures
 * refuse with the stable FR-04 reason codes and zero mutation.
 */
export async function attachOwnerEvidence(
  stateManager: RuntimeStateManager,
  input: AttachOwnerEvidenceInput,
): Promise<OwnerEvidenceAttachOutcome> {
  const loaded = await loadEvidenceTask(stateManager, input.taskId);
  if (loaded.ok === false) return loaded.refusal;
  const { task, piTask } = loaded;
  const canonicalPainId = await resolveArtificerCanonicalPainId(input.taskId, (id) => stateManager.getTask(id));
  if (canonicalPainId === null || canonicalPainId !== input.selection.sourcePainId) {
    return {
      status: 'refused',
      taskId: input.taskId,
      reason: 'owner_behavior_examples_scope_mismatch',
      nextAction: 'Selected Pain must match the task canonical seed Pain; inspect the task lineage before attaching evidence.',
    };
  }

  // One shared judgment: shape → assembly → pack contract (ready ⇒ pack +
  // digest). The shape check runs first even in dry-run so an unusable
  // selection refuses before any assembly I/O.
  const selectionProblems = validateOwnerEvidenceSelectionShape(input.selection);
  if (selectionProblems.length > 0) {
    return {
      status: 'refused',
      taskId: input.taskId,
      reason: 'owner_behavior_examples_invalid',
      detail: selectionProblems.join('; '),
      nextAction: 'Provide a positive safe integer negative tool call id, 1..3 unique positive positive ids, and a non-empty outcome text.',
    };
  }

  const readiness = assessEvidenceReadiness({
    channelRequiresOwnerEvidence: true,
    ownerSelection: input.selection,
    assemblePack: () => input.assemble.assemble(input.selection),
  });
  if (readiness.status !== 'ready') {
    if (readiness.status === 'owner_evidence_required') {
      // Unreachable: the caller provided the selection above.
      return {
        status: 'refused',
        taskId: input.taskId,
        reason: 'owner_behavior_examples_invalid',
        nextAction: 'Provide the complete Owner selection.',
      };
    }
    if (readiness.status === 'not_applicable') {
      return {
        status: 'refused',
        taskId: input.taskId,
        reason: 'owner_behavior_examples_invalid',
        nextAction: 'Evidence gate returned not_applicable — caller bug (channel is hard-required for attach).',
      };
    }
    if (readiness.status === 'evidence_source_error') {
      // PRI-980 review P2-1 (SPEC §6.2 case 3): a trajectory-store I/O fault
      // is not an Owner evidence fault — the refusal carries the storage
      // reason verbatim and mutates nothing (attach is zero-mutation until
      // its CAS anyway; cli-5).
      return {
        status: 'refused',
        taskId: input.taskId,
        reason: readiness.reason,
        detail: readiness.detail,
        nextAction: readiness.nextAction,
      };
    }
    return {
      status: 'refused',
      taskId: input.taskId,
      reason: readiness.reasonCode,
      detail: readiness.detail,
      nextAction: readiness.nextAction,
    };
  }

  const previousRevision = piTask.ownerEvidenceSelection?.revision ?? 0;
  const revision = previousRevision + 1;
  const ownerOperation = ownerOperationLabel(input.decidedBy);
  const attachedAt = new Date().toISOString();
  const persisted: OwnerEvidenceSelection = {
    ...input.selection,
    revision,
    contentDigest: readiness.evidenceHash,
    ownerOperation,
    attachedAt,
  };

  if (input.mode === 'dry_run') {
    return {
      status: 'dry_run',
      taskId: input.taskId,
      painId: persisted.sourcePainId,
      wouldPersist: {
        revision,
        contentDigest: readiness.evidenceHash,
        ownerOperation,
        attachedAt,
      },
      nextAction: 'Dry-run only — nothing was written. Re-run with --confirm to attach this selection (the task stays needs_human_review until evidence resume --confirm).',
    };
  }

  // Narrow CAS: single conditional UPDATE on diagnostic_json (status untouched
  // — attach must not unblock). A concurrent writer between our read and write
  // makes us lose the CAS and refuse observably instead of clobbering.
  const merged = mergePITaskMetadata(piTask, { ownerEvidenceSelection: persisted });
  const updated = await stateManager.updateTaskIfDiagnosticJsonUnchanged(
    input.taskId,
    readDiagnosticJson(task),
    { diagnosticJson: createPITaskDiagnosticJson(merged) },
    { expectedStatus: 'needs_human_review' },
  );
  if (!updated) {
    return {
      status: 'conflict',
      taskId: input.taskId,
      nextAction: 'The task row changed concurrently; re-run evidence list / attach (the CAS refused this write — nothing was mutated).',
    };
  }

  // Read-back invariant (EP-07): only a durable effect may be reported.
  const reread = await stateManager.getTask(input.taskId);
  const rereadPi = reread ? hydrateOrNull(reread) : null;
  if (reread === null || rereadPi === null || rereadPi.ownerEvidenceSelection?.revision !== revision
    || rereadPi.ownerEvidenceSelection.contentDigest !== readiness.evidenceHash) {
    throw new PDRuntimeError(
      'storage_unavailable',
      `owner evidence attach not durable for task ${input.taskId} (read-back revision/digest mismatch)`,
    );
  }

  appendOwnerEvidenceAction(input.workspaceDir, {
    taskId: input.taskId,
    action: 'attach_evidence',
    painId: persisted.sourcePainId,
    revision,
    contentDigest: readiness.evidenceHash,
    operator: input.decidedBy ?? null,
  });

  input.eventEmitter.emitTelemetry({
    eventType: 'artificer_owner_evidence_attached',
    traceId: input.taskId,
    timestamp: attachedAt,
    sessionId: input.owner,
    agentId: 'artificer',
    payload: {
      // FR-08 run-correlation block (PRI-984): attach never leases an NHR
      // task → persistentRunId/adapterRunId are semantically absent.
      ...buildArtificerRunCorrelation({
        taskId: input.taskId,
        attemptNumber: task.attemptCount, // attach never touches the budget — real value at write time
        executionMode: 'recovery',
        reasonCode: 'attached', // no failure reason code exists → the operation status
        workspaceDir: input.workspaceDir,
        evidenceDigest: readiness.evidenceHash,
      }),
      painId: persisted.sourcePainId,
      revision,
      contentDigest: readiness.evidenceHash,
      ownerOperation,
      taskStillNeedsHumanReview: true,
    },
  });

  return {
    status: 'attached',
    taskId: input.taskId,
    revision,
    contentDigest: readiness.evidenceHash,
    ownerOperation,
    attachedAt,
    taskStillNeedsHumanReview: true,
    nextAction: 'Selection attached (task still needs_human_review). Verify with evidence resume (dry-run), then execute: pd runtime internalization evidence resume --task <taskId> --confirm.',
  };
}

// ── resume (FR-06 7/8 + §6.3 concurrency) ───────────────────────────────────

export interface ResumeOwnerEvidenceInput {
  readonly taskId: string;
  readonly decidedBy?: string;
  readonly mode: 'dry_run' | 'confirm';
  readonly assemble: BehaviorEvidencePort;
  readonly workspaceDir: string;
  readonly eventEmitter: StoreEventEmitter;
  readonly owner: string;
}

export type OwnerEvidenceResumeOutcome =
  | {
      readonly status: 'dry_run';
      readonly taskId: string;
      readonly reasonCode: OwnerEvidenceReasonCode | 'owner_behavior_examples_verified';
      readonly previousAttemptCount: number;
      readonly revision: number;
      readonly contentDigest: string;
      readonly painId: string;
      readonly nextAction: string;
    }
  | {
      readonly status: 'resumed';
      readonly taskId: string;
      readonly previousStatus: 'needs_human_review';
      readonly newStatus: 'pending';
      readonly previousAttemptCount: number;
      readonly revision: number;
      readonly contentDigest: string;
      readonly nextAction: string;
    }
  | {
      readonly status: 'refused';
      readonly taskId: string;
      readonly reason: string;
      readonly detail?: string;
      readonly nextAction: string;
    }
  | {
      readonly status: 'conflict';
      readonly taskId: string;
      readonly nextAction: string;
    };

/**
 * FR-06 7/8: digest-verified, atomic, single-authority recovery.
 *
 * Sequence: NHR + evidence-code gate → stored selection present → re-assemble
 * through the shared readiness judgment → digest comparison (mismatch ⇒
 * `owner_behavior_examples_stale`, missing digest ⇒ `invalid`) → ONE
 * conditional authority reset via `ownerRetryNeedsHumanReviewTask` (CAS
 * option; loser gets `conflict`). Run history / audit records are never
 * deleted; the attempt budget reset is explicit and audited (see header).
 */
export async function resumeOwnerEvidenceTask(
  stateManager: RuntimeStateManager,
  input: ResumeOwnerEvidenceInput,
): Promise<OwnerEvidenceResumeOutcome> {
  const loaded = await loadEvidenceTask(stateManager, input.taskId);
  if (loaded.ok === false) return loaded.refusal;
  const { task, piTask } = loaded;
  const previousAttemptCount = task.attemptCount;

  const selection = piTask.ownerEvidenceSelection;
  if (selection === undefined) {
    return {
      status: 'refused',
      taskId: input.taskId,
      reason: 'owner_behavior_examples_required',
      nextAction: 'No evidence selection is attached yet; run evidence attach (dry-run by default) first.',
    };
  }

  const canonicalPainId = await resolveArtificerCanonicalPainId(input.taskId, (id) => stateManager.getTask(id));
  if (canonicalPainId === null || canonicalPainId !== selection.sourcePainId) {
    return {
      status: 'refused',
      taskId: input.taskId,
      reason: 'owner_behavior_examples_scope_mismatch',
      nextAction: 'Owner evidence does not match the canonical task Pain; re-attach evidence for this task lineage.',
    };
  }
  const readiness = assessEvidenceReadiness({
    channelRequiresOwnerEvidence: true,
    ownerSelection: selection,
    assemblePack: () => input.assemble.assemble(selection),
  });
  if (readiness.status !== 'ready') {
    if (readiness.status === 'owner_evidence_required' || readiness.status === 'not_applicable') {
      return {
        status: 'refused',
        taskId: input.taskId,
        reason: 'owner_behavior_examples_invalid',
        nextAction: 'Stored selection is unusable; re-attach with evidence attach --confirm.',
      };
    }
    if (readiness.status === 'evidence_source_error') {
      // PRI-980 review P2-1 (SPEC §6.2 case 3): a storage fault during the
      // re-assembly must not read as a stale/invalid Owner selection. The
      // task STAYS needs_human_review with its existing owner-fault reason
      // untouched — the refusal reports the storage reason so the operator
      // can retry when the store recovers.
      return {
        status: 'refused',
        taskId: input.taskId,
        reason: readiness.reason,
        detail: readiness.detail,
        nextAction: readiness.nextAction,
      };
    }
    return {
      status: 'refused',
      taskId: input.taskId,
      reason: readiness.reasonCode,
      detail: readiness.detail,
      nextAction: readiness.nextAction,
    };
  }

  if (selection.contentDigest === undefined) {
    return {
      status: 'refused',
      taskId: input.taskId,
      reason: 'owner_behavior_examples_invalid',
      detail: 'stored selection carries no contentDigest (legacy pre-B1 record); resume cannot verify it',
      nextAction: 'Re-attach the selection with evidence attach --confirm (this upgrades it to a digest-verified revision), then resume.',
    };
  }
  if (readiness.evidenceHash !== selection.contentDigest) {
    return {
      status: 'refused',
      taskId: input.taskId,
      reason: 'owner_behavior_examples_stale',
      detail: `re-assembled digest ${readiness.evidenceHash} != stored ${selection.contentDigest}`,
      nextAction: 'Evidence content changed since attach; re-attach fresh examples with evidence attach --confirm, then resume.',
    };
  }

  if (input.mode === 'dry_run') {
    return {
      status: 'dry_run',
      taskId: input.taskId,
      reasonCode: 'owner_behavior_examples_verified',
      previousAttemptCount,
      revision: selection.revision ?? 0,
      contentDigest: selection.contentDigest,
      painId: selection.sourcePainId,
      nextAction: 'Digest verified — nothing was written. Re-run with --confirm to atomically requeue this task (attempt budget resets; the reset is audited with previousAttemptCount).',
    };
  }

  // Single recovery authority (owner-retry.ts) with the B1 CAS precondition:
  // at most one concurrent resume can win (T06); the loser gets `conflict`
  // with the row untouched.
  const retryOutcome = await ownerRetryNeedsHumanReviewTask(stateManager, input.taskId, {
    expectedDiagnosticJson: readDiagnosticJson(task),
  });

  if (retryOutcome.status === 'conflict') {
    return {
      status: 'conflict',
      taskId: input.taskId,
      nextAction: 'Another writer changed the task concurrently (possible parallel resume); inspect status and re-run evidence resume if still appropriate.',
    };
  }
  if (retryOutcome.status === 'rejected') {
    return {
      status: 'refused',
      taskId: input.taskId,
      reason: retryOutcome.reason,
      nextAction: 'This task awaits an Owner decision (governance focus) — recover is not a governance exit.',
    };
  }
  if (retryOutcome.status === 'metadata_invalid') {
    return {
      status: 'refused',
      taskId: input.taskId,
      reason: 'metadata_invalid',
      nextAction: 'Task metadata failed PI hydration mid-resume; inspect pd runtime internalization integrity --json.',
    };
  }
  if (retryOutcome.status !== 'requeued') {
    // not_found / skipped: state moved between our read and the authority.
    return {
      status: 'conflict',
      taskId: input.taskId,
      nextAction: `Task state changed concurrently (authority outcome: ${retryOutcome.status}); inspect with evidence list and re-run if appropriate.`,
    };
  }

  appendOwnerEvidenceAction(input.workspaceDir, {
    taskId: input.taskId,
    action: 'resume_evidence',
    painId: selection.sourcePainId,
    revision: selection.revision ?? 0,
    contentDigest: selection.contentDigest,
    previousAttemptCount,
    operator: input.decidedBy ?? null,
  });

  const resumedAt = new Date().toISOString();
  input.eventEmitter.emitTelemetry({
    eventType: 'artificer_owner_evidence_resumed',
    traceId: input.taskId,
    timestamp: resumedAt,
    sessionId: input.owner,
    agentId: 'artificer',
    payload: {
      // FR-08 run-correlation block (PRI-984): the resume requeues to
      // pending; the next attempt's run row is minted by the NEXT lease
      // (deterministic `run_<taskId>_<max+1>`), so persistentRunId stays
      // absent here and the correlation joins through
      // (taskId, attemptNumber) — proven by the recovery T10 test.
      ...buildArtificerRunCorrelation({
        taskId: input.taskId,
        // PRI-984/F-1 wording: this is the WRITE-TIME value the authority
        // reset landed (attemptCount=0). It is NOT "a new budget start" — the
        // NEXT lease renumbers attempt_count from run history
        // (lease-manager.ts, T10 pins the renumbered value). The correlation
        // join keys on this write-time value.
        attemptNumber: 0,
        executionMode: 'recovery',
        reasonCode: 'owner_behavior_examples_verified',
        workspaceDir: input.workspaceDir,
        evidenceDigest: selection.contentDigest,
      }),
      painId: selection.sourcePainId,
      revision: selection.revision ?? 0,
      contentDigest: selection.contentDigest,
      previousAttemptCount,
      ownerOperation: input.decidedBy !== undefined && input.decidedBy.trim() !== '' ? `cli:resume:${input.decidedBy.trim()}` : 'cli:resume',
    },
  });

  return {
    status: 'resumed',
    taskId: input.taskId,
    previousStatus: 'needs_human_review',
    newStatus: 'pending',
    previousAttemptCount,
    revision: selection.revision ?? 0,
    contentDigest: selection.contentDigest,
    nextAction: 'Task requeued with its full history; the evidence-aware auto-consumer picks up Code Rule tasks. run-once is not an evidence-capable execution entry. The attempt budget reset is audited.',
  };
}
