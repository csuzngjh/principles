# EXPERIMENT_CURRENT_STATE_AUDIT — PD-SPEC-001 Remediation Phase 0

> Audited: 2026-11-15T01:53Z. All SHAs freshly captured (40-digit, not reused from prior reports).

## 1. Git / PR state (fresh capture)

| Item | Value |
|---|---|
| PR #2653 state | OPEN, MERGEABLE |
| PR head | `64369b28c6841b337fd0cdf49b2362b5c5308724` |
| PR base (origin/main) | `0485046e71d2aeba4769725adb4f2aac35a5dd9b` |
| Local worktree HEAD | `64369b28c6841b337fd0cdf49b2362b5c5308724` (clean, = PR head) |
| Commits on branch | 15 |
| V1 baseline commit | `0485046e71d2aeba4769725adb4f2aac35a5dd9b` (= origin/main = PR base) |
| Prompt V2 code commit | `719846d8c…` (full SHA: `git log --format=%H -1 719846d8c` — captured in fingerprint step) |

CI at audit time: **all checks PASS** (Test principles-core 2m39s, pd-cli, shared runtime, plugin, e2e, quick-check, packaged install …). CodeRabbit skipping (not triggered). PR review comment: 1 × `github-advanced-security[bot]` = **6 CodeQL inline alerts, all `js/file-system-race`, all in THIS PR's experiment scripts** (`ab-eval.mjs:104`, `ab-run.mjs:215/221`, `ab-stage.mjs:120/193/198`) — introduced by this PR, must be fixed (Phase 7).

Local `tsc --noEmit` (packages/principles-core): **2 TS2740 errors** — `schema-prompt-adapter-semantic.test.ts:89` and `schema-prompt-adapter.test.ts:112` (`Record<string, unknown>` passed where `DiagnosticianOutputV2` is required). CI's test lanes transpile without typecheck, so they stayed green; `verify:merge` gate would catch it. Confirmed real → Phase 7.

Code-scanning alerts repo-wide: the only `high`-severity OPEN alerts are `js/insufficient-password-hash` ×2 (introduced 2026-11-10, `host-runtime/production-pain-evidence.ts` + `intervention-evidence-ingress.ts`) and `js/file-system-race` (2026-11-08, test file) — **all pre-date this branch and touch none of this PR's files** → pre-existing, evidenced, NOT suppressed, reported to Owner (they belong to other in-flight work).

## 2. Running experiments (Phase 3/4 grid)

**Processes: NONE alive.** `Get-CimInstance` for `ab-run.mjs`/`ab-grid.mjs` returns nothing — the grid ended by itself before this audit. Nothing was killed by this remediation.

### grid-1 outcome census (52 records: 16 samples × 2 arms + 20 repeat files)

- **52/52 records have `status: "incomplete"`** — zero records meet the honest terminal condition (router terminal AND no live internalization).
- Root cause A — **formation chain never advanced past dreamer**: `pd diagnose run` seeds dreamer tasks; `run-once` executed them (v2 workspace: 8 dreamer succeeded / 6 failed / 1 leased-expired), but **philosopher successors were never enqueued** — the harness invoked `run-once` WITHOUT `--enqueue-next` (the production host cycle owns successor enqueue; the manual CLI flow needs the flag or the `enqueue-successors` command). Result: 8 philosopher tasks stuck `pending`; the loop then burned 24 iterations on `no_ready_tasks / filtered_out`.
- Root cause B — **AMD endpoint rate limiting**: multiple `diagnose` runs died 3/3 attempts with `rate_limit_exceeded` (provider message references a UTC+8 reset time). 38 diag tasks failed, 36 succeeded in the shared v2 workspace.
- Root cause C — **shared per-arm workspaces across shards**: all 6 shards wrote ONE v1 and ONE v2 state.db concurrently (lease-conflict churn; smoke-s01 history mixed into grid S01.v2 via task-id reuse).

### VERDICT

| Scope | Verdict |
|---|---|
| grid-1 records (52) | **VERIFIED_INVALID** — formation chain broken + rate-limit pollution + shared-workspace concurrency. Not deletable (preserved under `.tmp/prompt-v2-ab/runs/grid-1/`); excluded from any final A/B statistics. |
| smoke-s01 records | **VERIFIED_INVALID** for statistics (same defects; kept as harness-development evidence). |
| Arm code versions | v1 dist = base `0485046e7` build (VERIFIED_VALID build, but outputs INVALID per above); v2 dist = V2 prompt code build (same). |
| Dataset used by grid | Full-fidelity copy loaded at shard start (pre-redaction committed file = byte-equal to current `.tmp/prompt-v2-inventory/pain-dataset.full.json` — both originated from the same freeze). Valid input; invalid outcomes. |
| Model config | GLM-5.3-Flash / AMD endpoint / production flags — as pinned; rate limit makes it unusable for high-parallelism runs. |

**Decision per remediation directive §3.2**: processes already dead; outputs preserved and marked INVALID; the grid will be re-run only AFTER the remediation (Gates 0–8) with per-shard isolated workspaces, successor enqueue fixed, strict done-gating, and rate-limit-aware scheduling.

## 3. Defects carried into remediation backlog (confirmed by this audit)

1. **P0 redaction holes**: `textPreview` NOT in REDACT_KEYS → committed `pain-inventory.json` still carries 85 verbatim text previews; `evidence_json` (string-encoded JSON inside `painDiagnosis`) not parsed/redacted; `provenanceReason` free text survives; `session_id`/paths not anonymized. (Detail: PUBLIC_DATA_REDACTION_AUDIT.md.)
2. Copied scripts compute repo root with wrong relative depth (`dump-v1-prompts.mjs`, `snapshot-and-discover.mjs`, `build-inventory.mjs`, `freeze-dataset.mjs` copied from `.tmp` locations) → non-reproducible from committed tree; `build-inventory.mjs` reads `./snapshot-report.json` relative to script dir (file actually lives in `.tmp/prompt-v2-inventory/`).
3. `ab-lib` dataset fallback (full → committed) violates "no full data, no experiment".
4. `ab-preflight` v2 check `startsWith('719846d8c') || true` — always-true (owner-identified).
5. V1 prompt snapshot lacks the 19th variant (`rootcause core+evidence-first` production combination) → V1/V2 variant-count mismatch.
6. Frozen-file claim mismatch: PR body says "16 frozen files", baseline doc lists 9; verification command used 16 paths.
7. `ab-stage` inserts into a fresh SQLite file WITHOUT PD schema initialization → first run would fail; no schema-version verification.
8. `done` gating insufficient (needs task+run succeeded + artifact schema validation); lease reaper is SELECT→UPDATE (no CAS); grid has no failure propagation.
9. Blind pack takes only the LAST artifact per stage; evidence CONTENT (not just refs) missing from packages; no leak/blindness tests.
10. Metrics: `files.length / 2` pairing (rep files break `endsWith('.v1.json')` filtering → repeats silently dropped); no (sample, stage, rep, arm) primary key.
11. TS2740 ×2 in adapter tests; CodeQL file-system-race ×6 in experiment scripts.
12. Successor enqueue missing in formation loop (`--enqueue-next` / `enqueue-successors`).

## 4. Handling of live artifacts

- No process was killed (none alive). No experiment output deleted. `grid-1`/`smoke-s01` directories stay in place (gitignored) and are referenced by this audit as INVALID evidence.
- The running-model rate limit is recorded; all further real-model Gates are scheduled after a rate-limit probe passes.
