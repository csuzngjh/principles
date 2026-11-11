/**
 * B3 — the OpenClaw gate's tool semantics resolution.
 *
 * The gate classifies every dispatched tool's canonical kind here. Before B3
 * it used `OPENCLAW_TOOL_SEMANTICS` (the compiled-in declaration) alone, so a
 * persisted workspace declaration — the SAME source replay, evidence and the
 * Console read — could disagree with production on the same tool call.
 *
 * Lives outside `constants/tool-semantics.ts` because it pulls
 * `@principles/host-runtime`: that module is reachable from the
 * `rulehost-evidence` satellite entry, and a value import of the host-runtime
 * barrel there would re-pull the whole LLM graph (OPT-002 / satellite-purity).
 */

import type { ToolSemanticRegistry } from '@principles/core/runtime/internalization/tool-semantic-registry';
import { resolveHostToolSemanticsForHook } from '@principles/host-runtime';
import { OPENCLAW_TOOL_SEMANTIC_MAPPINGS, OPENCLAW_TOOL_SEMANTICS } from '../constants/tool-semantics.js';

/**
 * Resolve the workspace's durable host declarations, with
 * `OPENCLAW_TOOL_SEMANTICS` as the fallback data source.
 *
 * Not cached: gateway start persists the declaration and may run after the
 * first hook invocation, so caching a fallback would pin the hook to the
 * static list for the rest of the process lifetime.
 */
export function resolveOpenClawHookToolSemantics(
  workspaceDir: string,
  logger: { warn?: (msg: string) => void },
): ToolSemanticRegistry {
  const resolution = resolveHostToolSemanticsForHook({
    workspaceDir,
    hostKind: 'openclaw',
    staticMappings: OPENCLAW_TOOL_SEMANTIC_MAPPINGS,
  });
  if (resolution.ok) {
    // ADR-0030: a legacy persisted declaration loads with default semantics;
    // the degradation is observable, never silent (rc-9).
    for (const warning of resolution.warnings) {
      logger.warn?.(`[PD:Gate] ${warning}`);
    }
    return resolution.registry;
  }
  // rc-9: the degradation is observable, and an unusable declaration must not
  // block the Owner's tool call — the compiled-in declaration keeps the gate
  // running (replay still refuses to validate against a partial view).
  logger.warn?.(`[PD:Gate] ${resolution.reason} — using the static OpenClaw tool declaration: ${resolution.nextAction}`);
  return OPENCLAW_TOOL_SEMANTICS;
}
