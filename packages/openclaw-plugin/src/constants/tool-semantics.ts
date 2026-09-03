/**
 * OpenClaw Tool Semantic Declaration — PRI-634-F Phase 1
 *
 * PURPOSE: the OpenClaw host layer of the Tool Semantic Registry. The raw
 * tool names derive from the ONE existing tool vocabulary in this package
 * (constants/tools.ts) so the host never maintains a second name list; only
 * the raw→canonicalKind axis is declared here.
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
 *
 * Fail loud at module load if the derived declaration is invalid — a broken
 * static declaration is a programming error, not a runtime condition (rc-3).
 */

import { buildToolSemanticRegistry, type CanonicalKind, type ToolSemanticMappingV1, type ToolSemanticRegistry } from '@principles/core/runtime-v2';
import { BASH_TOOL_NAMES, LOW_RISK_WRITE_TOOL_NAMES, AGENT_TOOL_NAMES } from './tools.js';

function toMappings(names: readonly string[], canonicalKind: CanonicalKind): ToolSemanticMappingV1[] {
  return names.map((rawToolName) => ({ rawToolName, canonicalKind }));
}

// delete_file / move_file are OpenClaw write-family tools (see WRITE_TOOLS in
// ./tools.js — they are listed outside LOW_RISK_WRITE_TOOL_NAMES for risk
// classification but are write tools semantically).
const HIGH_RISK_WRITE_TOOL_NAMES: readonly string[] = ['delete_file', 'move_file'];

// Read/search: curated subset of READ_ONLY_TOOL_NAMES whose behavior IS a
// file read or a search. The remaining read-only entries (lsp_*, web_*,
// ref_*, memory_*, todo_*, ask_*, pd-status, report) stay unmapped — 'other'
// is semantically honest for rule matching and keeps the declaration minimal.
const READ_FAMILY_TOOL_NAMES: readonly string[] = ['read', 'read_file', 'read_many_files', 'image_read'];
const SEARCH_FAMILY_TOOL_NAMES: readonly string[] = ['grep', 'grep_search', 'search_file_content', 'glob', 'list_directory', 'ls'];

export const OPENCLAW_TOOL_SEMANTIC_MAPPINGS: readonly ToolSemanticMappingV1[] = Object.freeze([
  ...toMappings(BASH_TOOL_NAMES, 'execute'),          // bash, run_shell_command, exec, execute, shell, cmd
  ...toMappings(LOW_RISK_WRITE_TOOL_NAMES, 'write'),  // write, write_file, edit, edit_file, replace, apply_patch, insert, patch
  ...toMappings(HIGH_RISK_WRITE_TOOL_NAMES, 'write'), // delete_file, move_file
  ...toMappings(AGENT_TOOL_NAMES, 'agent'),           // sessions_spawn
  ...toMappings(READ_FAMILY_TOOL_NAMES, 'read'),
  ...toMappings(SEARCH_FAMILY_TOOL_NAMES, 'search'),
]);

const builtRegistry = buildToolSemanticRegistry(OPENCLAW_TOOL_SEMANTIC_MAPPINGS);
if (!builtRegistry.ok) {
  throw new Error(
    `[PD] OpenClaw tool semantic declaration is invalid: ${builtRegistry.errors.join('; ')}`,
  );
}

/** The OpenClaw ToolSemanticRegistry — ONE instance shared by replay and production. */
export const OPENCLAW_TOOL_SEMANTICS: ToolSemanticRegistry = builtRegistry.registry;
