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
`<directive>` injection are unchanged.

Behaviour difference to know about before upgrading: a principle that lived
ONLY in the legacy reducer (active/probation, no Runtime V2 activation) used to
reach the prompt through the deleted block and no longer does. On the Owner's
machine that set is empty — 0 of the 847 scanned prompt events ever carried a
non-zero `legacySelectedCount`, so no turn ever showed a legacy-only principle.
That census proves "no legacy-only injection happened here", not "every
workspace is empty": if another workspace still holds active principles with no
V2 activation, review them with `pd principles stats` and activate them through
the Owner path before upgrading.

Legacy probation therefore ends with this change: with no probation block there
is no per-tool feedback attribution, so `recordProbationFeedback` (the only
path that could promote probation → active at `PROBATION_SUCCESS_THRESHOLD`) is
deleted too. Existing probation entries keep expiring
(`probation_expired`) instead of graduating; promotion is Owner-driven through
Runtime V2 activations.
