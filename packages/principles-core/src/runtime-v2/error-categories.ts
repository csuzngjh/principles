/**
 * Canonical error categories for PD Runtime v2.
 *
 * Unified from:
 *   - PD Runtime Protocol SPEC v1, Section 19
 *   - Diagnostician v2 Detailed Design, Section 20
 *   - History Retrieval and Context Assembly SPEC, Section 14
 *
 * All PD components, adapters, CLI commands, and events MUST use these
 * categories instead of inventing local error codes.
 *
 * MIGRATION NOTE:
 *   - openclaw-plugin's TrinityRuntimeFailureCode → superseded
 *   - openclaw-plugin's TaskResolution → superseded (legacy marker-file values kept as legacy-only)
 *   - openclaw-plugin's PdError class hierarchy → may wrap these categories
 */
import { Type, type Static } from '@sinclair/typebox';
import { Value } from '@sinclair/typebox/value';

// ── TypeBox schema for PDErrorCategory ──

export const PDErrorCategorySchema = Type.Union([
  Type.Literal('runtime_unavailable'),
  Type.Literal('capability_missing'),
  Type.Literal('input_invalid'),
  Type.Literal('lease_conflict'),
  Type.Literal('execution_failed'),
  Type.Literal('timeout'),
  Type.Literal('cancelled'),
  Type.Literal('output_invalid'),
  Type.Literal('artifact_commit_failed'),
  Type.Literal('max_attempts_exceeded'),
  Type.Literal('context_assembly_failed'),
  Type.Literal('history_not_found'),
  Type.Literal('trajectory_ambiguous'),
  Type.Literal('storage_unavailable'),
  Type.Literal('workspace_invalid'),
  Type.Literal('query_invalid'),
]);
export type PDErrorCategory = Static<typeof PDErrorCategorySchema>;

/** All valid error category values. Useful for validation. */
export const PD_ERROR_CATEGORIES: readonly PDErrorCategory[] = [
  'runtime_unavailable',
  'capability_missing',
  'input_invalid',
  'lease_conflict',
  'execution_failed',
  'timeout',
  'cancelled',
  'output_invalid',
  'artifact_commit_failed',
  'max_attempts_exceeded',
  'context_assembly_failed',
  'history_not_found',
  'trajectory_ambiguous',
  'storage_unavailable',
  'workspace_invalid',
  'query_invalid',
] as const;

/** Type guard for PDErrorCategory — uses TypeBox Value.Check for runtime validation. */
export function isPDErrorCategory(value: string): value is PDErrorCategory {
  return Value.Check(PDErrorCategorySchema, value);
}

/**
 * Structured PD error carrying a normalized category.
 *
 * Adapters and services should throw or return PDRuntimeError
 * instead of generic Error when operating within runtime-v2 paths.
 */
export class PDRuntimeError extends Error {
  readonly category: PDErrorCategory;
  readonly details?: Record<string, unknown>;

  constructor(category: PDErrorCategory, message: string, details?: Record<string, unknown>) {
    super(`[${category}] ${message}`);
    this.name = 'PDRuntimeError';
    this.category = category;
    this.details = details;
  }
}
