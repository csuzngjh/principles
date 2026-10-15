/**
 * PRI-982 (SPEC-PD-IAER-001 FR-02 / FR-04) — consumer evidence preflight.
 *
 * The authoritative PRE-MODEL gate for Artificer tasks on the
 * `code_tool_hook` channel, invoked by the shared consumer cycle BEFORE any
 * runner construction:
 *
 *   1. no `behaviorEvidence` port injected by the host → the evidence source
 *      itself is unavailable. This is a HOST ASSEMBLY GAP, not "Owner has not
 *      labeled" (SPEC §6.2) → `evidence_source_unavailable`, task untouched;
 *      the caller must keep the task pending and degrade OBSERVABLY.
 *   2. otherwise the ONE shared judgment (`assessEvidenceReadiness`, FR-01)
 *      decides:
 *        - ready            → the pack rides into the ArtificerRunner deps;
 *        - required/invalid → atomic `needs_human_review` transition
 *          (evaluator-runner NHR precedent: humanReviewContext written in the
 *          SAME metadata mutation, read-back invariant, CAS via
 *          `updateTaskIfDiagnosticJsonUnchanged` against concurrent
 *          consumers). NO run record, NO attemptCount consumption, NO LLM
 *          call, NO retry — and since needs_human_review is outside the
 *          consumer wake scan (pending/retry_wait only), the task is never
 *          auto-rewoken (FR-05/T02).
 *
 * Reason codes are the stable FR-04 IDs. Assembly failures surface as
 * `owner_behavior_examples_invalid` today — the plugin assembler owns
 * scope/staleness rejection and does not yet carry structured stale/scope
 * codes (evidence-readiness.ts contract); refining that mapping is B1 scope.
 *
 * Telemetry: the two events are registered in the telemetry-event union in
 * the same change (ERR-060: unregistered names are silently rewritten to
 * `degradation_triggered`). `artificer_blocked_on_owner_evidence` is
 * Owner-recovery evidence that must survive a crash — the host wires this
 * emitter through WorkspaceTelemetryEmitter so it lands in the critical
 * allowlist sink. Both payloads carry the unified FR-08 run-correlation
 * block (PRI-984, artificer-run-correlation.ts); persistentRunId /
 * adapterRunId are semantically absent here — the gate fires pre-lease, so
 * no run row or runtime invocation exists.
 *
 * rc-1/rc-2: the selection arrives from parsed diagnosticJson (already
 * guarded by pitask-metadata parse) and the assembled pack is re-validated by
 * the shared validator inside the readiness gate — no `as` bypass.
 * rc-8: failure details are bounded before they enter payloads.
 * rc-9: every non-ready outcome carries reasonCode + nextAction.
 *
 * Spec: docs/specs/SPEC-PD-IAER-001-v1.0.md §5 FR-02, §6.1/§6.2
 */
import type { BehaviorExamplePack } from './behavior-example-pack.js';
import {
  assessEvidenceReadiness,
  type OwnerEvidenceReasonCode,
  type OwnerEvidenceSelection,
} from './evidence-readiness.js';
import { buildArtificerRunCorrelation } from './artificer-run-correlation.js';
import { PDRuntimeError } from '../error-categories.js';
import type { StoreEventEmitter } from '../store/event-emitter.js';
import type { RuntimeStateManager } from '../store/runtime-state-manager.js';
import type { PITaskRecord } from './peer-runner-contracts.js';
import type { HumanReviewContext } from './pitask-metadata.js';
import { createPITaskDiagnosticJson, mergePITaskMetadata } from './pitask-metadata.js';

/**
 * Lineage marker for preflight NHR transitions. Honest by construction: this
 * is NOT a persisted run id (`run_<taskId>_<attempt>` spelling is reserved
 * for lease-minted runs — there is no run for a pure preflight block), and
 * consumer-side recovery classification treats unknown reasonCodes as
 * recovery-type review, which never resolves artifacts through sourceRunId.
 */
export const ARTIFICER_EVIDENCE_NHR_SOURCE_RUN_ID = 'evidence-preflight';

/** Host-injected evidence assembly port (production: BehaviorExamplePackAssembler). */
export interface BehaviorEvidencePort {
  /**
   * Assemble a validated BehaviorExamplePack from the Owner selection.
   * Throws on any gap (missing pain, session-mismatched rows, invalid pack)
   * — ERR-069 fail-loud convention; the gate captures the throw as
   * `invalid_evidence`.
   */
  assemble(selection: OwnerEvidenceSelection): BehaviorExamplePack;
}

