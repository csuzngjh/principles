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

/**
 * ADR-0030: the payload ENCODING of a `write` tool. `canonicalKind: 'write'`
 * says "this tool writes"; it does not say how the payload is framed, so
 * consumers that must parse the payload (the Codex design gate needs the
 * `*** Add|Update|Delete File:` headers to know the target paths) cannot
 * derive that from the kind alone.
 *
 * Closed set: only formats with a real consumer today. `file-header-patch`
 * is the `*** Begin Patch` envelope (Codex apply_patch and same-format
 * aliases); omitted means a plain `content` payload.
 */
export const WRITE_PAYLOAD_FORMAT_VALUES = ['file-header-patch'] as const;
export type WritePayloadFormat = (typeof WRITE_PAYLOAD_FORMAT_VALUES)[number];

export function isWritePayloadFormat(value: unknown): value is WritePayloadFormat {
  return typeof value === 'string' && (WRITE_PAYLOAD_FORMAT_VALUES as readonly string[]).includes(value);
}

export interface ToolSemanticMappingV1 {
  readonly rawToolName: string;
  readonly canonicalKind: CanonicalKind;
  /**
   * ADR-0030: only valid when `canonicalKind === 'write'`. Absent = plain
   * content payload; never guessed from the raw tool name.
   */
  readonly writePayloadFormat?: WritePayloadFormat;
}

/** Resolved registry: closed lookup surface shared by replay and production. */
export interface ToolSemanticRegistry {
  readonly version: 1;
  /**
   * Explicit lookup. Returns `null` when the raw name has no mapping in
   * baseline + host layers — classification contexts use this to distinguish
   * "known kind" from "unknown".
   */
  lookup(rawToolName: string): CanonicalKind | null;
  /**
   * Runtime lookup with graceful fallback: unknown names resolve to 'other'
   * (same semantics as canonicalizeToolKind — production evaluation must
   * never throw on an unmapped tool name).
   */
  resolve(rawToolName: string): CanonicalKind;
  /**
   * PRI-634-F R2 (review P1): SEMANTIC RESOLVABILITY IS NOT HOST EXISTENCE.
   * True iff the raw name is declared by the HOST layer — i.e. the host
   * actually dispatches this tool name AND routes it to the RuleHost gate.
   * Core-baseline membership (generic LLM vocabulary like `execute_command`,
   * or read/search names the OpenClaw hook never routes) never counts as
   * existence evidence: a rule matching such a name passes replay against
   * fictional inputs while never firing in production — exactly the failure
   * class PRI-634-F exists to eliminate.
   */
  hasHostTool(rawToolName: string): boolean;
  /** True iff this registry carries a host-declared layer at all. */
  readonly hasHostLayer: boolean;
  /**
   * ADR-0030: the declared payload encoding for a `write` tool, or
   * `undefined` when the host declared none (plain content payload). Only
   * host-layer mappings may carry a format; baseline names never do, and the
   * registry never infers one from the raw tool name.
   */
  resolveWritePayloadFormat(rawToolName: string): WritePayloadFormat | undefined;
  /**
   * PRI-741: read-only projection of the HOST layer declarations (raw name →
   * canonicalKind), for prompt DTOs that must teach generators the real host
   * dispatch surface. Empty for a baseline-only registry. This is a view of
   * the declaration this registry was built from — never a writable surface.
   */
  hostMappings(): readonly ToolSemanticMappingV1[];
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
  const seen = new Map<string, { kind: CanonicalKind; writePayloadFormat?: WritePayloadFormat }>();
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
    // ADR-0030: payload format exists only for write tools, and only the
    // closed set is legal. `undefined` is the same as absent (JSON cannot
    // carry it); any other value fails loud (rc-3).
    const format = entry.writePayloadFormat;
    if (format !== undefined) {
      if (!isWritePayloadFormat(format)) {
        errors.push(
          `toolSemanticMappings[${index}].writePayloadFormat must be one of ${WRITE_PAYLOAD_FORMAT_VALUES.join('|')}, got ${String(format)}`,
        );
        return;
      }
      if (kind !== 'write') {
        errors.push(
          `toolSemanticMappings[${index}].writePayloadFormat is only valid for canonicalKind 'write' (got '${kind}')`,
        );
        return;
      }
    }
    // A host may repeat a raw name only with the SAME kind (idempotent
    // declaration); a conflicting duplicate is a declaration defect. The
    // payload format is part of that identity (ADR-0030): the same write tool
    // cannot have two encodings.
    const previous = seen.get(entry.rawToolName);
    if (previous !== undefined && previous.kind !== kind) {
      errors.push(
        `toolSemanticMappings[${index}]: rawToolName '${entry.rawToolName}' declared twice with conflicting kinds (${previous.kind} vs ${kind})`,
      );
      return;
    }
    if (previous !== undefined && previous.writePayloadFormat !== format) {
      errors.push(
        `toolSemanticMappings[${index}]: rawToolName '${entry.rawToolName}' declared twice with conflicting writePayloadFormat (${previous.writePayloadFormat ?? 'unset'} vs ${format ?? 'unset'})`,
      );
      return;
    }
    seen.set(entry.rawToolName, { kind, ...(format !== undefined ? { writePayloadFormat: format } : {}) });
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
  const hostNames = new Set<string>();
  const writePayloadFormats = new Map<string, WritePayloadFormat>();
  let declaredHostMappings: readonly ToolSemanticMappingV1[] = [];
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
      hostNames.add(mapping.rawToolName);
      if (mapping.writePayloadFormat !== undefined) {
        writePayloadFormats.set(mapping.rawToolName, mapping.writePayloadFormat);
      }
    }
    // Deep-freeze per mapping (CodeRabbit review): a caller mutating its
    // original objects after build must not drift the hostMappings()
    // projection away from resolve()/hasHostTool(), which read the merged
    // record captured above.
    declaredHostMappings = Object.freeze(
      hostMappings.map((mapping) => Object.freeze({
        rawToolName: mapping.rawToolName,
        canonicalKind: mapping.canonicalKind,
        ...(mapping.writePayloadFormat !== undefined
          ? { writePayloadFormat: mapping.writePayloadFormat }
          : {}),
      })),
    );
    merged = Object.freeze(record);
  }

  return {
    ok: true,
    registry: {
      version: 1,
      hasHostLayer: hostNames.size > 0,
      hasHostTool(rawToolName: string): boolean {
        if (typeof rawToolName !== 'string') return false;
        return hostNames.has(rawToolName);
      },
      hostMappings(): readonly ToolSemanticMappingV1[] {
        return declaredHostMappings;
      },
      resolveWritePayloadFormat(rawToolName: string): WritePayloadFormat | undefined {
        if (typeof rawToolName !== 'string') return undefined;
        return writePayloadFormats.get(rawToolName);
      },
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
