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
  // OG-4 (Owner authorization 2026-11-13, all three hosts): the shared MCP
  // write tool. Its bare name is evidenced by `SUBMIT_TOOL_NAME` in
  // `pd-mcp-server/src/server.ts`; the gate classifies it through the same
  // `event.toolName` path as the native tool families above. A host-prefixed
  // variant is NOT guessed — it resolves to 'other' and is treated
  // conservatively rather than being fabricated into a real dispatch name.
  { rawToolName: 'pd_submit_pain', canonicalKind: 'write' },
]);

const builtRegistry = buildToolSemanticRegistry(OPENCLAW_TOOL_SEMANTIC_MAPPINGS);
if (!builtRegistry.ok) {
  throw new Error(
    `[PD] OpenClaw tool semantic declaration is invalid: ${builtRegistry.errors.join('; ')}`,
  );
}

/** The OpenClaw ToolSemanticRegistry — ONE instance shared by replay and production. */
export const OPENCLAW_TOOL_SEMANTICS: ToolSemanticRegistry = builtRegistry.registry;