export type ArtificerEvidencePreflightVerdict =
  | {
      readonly decision: 'ready';
      readonly pack: BehaviorExamplePack;
      /** `sha256:<hex>` content digest of the pack (FR-01 contract). */
      readonly evidenceHash: string;
      readonly sourcePainId: string;
    }
  | {
      readonly decision: 'blocked';
      readonly reasonCode: OwnerEvidenceReasonCode;
      readonly nextAction: string;
      readonly missingFields?: readonly string[];
      readonly detail?: string;
      /**
       * Whether the needs_human_review transition durably landed (CAS +
       * read-back). `false` = a concurrent writer won the diagnosticJson CAS;
       * the caller must still NOT run the task, and surface the lost race
       * observably.
       */
      readonly reviewPersisted: boolean;
    }
  | {
      /** Host assembly gap (port not injected) — task untouched. */
      readonly decision: 'evidence_source_unavailable';
    };

export interface ArtificerEvidencePreflightParams {
  readonly taskId: string;
  /** Hydrated task record (channel already resolved by the caller). */
  readonly piTask: PITaskRecord;
  /** Lease-owner label for telemetry sessionId ('auto-consumer' | …). */
  readonly owner: string;
  /**
   * Workspace root for the FR-08 run-correlation telemetry (PRI-984).
   * Optional: the key is omitted from payloads when a direct caller has no
   * workspace context — the production consumer cycle always provides it.
   */
  readonly workspaceDir?: string;
  readonly stateManager: Pick<RuntimeStateManager, 'getTask' | 'updateTaskIfDiagnosticJsonUnchanged'>;
  readonly eventEmitter: StoreEventEmitter;
  /** Optional: absent = host assembly gap (SPEC §6.2 semantics). */
  readonly behaviorEvidence?: BehaviorEvidencePort;
}

/** rc-8: bounded single-line detail for metadata payloads. */
function boundedDetail(value: string, max = 480): string {
  const flat = value.replace(/\s+/g, ' ').trim();
  return flat.length > max ? `${flat.slice(0, max)}…[truncated]` : flat;
}

/**
 * FR-04: the persisted NHR diagnostics must name the concrete out-edge — the
 * `pd runtime internalization retry --confirm` recovery authority
 * (ownerRetryNeedsHumanReviewTask) and the B1 evidence-attach entry.
 */
function withNhrOutEdge(nextAction: string): string {
  return `${nextAction} Out-edge once evidence is attached (or to abandon this review): pd runtime internalization retry --confirm.`;
}

function readDiagnosticJson(task: PITaskRecord): string | null {
  const raw = (task as unknown as Record<string, unknown>).diagnosticJson;
  return typeof raw === 'string' && raw.trim() !== '' ? raw : null;
}

/**
 * Atomic needs_human_review transition (evaluator-runner NHR precedent):
 * status + humanReviewContext in ONE CAS-guarded metadata write, then the
 * read-back invariant (INV-2 class: only a durable effect may be reported).
 */
async function transitionToNeedsHumanReview(
  params: ArtificerEvidencePreflightParams,
  context: HumanReviewContext,
): Promise<boolean> {
  const { taskId, piTask, stateManager } = params;
  const merged = mergePITaskMetadata(piTask, { humanReviewContext: context });
  const updated = await stateManager.updateTaskIfDiagnosticJsonUnchanged(
    taskId,
    readDiagnosticJson(piTask),
    { status: 'needs_human_review', diagnosticJson: createPITaskDiagnosticJson(merged) },
  );
  if (!updated) {
    return false;
  }
  const current = await stateManager.getTask(taskId);
  if (!current || current.status !== 'needs_human_review') {
    throw new PDRuntimeError(
      'storage_unavailable',
      `needs_human_review effect not durable for task ${taskId} (read-back status: ${current?.status ?? 'task_missing'})`,
    );
  }
  return true;
}

/**
 * Run the evidence readiness preflight for one code_tool_hook Artificer task.
 * The caller owns channel resolution (pi_metadata.channel ===
 * 'code_tool_hook'); this module never re-guesses channels.
 */
