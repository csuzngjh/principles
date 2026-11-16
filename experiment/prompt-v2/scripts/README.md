# experiment/prompt-v2/scripts — PD-SPEC-001 reproducibility scripts

Copies of the exact scripts used to produce the Phase 0 artifacts (originals ran from `.tmp/`, which never enters commits). Run with the worktree as cwd.

| Script | Produces |
|---|---|
| `dump-v1-prompts.mjs` | `baseline/runtime-prompts/*.txt` + `baseline/prompt-hashes.json` (18 flag-variant V1 system prompts; refuses a dirty tree) |
| `snapshot-and-discover.mjs` | read-only production DB snapshots (backup API through hot WAL) + integrity/count report + linkage discovery |
| `build-inventory.mjs` | `dataset/pain-inventory.json` (106-pain aggregation + classification) |
| `freeze-dataset.mjs` | `dataset/pain-dataset.json` + `dataset/dataset-manifest.json` (16-sample frozen dataset) |

Re-running `dump-v1-prompts.mjs` after the V2 commits lands the V2 prompts; the V1 hashes in `baseline/prompt-hashes.json` pin the pre-change state (base commit `0485046e71`).
