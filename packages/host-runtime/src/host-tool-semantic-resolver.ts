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
} from '@principles/core/runtime-v2';
import {
  loadHostToolDeclarations,
  saveHostToolDeclaration,
  type HostToolDeclaration,
} from './host-tool-declaration.js';

export type HostToolSemanticResolution =
  | { readonly ok: true; readonly registry: ToolSemanticRegistry; readonly hostKinds: readonly string[] }
  | { readonly ok: false; readonly reason: string; readonly nextAction: string };

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
  const mappings: ToolSemanticMappingV1[] = [];
  for (const declaration of loaded.declarations) {
    for (const mapping of declaration.mappings) {
      // Same raw name from two hosts must agree on kind; a conflict means a
      // host declared a name it does not own — fail loud rather than pick a
      // winner by startup order (P4 one-source-of-truth).
      const existing = mappings.find((m) => m.rawToolName === mapping.rawToolName);
      if (existing && existing.canonicalKind !== mapping.canonicalKind) {
        return {
          ok: false,
          reason: `host_tool_declaration_invalid (conflicting canonicalKind for '${mapping.rawToolName}': ${existing.canonicalKind} vs ${mapping.canonicalKind})`,
          nextAction: 'each raw tool name must resolve to one canonical kind across all co-installed hosts — fix the conflicting host declaration',
        };
      }
      if (!existing) mappings.push(mapping);
    }
  }
  const built = buildToolSemanticRegistry(mappings);
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
  };
}

export { saveHostToolDeclaration };
export type { HostToolDeclaration };
