---
"@principles/core": major
"@principles/host-runtime": major
"principles-disciple": minor
"@principles/pd-cli": minor
"create-principles-disciple": patch
---

Remove the Global Friction Index (GFI) mechanism end to end (SPEC `GFI_COMPLETE_REMOVAL_SPEC`).

- BREAKING: friction scoring, mental mode / fatigue state, `GFI_SLICE_RESET` and the `tool_calls.gfi_before` / `gfi_after` columns are gone. `trajectory.db` is migrated when PD opens it: the two legacy columns are dropped and pending empathy confirmations are closed as `abandoned` / `gfi_removal`. A database whose legacy columns cannot be dropped now fails loudly (`trajectory_migration_failed:<reason>`) instead of being silently treated as canonical.
- BREAKING: Rule Host input no longer carries `session.currentGfi`; `evolution.epTier` and `derived.bashRisk` enrichment are unchanged.
- Owner-visible GFI surfaces are removed: `/pd-status reset`, `pd runtime health gfi`, the Console GFI health check and GFI status rows. Existing workspaces keep working after the automatic schema migration.
