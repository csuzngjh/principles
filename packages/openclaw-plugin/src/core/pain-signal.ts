/**
 * Universal PainSignal schema for the Evolution SDK.
 *
 * This module defines a framework-agnostic pain signal that any AI agent
 * framework can produce. It extends the existing PainFlagData format with
 * additional structured fields (domain, severity, context) needed for
 * cross-workspace evolution and multi-domain support.
 *
 * Validation uses @sinclair/typebox to match existing project patterns.
 */
import { Type, type Static } from '@sinclair/typebox';
import { Value } from '@sinclair/typebox/value';

// ---------------------------------------------------------------------------
// PainSignal Schema
// ---------------------------------------------------------------------------

/**
 * Severity levels derived from pain score thresholds.
 * - low:      0-39  (minor issue, informational)
 * - medium:   40-69 (moderate error)
 * - high:     70-89 (severe violation)
 * - critical: 90-100 (systemic failure, spiral detected)
 */
export const PainSeverity = Type.Union([
  Type.Literal('low'),
  Type.Literal('medium'),
  Type.Literal('high'),
  Type.Literal('critical'),
]);

export type PainSeverity = Static<typeof PainSeverity>;

/**
 * TypeBox schema for a universal pain signal.
 *
 * Every signal MUST have: source, score, timestamp, reason, sessionId,
 * agentId, traceId, triggerTextPreview. Optional fields (domain, severity,
 * context) default during validation.
 */
export const PainSignalSchema = Type.Object({
  /** What triggered this pain signal (e.g., 'tool_failure', 'human_intervention') */
  source: Type.String({ minLength: 1 }),
  /** Pain score 0-100 */
  score: Type.Number({ minimum: 0, maximum: 100 }),
  /** ISO 8601 timestamp */
  timestamp: Type.String({ minLength: 1 }),
  /** Human-readable reason / error description */
  reason: Type.String({ minLength: 1 }),
  /** Session ID — identifies which conversation this happened in */
  sessionId: Type.Optional(Type.String()),
  /** Agent ID — identifies which agent (main, builder, diagnostician, etc.) */
  agentId: Type.Optional(Type.String()),
  /** Correlation trace ID for linking events across the pipeline */
  traceId: Type.Optional(Type.String()),
  /** Preview of the text that triggered this pain */
  triggerTextPreview: Type.String(),
  /** Domain context (e.g., 'coding', 'writing', 'analysis') */
  domain: Type.String({ default: 'coding' }),
  /** Severity level derived from score */
  severity: PainSeverity,
  /** Additional structured context payload */
  context: Type.Record(Type.String(), Type.Unknown()),
});

export type PainSignal = Static<typeof PainSignalSchema>;

// ---------------------------------------------------------------------------
// Default Derivation
// ---------------------------------------------------------------------------

/**
 * Derives severity from a numeric pain score.
 */
export function deriveSeverity(score: number): PainSeverity {
  if (score >= 90) return 'critical';
  if (score >= 70) return 'high';
  if (score >= 40) return 'medium';
  return 'low';
}

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

export interface PainSignalValidationResult {
  valid: boolean;
  errors: string[];
  signal?: PainSignal;
}

/**
 * Validates an arbitrary object against the PainSignal schema.
 *
 * Returns a structured result with:
 * - `valid`: whether the input conforms to the schema
 * - `errors`: human-readable list of validation failures
 * - `signal`: the typed signal (only present when valid)
 *
 * Missing optional fields (domain, severity, context) are filled with defaults
 * before validation so callers get a fully-formed signal back.
 */
export function validatePainSignal(input: unknown): PainSignalValidationResult {
  if (typeof input !== 'object' || input === null || Array.isArray(input)) {
    return { valid: false, errors: ['Input must be a non-null object'] };
  }

  const raw = input as Record<string, unknown>;

  // Apply defaults for optional fields before validation
  const hydrated = {
    ...raw,
    domain: raw.domain ?? 'coding',
    sessionId: raw.sessionId ?? undefined,
    agentId: raw.agentId ?? undefined,
    traceId: raw.traceId ?? undefined,
    severity: raw.severity ?? deriveSeverity(
      typeof raw.score === 'number' ? raw.score : 0,
    ),
    context: raw.context ?? {},
  };

  // Collect TypeBox errors
  const errors = [...Value.Errors(PainSignalSchema, hydrated)];
  if (errors.length > 0) {
    return {
      valid: false,
      errors: errors.map(
        (e) => `${e.path ? `${e.path}: ` : ''}${e.message}`,
      ),
    };
  }

  return {
    valid: true,
    errors: [],
    signal: Value.Cast(PainSignalSchema, hydrated) as PainSignal,
  };
}
