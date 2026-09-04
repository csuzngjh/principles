/**
 * Workspace Tool Semantics Resolution — PRI-634-F R2 (review P1-2), R3
 * (SPEC §五 P1-1): thin delegation to the ONE host-runtime resolver so CLI,
 * Console, and any future entry point share the same multi-host
 * load/merge/validate/resolve path. The CLI refusal policy (code_tool_hook
 * refuses when unresolvable — no host guessing, no silent skip) stays here.
 */

import type { ToolSemanticRegistry } from '@principles/core/runtime-v2';
import { resolveWorkspaceHostToolSemantics } from '@principles/host-runtime';

export type WorkspaceToolSemanticsResolution =
  | { readonly ok: true; readonly registry: ToolSemanticRegistry; readonly hostKind: string }
  | { readonly ok: false; readonly reason: string; readonly nextAction: string };

export function resolveWorkspaceToolSemantics(workspaceDir: string): WorkspaceToolSemanticsResolution {
  const resolved = resolveWorkspaceHostToolSemantics(workspaceDir);
  if (!resolved.ok) {
    return { ok: false, reason: resolved.reason, nextAction: resolved.nextAction };
  }
  return {
    ok: true,
    registry: resolved.registry,
    hostKind: resolved.hostKinds.join('+'),
  };
}
