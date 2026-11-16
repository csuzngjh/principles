# EXPERIMENT_INTEGRITY_REMEDIATION_REPORT — PD-SPEC-001

> Remediation directive compliance report. All SHAs fresh at write time (HEAD `be7167dd9e…` line — see git log for the current head; every gate cites its own captured evidence).

## 1. Original defects → fixes (complete map)

| # | Owner-identified defect | Root cause (verified in code, not assumed) | Fix | Commit |
|---|---|---|---|---|
| 1 | `textPreview` verbatim leak | custom field name outside DENY_KEYS | deny key + parsed-JSON structural backstop | `150dff2d0` |
| 2 | `evidence_json` is a JSON **string** | redactor did not parse string-encoded JSON | parse → recurse → re-serialize; unparseable → placeholder (fail-closed) | `150dff2d0` |
| 3 | Free text under UNKNOWN keys (canary-proven: `nested.deep`) | blacklist cannot enumerate model-invented keys | **structural-string backstop**: inside parsed JSON subtrees, non-structural strings are redacted regardless of key | `150dff2d0` |
| 4 | Relatable ids (`session_id`) | no anon rule | stable irreversible `anon-<sha256:16>` | `150dff2d0` |
| 5 | Local/production paths (`snapshotHashes[].path`, `diagnosisTarget.workspaceDir`) | no path rule | PATH_KEYS → placeholder | `150dff2d0` |
| 6 | `provenanceReason` free text | not in deny list | deny key | `150dff2d0` |
| 7 | Dataset fallback (full→redacted) | `DATASET_FILE` ternary fallback | **deleted** — full-only, fail-closed `loadDataset` with marker detection | `7e881a9f4` |
| 8 | `v2Head.startsWith('719846d8c') \|\| true` | always-true tautology | V2 prompt version anchored by **19-variant fingerprint recompute from the arm dist vs manifest** (content-anchored, no head guessing) | `7e881a9f4` |
| 9 | V1 18 vs V2 19 variants | V1 dump lacked the production-default combination | V1 dump re-executed at the frozen base arm → 18 prior hashes byte-reproduced + 19th variant added; strict 19↔19 pairing | `7c456c5f5` |
| 10 | Frozen-list mismatch (PR says 16, doc lists 9) | doc drift | §9 aligned to the full 16-file list + `check-frozen-files.mjs` (blob-SHA proof, 0 failures) | `7e881a9f4` |
| 11 | ab-stage INSERTs into a table-less SQLite file | no PD schema bootstrap | `SqliteConnection` bootstrap + `schema_version` verification + fresh-DB-only seeding (contamination guard) | `7e881a9f4` |
| 12 | Unconditional `done` | no terminal gating | STRICT done: exit/`status` payload + task succeeded + succeeded run + TypeBox-validated artifacts (arm dist) + candidates; admission-refused recorded as legitimate terminal state | `7e881a9f4` + `29dec7571…` line |
| 13 | SELECT→UPDATE lease recovery (no CAS) | check-then-write | single conditional UPDATE (`WHERE … status='leased' AND lease_expires_at < now`) | `7e881a9f4` |
| 14 | Shard failure swallowed (launcher exit 0) | results logged, never aggregated | exit-code aggregation → non-zero launcher exit + grid-manifest; `--simulate-failure` hook | `7e881a9f4` |
| 15 | Blind pack took only the LAST artifact | `pool[pool.length-1]` | full per-stage artifact sets + attempt annotation + dreamer candidate-count completeness check | subagent line (`d3b3…` — see git log) |
| 16 | Evidence CONTENT missing from blind packs | only refs passed | evidence note content in local-only packs (never public) | subagent line |
| 17 | Blindness not verified | no group-leak scan | pre-scrub + post-scan fail-loud (arm/contract/receipt fields) | subagent line |
| 18 | `files.length/2` pairing + rep files dropped | `endsWith('.v1.json')` grammar | pair key `(sample, stage, rep, arm)`; shared repN grammar; missing/invalid structurally reported | subagent line |
| 19 | TS2740 ×2 (`Record<string,unknown>` → typed param) | test used JSON.parse output directly | post-guard narrowing; tsc 0 errors; 44 adapter tests green | `29dec7571…` line |
| 20 | CodeQL `js/file-system-race` ×6 (this PR introduced) | existsSync→use TOCTOU | stat-once pattern across ab-run/ab-stage/ab-eval/ab-lib | `17e19fa8d` |
| 21 | Shared per-arm workspaces across shards | workspace layout per arm only | per-shard workspaces `workspaces/<arm>-s<shardId>` | `7e881a9f4` |
| 22 | run-once dispatches ONE runner kind (default dreamer) — philosopher/scribe dead-locked | CLI semantic misunderstood | formation loop round-robins dreamer→philosopher→scribe | `7e881a9f4` |
| 23 | Formation artifacts joined by pain id | task ids carry candidate uuid | candidate-uuid join | post-Gate-8 fix |
| 24 | Scripts' repo-root walk-ups broken | copied from .tmp with wrong depth | unified `findRepoRoot()` (git toplevel + .git validation, no cwd fallback) | `7c456c5f5` |
| 25 | snapshot-report read from wrong dir | `require('./snapshot-report.json')` | repo-local `.tmp/prompt-v2-inventory/` path (fail-fast) | `7c456c5f5` |

