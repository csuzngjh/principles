/**
 * WorkBuddy Tool Semantic Declaration (SPEC §4.5, ADR-0020 third host).
 *
 * PURPOSE: the WorkBuddy host layer of the Tool Semantic Registry
 * (PRI-634-F pattern, mirroring codex-adapter's declaration). WorkBuddy
 * names its tools with a capitalized vocabulary the core baseline never
 * matches — a rule generated against `write` would pass replay and never
 * fire on a real `Write` event.
 *
 * EVIDENCE BOUND: only names with in-repo evidence are declared —
 * Read/Write/Bash appear as real tool names in the frozen Phase 0 fixtures
 * (tests/fixtures/host-contract/events/*.json, probes P03); Glob/Grep/Edit
 * are documented core tools in the official hooks reference snapshot
 * (docs/plans/2026-10-12-workbuddy-official-hooks-reference.md §PreToolUse
 * common matchers). Extending beyond this surface is a follow-up once real
 * sessions sample more names — a wrong guess is worse than a gap (unknown
 * names resolve to 'other' and are never fabricated into Write/Bash
 * equivalences).
 */

import { buildToolSemanticRegistry, type ToolSemanticMappingV1, type ToolSemanticRegistry } from '@principles/core/runtime-v2';

export const WORKBUDDY_TOOL_SEMANTIC_MAPPINGS: readonly ToolSemanticMappingV1[] = Object.freeze([
  { rawToolName: 'Read', canonicalKind: 'read' },
  { rawToolName: 'Glob', canonicalKind: 'search' },
  { rawToolName: 'Grep', canonicalKind: 'search' },
  { rawToolName: 'Write', canonicalKind: 'write' },
  { rawToolName: 'Edit', canonicalKind: 'write' },
  { rawToolName: 'Bash', canonicalKind: 'execute' },
]);

const built = buildToolSemanticRegistry(WORKBUDDY_TOOL_SEMANTIC_MAPPINGS);
if (!built.ok) {
  throw new Error(`[PD] WorkBuddy tool semantic declaration is invalid: ${built.errors.join('; ')}`);
}

export const WORKBUDDY_TOOL_SEMANTICS: ToolSemanticRegistry = built.registry;
