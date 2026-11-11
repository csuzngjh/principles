/**
 * Host Tool Semantic Resolver — PRI-634-F R2 Phase 1 (SPEC §五 P1-1/P1-2)
 *
 * PURPOSE: the ONE deep module every entry point uses to answer "which raw
 * tool names can really reach this workspace's RuleHost gate, and what kind
 * is each?" — load (all persisted host declarations) → merge (every declared
 * host contributes its gate-reachable names; no host is guessed, no host is
 * dropped) → validate (structural, fail-loud) → resolve (a merged
 * ToolSemanticRegistry). Consumers:
 *
 *   - pd-cli activation / approval / promotion-readiness
 *   - pd-console ApprovalsConsoleModel / ActivationsConsoleModel (R2 P1-1:
 *     previously constructed RuleHostWriter directly and validated with the
 *     bare baseline — the same artifact could refuse on the CLI and approve
 *     on the Console)
 *   - auto-consumer / codex worker (host-threaded registries, already
 *     host-exact; the resolver exists for host-neutral entries)
 *   - B3: `resolveHostToolSemanticsForHook` — the realtime hook entry point
 *     (OpenClaw gate, Codex / WorkBuddy pd-hook) resolves the SAME durable
 *     declarations replay reads, instead of only its compiled-in list.
 *
 * Multi-host semantics (R2 P1-2): declarations are PER-HOST files under
 * `.pd/host-tool-semantics/<hostKind>.json` (last-writer-wins on a shared
 * workspace was the R1 defect — startup order must not change verification
 * results). The merged registry is the UNION of all declared hosts'
 * gate-reachable names, so a rule generated under any co-installed host
 * validates against its own host's surface.
 *
 * Pure logic + declared-file I/O only. Merging is order-independent.
 */

import {
  buildToolSemanticRegistry,
  type ToolSemanticMappingV1,
  type ToolSemanticRegistry,
} from '@principles/core/runtime';
import {
  loadHostToolDeclarations,
  saveHostToolDeclaration,
  type HostToolDeclaration,
} from './host-tool-declaration.js';

export type HostToolSemanticResolution =
  | {
      readonly ok: true;
      readonly registry: ToolSemanticRegistry;
      readonly hostKinds: readonly string[];
      /** Non-blocking load diagnostics (legacy declaration version). */
      readonly warnings: readonly string[];
    }
  | { readonly ok: false; readonly reason: string; readonly nextAction: string };

type MergedMappings =
  | { readonly ok: true; readonly mappings: readonly ToolSemanticMappingV1[] }
  | { readonly ok: false; readonly reason: string; readonly nextAction: string };

/**
 * Union every declared host's mappings, order-independently.
 *
 * Same raw name from two hosts must agree on kind; a conflict means a host
 * declared a name it does not own — fail loud rather than pick a winner by
 * startup order (P4 one-source-of-truth).
 */
function mergeDeclarations(declarations: readonly HostToolDeclaration[]): MergedMappings {
  const mappings: ToolSemanticMappingV1[] = [];
  for (const declaration of declarations) {
    for (const mapping of declaration.mappings) {
      const existing = mappings.find((m) => m.rawToolName === mapping.rawToolName);
      if (existing && existing.canonicalKind !== mapping.canonicalKind) {
        return {
          ok: false,
          reason: `host_tool_declaration_invalid (conflicting canonicalKind for '${mapping.rawToolName}': ${existing.canonicalKind} vs ${mapping.canonicalKind})`,
          nextAction: 'each raw tool name must resolve to one canonical kind across all co-installed hosts — fix the conflicting host declaration',
        };
      }
      // ADR-0030: the payload encoding is part of the same identity. Two hosts
      // claiming the same write tool with different encodings cannot both be
      // right, and picking by startup order would make parsing order-dependent.
      if (existing && existing.writePayloadFormat !== mapping.writePayloadFormat) {
        return {
          ok: false,
          reason: `host_tool_declaration_invalid (conflicting writePayloadFormat for '${mapping.rawToolName}': ${existing.writePayloadFormat ?? 'unset'} vs ${mapping.writePayloadFormat ?? 'unset'})`,
          nextAction: 'each raw tool name must resolve to one write payload format across all co-installed hosts — fix the conflicting host declaration',
        };
      }
      if (!existing) mappings.push(mapping);
    }
  }
  return { ok: true, mappings };
}

/**
 * Resolve the merged workspace registry from durable host provenance.
 * Fails loud when no declaration is persisted or any persisted declaration
 * is malformed — never falls back to the core baseline (an existence check
 * against baseline names is a forged proof; ERR-114).
 */
