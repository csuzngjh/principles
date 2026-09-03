/**
 * Tool Semantic Registry — PRI-634-F Phase 1 (Tool Semantic Closure)
 *
 * PURPOSE: One authoritative mapping from raw tool names to the closed
 * CanonicalKind enum, so replay and production resolve identical tool
 * semantics for the same raw name.
 *
 * OWNERSHIP (SPEC §5, mirroring the anti-drift note in rule-context-v2.ts):
 *   - core owns the CLOSED CanonicalKind enum + the host-neutral baseline
 *     table (generic LLM vocabulary names, no host-specific tools);
 *   - each host owns its raw tool name list and declares mappings that are
 *     layered on top of the baseline (host wins on conflict);
 *   - core never grows the baseline with host tool names.
 *
 * Pure logic — zero I/O. Runtime Contract: mappings arrive as untrusted
 * `unknown` at the public builder boundary and are validated structurally
 * (rc-1, rc-2, rc-4, rc-5) before use.
 */

import type { CanonicalKind } from './rule-context-v2.js';
import { baselineToolAlias, CANONICAL_KIND_VALUES, isCanonicalKind } from './tool-semantic-baseline.js';

export type { CanonicalKind } from './rule-context-v2.js';

export interface ToolSemanticMappingV1 {
  readonly rawToolName: string;
  readonly canonicalKind: CanonicalKind;
}

/** Resolved registry: closed lookup surface shared by replay and production. */
export interface ToolSemanticRegistry {
  readonly version: 1;
  /**
   * Explicit lookup. Returns `null` when the raw name has no mapping in
   * baseline + host layers — validation contexts use this to fail explicitly
   * (SPEC §9 Tool存在性) instead of silently treating unknown as 'other'.
   */
  lookup(rawToolName: string): CanonicalKind | null;
  /**
   * Runtime lookup with graceful fallback: unknown names resolve to 'other'
   * (same semantics as canonicalizeToolKind — production evaluation must
   * never throw on an unmapped tool name).
   */
  resolve(rawToolName: string): CanonicalKind;
}

export interface ToolSemanticMappingValidationResult {
  readonly valid: boolean;
  readonly errors: readonly string[];
}

const PROTO_KEYS: ReadonlySet<string> = new Set(['__proto__', 'constructor', 'prototype']);

function isPlainObjectLike(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Validate untrusted host mappings (rc-1: unknown until validated; rc-4: every
 * element checked, not just "is array"; rc-5: Object.hasOwn over `in`).
 */
export function validateToolSemanticMappings(raw: unknown): ToolSemanticMappingValidationResult {
  if (!Array.isArray(raw)) {
    return { valid: false, errors: ['toolSemanticMappings must be an array'] };
  }
  const errors: string[] = [];
  const seen = new Map<string, CanonicalKind>();
  raw.forEach((entry: unknown, index: number) => {
    if (!isPlainObjectLike(entry)) {
      errors.push(`toolSemanticMappings[${index}] must be a plain object`);
      return;
    }
    if (!Object.hasOwn(entry, 'rawToolName') || typeof entry.rawToolName !== 'string' || entry.rawToolName.trim() === '') {
      errors.push(`toolSemanticMappings[${index}].rawToolName must be a non-empty string`);
      return;
    }
    if (PROTO_KEYS.has(entry.rawToolName)) {
      errors.push(`toolSemanticMappings[${index}].rawToolName must not be a prototype-pollution key`);
      return;
    }
    const kind: unknown = entry.canonicalKind;
    if (!isCanonicalKind(kind)) {
      errors.push(
        `toolSemanticMappings[${index}].canonicalKind must be one of ${[...CANONICAL_KIND_VALUES].join('|')}, got ${String(kind)}`,
      );
      return;
    }
    // A host may repeat a raw name only with the SAME kind (idempotent
    // declaration); a conflicting duplicate is a declaration defect.
    const previous = seen.get(entry.rawToolName);
    if (previous !== undefined && previous !== kind) {
      errors.push(
        `toolSemanticMappings[${index}]: rawToolName '${entry.rawToolName}' declared twice with conflicting kinds (${previous} vs ${kind})`,
      );
      return;
    }
    seen.set(entry.rawToolName, kind);
  });
  return { valid: errors.length === 0, errors };
}

/**
 * Build the effective registry: host mappings validated then layered over the
 * host-neutral core baseline (host wins on conflict). Returns a discriminated
 * result so an invalid host declaration fails loud at construction (rc-3)
 * instead of silently degrading to baseline.
 */
export function buildToolSemanticRegistry(
  hostMappings?: readonly ToolSemanticMappingV1[],
): { ok: true; registry: ToolSemanticRegistry } | { ok: false; errors: readonly string[] } {
  let merged: Readonly<Record<string, CanonicalKind>>;
  if (hostMappings === undefined) {
    merged = baselineToolAlias;
  } else {
    const validation = validateToolSemanticMappings(hostMappings);
    if (!validation.valid) {
      return { ok: false, errors: validation.errors };
    }
    const record: Record<string, CanonicalKind> = { ...baselineToolAlias };
    for (const mapping of hostMappings) {
      // validateToolSemanticMappings guarantees own-property safety
      record[mapping.rawToolName] = mapping.canonicalKind;
    }
    merged = Object.freeze(record);
  }

  return {
    ok: true,
    registry: {
      version: 1,
      lookup(rawToolName: string): CanonicalKind | null {
        if (typeof rawToolName !== 'string') return null;
        // ERR-076: Object.hasOwn guards inherited Object.prototype keys
        if (!Object.hasOwn(merged, rawToolName)) return null;
        const hit = merged[rawToolName];
        return hit ?? null;
      },
      resolve(rawToolName: string): CanonicalKind {
        return this.lookup(rawToolName) ?? 'other';
      },
    },
  };
}
