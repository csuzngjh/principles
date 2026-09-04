/**
 * Codex Tool Semantic Declaration — PRI-634-F R2 (review P1-2)
 *
 * PURPOSE: the Codex host layer of the Tool Semantic Registry. Codex names
 * its shell tool `Bash` (capitalized — evidenced by the codex-adapter
 * integration fixtures), which the core baseline's lowercase `bash` never
 * matches: rules generated against the baseline name could pass replay and
 * never fire on a real Codex event.
 *
 * EVIDENCE BOUND: this declaration currently contains only the names with
 * in-repo evidence. Extending it with the remaining Codex tool surface is
 * tracked as PRI-657 — a wrong guess would be worse than a gap (the
 * reliability check rejects undeclared names, forcing correct names).
 */

import { buildToolSemanticRegistry, type ToolSemanticMappingV1, type ToolSemanticRegistry } from '@principles/core/runtime-v2';

export const CODEX_TOOL_SEMANTIC_MAPPINGS: readonly ToolSemanticMappingV1[] = Object.freeze([
  { rawToolName: 'Bash', canonicalKind: 'execute' },
]);

const built = buildToolSemanticRegistry(CODEX_TOOL_SEMANTIC_MAPPINGS);
if (!built.ok) {
  throw new Error(`[PD] Codex tool semantic declaration is invalid: ${built.errors.join('; ')}`);
}

export const CODEX_TOOL_SEMANTICS: ToolSemanticRegistry = built.registry;
