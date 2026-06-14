# PD Daily Scout Report — 2026-06-14

**Generated:** 2026-06-14 01:00:57 UTC
**Repository:** D:\Code\principles (main @ b4b8b0b7)
**Production workspace:** D:\.openclaw\workspace

---

## 1. Linear State Summary

| State | Count | Issue Identifiers & Titles |
|-------|-------|----------------------------|
| Todo | Unknown | Query failed: `fetch failed` (Linear CLI error) |
| In Progress | Unknown | Query failed: `fetch failed` (Linear CLI error) |
| In Review | 2 | **PRI-365** — Diagnostician pipeline refactor: async CLI + BasePeerRunner unification + axiom-grounded 3-stage split<br>**PRI-366** — T-B: P-spike — validate Distiller grounding hypothesis |

> **Note:** Linear CLI returned `linear_cli_unhandled_error: fetch failed` for Todo and In Progress states. This may indicate a transient API issue or token permissions problem.

---

## 2. Open GitHub PRs & CI Status

**1 open PR:**

| # | Title | Branch | Created | CI Status |
|---|-------|--------|---------|-----------|
| 921 | fix(console): dedupe trajectory pain rows with Runtime V2 canonical pain records | `fix/pri-388-console-dedupe-pain-rows` | 2026-06-13T15:02:23Z | ✅ **All 16 checks PASS** (tsc-plugin, Verify Merge Gate, Auto Label PR, Release Build Parity, Check PR Size, Lint, Welcome First Time Contributor, Test (20), Test (22), Build OpenClaw Plugin, TypeScript Check, Test OpenClaw Plugin unit/integration/coverage, CodeRabbit) |

---

## 3. PD Runtime Health

### Config Doctor Status: **DEGRADED**
- Workspace directories and config files exist and are parseable
- **Provider health degraded:** LM Studio connectivity needs probe (`classification: needs_probe`)
- **Warnings (4):**
  1. `feature 'pain_evidence_admission': unknown flag accepted as-is` (duplicate warning)
  2. Legacy config files detected (2): `.pd/feature-flags.yaml`, `.state/workflows.yaml`
  3. `state.db tasks table has no error_message column — provider signal unavailable`

### Feature Flags Summary
- **Total flags:** 18
- **Enabled:** 8 (core: `prompt`, `code_tool_hook`, `defer_archive`, `pain_evidence_admission`, `internalization_auto_consumer`, `feedback_channel`, `diagnostician_core_grounding`, `diagnostician_split_pipeline`)
- **Disabled:** 10 (quiet: 6, gone: 4)
- **MVP Channels (enabled):** `prompt`, `code_tool_hook`, `defer_archive`
- **Warnings:** Same as config doctor — unknown `pain_evidence_admission` flag + legacy files

### Internal Agents Readiness
| Agent | Enabled | Runtime Profile | Readiness | Notes |
|-------|---------|-----------------|-----------|-------|
| diagnostician | ✅ | pi-ai.lmstudio (qwen3.6-27b-mtp) | ❌ **not_ready** | LM Studio API key present but connectivity unknown |
| dreamer | ✅ | openclaw.default | ✅ ready | |
| philosopher | ✅ | openclaw.default | ✅ ready | |
| scribe | ✅ | openclaw.default | ✅ ready | |
| artificer | ✅ | openclaw.default | ✅ ready | |
| evaluator | ❌ | openclaw.default | disabled | Set `enabled=true` in config to enable |
| rolloutReviewer | ❌ | openclaw.default | disabled | Set `enabled=true` in config to enable |
| trainer | ❌ | openclaw.default | disabled | Set `enabled=true` in config to enable |
| correctionObserver | ❌ | openclaw.default | disabled | Set `enabled=true` in config to enable |
| empathyObserver | ❌ | openclaw.default | disabled | Set `enabled=true` in config to enable |

### Internalization Integrity Check: **ERROR** (47 broken chains)
| Issue Type | Severity | Count | Details |
|------------|----------|-------|---------|
| `missing_dreamer_task` | warning | 3 | Consumed candidates with no corresponding dreamer task (e0f1da64, c1938d3b, d68f89c1) |
| `task_succeeded_no_succeeded_run` | error | 9 | Diagnostician tasks marked succeeded but have no succeeded run |
| `running_run_stuck` | error | 35 | Dreamer runs still 'running' but task status is failed |

**Chain Summary:** 60 candidates, 43 dreamer tasks, 4 philosopher tasks, 24 PI artifacts, **47 chains with broken links**

---

## 4. Stalled Diagnostician Tasks

| Task ID | Status | Attempts | Created At | Age |
|---------|--------|----------|------------|-----|
| *(none found)* | — | — | — | — |

