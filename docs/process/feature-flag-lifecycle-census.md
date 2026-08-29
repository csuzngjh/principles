# Feature Flag Lifecycle Census — PRI-610

**Date:** 2026-08-27
**Baseline:** `origin/main` @ `fdbab606` + PRI-609 canonical-identity fix
**Census source of truth:** `packages/principles-core/src/runtime-v2/feature-flags/feature-flag-lifecycle.ts` (`QUIET_FLAG_LIFECYCLE`)
**Enforcement:** `packages/principles-core/src/runtime-v2/feature-flags/__tests__/feature-flag-lifecycle.test.ts` — a quiet flag without a lifecycle entry fails CI.

This document records the reproducible census method, the classification decisions, and the new-flag rule. The machine-readable registry (the TS module) is the single authority; this doc explains it.

## Census method (reproducible)

```
git fetch origin && git checkout <latest main>
# 1. Enumerate quiet flags from the registry
grep -o "\{ id: '([^']+)', category: 'quiet'" \
  packages/principles-core/src/runtime-v2/feature-flags/feature-flag-contract.ts
# 2. For each flag id, count production consumers (src only, no tests/registry)
git grep -l <flag-id> -- packages | grep '/src/' | grep -v feature-flag-contract | grep -v __tests__
# 3. Classify per the decision table below using registry description + consumer evidence + roadmap
```

A "production consumer" = a reference in `packages/*/src/**` outside the registry, tests, and docs surfaces. Console UI label maps (enum-labels.ts) are display-only and do NOT count as consumers.

## Category semantics

| Category | Meaning | Config override |
|---|---|---|
| `core` | MVP-Core; default ON; explicit `enabled: false` honored as emergency disable (warned) | emergency disable only |
| `quiet` | Opt-in/opt-out capability; lifecycle decision REQUIRED (this census) | full override |
| `gone` | Retired; can never be re-enabled; terminal state (no lifecycle entry) | rejected with warning |
| `legacy_retire` | Deletion approved and scheduled; behaves like quiet until the removal PR lands, then flips to `gone` | full override (transition only) |

Currently no flag is in `legacy_retire` transition. Flags expected to retire (e.g. `evolution_worker`) carry a RETIRE-ready `retirementCriteria` in the census instead; the category flip happens with the actual deletion PR.

## Decisions (34 quiet flags at census time)

Full per-flag evidence (consumers, rationale, criteria) lives in `QUIET_FLAG_LIFECYCLE`. Summary by decision:

| Decision | Flags | Count |
|---|---|---|
| KEEP_QUIET | correction_observer, signal_collector, internalization_auto_consumer, story_a_approval_completion, feedback_channel, gfi, evolution_worker, empathy_observer, painEvidenceAdmission, painEvidenceAdmissionDefault, diagnostician_async_cli, diagnostician_core_grounding, internalization_core_grounding, diagnostician_split_pipeline, l2_dreamer, intent_engineering, rulecode_context_v2, failed_tasks_observability, evaluator_artificer_repair_loop, artifact_summary_redundancy, context_manifest_budget, progressive_evaluator, abstraction_layer_v1, principle_receipt_self_report, failed_task_recovery_console, pain_diagnosis_persistence, governance_experience_v1, anonymous_product_telemetry | 28 |
| GRADUATE (executed) | diagnostician_llm_degradation, principle_receipt_block_copy, principle_receipt_ledger, principle_governance_projection_v2 — all via PRI-571 (2026-08-24); artificer_output_retry via PRI-621 (2026-08-29, live evidence: dreamer self-healed the same error category while artificer dead-ended 5/6 chains); all stay category=quiet so config rollback remains available | 5 |
| RETIRE | none — `evolution_worker` is RETIRE-ready (retirementCriteria = quarantine window closes 2026-12-01) but deletion is a separate PR | 0 |
| STAGED | release_manager_shadow — zero current consumer by design; wiring arrives with PRI-614 Gate B (update convergence roadmap). NOT dead code. | 1 |

**Feature purgatory check:** `zero consumer + no roadmap + no retirement decision = 0` ✅ (the one zero-consumer flag, `release_manager_shadow`, has an explicit staged roadmap owner: PRI-614).

Notable consumer-evidence anchors (abbreviated; full paths in the TS registry):
- `painEvidenceAdmission`(+Default): openclaw-plugin pain.ts / llm.ts / gate-block-helper.ts (production readers since PRI-454).
- `anonymous_product_telemetry`: host-runtime product-telemetry service + pd-cli telemetry command (PR #1419).
- `governance_experience_v1`: pd-console governance experience route + Focus page (PR #1409).
- `release_manager_shadow`: consumers = none (staged; ReleaseManager shadow implementation lives in create-principles-disciple/src/update/, wiring = PRI-614).

## New quiet-flag rule (PR gate)

A PR that adds a quiet flag to `DEFAULT_FEATURE_FLAGS` MUST, in the same PR:

1. Add a `QUIET_FLAG_LIFECYCLE` entry answering:
   - **Purpose** — what behavior the flag gates (evidence string)
   - **Default** — on/off and why (registry `enabled`)
   - **Rollback** — what `enabled: false` restores
   - **Graduation criteria** — what evidence promotes it (or "will not graduate")
   - **Retirement criteria** — under what condition the flag AND its code disappear
   - **Exit path** — `retirementCriteria` is mandatory for every decision
2. Pass `feature-flag-lifecycle.test.ts` (both the completeness and orphan checks).
3. Have at least one production consumer reference in the PR (or an explicit STAGED entry naming the roadmap issue that will wire it).

Time-based triggers (>30 days inactive) are review triggers only — never automatic deletion criteria.

## Relationship to prior audits

- The 2026-08-27 complexity audit's "47 flags" count is a historical snapshot; the registry has continued evolving (`legacy_retire` category, PRI-571 graduations, telemetry flags). This census counts 34 quiet + 9 core + 2 gone = 45 registered flags after PRI-609 removed the 2 snake_case alias entries.
- `docs/archive/reports/feature-flag-graduation-audit.md` (PRI-571) remains the graduation-decision record; this census imports its outcomes as GRADUATE rows.