export async function preflightArtificerOwnerEvidence(
  params: ArtificerEvidencePreflightParams,
): Promise<ArtificerEvidencePreflightVerdict> {
  const { taskId, piTask, owner, workspaceDir, eventEmitter, behaviorEvidence } = params;

  // 1. Host assembly gap — never misread as "Owner has not labeled" (§6.2).
  if (behaviorEvidence === undefined) {
    return { decision: 'evidence_source_unavailable' };
  }

  const selection = piTask.ownerEvidenceSelection;
  const readiness = assessEvidenceReadiness({
    channelRequiresOwnerEvidence: true,
    ownerSelection: selection ?? null,
    assemblePack: selection !== undefined ? () => behaviorEvidence.assemble(selection) : undefined,
  });

  // Telemetry (FR-08): the gate ran — record the verdict with the unified
  // run-correlation block (PRI-984; persistentRunId/adapterRunId are
  // semantically absent pre-lease, see artificer-run-correlation.ts) + stable
  // reasonCode + bounded references, never raw trajectories. reasonCode is
  // the FR-04 code where one exists, otherwise the gate status itself
  // ('ready'; 'not_applicable' cannot occur for this hard-coded channel gate
  // and throws below).
  eventEmitter.emitTelemetry({
    eventType: 'artificer_evidence_readiness_checked',
    traceId: taskId,
    timestamp: new Date().toISOString(),
    sessionId: owner,
    agentId: 'artificer',
    payload: {
      ...buildArtificerRunCorrelation({
        taskId,
        attemptNumber: piTask.attemptCount,
        executionMode: 'preflight',
        reasonCode: readiness.status === 'owner_evidence_required' || readiness.status === 'invalid_evidence'
          ? readiness.reasonCode
          : readiness.status,
        workspaceDir,
        evidenceDigest: readiness.status === 'ready' ? readiness.evidenceHash : undefined,
      }),
      channel: 'code_tool_hook',
      gateStatus: readiness.status,
      ...(readiness.status === 'owner_evidence_required' ? { missingFields: [...readiness.missingFields] } : {}),
      ...(readiness.status === 'invalid_evidence' ? { detail: boundedDetail(readiness.detail) } : {}),
      ...(readiness.status === 'ready' ? { evidenceHash: readiness.evidenceHash, sourcePainId: readiness.sourcePainId } : {}),
    },
  });

  if (readiness.status === 'ready') {
    return {
      decision: 'ready',
      pack: readiness.pack,
      evidenceHash: readiness.evidenceHash,
      sourcePainId: readiness.sourcePainId,
    };
  }

  if (readiness.status === 'not_applicable') {
    // Unreachable by construction (channelRequiresOwnerEvidence is hard-coded
    // true) — fail loud rather than silently proceeding evidence-less.
    throw new PDRuntimeError('input_invalid', 'evidence preflight returned not_applicable for a code_tool_hook task — channel gate caller bug');
  }

  const blocked: {
    reasonCode: OwnerEvidenceReasonCode;
    nextAction: string;
    missingFields?: readonly string[];
    detail?: string;
  } = readiness.status === 'owner_evidence_required'
    ? {
        reasonCode: readiness.reasonCode,
        nextAction: withNhrOutEdge(readiness.nextAction),
        missingFields: readiness.missingFields,
      }
    : {
        reasonCode: readiness.reasonCode,
        nextAction: withNhrOutEdge(readiness.nextAction),
        detail: boundedDetail(readiness.detail),
      };

  const reviewContext: HumanReviewContext = {
    reasonCode: blocked.reasonCode,
    sourceRunId: ARTIFICER_EVIDENCE_NHR_SOURCE_RUN_ID,
    revisionEpoch: piTask.revisionCount ?? 0,
    detail: boundedDetail(JSON.stringify({
      missingFields: blocked.missingFields,
      ...(blocked.detail !== undefined ? { detail: blocked.detail } : {}),
      nextAction: blocked.nextAction,
    })),
    createdAt: new Date().toISOString(),
  };
  const reviewPersisted = await transitionToNeedsHumanReview(params, reviewContext);

  // Owner-recovery evidence: must be durably observable even if the process
  // dies right after the state transition. Carries the FR-08 correlation
  // block (persistentRunId stays absent: the block happened pre-lease — no
  // run row exists and none may be fabricated).
  eventEmitter.emitTelemetry({
    eventType: 'artificer_blocked_on_owner_evidence',
    traceId: taskId,
    timestamp: new Date().toISOString(),
    sessionId: owner,
    agentId: 'artificer',
    payload: {
      ...buildArtificerRunCorrelation({
        taskId,
        attemptNumber: piTask.attemptCount,
        executionMode: 'preflight',
        reasonCode: blocked.reasonCode,
        workspaceDir,
      }),
      nextAction: blocked.nextAction,
      ...(blocked.missingFields !== undefined ? { missingFields: [...blocked.missingFields] } : {}),
      ...(blocked.detail !== undefined ? { detail: blocked.detail } : {}),
      reviewPersisted,
    },
  });

  return {
    decision: 'blocked',
    reasonCode: blocked.reasonCode,
    nextAction: blocked.nextAction,
    ...(blocked.missingFields !== undefined ? { missingFields: blocked.missingFields } : {}),
    ...(blocked.detail !== undefined ? { detail: blocked.detail } : {}),
    reviewPersisted,
  };
}
