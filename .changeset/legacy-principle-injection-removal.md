---
'@principles/core': patch
'@principles/host-runtime': patch
'principles-disciple': patch
'create-principles-disciple': patch
---

Legacy principle-injection removal: Runtime V2 activations become the only
prompt injection authority.

- Plugin: delete the unconditional `<evolution_principles>` block, the
  plugin-local selector shim (`core/principle-injection.ts`), inline
  probation injection (1000-char sub-budget and its session bookkeeping),
  cross-block dedup plumbing (`excludePrincipleIds`, `crossBlockDuplicateIds`,
  `all_deduped_against_legacy`), and probation feedback attribution
  (`handleProbationFeedback` / `recordProbationFeedback`). `prompt.ts` reads
  activations via `readActivatedPrinciples` only.
- Core: delete `prompt-builder/principle-selection.ts`
  (`selectPrinciplesForInjection`, `formatPrinciple`,
  `DEFAULT_PRINCIPLE_BUDGET`, `InjectablePrinciple`,
  `PrincipleSelectionResult`, `PromptInjectionPart`) and the
  `evolution_principles` step in `truncateInjectionToBudget`.
- Host runtime: drop the now-unused exclusion input and diagnostic fields from
  `buildActivePrinciplePromptContext`.
- Event schema: `legacySelectedCount` / `legacyTotalChars` /
  `legacyTruncated` / `crossBlockDuplicateIds` stay optional for reading
  historical events; the plugin no longer emits them, so `pd principles stats`
  reports legacy counters only for turns recorded before this change.

`<core_principles>` (static T-01..T-10 axioms) and Runtime V2
`<directive>` injection are unchanged. A workspace whose legacy reducer still
holds active principles renders exactly the same prompt as before, minus the
legacy block that was already empty on this installation.
