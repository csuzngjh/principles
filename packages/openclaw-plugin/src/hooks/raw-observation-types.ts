/**
 * Raw Observation Types — PRI-362
 *
 * Source adapter layer that normalizes diverse hook contexts into a unified
 * observation model before mapping to SourceKind.
 *
 * This replaces scattered resolveSourceKindFrom* functions with a single
 * field-driven adapter.
 *
 * ERR checklist:
 * - ERR-001: No `as` casts; validate unknown payload field-by-field.
 * - ERR-002: Every decision carries reason + nextAction.
 * - EP-01: Source adapter validates before use.
 */

/**
 * Raw observation from a source adapter.
 *
 * This is the input to resolveSourceKind. It contains all possible
 * context fields that different sources may provide. The adapter
 * reads only the fields it needs based on the observation source.
 */
export interface RawObservation {
  /** When the observation was made (ISO timestamp) */
  readonly observedAt: string;
  /** Workspace identifier */
  readonly workspaceId?: string;
  /** Session identifier */
  readonly sessionId?: string;
  /** Trace identifier for correlation */
  readonly traceId?: string;

  // ── Tool Failure Fields ────────────────────────────────────────────────
  /** Tool name (for after_tool_call hook) */
  readonly toolName?: string;
  /** Failure source classification */
  readonly failureSource?: 'tool_failure' | 'dispatch_error';
  /** Whether the tool call exited with non-zero code */
  readonly nonZeroExit?: boolean;
  /** Whether the tool call timed out */
  readonly timedOut?: boolean;
  /** Whether the tool does not exist */
  readonly toolNotFound?: boolean;

  // ── LLM Detection Fields ───────────────────────────────────────────────
  /** Detection source identifier */
  readonly detectionSource?: string;
  /** Whether GFI threshold was crossed */
  readonly isGfiTriggered?: boolean;

  // ── Provider Fields ───────────────────────────────────────────────────
  /** Whether the failure was a rate limit (429) */
  readonly isRateLimit?: boolean;

  // ── Gate Block Fields ────────────────────────────────────────────────
  /** Whether this observation came from a gate block */
  readonly isGateBlock?: boolean;

  // ── Manual Entry Fields ───────────────────────────────────────────────
  /** Whether this was a manual CLI entry */
  readonly isManualEntry?: boolean;
  /** Provenance: how trustworthy and context-bound is the observation */
  readonly provenance?: 'openclaw_context_bound' | 'owner_reported_no_host_trace' | 'automatic_hook';

  // ── Subagent Fields ───────────────────────────────────────────────────
  /** Whether this observation came from a subagent error */
  readonly isSubagentError?: boolean;

  // ── Raw Payload ──────────────────────────────────────────────────────
  /**
   * Raw payload from the source.
   *
   * This is always `unknown` (ERR-005). Source adapters validate only
   * enough to identify the source and capture bounded context.
   */
  readonly payload?: unknown;
}