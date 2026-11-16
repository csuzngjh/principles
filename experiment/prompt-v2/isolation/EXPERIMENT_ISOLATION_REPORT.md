# EXPERIMENT_ISOLATION_REPORT — PD-SPEC-001 Phase 2

> Preflight: **all 11 checks PASS** (rerun any time: `node experiment/prompt-v2/scripts/ab/ab-preflight.mjs`; JSON report captured at `.tmp/preflight-report.json`).

## 1. Execution architecture — two REAL-code arms

| Arm | Code source | Role |
|---|---|---|
| v1 | worktree `adhoc-20261115-prompt-v2-v1arm-v1-base` pinned at `0485046e71d2aeba4769725adb4f2aac35a5dd9b` (== V1 baseline commit) | frozen V1 prompts — the SPEC §4.2 "冻结 V1 Prompt 重新执行" arm runs the actual V1 production code, not a rewrite |
| v2 | worktree `adhoc-20261115-prompt-v2-k4wz9t` @ `719846d8c`+ (task branch) | V2 prompts |

**Code-delta proof**: `git diff --name-only <v1> <v2> -- packages/principles-core/src/runtime` contains ONLY the six prompt builders + `adapter/schema-prompt-adapter.ts` (plus `__tests__`/`__snapshots__`). Verified by preflight check `arm-runtime-delta-scope`; the 16-file frozen list (schemas/validators/all runners/adapter validation path/flag contract) is byte-identical between the arms.

## 2. Isolated experiment state (SPEC §5.1)

```
<v2-worktree>/.tmp/prompt-v2-ab/            (gitignored — .gitignore:224 `.tmp/`)
  workspaces/v1/  .pd/state.db (fresh)  .state/trajectory.db (snapshot copy)  .pd/config.yaml (generated)
  workspaces/v2/  (same layout)
  runs/<run-id>/records/<sample>.<arm>[.repN].json + run-manifest.json
```

- **state.db**: fresh per arm — diagnosis tasks created only by the real ingress; no production tasks/principles copied. Principle ledger starts empty in both arms (same starting point; ledger-overlap dimension evaluated against the frozen production ledger snapshot recorded in `dataset-manifest.json`).
- **trajectory.db**: byte copy of the integrity-verified production snapshot (state `f25c8fab…`, trajectory `4dcb401e…`) — provides the real conversation/session evidence for context assembly. Read-write surface confined to the experiment copy.
- **config.yaml**: generated, self-contained — the production model profile (`pi-ai.amd-ds-vision` / GLM-5.3-Flash / `AMD_RADEON_API_KEY` env NAME only / maxTokens 16384 / timeout 600000) and the production flag values (`diagnostician_core_grounding=true`, `pain_diagnosis_persistence=true`, `diagnostician_llm_degradation=false`, `intent_engineering=false`). No feedback tokens, no ingest tokens, no console wiring. Identical between arms.
- **Execution surface**: production CLI (`pd pain record` → `pd diagnose run` → `pd runtime internalization run-once`) from each arm's own built dist — real gates, admission checks, leases, committers, repair loops.

## 3. Production protection (SPEC §5.2/§5.3 — fail-fast)

Preflight refusals (no warn-and-continue):
1. experiment root must resolve OUTSIDE: production workspace `D:\.openclaw\workspace`, `D:\.openclaw`, `~/.pd`, `~/.openclaw`, `~/.codex`, primary repo `D:\Code\principles` (canonicalized through junctions/symlinks, case-folded on Windows);
2. the child environment built by the harness must carry ZERO workspace pointer vars (`PD_WORKSPACE_DIR`, `OPENCLAW_WORKSPACE`, `OPENCLAW_WORKSPACE_DIR`, `PD_STATE_DIR`, `OPENCLAW_HOME`); the per-arm `PD_WORKSPACE_DIR` override must canonicalize inside the experiment root;
3. arm workspaces must stay inside the experiment root after `realpath` resolution.

**Real hazard caught and neutralized**: this machine's shell exports `PD_WORKSPACE_DIR=d:\.openclaw\workspace` (production). Recorded as an inherited hazard by the preflight; every child process gets the cleaned env with the explicit experiment override, and `--workspace` is passed explicitly on every CLI invocation (highest precedence in `resolve-workspace.ts`).

**Never done**: no process in the experiment opens any `D:\.openclaw\workspace` database for writing; production reads happened exactly once, read-only, via the SQLite backup API (Phase 0c).

## 4. Known divergence policy (recorded, identical across arms)

- **Sentinel sessions**: pains whose `session_id` is the literal `cli` sentinel (early manual pains, e.g. S01) are refused session binding by TODAY'S production ingress (`session_not_found` + nextAction "drop --session"). The harness follows the CLI's own nextAction (unbound Owner report) for BOTH arms; `ingressMode` is recorded per sample. This diverges from the 2026-09 historical run conditions and is disclosed — the A/B comparison remains internally paired.
- **Fresh ledger**: both arms start from an empty principle ledger (no activated principles), so Router `trustedContext` exposure differs from the historical runs. Identical across arms; recorded.
- **Signal classifier**: `signalCollector: false` in the experiment config — the ingress classifier path degrades identically in both arms (observed behavior recorded in the run records).

## 5. Run artifacts

Each (sample × arm × rep) record persists: ingress mode + CLI JSON, diagnose-run stdout tail, internalization loop logs, and the collected `pi_artifacts` / `principle_candidates` / `pain_diagnoses` / `runs` rows for the new task — the raw material for Phase 5 evaluation. Run-level manifest records both arms' git HEADs.
