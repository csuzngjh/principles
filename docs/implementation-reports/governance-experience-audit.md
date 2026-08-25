# Governance Experience Snapshot v1.5.1 — Phase 0 Repository Audit

> Date: 2026-08-24 · Branch: `feat/pri-584-governance-experience-snapshot` (off `origin/main` @ 3d17b90b2)
> Scope: PRI-584 / PRI-585 / PRI-586 / PRI-587 / PRI-588 pre-implementation audit (read-only)
> SPEC: Governance Experience Snapshot v1.5.1 (context-provided, treated as authoritative)

## 1. Confirmed Facts

### A. Existing projection (SPEC §4 reuse target)

| Artifact | Location | Notes |
|---|---|---|
| `GovernanceFactsSchema` | `packages/principles-core/src/runtime-v2/governance-projection-contract.ts:83-88` | TypeBox, `additionalProperties: false` |
| `OwnerGovernanceViewSchema` | same file, lines 134-139 | attention (`none/owner_required/recovery_required`), automation (`idle/queued/running/retry_scheduled/stalled`), per-view dataQuality |
| `deriveOwnerGovernanceView()` | `packages/principles-core/src/runtime-v2/governance-projection.ts:29-140` | pure; validates input+output via TypeBox; throws `invalid_governance_facts` / `invalid_owner_governance_view` |
| Producer | `GovernanceProjectionCollector` — `packages/pd-console/src/server/models/GovernanceProjectionCollector.ts:93` | lives in **pd-console**, not core |
| Existing API | `GET /api/v1/principles/:id/governance` — `routes/principles.ts:105-144` | flag `principle_governance_projection_v2`, default ON (PRI-571 graduation 2026-08-24) |

Lifecycle judgments already inside `deriveOwnerGovernanceView()` (must NOT be reimplemented by the experience layer):
strong-lineage filter, frontier computation (successor_present exclusion), per-frontier automation states
(pending→queued, retry_wait→retry_scheduled, leased+unexpired→running, lease expired→stalled+`lease_expired_unrecovered`,
failed/needs_human_review→stalled+recovery item, verdict_missing→stalled+recovery, revision_not_materialized→stalled+recovery),
approval fold (weak dropped + `weak_fact_ignored` issue), activation fold, headline precedence.

### B. Collector architecture — SPEC's main finding confirmed

`collect(principleId)` per call performs: 1 ledger file read + **4 full-table queries**
(`pi_artifacts`, `tasks`, `approvals`, `activations` — all `SELECT * ... ORDER BY`, filtered in JS).
Viewing N principles = **N×4 full-table scans + N ledger reads**. This is exactly the
"Principles × Source Scan" pattern the SPEC's query-budget test (§16.1) forbids.

The per-principle grouping after the queries (lines 112-379) is pure in-memory logic.
**Plan:** extract it as `static buildFacts(principleId, asOf, principle, tables)`; `collect()` keeps identical
behavior through the same extracted code; the new batch collector queries once and calls `buildFacts` per
principle → zero projection-logic duplication, exact view equivalence testable.

### C. Config system

