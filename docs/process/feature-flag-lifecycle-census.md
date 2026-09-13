# Feature Flag Lifecycle Census — PRI-610

**Date:** 2026-08-27
**Baseline:** `origin/main` @ `fdbab606` + PRI-609 canonical-identity fix
**Census source of truth:** `packages/principles-core/src/runtime-v2/feature-flags/feature-flag-lifecycle.ts` (`QUIET_FLAG_LIFECYCLE`)
**Enforcement:** `packages/principles-core/src/runtime-v2/feature-flags/__tests__/feature-flag-lifecycle.test.ts` — a quiet flag without a lifecycle entry fails CI, and (PRI-779) a census claim that contradicts production sources fails CI (see "Consumer reality guards" below).

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

Currently no flag is in `legacy_retire` transition. `evolution_worker` completed its retirement on 2026-09-12 (PRI-752): the worker was deleted in PRI-737 and the flag flipped directly to `gone` (live evidence: flag=off, evolution_tasks/evolution_events 0 rows; the census retirement window of 2026-12-01 was superseded because its subject — the quarantined worker — no longer existed).

## Decisions (authoritative snapshot; the TS registry always wins)

> PRI-779 sync: the per-decision summary previously kept here had drifted from the registry
> (release_manager_shadow still listed STAGED after its 2026-09-07 graduation; GRADUATE count 5 vs 8).
> Per-flag evidence lives ONLY in `QUIET_FLAG_LIFECYCLE`; this table is a snapshot, not an authority.

Snapshot at `origin/main` `40c6090f9` (2026-09-13): 31 quiet = **23 KEEP_QUIET** + **8 GRADUATE**
(release_manager_shadow, release_manager_write_authority — Owner decision 2026-09-07 via PRI-672/698;
diagnostician_llm_degradation, principle_receipt_block_copy, principle_receipt_ledger,
principle_governance_projection_v2 — PRI-571 2026-08-24; artificer_output_retry — PRI-621 2026-08-29;
governance_experience_v1 — 2026-08-29) + **0 RETIRE** + **0 STAGED**.
Retired 2026-09-12: evolution_worker (PRI-752), internalization_core_grounding (#1624),
empathy_observer (#1625), painEvidenceAdmission(+Default) removed entirely (PRI-763).

**Feature purgatory check:** `zero consumer + no roadmap + no retirement decision = 0` ✅ — now machine-checked
by the PRI-779 zombie guard on every CI run.

Notable consumer-evidence anchors (abbreviated; full paths in the TS registry):
- `painEvidenceAdmission`(+Default): **retired 2026-09-12 (PRI-763)** — flags + aliases removed from registry; zero executable consumers (pain.ts / llm.ts / gate-block-helper.ts never read them); admission is unconditional Gate B (TriggerController).
- `anonymous_product_telemetry`: host-runtime product-telemetry service + pd-cli telemetry command (PR #1419).
- `governance_experience_v1`: pd-console governance experience route + Focus page (PR #1409).

## Consumer reality guards (PRI-779)

`feature-flag-lifecycle.test.ts` additionally enforces, against the real repo sources:

1. **Guard 1 — path reality.** A `consumers` entry that is exactly one path-like token
   (contains `/`, no whitespace) must resolve to a real file under `packages/*/src` or
   `plugins/*/src`. Mixed prose entries carry no checkable path claim; their reality
   burden falls on Guard 2. (Rationale: census entries historically mixed globs with
   prose such as "release_manager_shadow — governed /check dispatch"; tokenizing prose
   as paths would be a false-positive machine.)
2. **Guard 2 — zombie flags.** Every quiet flag whose decision is not `STAGED` must have
   at least one executable consumer read in production sources. STAGED is exempt by
   design (wiring deliberately pending, roadmap issue named in the census entry).
3. **Guard 3 — gone resurrection.** Gone tombstones must have ZERO executable consumer
   reads. Exemptions are a minimal, reason-documented list
   (`GONE_READ_EXEMPT_PATHS` in the test): installer `--channels` validation metadata
   (`create-principles-disciple/src/mvp-config.ts`) and the legacy keyword probe
   (`proven-channel-baseline.ts`).

"Executable read" definition (source-level, not AST): the flag id appears as a complete
quoted string, or as a `.flagId` member access on any receiver (import paths
`./flag.js` excluded via lookbehind). Comments (including multi-line block comments),
test files, the flag registry module itself, and Console label maps / `enumLabel()`
display lookups never count as reads. Known limit: dynamic `flags[variable]` dispatch is
undetectable; a guard failure lists the exact file:line candidates for human triage.

Adding an exemption requires a recorded reason in `GONE_READ_EXEMPT_PATHS` — never a
silent broadening of the read patterns.

## New quiet-flag rule (PR gate)

A PR that adds a quiet flag to `DEFAULT_FEATURE_FLAGS` MUST, in the same PR:

1. Add a `QUIET_FLAG_LIFECYCLE` entry answering:
   - **Purpose** — what behavior the flag gates (evidence string)
   - **Default** — on/off and why (registry `enabled`)
   - **Rollback** — what `enabled: false` restores
   - **Graduation criteria** — what evidence promotes it (or "will not graduate")
   - **Retirement criteria** — under what condition the flag AND its code disappear
   - **Exit path** — `retirementCriteria` is mandatory for every decision
2. Pass `feature-flag-lifecycle.test.ts` (completeness, orphan, and PRI-779 reality checks).
3. Have at least one production consumer reference in the PR (or an explicit STAGED entry naming the roadmap issue that will wire it) — Guard 2 fails CI for non-STAGED flags without an executable read.

Time-based triggers (>30 days inactive) are review triggers only — never automatic deletion criteria.

## Relationship to prior audits

- The 2026-08-27 complexity audit's "47 flags" count is a historical snapshot; the registry has continued evolving (`legacy_retire` category, PRI-571 graduations, telemetry flags, PRI-752 retirement). This census counts 33 quiet + 9 core + 3 gone = 45 registered flags after PRI-609 removed the 2 snake_case alias entries.
- `docs/archive/reports/feature-flag-graduation-audit.md` (PRI-571) remains the graduation-decision record; this census imports its outcomes as GRADUATE rows.
