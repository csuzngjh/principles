# Error Experience Archive

> Archived ERR entries whose last recurrence is > 90 days old. These entries are no longer active but retained for historical reference and pattern analysis.

## Purpose

This file holds ERR entries that have been moved out of `ERROR_EXPERIENCE_HANDBOOK.md` because:
- Their last recurrence was > 90 days ago (the pattern appears to be learned)
- The active handbook exceeded 50 entries and needed pruning

Archived entries are still referenced by `ERROR_PATTERN_INDEX.md` (marked `[archived]`), because the pattern itself remains valid even if the specific incidents are old.

## Archive Process

Entries are moved here by the `record-error` skill (Step 10: Archive Gate) when:
1. Total active entries in `ERROR_EXPERIENCE_HANDBOOK.md` exceed 50
2. `npm run check:error-handbook -- --audit` identifies entries with no recurrence in > 90 days

When archiving:
1. Move the full detailed entry (including Recurrence history) from handbook to this file
2. Remove the category table row from the handbook
3. Mark the entry as `[archived]` in `ERROR_PATTERN_INDEX.md` representative ERRs
4. Keep the EP pattern card active — the pattern is still relevant

## Archived Entries

<!-- Archived ERR entries will be added here as they are pruned from the active handbook. -->
<!-- Format: same as ERROR_EXPERIENCE_HANDBOOK.md detailed entries. -->

*No entries archived yet. The handbook will be pruned once entries exceed 90 days of inactivity.*
