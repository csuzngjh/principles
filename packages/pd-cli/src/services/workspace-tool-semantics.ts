/**
 * Workspace Tool Semantics Resolution — PRI-634-F R2 (review P1-2)
 *
 * PURPOSE: resolve the ToolSemanticRegistry for a workspace from DURABLE
 * HOST PROVENANCE — the host-authored declaration persisted at
 * `<workspaceDir>/.pd/host-tool-semantics.json` (written by the OpenClaw
 * plugin / Codex worker at startup). pd-cli is host-neutral and must NOT
 * guess a host (a multi-host workspace activated with the wrong registry
 * would validate rules against the wrong tool surface) and must NOT
 * silently skip reliability validation (review P1: silent skip is how
 * "validated but never fires" rules reach activation).
 *
 * Policy (caller-enforced): when resolution fails, code_tool_hook
 * activation REFUSES with the structured reason/nextAction below.
 */

import {
  buildToolSemanticRegistry,
  type ToolSemanticRegistry,
} from '@principles/core/runtime-v2';
import { loadHostToolDeclaration } from '@principles/host-runtime';

export type WorkspaceToolSemanticsResolution =
  | { readonly ok: true; readonly registry: ToolSemanticRegistry; readonly hostKind: string }
  | { readonly ok: false; readonly reason: string; readonly nextAction: string };

export function resolveWorkspaceToolSemantics(workspaceDir: string): WorkspaceToolSemanticsResolution {
  const loaded = loadHostToolDeclaration(workspaceDir);
  if (!loaded.ok) {
    return { ok: false, reason: loaded.reason, nextAction: loaded.nextAction };
  }
  const built = buildToolSemanticRegistry(loaded.declaration.mappings);
  if (!built.ok) {
    return {
      ok: false,
      reason: 'host_tool_declaration_invalid',
      nextAction: `host tool declaration mappings invalid: ${built.errors.slice(0, 3).join('; ')}`,
    };
  }
  if (!built.registry.hasHostLayer) {
    return {
      ok: false,
      reason: 'host_tool_declaration_invalid',
      nextAction: 'host tool declaration carries no mappings — re-run the host to refresh it',
    };
  }
  return { ok: true, registry: built.registry, hostKind: loaded.declaration.hostKind };
}
