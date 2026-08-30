/**
 * Observation Resolver — PRI-446 (migrated from the plugin adapter)
 *
 * Unified source-kind resolution from RawObservation.
 *
 * Pure data mapping — no I/O, no plugin imports, no side effects. This module
 * replaces the scattered resolveSourceKindFrom* helpers that previously lived in
 * the plugin-side raw-observation-adapter.ts. The plugin file now re-exports
 * these symbols so existing callers and source-string characterization tests
 * keep working unchanged.
 *
 * Field precedence (highest to lowest):
 * 1. isManualEntry → owner_reported
 * 2. isGateBlock → rulehost_block
 * 3. isSubagentError → subagent_error
 * 4. isRateLimit → rate_limit / provider_failure
 * 5. toolName === 'pain' / 'skill:pain' → agent_on_owner_request / owner_reported
 * 6. isGfiTriggered → gfi_threshold
 * 7. failureSource → tool_failure / dispatch_error
 * 8. detectionSource → llm_paralysis / semantic / empathy_inferred / unknown
 * 9. Fallback → unknown
 *
 * ERR checklist:
 * - ERR-001: Source kind resolved from runtime values, no `as` casts.
 * - ERR-002: Every path returns a valid SourceKind (fallback to 'unknown').
 * - EP-01: Runtime values validated before use.
 */

import type { SourceKind } from './types.js';

// ── RawObservation (PRI-362) ────────────────────────────────────────────────

/**
 * Raw observation from a source adapter.
 *
 * This is the input to resolveSourceKind. It contains all possible
 * context fields that different sources may provide. The resolver
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
  readonly provenance?: 'host_context_bound' | 'owner_reported_no_host_trace' | 'automatic_hook';

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

// ── Source Kind Resolution ──────────────────────────────────────────────────

/**
 * Resolve SourceKind from a unified RawObservation.
 *
 * This function replaces the scattered resolveSourceKindFrom* functions
 * and provides a single entry point for source-kind classification.
 *
 * Field precedence is explicitly defined in the function body to ensure
 * deterministic behavior and make the logic easy to understand and test.
 */
export function resolveSourceKind(observation: RawObservation): SourceKind {
  const {
    isManualEntry,
    isGateBlock,
    isSubagentError,
    isRateLimit,
    toolName,
    failureSource,
    isGfiTriggered,
    detectionSource,
    nonZeroExit,
    timedOut,
    toolNotFound,
  } = observation;

  // Priority 1: Manual entry (CLI, owner-reported)
  if (isManualEntry) {
    return 'owner_reported';
  }

  // Priority 2: Gate block
  if (isGateBlock) {
    return 'rulehost_block';
  }

  // Priority 3: Subagent error
  if (isSubagentError) {
    return 'subagent_error';
  }

  // Priority 4: Provider rate limit (explicit true/false)
  if (isRateLimit === true) {
    return 'rate_limit';
  }
  if (isRateLimit === false) {
    return 'provider_failure';
  }

  // Priority 5: Manual pain tool
  if (toolName === 'pain' || toolName === 'skill:pain') {
    // Match resolveSourceKindFromToolFailure behavior:
    // host context bound (incl. legacy openclaw_context_bound) → agent_on_owner_request
    // other provenance or undefined → owner_reported
    if (observation.provenance === 'host_context_bound') {
      return 'agent_on_owner_request';
    }
    return 'owner_reported';
  }

  // Priority 6: GFI threshold (must check before failure source for LLM detection path)
  if (isGfiTriggered) {
    return 'gfi_threshold';
  }

  // Priority 7: Tool failure / dispatch error
  if (failureSource) {
    // Match resolveSourceKindFromToolFailure behavior:
    // dispatch_error → dispatch_error, anything else → tool_failure
    if (failureSource === 'dispatch_error') {
      return 'dispatch_error';
    }
    return 'tool_failure';
  }

  // Infer failureSource from tool failure indicators if not explicitly set
  if (toolNotFound) {
    return 'dispatch_error';
  }

  // Match classifyToolFailureSource behavior: unknown tool name → dispatch_error
  // BUT only if this looks like a tool failure context (has other tool fields)
  // Otherwise, this is likely a non-tool observation (e.g., LLM detection)
  const hasToolContext = toolName !== undefined || nonZeroExit || timedOut || toolNotFound;
  if (hasToolContext && (!toolName || toolName.trim() === '')) {
    return 'dispatch_error';
  }

  // Exit code-based detection: non-zero exit or timeout → tool_failure
  if (nonZeroExit || timedOut) {
    return 'tool_failure';
  }

  // Priority 8: LLM detection source
  if (detectionSource) {
    // Match resolveSourceKindFromLlmDetection behavior:
    if (detectionSource === 'llm_paralysis') {
      return 'llm_paralysis';
    }
    if (detectionSource.startsWith('llm_')) {
      return 'semantic';
    }
    if (detectionSource === 'user_empathy') {
      return 'empathy_inferred';
    }
  }

  // Fallback: unknown
  return 'unknown';
}

