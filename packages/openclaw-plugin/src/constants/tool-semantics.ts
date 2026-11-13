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
 *
 * OG-4 DELIBERATE OMISSION (2026-11-13): `pd_submit_pain` (the shared MCP
 * write tool) is NOT declared here. Two independent reasons, both required by
 * this file's own contract:
 *   1. DISPATCHABILITY — `hooks/gate.ts:363-366` only enters the RuleHost for
 *      `WRITE_TOOLS | BASH_TOOLS_SET | AGENT_TOOLS`; the MCP tool is in none
 *      of them, so declaring it would make `hasHostTool` true for a name no
 *      rule can ever fire on (the exact PRI-741 failure this list fixes).
 *   2. SEMANTICS — `CanonicalKind` is a file-mutation axis. `write` feeds
 *      `computeBehaviorFacts.writeCount` and disables the `'other' ⇒ facts
 *      incomplete` conservative guard, but the MCP payload carries no target
 *      path. It stays `'other'` (conservative) until the enum grows a
 *      non-file mutation kind AND the gate routes it.
 */

import { buildToolSemanticRegistry, type CanonicalKind, type ToolSemanticMappingV1, type ToolSemanticRegistry, type WritePayloadFormat } from '@principles/core/runtime/internalization/tool-semantic-registry';
import { BASH_TOOL_NAMES, AGENT_TOOL_NAMES, PATCH_WRITE_TOOL_NAMES, PLAIN_CONTENT_WRITE_TOOL_NAMES } from './tools.js';

function toMappings(
  names: readonly string[],
  canonicalKind: CanonicalKind,
  writePayloadFormat?: WritePayloadFormat,
): ToolSemanticMappingV1[] {
  return names.map((rawToolName) => ({
    rawToolName,
    canonicalKind,
    ...(writePayloadFormat !== undefined ? { writePayloadFormat } : {}),
  }));
}

// PRI-741: every entry below must be a name the OpenClaw hook really
// dispatches (host layer = dispatchability evidence for `hasHostTool`).
// Generic LLM vocabulary names (write_file, bash, delete_file, ...) were
// removed from constants/tools.ts — declaring them here let rules reference
// tools that can never fire.
//
// ADR-0030: `apply_patch` writes the `*** Begin Patch` envelope. The host
// declaration states that encoding even though this package has no consumer
// for it yet: an unset format is a plain-content claim, so a co-installed
// Codex declaration would otherwise make `mergeDeclarations()` fail.
export const OPENCLAW_TOOL_SEMANTIC_MAPPINGS: readonly ToolSemanticMappingV1[] = Object.freeze([
  ...toMappings(BASH_TOOL_NAMES, 'execute'),                         // exec
  ...toMappings(PLAIN_CONTENT_WRITE_TOOL_NAMES, 'write'),            // write, edit
  ...toMappings(PATCH_WRITE_TOOL_NAMES, 'write', 'file-header-patch'), // apply_patch
  ...toMappings(AGENT_TOOL_NAMES, 'agent'),                          // sessions_spawn
]);

const builtRegistry = buildToolSemanticRegistry(OPENCLAW_TOOL_SEMANTIC_MAPPINGS);
if (!builtRegistry.ok) {
  throw new Error(
    `[PD] OpenClaw tool semantic declaration is invalid: ${builtRegistry.errors.join('; ')}`,
  );
}

/** The OpenClaw ToolSemanticRegistry — ONE instance shared by replay and production. */
export const OPENCLAW_TOOL_SEMANTICS: ToolSemanticRegistry = builtRegistry.registry;
