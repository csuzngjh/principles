# ERR Structured Records — Authority (PRI-799 Phase C)

This directory is the **single write authority** for the ERR (Error Experience
Record) knowledge base since the Phase C cutover (2026-09-17).

```
records/
├── patterns/<recordId>.md             one small mutable pattern record per file
├── occurrences/<recordId>/<occId>.md  one independently mergeable fact per file
├── preserved/<displayId>-<hash>.md    verbatim legacy conflict copies (read-only)
├── migration-manifest.json            one-time legacy→records mapping provenance
└── README.md                          this file
```

## Authority rules

1. **All writes go through the writer CLI** — never hand-edit record files:

   ```bash
   npm run error:record create-pattern --display ERR-NNN --title "..." --category "..." --ep EP-NN --source "PRI-YYY / PR #ZZZ" --body-file body.md
   npm run error:record add-occurrence --pattern P-ERR-NNN --date YYYY-MM-DD --source "..." \
     --invariant <kebab-invariant> --severity P0..P3 --escaped <gate|none> \
     --caughtBy self-review|pr-review|ci|runtime|owner --guard <none|guard-id> \
     --body "one-sentence recurrence narrative"
   npm run error:record archive --pattern P-ERR-NNN     # lifecycle flip, never a narrative move
   npm run error:record validate                        # fail-loud whole-tree validation
   ```

2. **Concurrent agents never collide**: every occurrence is its own file and new
   records use filesystem-level no-clobber creation, so two agents writing the
   same pattern (or two new patterns) merge clean. Duplicate display ids
   (`ERR-NNN`) fail loud at validation instead of being relied on for identity.

3. **The legacy Markdown files are frozen snapshots**, not writers:
   `../ERROR_EXPERIENCE_HANDBOOK.md` and `../ERROR_ARCHIVE.md` are historical
   snapshots at cutover time. They are never updated by the recording flow and
   never parsed as authority again. Human-readable views of the CURRENT records
   are generated on demand:

   ```bash
   npm run error:migrate -- --project --project-out <dir>   # projected active/archived views
   ```

   Projection is strictly one-way: `records → projection`. A projection must
   never become a write target.

4. **`ERROR_PATTERN_INDEX.md` stays the routing SSoT** (EP cards +
   `error-pattern-routing` metadata). It is hand-maintained for routing only —
   ERR lifecycle facts live here, not there.

5. **`preserved/` is append-only provenance**: verbatim copies of legacy blocks
   that could not be represented structurally (e.g. the divergent archived copy
   of ERR-083, kept for the pending Owner decision). Never merge, rewrite or
   delete these files; they are the losslessness proof of the migration.

## Record file format

Each record is an HTML-comment JSON metadata block (marker `pd-error-record`)
followed by a Markdown narrative body. Schema v1 is validated by
`scripts/error-records.cjs` (`loadRecords`): referential integrity, duplicate
ids, enums, and dates fail loud. See that module's header comment for the full
identity model.

## Migration provenance

`migration-manifest.json` maps every legacy block (handbook + archive) to its
record (`structured`) or its preserved copy (`preserved_raw`). Summary at
cutover: 370 legacy blocks → 369 structured + 1 preserved_raw, unmapped = 0,
parity losses = 0, 133 patterns, 223 occurrences.
