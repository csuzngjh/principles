---
'@principles/core': patch
'@principles/pd-cli': minor
'principles-disciple': patch
'create-principles-disciple': patch
---

Legacy pruning-review chain removal (follow-up to the legacy principle-injection
removal): the pruning audit log, its injection mask and the operator commands
that wrote it are deleted, together with the dead legacy subtree reader.

`pd-cli` takes a minor bump rather than a patch because two operator-visible
subcommands disappear from the CLI surface. `pd runtime pruning report`,
`explain` and `orphans` keep their contract; `pd runtime pruning review` and
`pd runtime pruning rollback` are removed, so any script or habit that calls
them must stop (they wrote a log that nothing reads any more, which made
`archive-candidate` look like a governance decision that changed nothing).

- Core: delete `runtime-v2/pruning-review-log.ts` (`appendPruningReview`,
  `listPruningReviews`, `PruningReviewDecision`, `PruningReviewRecord`,
  `AppendPruningReviewInput`) and `runtime-v2/pruning-mask.ts`
  (`buildMaskedPrincipleSet`, `getCachedMaskedPrincipleSet`,
  `clearPruningMaskCache`) and their barrel exports. `PruningReadModel` and
  `removeOrphanReferencesFromLedger` stay.
- pd-cli: `pd runtime pruning` keeps `report`, `explain` and `orphans`; the
  `review` and `rollback` subcommands are gone (`rollback` existed only to
  un-mask a principle for the legacy injection block).
- Plugin: delete `WorkspaceContext.getActivePrincipleSubtrees()`, which no
  production path called, and the Story A "masked legacy overlap" scenario that
  pinned the mask contract. Retire the `sync-plugin` npm entry point of the
  deactivated dev install chain (the refusing `scripts/sync-plugin.mjs` stub and
  its guard test stay).

Nothing reads the historical `<workspace>/.state/pruning_reviews.jsonl` any more;
existing files are left untouched and are now inert data.

Prompt injection, pruning health reporting, orphan cleanup and the console
health panel are unchanged: the mask only ever filtered the `<evolution_principles>`
block that the previous step removed, so on this installation it had no effect
left to lose.