**Result:** No pending diagnostician tasks found in state.db.

---

## 5. Recent Failed Runs (Last 10)

| Task ID | Error Category | Reason | Created At |
|---------|----------------|--------|------------|
| dreamer-cae495cf-...-code_tool_hook | recovery_sweep | Orphaned run — recovered by integrity-repair (task not leased) | 2026-06-13T14:04:33.992Z |
| dreamer-8619a69d-...-prompt | recovery_sweep | Orphaned run — recovered by integrity-repair (task not leased) | 2026-06-13T14:02:33.946Z |
| dreamer-196ee1fd-...-prompt | recovery_sweep | Orphaned run — recovered by integrity-repair (task not leased) | 2026-06-13T12:58:33.352Z |
| dreamer-9508c9cb-...-prompt | lease_expired | Lease expired — force-expired by integrity-repair | 2026-06-13T08:24:43.627Z |
| dreamer-c2077619-...-prompt | lease_expired | Lease expired — force-expired by integrity-repair | 2026-06-13T08:22:43.587Z |
| dreamer-9a8687df-...-prompt | lease_expired | Lease expired — force-expired by integrity-repair | 2026-06-13T08:20:43.559Z |
| dreamer-9df4f8ce-...-prompt | lease_expired | Lease expired — force-expired by integrity-repair | 2026-06-13T08:18:43.538Z |
| dreamer-f67618f8-...-prompt | lease_expired | Lease expired — force-expired by integrity-repair | 2026-06-13T08:16:43.503Z |
| dreamer-cfec400f-...-prompt | lease_expired | Lease expired — force-expired by integrity-repair | 2026-06-13T08:14:43.470Z |
| dreamer-c4095bec-...-prompt | lease_expired | Lease expired — force-expired by integrity-repair | 2026-06-13T08:12:43.396Z |

**Pattern:** All recent failures are from integrity-repair recovery sweeps (orphaned runs + lease expirations) on dreamer tasks from ~17 hours ago. No new failures in the last ~12 hours.

---

## 6. Test Pollution Check

**Result: CLEAN**

No test artifacts found in production workspace (`/d/.openclaw/workspace`):
- No `*.test.*` files
- No `*.spec.*` files
- No `__tests__` directories
- No `jest.config*` files

---

## 7. Recommended Next Actions

| Priority | Action | Rationale |
|----------|--------|-----------|
| **P0** | Run `pd runtime internalization integrity-repair --workspace /d/.openclaw/workspace --confirm` | 35 `running_run_stuck` errors + 9 `task_succeeded_no_succeeded_run` errors require repair to unblock chain integrity |
| **P0** | Run `pd candidate internalize --candidate-id <id>` for the 3 missing dreamer task candidates (e0f1da64, c1938d3b, d68f89c1) | Consumed candidates orphaned without dreamer tasks — breaks internalization chain |
| **P0** | Run `pd runtime probe` to verify LM Studio connectivity for diagnostician | Diagnostician agent shows `not_ready` — `needs_probe` classification blocks diagnostician pipeline |
| **P1** | Remove legacy config files: `.pd/feature-flags.yaml`, `.state/workflows.yaml` | Config doctor warns about legacy files; PD now uses `.pd/config.yaml` exclusively |
| **P1** | Investigate/fix `pain_evidence_admission` unknown flag warning (appears 3x in config) | Unknown flag accepted as-is — may indicate config drift or typo (`painEvidenceAdmission` vs `pain_evidence_admission`) |
| **P2** | Address Linear CLI fetch failures for Todo/In Progress queries | Unable to view full Linear board state; may need token refresh or API status check |
| **P2** | Consider enabling `evaluator`, `rolloutReviewer` agents if needed for pipeline completeness | Currently 5 internal agents disabled; evaluate if any should be active for current workflow |

---

## 8. Limitations

| Check | Limitation | Reason |
|-------|------------|--------|
| Linear (Todo, In Progress) | Query failed | Linear CLI returned `fetch failed` — possible transient API issue or token expiry |
| Linear (In Review) | Partial success | Only 2 issues returned; cannot verify if more exist beyond limit=30 |
| PD Config Doctor | Read-only | Did not run `--fix` or modify any config |
| Internalization Integrity | Read-only | Did not run repair command (would mutate state) |
| Stalled Tasks | Point-in-time | Only checked `status='pending'`; `running` tasks not queried |
| Failed Runs | Last 10 only | Older failures not included; pattern suggests batch recovery ~17h ago |
| Git Status | Uncommitted only | `.omo/` directory untracked — unknown if expected or debris |
| Test Pollution | Production workspace only | Did not scan repository source tree (`/d/Code/principles`) |

---

*Report generated by PD Daily Scout cron job. No mutations performed.*