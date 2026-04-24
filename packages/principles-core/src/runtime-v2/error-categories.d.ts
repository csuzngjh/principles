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
import { type Static } from '@sinclair/typebox';
export declare const PDErrorCategorySchema: import("@sinclair/typebox").TUnion<[import("@sinclair/typebox").TLiteral<"runtime_unavailable">, import("@sinclair/typebox").TLiteral<"capability_missing">, import("@sinclair/typebox").TLiteral<"input_invalid">, import("@sinclair/typebox").TLiteral<"lease_conflict">, import("@sinclair/typebox").TLiteral<"lease_expired">, import("@sinclair/typebox").TLiteral<"execution_failed">, import("@sinclair/typebox").TLiteral<"timeout">, import("@sinclair/typebox").TLiteral<"cancelled">, import("@sinclair/typebox").TLiteral<"output_invalid">, import("@sinclair/typebox").TLiteral<"artifact_commit_failed">, import("@sinclair/typebox").TLiteral<"max_attempts_exceeded">, import("@sinclair/typebox").TLiteral<"context_assembly_failed">, import("@sinclair/typebox").TLiteral<"history_not_found">, import("@sinclair/typebox").TLiteral<"trajectory_ambiguous">, import("@sinclair/typebox").TLiteral<"storage_unavailable">, import("@sinclair/typebox").TLiteral<"workspace_invalid">, import("@sinclair/typebox").TLiteral<"query_invalid">]>;
export type PDErrorCategory = Static<typeof PDErrorCategorySchema>;
/** All valid error category values. Useful for validation. */
export declare const PD_ERROR_CATEGORIES: readonly PDErrorCategory[];
/** Type guard for PDErrorCategory — uses TypeBox Value.Check for runtime validation. */
export declare function isPDErrorCategory(value: string): value is PDErrorCategory;
/**
 * Structured PD error carrying a normalized category.
 *
 * Adapters and services should throw or return PDRuntimeError
 * instead of generic Error when operating within runtime-v2 paths.
 */
export declare class PDRuntimeError extends Error {
    readonly category: PDErrorCategory;
    readonly details?: Record<string, unknown>;
    constructor(category: PDErrorCategory, message: string, details?: Record<string, unknown>);
}
//# sourceMappingURL=error-categories.d.ts.map