25 defects, all fixed with evidence. Additionally: dataset redaction regeneration equivalence (scanner-enforced), Gate-1 snapshot re-run into an independent directory (counts identical), freeze re-run digest-identical (16/16 inputDigests byte-equal).

## 2. Test inventory (all runnable, all green)

| Suite | Count | Scope |
|---|---|---|
| `scripts/__tests__/pdspec001-redaction.test.ts` | 7 | canary projection, nested JSON, anon stability, enum preservation, positive-control leak assertion |
| `scripts/__tests__/pdspec001-ab-metrics.test.ts` | (subagent) | pair-key math, repN grammar, missing/invalid reporting |
| `scripts/__tests__/pdspec001-blindpack.test.ts | (subagent) | completeness, evidence content, blindness scan |
| `packages/principles-core/src/runtime/adapter/__tests__/schema-prompt-adapter(.semantic).test.ts` | 44 | example validity + PRI-817 two-gate invariant |
| diagnostician/adapter/internalization full suites | 2374 | unchanged since Phase 1 |
| Gate 0 | 6/6 | negative controls (missing/redacted dataset refusal, fingerprint drift, grid propagation, env-pointer stripping, containment) |
| preflight | 9/9 | containment, V1 base pin, V2 fingerprint, delta scope, dataset integrity, snapshots, dist, env |
| check-frozen-files | 16/16 | blob-SHA proof vs V1 base |

## 3. Model profile switch (Owner-directed, disclosed)

AMD daily-rate-limited (reset 2026-11-16 00:00 UTC+8) → Owner instructed intern-ai → **INTERN_AI_API_KEY returns 401 "user token expired"** under all three auth header variants (requires Owner reissue; not self-healable) → executed profile: **zai glm-5.3 (`pi-ai.glm`, production fallback profile, verified 200 OK; realistic-payload 19.7s vs AMD's 137-185s)**. Both arms run the same profile; pairing fairness unaffected; blind evaluator (openrouter nemotron) unchanged and independent. Deviation recorded in `baseline/model-config.json`.

## 4. Real experiments status (honest ledger)

| Experiment | Status |
|---|---|
| Gate 8 single-sample (S05 × both arms, zai) | **PASS** — full chain done: 3 diag stages + dreamer×2 + philosopher×2 + scribe; strict verification all-true both arms; v1 scribe `needs_human_review` is the V1-defect behavior surfacing live |
| grid-1 (pre-remediation) | VERIFIED_INVALID, preserved in `.tmp`, excluded from statistics |
| grid-2 (remediated, zai, 4 shards, per-shard isolation) | **RUNNING** at report time — results only counted after the same strict verification |
| Per-agent paired runs (ab-stage) | READY (harness verified by Gate 0-8; requires model quota) |
| Blind evaluation | READY (tooling verified; runs after grid-2 completes) |
| S05 admission-refused probe (S01 probe) | CORRECT pipeline behavior evidence — admission gate refused low-confidence candidates (0.30<0.5), recorded as `done-admission-refused` legitimate terminal state (SPEC §4.4 compliance) |
