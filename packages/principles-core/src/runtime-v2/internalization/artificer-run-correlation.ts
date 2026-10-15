/**
 * PRI-984 (SPEC-PD-IAER-001 FR-08) — the unified run-correlation payload
 * block shared by the Artificer evidence telemetry emitters (the A2 consumer
 * preflight and the B1 Owner evidence recovery are the only current writers;
 * this module is the single definition of the contract, not a mechanism).
 *
 * FR-08: every key event must be traceable to its authoritative task and run
 * through stable references. The correlation block carried by
 * `artificer_evidence_readiness_checked`, `artificer_blocked_on_owner_evidence`,
 * `artificer_owner_evidence_attached` and `artificer_owner_evidence_resumed`:
 *
 *   taskId               — always present (joins tasks.task_id).
 *   attemptNumber        — always present: the task's attemptCount at event
 *                          write time (the real value; after a resume that is
 *                          the new budget start certified by the authority
 *                          reset, i.e. 0).
 *   workspace            — the workspaceDir when the caller has one (both
 *                          production paths do); the key is omitted when a
 *                          direct caller has no workspace context — never a
 *                          placeholder.
 *   agentKind            — 'artificer' constant.
 *   executionMode        — FR-08 vocabulary ('l2' | 'l1' | 'preflight' |
 *                          'recovery') resolved by the event's real
 *                          semantics: the evidence gate and the Owner
 *                          recovery operations run pre-execution
 *                          ('preflight' / 'recovery').
 *   reasonCode           — a stable FR-04 evidence code where one exists,
 *                          otherwise the operation status ('ready' /
 *                          'attached').
 *   evidenceDigestPrefix — the first 12 characters of the behavior-pack
 *                          contentDigest when a digest exists — an auditable
 *                          reference that never carries pack content or the
 *                          private trajectory behind it (rc-8). Absent when
 *                          no pack was assembled (blocks).
 *
 * persistentRunId / adapterRunId are DELIBERATELY never emitted by these
 * events, and the absence is semantic, not an omission:
 *   - persistentRunId (runs.run_id, minted as `run_<taskId>_<attempt>` by the
 *     lease transaction, lease-manager.ts) does not exist at any of these
 *     emit points: the consumer cycle drives the preflight against a dry-run
 *     wake (no lease → zero run rows — pinned by the host T01 test), a
 *     needs_human_review task cannot be leased (attach), and resume only
 *     requeues to pending — the next attempt's run row is minted by the NEXT
 *     lease under the deterministic `run_<taskId>_<max+1>` spelling, which
 *     joins this event through (taskId, attemptNumber) — proven end-to-end on
 *     real SQLite by the recovery T10 test.
 *   - adapterRunId (RunHandle.runId) exists only inside a live runtime
 *     invocation; none of these events invokes one.
 * Fabricating placeholder ids would break FR-08's auditability, so the keys
 * are omitted and the absence is pinned by tests.
 *
 * rc-1/rc-2/rc-8: every field is a bounded, caller-validated scalar from an
 * already-guarded source (TaskRecord / readiness verdict / validated
 * selection) — no unknown spreads, no raw tool output, no private
 * trajectories.
 *
 * Spec: docs/specs/SPEC-PD-IAER-001-v1.0.md §5 FR-08, §12 AC-09
 */

/** FR-08 executionMode vocabulary, resolved per event by real semantics. */
export type ArtificerExecutionMode = 'l2' | 'l1' | 'preflight' | 'recovery';

/** rc-8: digest references stay a fixed bounded prefix. */
const DIGEST_PREFIX_LENGTH = 12;

export interface ArtificerRunCorrelationInput {
  readonly taskId: string;
  /**
   * The task's attemptCount at event-write time — the real value, never
   * derived or defaulted (after a resume: the new budget start, 0).
   */
  readonly attemptNumber: number;
  readonly executionMode: ArtificerExecutionMode;
  /** Stable FR-04 evidence code, or the operation status when none exists. */
  readonly reasonCode: string;
  /** Workspace root; the key is omitted when the caller has none. */
  readonly workspaceDir?: string;
  /** Full `sha256:<hex>` pack digest; emitted as a bounded prefix when present. */
  readonly evidenceDigest?: string;
}

/**
 * Build the FR-08 run-correlation payload block. Fields are explicit
 * (rc-1/rc-3): only defined values enter the payload, and every absent key
 * carries its documented absent semantics.
 */
export function buildArtificerRunCorrelation(input: ArtificerRunCorrelationInput): Record<string, unknown> {
  return {
    taskId: input.taskId,
    attemptNumber: input.attemptNumber,
    ...(input.workspaceDir !== undefined ? { workspace: input.workspaceDir } : {}),
    agentKind: 'artificer' as const,
    executionMode: input.executionMode,
    reasonCode: input.reasonCode,
    ...(input.evidenceDigest !== undefined
      ? { evidenceDigestPrefix: input.evidenceDigest.slice(0, DIGEST_PREFIX_LENGTH) }
      : {}),
  };
}
