/**
 * Codex Tool Semantic Declaration — PRI-634-F R2 (review P1-2)
 *
 * PURPOSE: the Codex host layer of the Tool Semantic Registry. Codex names
 * its shell tool `Bash` (capitalized — evidenced by the codex-adapter
 * integration fixtures), which the core baseline's lowercase `bash` never
 * matches: rules generated against the baseline name could pass replay and
 * never fire on a real Codex event.
 *
 * EVIDENCE BOUND: this declaration contains only names with in-repo
 * evidence — the shipped hook matcher `Bash|apply_patch|pd_submit_pain`
 * (plugins/principles-disciple/hooks/hooks.json:5, locked by
 * packages/codex-adapter/tests/codex-plugin-bundle.test.ts:183 and used as
 * the installed-hook fixture in
 * packages/create-principles-disciple/tests/codex-host-installer.test.ts
 * lines 122/162/170). Extending it with the remaining
 * Codex tool surface is tracked as PRI-657 — a wrong guess would be worse
 * than a gap (the reliability check rejects undeclared names, forcing
 * correct names).
 *
 * OG-4 DELIBERATE OMISSION (2026-11-13): the PreToolUse matcher now also
 * routes `pd_submit_pain` (the shared MCP write tool) so the hook OBSERVES the
 * call, but the name is intentionally NOT declared here. `CanonicalKind` is a
 * file-mutation axis: `write` feeds `computeBehaviorFacts.writeCount` and
 * disables the `'other' ⇒ facts incomplete` conservative guard. Declaring a
 * ledger write as a file write would fabricate file-level facts, and the
 * payload carries no target path. Until the enum grows a non-file mutation
 * kind (or host-sampled events justify a mapping), it resolves to `'other'`,
 * which the provider treats as an incomplete semantic view.
 */

import { buildToolSemanticRegistry, type ToolSemanticMappingV1, type ToolSemanticRegistry } from '@principles/core/runtime';

export const CODEX_TOOL_SEMANTIC_MAPPINGS: readonly ToolSemanticMappingV1[] = Object.freeze([
  { rawToolName: 'Bash', canonicalKind: 'execute' },
  // ADR-0030: apply_patch writes a `*** Begin Patch` envelope. The design gate
  // must parse those file headers to know the target paths, and that encoding
  // is not expressible via canonicalKind — declare it instead of matching the
  // raw name downstream.
  { rawToolName: 'apply_patch', canonicalKind: 'write', writePayloadFormat: 'file-header-patch' },
]);

const built = buildToolSemanticRegistry(CODEX_TOOL_SEMANTIC_MAPPINGS);
if (!built.ok) {
  throw new Error(`[PD] Codex tool semantic declaration is invalid: ${built.errors.join('; ')}`);
}

export const CODEX_TOOL_SEMANTICS: ToolSemanticRegistry = built.registry;