export function resolveWorkspaceHostToolSemantics(workspaceDir: string): HostToolSemanticResolution {
  const loaded = loadHostToolDeclarations(workspaceDir);
  if (!loaded.ok) {
    return { ok: false, reason: loaded.reason, nextAction: loaded.nextAction };
  }
  const merged = mergeDeclarations(loaded.declarations);
  if (!merged.ok) return merged;
  const built = buildToolSemanticRegistry(merged.mappings);
  if (!built.ok) {
    return {
      ok: false,
      reason: 'host_tool_declaration_invalid',
      nextAction: `merged host tool mappings invalid: ${built.errors.slice(0, 3).join('; ')}`,
    };
  }
  return {
    ok: true,
    registry: built.registry,
    hostKinds: loaded.declarations.map((d: HostToolDeclaration) => d.hostKind).sort(),
    warnings: loaded.warnings,
  };
}

/** Where the hook-facing registry got its host layer from. */
export type HookToolSemanticsSource = 'workspace-declaration' | 'host-static';

export type HookToolSemanticsResolution =
  | {
      readonly ok: true;
      readonly registry: ToolSemanticRegistry;
      readonly source: HookToolSemanticsSource;
      /** Non-blocking diagnostics the host must surface (legacy version). */
      readonly warnings: readonly string[];
    }
  | { readonly ok: false; readonly reason: string; readonly nextAction: string };

export interface HookToolSemanticsOptions {
  readonly workspaceDir: string;
  /** The calling host's identity label (also the declaration filename). */
  readonly hostKind: string;
  /** The host's compiled-in declaration — the fallback data source. */
  readonly staticMappings: readonly ToolSemanticMappingV1[];
}

/**
 * B3 — the ONE entry point the realtime hook uses to resolve tool semantics.
 *
 * Precedence (plan §4.2): workspace declaration → host static declaration →
 * core baseline. Replay/evidence/Console already read the declarations via
 * `resolveWorkspaceHostToolSemantics`; before B3 the hook read the compiled-in
 * static list only, so a workspace declaration could disagree with production
 * on the same event.
 *
 * - no declaration persisted → the host static registry (`source:
 *   'host-static'`): the pre-B3 behavior, and the normal state before a host
 *   has started once in this workspace.
 * - declaration persisted → its names win (they are what replay resolves),
 *   and static names the declaration does not carry are still filled in so a
 *   stale file cannot amputate the host's current surface.
 * - malformed / conflicting declaration → typed refusal, never a silent
 *   static fallback and never an empty registry. Consumers must surface the
 *   reason (rc-9) and may fall back to their static registry for availability.
 * - legacy declaration version (v1 read by a v2 build) → NOT a refusal: the
 *   file is read with v1 semantics (`writePayloadFormat` unset) and the
 *   result carries `warnings`, which consumers must surface (rc-9).
 */
export function resolveHostToolSemanticsForHook(
  options: HookToolSemanticsOptions,
): HookToolSemanticsResolution {
  const builtStatic = buildToolSemanticRegistry(options.staticMappings);
  if (!builtStatic.ok) {
    return {
      ok: false,
      reason: `host_tool_semantics_static_invalid (${options.hostKind})`,
      nextAction: `fix the '${options.hostKind}' compiled-in tool declaration: ${builtStatic.errors.slice(0, 3).join('; ')}`,
    };
  }
  const loaded = loadHostToolDeclarations(options.workspaceDir);
  if (!loaded.ok) {
    if (loaded.reason === 'host_tool_declaration_missing') {
      return { ok: true, registry: builtStatic.registry, source: 'host-static', warnings: [] };
    }
    return { ok: false, reason: loaded.reason, nextAction: loaded.nextAction };
  }
  const merged = mergeDeclarations(loaded.declarations);
  if (!merged.ok) return merged;
  const mappings: ToolSemanticMappingV1[] = [...merged.mappings];
  for (const mapping of options.staticMappings) {
    if (!mappings.some((m) => m.rawToolName === mapping.rawToolName)) mappings.push(mapping);
  }
  const built = buildToolSemanticRegistry(mappings);
  if (!built.ok) {
    return {
      ok: false,
      reason: `host_tool_semantics_static_invalid (${options.hostKind})`,
      nextAction: `merged tool mappings invalid: ${built.errors.slice(0, 3).join('; ')}`,
    };
  }
  return { ok: true, registry: built.registry, source: 'workspace-declaration', warnings: loaded.warnings };
}

export { saveHostToolDeclaration };
export type { HostToolDeclaration };
