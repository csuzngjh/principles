/**
 * OpenClaw Tool Semantic Declaration — PRI-634-F Phase 1, revised in R2
 *
 * PURPOSE: the OpenClaw host layer of the Tool Semantic Registry. The raw
 * tool names derive from the ONE existing tool vocabulary in this package
 * (constants/tools.ts) so the host never maintains a second name list; only
 * the raw→canonicalKind axis is declared here.
 *
 * R2 REVIEW FIX (semantic resolvability ≠ host existence): the declaration
 * covers ONLY tools the OpenClaw hook actually ROUTES to the RuleHost gate
 * (write / bash / agent families — hooks/gate.ts returns early for anything
 * else). `hasHostTool` on the resulting registry therefore means "a rule
 * matching this name can really fire in OpenClaw production". Read/search
 * family names stay OUT: they are real OpenClaw tools but never reach the
 * gate, so rules declared against them would pass replay and silently never
 * trigger. Their semantic classification still resolves via the core
 * baseline (read_file/grep/glob/...) where history facts need it.
 *
 * Ownership (SPEC §5): core owns CanonicalKind + the host-neutral baseline
 * (generic LLM vocabulary); THIS module owns the OpenClaw raw tool names.
 * buildToolSemanticRegistry layers host mappings over the baseline (host wins
 * on conflict).
 *
 * Consumed by:
 *   - the internalization auto-consumer cycle (activation-gate replay parity)
 *   - hooks/gate.ts (production action snapshots)
 *   - core/rule-context-assembler.ts (production RuleContextV2 facts)
 *   - host-runtime/openclaw-host-runtime.ts (shared production gate)
 *
 * Fail loud at module load if the derived declaration is invalid — a broken
 * static declaration is a programming error, not a runtime condition (rc-3).
 */

import { buildToolSemanticRegistry, type CanonicalKind, type ToolSemanticMappingV1, type ToolSemanticRegistry } from '@principles/core/runtime-v2';
import { BASH_TOOL_NAMES, LOW_RISK_WRITE_TOOL_NAMES, AGENT_TOOL_NAMES } from './tools.js';

function toMappings(names: readonly string[], canonicalKind: CanonicalKind): ToolSemanticMappingV1[] {
  return names.map((rawToolName) => ({ rawToolName, canonicalKind }));
}

// Gate-reachable write family: LOW_RISK_WRITE_TOOL_NAMES + the high-risk
// write names (WRITE_TOOLS in ./tools.js = low-risk + delete_file/move_file).
const HIGH_RISK_WRITE_TOOL_NAMES: readonly string[] = ['delete_file', 'move_file'];

export const OPENCLAW_TOOL_SEMANTIC_MAPPINGS: readonly ToolSemanticMappingV1[] = Object.freeze([
  ...toMappings(BASH_TOOL_NAMES, 'execute'),          // bash, run_shell_command, exec, execute, shell, cmd
  ...toMappings(LOW_RISK_WRITE_TOOL_NAMES, 'write'),  // write, write_file, edit, edit_file, replace, apply_patch, insert, patch
  ...toMappings(HIGH_RISK_WRITE_TOOL_NAMES, 'write'), // delete_file, move_file
  ...toMappings(AGENT_TOOL_NAMES, 'agent'),           // sessions_spawn
]);

const builtRegistry = buildToolSemanticRegistry(OPENCLAW_TOOL_SEMANTIC_MAPPINGS);
if (!builtRegistry.ok) {
  throw new Error(
    `[PD] OpenClaw tool semantic declaration is invalid: ${builtRegistry.errors.join('; ')}`,
  );
}

/** The OpenClaw ToolSemanticRegistry — ONE instance shared by replay and production. */
export const OPENCLAW_TOOL_SEMANTICS: ToolSemanticRegistry = builtRegistry.registry;
