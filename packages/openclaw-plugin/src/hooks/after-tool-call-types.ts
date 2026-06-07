/**
 * After-Tool-Call Decomposition Types — PRI-326
 *
 * Shared types for the decomposed handleAfterToolCall pipeline.
 * These types make the pipeline stages explicit without introducing
 * the larger RawObservation/PainEpisode/PainEvidence architecture.
 *
 * ERR checklist:
 * - ERR-001: No `as` casts in this file; these are type definitions only.
 * - ERR-002: Every decision/result carries structured reason + nextAction.
 * - EP-01: These types document boundaries, not runtime validation targets.
 */

import type { SessionState } from '../core/session-tracker.js';

// ── Tool Call Outcome Classification ────────────────────────────────────────

/**
 * Result of classifying what happened in a tool call event.
 *
 * Pure extraction — no I/O, no side effects.
 */
export interface ToolCallOutcome {
  /** Whether the tool call is considered a failure */
  readonly isFailure: boolean;
  /** Resolved exit code (numeric, 0 if success/absent) */
  readonly exitCode: number;
  /** For failures: classified as 'tool_failure' or 'dispatch_error' */
  readonly failureSource: 'tool_failure' | 'dispatch_error' | undefined;
}

// ── Tool Call Observation ───────────────────────────────────────────────────

/**
 * Normalized observation built from the tool call event and context.
 *
 * Used by friction tracking, event recording, and pain admission.
 * Constructed after classification, before any I/O.
 */
export interface ToolCallObservation {
  /** Tool parameters (typed subset) */
  readonly params: {
    readonly filePath?: string;
    readonly content?: string;
    readonly text?: string;
    readonly newString?: string;
    readonly query?: string;
    readonly input?: string;
    readonly arguments?: string;
  };
  /** File path relative to workspace */
  readonly relPath: string;
  /** Whether the file path is in the risk set */
  readonly isRisk: boolean;
  /** Error type classification string */
  readonly errorType: string;
  /** Denoised, hashed error identifier */
  readonly errorHash: string;
  /** Error text for logging */
  readonly errorText: string;
  /** Pain score (only meaningful for write-tool failures on risky paths) */
  readonly painScore: number;
  /** Trace ID for this observation chain */
  readonly traceId: string;
}

// ── Pain Admission Decision ─────────────────────────────────────────────────

/**
 * Result of evaluating whether a tool failure should trigger pain diagnosis.
 *
 * Encapsulates the combined triage + PainDiagnosticGate decision.
 */
export interface PainAdmissionDecision {
  /** Whether the tool failure should proceed to pain emission */
  readonly admitted: boolean;
  /** The admission stage that made the decision */
  readonly stage: 'triage_evidence_only' | 'gate_rejected' | 'gate_admitted' | 'not_applicable';
  /** Human-readable reason for the decision */
  readonly reason: string;
  /** Detail about the decision */
  readonly detail: string;
  /** The diagnostic gate result (if gate was evaluated) */
  readonly gateResult?: {
    readonly shouldDiagnose: boolean;
    readonly reason: string;
    readonly detail: string;
  };
}

// ── Friction Update Result ──────────────────────────────────────────────────

/**
 * Result of friction tracking for a tool call.
 */
export interface FrictionUpdateResult {
  /** GFI before this update */
  readonly gfiBefore: number;
  /** GFI after this update */
  readonly gfiAfter: number;
  /** Updated session state (if failure) */
  readonly sessionState: SessionState | undefined;
  /** The error hash used for tracking */
  readonly errorHash: string;
}