// ── Builder Functions ──────────────────────────────────────────────────────
//
// PRI-360 S1: These builders construct RawObservation from specific contexts,
// centralizing source classification rules in the adapter layer.
// Hooks should NOT hold source classification logic — use these builders.

/**
 * Classify error message as dispatch_error vs tool_failure.
 *
 * This centralizes the regex-based classification that was previously
 * scattered in classifyToolFailureSource and after-tool-call-helpers.
 * Now hooks call this builder + resolveSourceKind instead of holding rules.
 */
function classifyErrorForDispatch(error: unknown): 'dispatch_error' | 'tool_failure' {
  if (!error) return 'tool_failure';
  const msg = String(error);
  if (/\btool\s+(?:\S+\s+)?not\s+found\b/i.test(msg) || /\bunknown\s+tool\b/i.test(msg)) {
    return 'dispatch_error';
  }
  return 'tool_failure';
}

/**
 * Build a RawObservation for a tool failure context.
 *
 * This replaces classifyToolFailureSource and the inline classification
 * in after-tool-call-helpers. All tool error → dispatch/tool_failure
 * classification is centralized here.
 */
export function buildToolFailureObservation(options: {
  toolName: string | undefined;
  error: unknown;
  exitCode?: number;
  provenance?: RawObservation['provenance'];
}): RawObservation {
  const { toolName, error, provenance } = options;
  const nonZeroExit = typeof options.exitCode === 'number' && options.exitCode !== 0;

  // Classify dispatch vs tool_failure centrally
  let failureSource: 'dispatch_error' | 'tool_failure' | undefined;

  if (!toolName || toolName.trim() === '') {
    // Empty/whitespace tool name → dispatch error
    failureSource = 'dispatch_error';
  } else {
    failureSource = classifyErrorForDispatch(error);
  }

  // If neither error nor non-zero exit, this is not a failure context
  if (!error && !nonZeroExit) {
    failureSource = undefined;
  }

  return {
    observedAt: new Date().toISOString(),
    toolName,
    failureSource,
    nonZeroExit,
    provenance,
  };
}

/**
 * Build a RawObservation for an LLM detection context.
 */
export function buildLlmDetectionObservation(options: {
  detectionSource: string;
  isGfiTriggered: boolean;
}): RawObservation {
  return {
    observedAt: new Date().toISOString(),
    detectionSource: options.detectionSource,
    isGfiTriggered: options.isGfiTriggered,
  };
}

/**
 * Build a RawObservation for an empathy/GFI-triggered context (PRI-454).
 *
 * Used by prompt.ts paths 2 and 3 (GFI threshold crossing + empathy keyword match).
 * When isGfiTriggered=true, resolveSourceKind returns 'gfi_threshold' (evidence_only).
 * When isGfiTriggered=false, resolveSourceKind returns 'empathy_inferred' (owner_confirm).
 */
export function buildEmpathyObservation(options: {
  detectionSource: string;
  isGfiTriggered: boolean;
  sessionId?: string;
}): RawObservation {
  return {
    observedAt: new Date().toISOString(),
    detectionSource: options.detectionSource,
    isGfiTriggered: options.isGfiTriggered,
    sessionId: options.sessionId,
  };
}

/**
 * Build a RawObservation for a manual pain entry (PRI-454).
 *
 * Used by pain.ts path 5 (manual /pd-pain command).
 * resolveSourceKind returns 'owner_reported' (triage: admit).
 */
export function buildManualPainObservation(options: {
  sessionId?: string;
}): RawObservation {
  return {
    observedAt: new Date().toISOString(),
    isManualEntry: true,
    sessionId: options.sessionId,
  };
}
