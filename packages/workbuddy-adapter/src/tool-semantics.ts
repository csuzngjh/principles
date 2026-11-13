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
 *
 * `pd_submit_pain` is the OG-4 MCP write tool (Owner-authorized for all three
 * hosts on 2026-11-13), and it is deliberately NOT declared here:
 * `CanonicalKind` is a FILE-mutation axis, and `workbuddy-rule-context-provider`
 * only marks facts incomplete for `'execute' | 'other'`. Declaring a ledger
 * write as `'write'` would make it count inside
 * `computeBehaviorFacts.writeCount` while its payload carries no target path,
 * and would switch off the conservative guard for every session that submits a
 * pain. It therefore stays `'other'` — the same "a wrong guess is worse than a
 * gap" rule as the rest of this declaration. The host's `*` PreToolUse matcher
 * still delivers the event, so the call remains observable.
 */

import { buildToolSemanticRegistry, type ToolSemanticMappingV1, type ToolSemanticRegistry } from '@principles/core/runtime';

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
