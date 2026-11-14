# DATASET_SELECTION — PD-SPEC-001 Phase 0d

> Frozen dataset: `pain-dataset.json` · freeze manifest: `dataset-manifest.json` (per-sample SHA-256 input digests).
> Frozen at 2026-11-14T16:55Z against V1 base commit `0485046e71d2aeba4769725adb4f2aac35a5dd9b` and the production snapshot (state.db `f25c8fab…`, trajectory.db `4dcb401e…`).
> Selection pool: 106 real pain_events (see `PAIN_INVENTORY.md`). No synthetic pain was created at any point.

## 1. Selection: 16 samples (SPEC target 12–20)

| ID | Pain | Source | Category | Inclusion reason |
|---|---|---|---|---|
| S01 | `manual_1788265732489_9nexm9e6` | manual | successful-full-chain | earliest complete chain (2026-09-01); principle+rule+implementation candidates |
| S02 | `manual_1790560349371_zjwa3dus` | manual | successful-full-chain | Router emitted all 5 kinds incl. defer — routing breadth |
| S03 | `pain_host_620a1683…068791` | user_correction | successful-full-chain | host correction with complete formation (09-17) |
| S04 | `pain_host_34d5095d…9399e` | user_correction | successful-full-chain | single-principle router output; duplicate-risk probe |
| S05 | `manual_1791287582948_82fego9k` | manual | successful-full-chain | principle+implementation+rule+defer mix (10-06) |
| S06 | `pain_host_432596ae…3f4c8f` | user_correction | successful-full-chain | principle-only, early period — ledger-overlap probe |
| S07 | `manual_1794417662834_86wvtpyy` | user_correction (manual channel) | successful-full-chain | freshest full chain (11-11), production flags active, mixed scribe outcomes |
| S08 | `manual_1788266915526_u5s94f40` | manual | successful-no-formation | diag complete (incl. defer+prompt), formation never ran |
| S09 | `pain_host_4dbcf38f…57c2c` | user_correction | successful-no-formation | recent (10-30) principle-only, no formation |
| S10 | `manual_1788417836446_68yyxjpc` | manual | needs-evidence | the only inventory pain flagged for insufficient evidence — uncertainty handling |
| S11 | `pain_host_ce2de9e3…86a1ed` | user_correction | failed-environment | 2026-10-13 timeout-class failure cluster; V1 output absent → V1-rebuild path |
| S12 | `pain_host_eb614cc9…5de6a9d94` | user_correction | failed-environment | most recent failure (11-12); rootcause timed out 3 attempts |
| S13 | `manual_1789971610800_jckds5xo` | manual | failed-environment | the only manual-source diagnosis failure |
| S14 | `manual_1794421512105_wz88cscb` | user_correction (manual channel) | scribe-failure | diag+dreamer+philosopher OK, scribe failed (11-12) — Scribe quality probe |
| S15 | `llm_1791862851742` | llm_paralysis | stage-a-only | never diagnosed — sparse-evidence Stage A probe |
| S16 | `pain_1789213195082_79cf6674` | tool_failure | stage-a-only | the only tool_failure pain, never diagnosed — tooling-attribution probe |

**Owner-correction evidence present** (PHASE 1.5 active): S04, S07, S09, S11, S12, S14.
**Repeat-run picks (SPEC §4.6, ≥4)**: S07, S10, S12, S02, S14 (recent correction chain, needs-evidence, environment-failure, routing-breadth, scribe-failure — deliberately includes hard cases, not only V2-friendly ones).

## 2. Coverage vs SPEC §2.4 priorities

| Priority | Covered by | Status |
|---|---|---|
| 明确用户纠正 | S03/S04/S06/S07/S09/S11/S12/S14 (8) | ✅ |
| Agent 越权/任务偏离 | S07/S14 (未经确认改构建配置等) | ✅ |
| 重复错误 | S04/S06 as ledger-overlap probes vs 36 activations / 31 non-consumed candidates | ✅ (judged at evaluation, SPEC §6.4) |
| 工具或环境故障 | S16 (tool_failure), S11/S12/S13 (timeout-class failures) | ✅ |
| 多重根因 | not mechanically pre-identifiable in this pool | ⚠️ judged at evaluation from ambiguityNotes; recorded as limitation if none emerges |
| 证据不完整 | S10 (needs-evidence), S15 (llm_paralysis sparse) | ✅ |
| 可能被现有原则覆盖 | S04/S06 (+ ledger snapshot frozen per-dataset) | ✅ |

## 3. Experiment-role matrix

| Role | Samples |
|---|---|
| Full-pipeline A/B (V1 historical outputs usable as reference; V1-rebuild still executed for pairing) | S01–S07 |
| Full-pipeline A/B (fresh formation in both arms — historical formation absent/failed) | S08, S09, S14 |
| Full-pipeline A/B (V1 outputs never existed — both arms fresh; failure context preserved) | S11, S12, S13 |
| Stage-A per-agent only (no historical diagnosis; input assembled via production bridge mapping) | S15, S16 |
| Per-agent stages B–F inputs | S01–S14 all carry persisted Stage A/B artifacts (exact upstream inputs reconstructable) |

## 4. Honest negatives

- `manual_1787215181354_339nethw` (SPEC §2.3 lead): absent from the production trajectory.db — not fabricated, recorded as not-found.
- All 19 llm_paralysis pains are undiagnosed; S15 represents the class (single pick avoids over-weighting).
- tool_failure has exactly 1 event (S16) — category covered with n=1, disclosed.
- Multi-cause: no mechanical marker in reason/root_cause text; classification deferred to artifact-level evaluation.

## 5. Freeze integrity

- Per-sample `inputDigest` = SHA-256 over (pain_event row + persisted diagnosisTarget + Stage A/B artifact contents) — see `dataset-manifest.json`.
- Ledger snapshot at freeze: activations=36 (sha256 `6b658788…`), non-consumed candidates=31 (sha256 `c461c322…`), approvals=63.
- Snapshots live at `.tmp/prompt-v2-inventory/snapshot/` (gitignored, hash-pinned above); the dataset JSON embeds all rows needed to rebuild every stage input except the Stage A conversation window, which is reassembled deterministically from the trajectory snapshot by production code in both arms identically.