- `PdConfig` + `WorkspaceConfig { default: string }` — `pd-config-types.ts:135-145, 251-265`; hand-rolled
  validator `pd-config-validate.ts` (`validateWorkspaceConfig` at :463-470 with `knownWorkspaceKeys = {'default'}`,
  unknown section keys are hard errors); `PD_CONFIG_VERSION = 1` with no migration machinery — all additions
  are optional fields (precedent: `contextInjection.projectFocus`, PR #1151: types→validate→defaults→effective→redaction→tests).
- **No `environment` concept exists anywhere in config today.**
- ⚠️ Name collision: pd-console has its own unrelated `WorkspaceConfig` (multi-workspace registry,
  `src/server/types/index.ts:87-92`). The experience `environment` field belongs to the **core**
  `workspace:` section of `.pd/config.yaml`.

### D. Feature flags

- Registry: `DEFAULT_FEATURE_FLAGS` TS array — `feature-flag-contract.ts:93-271`; `FeatureFlagDefinition { id, category, enabled, since, description? }`.
- Console backend: `initServices` (server/index.ts:261-274) builds `ctx.featureFlags` at startup; gates use `sendError(res, 403, '<id>_disabled', msg, {nextAction})` (`failed-tasks.ts:400-408`).
- Console frontend: `/api/v1/config/summary` → `App.tsx:95-106` folds `flags[id]` → props (example: sidebar `failed_tasks_observability` gate, `app-sidebar.tsx:136-143`).
- Test coverage: `feature-flag-contract.test.ts` — registry hygiene + "default-off quiet flags" test (:229-258; default-off quiet flags need NO skip-list entry; default-ON quiet flags do).

### E. Console consumption

- FocusPage (`ui/pages/focus/FocusPage.tsx:758`) = governance queue view; consumes `GET /api/v1/governance/queue` +
  `/api/v1/approvals/grouped` + `/api/v1/activations`; plain `useState`/`useEffect` (no react-query).
- `NotificationProvider` polls the queue endpoint every 30s for sidebar badges (separate subsystem).
- API layer: `ui/api.ts` fetch wrapper + hand-rolled validators (`ui/utils/validators.ts`), `Object.hasOwn`,
  no `as` casts, fail-loud (rc-1..rc-5 conventions).
- i18n: i18next, `en.json` + `zh-CN.json`, parity + terminology (拥有者/智能体) enforced by `tests/ui/cr10-i18n-governance.test.ts`.
- Theme: `[data-theme]` tokens in `globals.css`; no raw hex in components (EP-13).
- Tests: vitest node-env (no jsdom mounting — data/validation-logic tests), Playwright E2E via seeded temp
  workspace (`scripts/e2e-start.mjs`, port 3101, `reuseExistingServer` discipline per ERR-101).

### F. Authority evidence (SPEC §6.4)

Exact wiring in `packages/pd-console/src/server/index.ts:462-471` and `routes/activations.ts:100`:

```
ownerActor    = authConfig.isEnabled() && PD_OWNER_ID && PD_OWNER_CREDENTIAL_ID
                ? configured_owner/console_token : null
breakGlassActor = break_glass/local_no_auth_emergency   (always constructed)
governance ops (promote/reject/recover/release)  → ownerActor only   (else 403 owner_authentication_required)
emergency pause / emergency-deactivate           → ownerActor ?? breakGlassActor
principle approvals (approve/reject/edit)        → no owner gate (console-auth only)  → operator_legacy
```

`ownerIdentityConfiguration` evidence = env presence + actor constructibility (matches SPEC §6.5: only
`configured | missing` — no `invalid` state exists in runtime).

## 2. SPEC ↔ Code Deltas and Resolutions

| # | Delta | Resolution |
|---|---|---|
| D1 | SPEC §5.2 input list lacks a workspace hash, but §13 requires `snapshotId = gov-exp:${workspaceHash}:${asOf}` without exposing paths | Additive input `workspaceHash` (sha256-prefix, computed server-side; core stays free of node:crypto). Documented deviation. |
| D2 | SPEC §11.2 lineage transparency sourced from `lineageConfidence`, but `OwnerGovernanceView` does not expose lineage confidence | Inputs carry per-view lineage confidence alongside each view (`GovernanceViewInput { view, lineageConfidence }`), taken verbatim from `GovernanceFacts.lineage.confidence`. |
| D3 | SPEC §8.1 `blocked` requires frontier evidence while the blocking source (ledger) being down also prevents building views | Additive input `frontierEvidence { activeTaskCount, sampleRefs }` computed from the `tasks` table (governance-kind, non-succeeded). blocked = frontier evidence present AND required source unavailable. state_db itself down → no frontier evidence → `degraded`, never blocked (no guessing). |
| D4 | `primaryAttention` enum has no `blocked` member but activity categories do | blocked surfaces as `recovery_required` attention with reason `governance.exp.reason.source_unavailable`; precedence: owner_decision > recovery(含 blocked) > degraded > setup_required > background_processing > all_clear. Documented in contract docs. |
| D5 | SPEC §14.1 error code `feature_disabled` vs codebase convention `<flag_id>_disabled` | SPEC wins for the new endpoint: `403 { code: 'feature_disabled' }`, message names the flag + nextAction (rc-9). |
| D6 | SPEC §4.2 forbids snapshot authorization, SPEC "禁止 old queue + new snapshot merge" | Snapshot is read-only; no mutation route reads it (ERR-102). When flag ON, FocusPage's summary/status comes solely from the snapshot; approve/reject action cards keep using grouped approvals (they are the **mutation surface**, not a status source). When flag OFF, byte-identical legacy behavior (ERR-102 pattern: disabled ≠ unavailable). |
| D7 | SPEC §10.2 `WorkspaceConfig { environment? }` vs existing core `WorkspaceConfig { default }` + name collision with pd-console registry type | `environment?` added to the **core** `workspace:` section (`.pd/config.yaml`), `knownWorkspaceKeys` extended, enum `production/development/demo/test`, missing → `unknown` (legal), invalid → existing validator error path (no bypass, no raw YAML reader). |
| D8 | SPEC §16.6 "Flag OFF: 旧 Console 行为保持" | Flag gate placed before any DB/ledger/model access in the route; UI does not call the endpoint when flag off (mirrors `failed_tasks_observability` sidebar pattern). |
| D9 | Task 3 forbids `for principle: collect()` | Batch collector: 1 connection, 4 queries, 1 ledger read, 1 config read — independent of principle count (query-budget test asserts constant). |

## 3. Risks

- **R1 (ERR-100):** pd-console UI must not runtime-import `@principles/core/runtime-v2` barrel. All UI imports of
  experience types are `import type` only; validators are browser-local.
- **R2 (ERR-102):** snapshot must never gate mutations. No mutation route changes in this PR.
- **R3 (ERR-106):** primaryAttention/category display uses exhaustive `Record<Union, …>` maps.
- **R4 (EP-02):** new core exports re-exported from `runtime-v2/index.ts`; console server wiring through the real
  `handleRequest` chain, not a parallel server.
- **R5:** refactoring `GovernanceProjectionCollector.collect()` must keep the graduated
  `/api/v1/principles/:id/governance` route byte-identical — extraction only, equivalence test added.
- **R6 (Mimosa):** pre-commit whole-project scan may block on pre-existing highs; if blocked, surface to owner
  (do not bypass).

## 4. ERR Entries Considered (Handbook Gate)

- **EP-01 / ERR-001, ERR-005, ERR-013** — inputs stay `unknown` until TypeBox validation; no `as` bypass;
  `Object.hasOwn` for keys; validated-shape checks on fields that exist.
- **EP-02 / ERR-083, ERR-100, ERR-106** — barrel re-exports; browser-safe `import type` only; exhaustive enum maps.
- **EP-03 / ERR-002, ERR-102** — every degraded path carries reason + nextAction; snapshot never authorizes.
- **EP-07 / ERR-092** — no module-level un-keyed caches; batch collector per-call state only.
- **EP-09 / ERR-099** — every conditional branch has a production seam + test (esp. `blocked`, which needs
  frontier+blocking evidence co-present).
- **EP-11 / ERR-075 & EP-13 / ERR-105** — all new UI strings via i18n keys in both locales; tokens only.

## 5. Implementation Adjustments (from this audit)

1. Collector batch refactor via `buildFacts` extraction (D9) instead of a parallel implementation.
2. Environment field placed in core `workspace:` config section (D7), PR #1151 five-file pattern.
3. Additive inputs `workspaceHash`, per-view lineage confidence, `frontierEvidence` (D1-D3) — all assembled by
   the pd-console collector; core derivation stays pure and evidence-driven.
4. `feature_disabled` error code for the new endpoint (D5); `governance_experience_v1` quiet, default OFF,
   registered in `DEFAULT_FEATURE_FLAGS` + `initServices` ctx + config summary (frontend discovers via existing mechanism).

## 6. Review round 1 adjustments (PR #1409, commit ad306880)

The two-axis review (Standards + Spec) tightened four interpretation points; the implementation now matches:

- **R1 (§7.3)** Within ONE principle, recovery outranks decision (`classifyView` reordered). The workspace-level
  `primaryAttention` still leads with `owner_decision_required` per SPEC Phase 4 UI priority ("1. Owner decision,
  2. Recovery") — both behaviors are test-locked.
- **R2 (§8.4)** Processing requires active execution evidence: only `running` / `retry_scheduled` count.
  `queued` (never-started pending frontier) is NOT processing — a pending-only workspace reports idle/all_clear.
- **R3 (§8.1/§9)** Evidence linkage: frontier evidence requires an established task↔artifact relationship
  (`taskIdsWithArtifact`); RuleCode decision evidence requires artifact-exists AND owner-principle-in-ledger.
  Unlinked shadow activations degrade to data-quality (`activation` unlinked source) instead of inflating
  needs_decision. The blocked marker carries frontier evidence refs (never a bare count). Ledger-down +
  orphan-tasks-only → degraded, never blocked.
- **R4 (P2 deferred → PRI-589)** `NotificationProvider` and `DebtPage` still consume the queue endpoint when the
  flag is on (adjacent subsystems, outside this delivery's acceptance criteria). Follow-up: PRI-589 (product
  decision needed on badge semantics before migrating; naive migration would rebuild the workspace snapshot every
  30s poll).
