# PRI-661 — ReleaseManager Runtime Mutation Authority Adoption Analysis

- Linear: PRI-672 (`[P1] Adopt ReleaseManager as runtime mutation authority`); the Owner instruction named this task "PRI-661", an identifier already taken in Linear (evaluator runtime parity, PR #1505). "PRI-661" is kept here as the task nickname.
- Baseline commit: `bcccd13c` (merge of PR #1505), branch `ai/PRI-672-release-manager-adoption`.
- Governing intent: ADR-0023 (installation architecture), ADR-0024 (runtime mutation governance, D-1/D-2/D-6/D-7), PRI-659 update-surface contract map, PRI-664 installer journal integration analysis, PRI-614 Gate B graduation criterion for `release_manager_shadow`.

## 1. Authority — current vs target

### Current (verified at bcccd13c)

| Surface | Authority today | Evidence |
|---|---|---|
| Web Console `/api/update/*` | `legacy-console-updater` — the only kind registered in the production `MutationController` singleton | `packages/pd-console/src/server/routes/update.ts:1429-1432` |
| Installer | Installer itself — digest-verified payload preflight + transaction journal per mutation (PRI-664) + real backup/restore rollback | `packages/create-principles-disciple/src/installer.ts`, `src/update/transaction-journal.ts` |
| ReleaseManager | Shadow mode: `inspect()`/`check()` functional; `apply()`/`rollback()` structurally refuse with `shadow_mode_read_only`. Production callers: **none** | `packages/create-principles-disciple/src/update/release-manager.ts:279-295`; `docs/audit/update-surface-contract-map.md` |
| Feature flag | `release_manager_shadow` — quiet, default off, **zero readers** | `packages/principles-core/src/runtime-v2/feature-flags/feature-flag-contract.ts:227` |

The routing boundary (PRI-659) already reserves the preferred slot: `PREFERRED_MUTATION_AUTHORITY = 'release-manager'` and `resolveAuthority` prefers it once registered (`packages/pd-console/src/server/update/mutation-controller.ts`). What is missing is (a) a production registration of ReleaseManager, (b) a machine-readable readiness surface, (c) explicit fallback reasons.

### Target (this task)

```
Console (trigger/presentation, ADR-0024 D-1)
  → MutationController (routing only — never mutates)
    → ReleaseManager (authority decision + transaction governance; PREFERRED)
      → installer deploy discipline (only direct artifact deployment authority)
        → transaction journal (~/.pd/transactions/, single source of truth)
          → runtime
```

Scope of adoption in this task: ReleaseManager becomes the **registered preferred authority** with a readiness/capability surface. Mutation kinds it cannot yet serve (apply / apply-full / rollback — blocked by the structural `shadow_mode_read_only` gate, whose opening belongs to the update subsystem's Phase 4 with its own go/no-go) fall back **explicitly** to the legacy updater with structured reasons. The `check` kind is served by ReleaseManager governance whenever the flag is on and the installation is ready, with the response body computed by the legacy path so the wire contract stays byte-identical.

### Readiness vocabulary (capability check)

ReleaseManager reports per-kind readiness. Reason codes (machine-readable, stable):

| Reason | Meaning |
|---|---|
| `metadata_source_unconfigured` | No release metadata base URL configured (`PD_RELEASE_METADATA_URL` unset) — the Gate B "release metadata availability strategy" is intentionally explicit: absent source ⇒ not ready, no guessing |
| `bootstrap_not_installed` | `inspect().layout === 'none'` — no `~/.pd` bootstrap/dual-slot state |
| `active_record_corrupt` | `active.json` failed the strict reader — must be recovered from the journal, not worked around |
| `journal_not_supported` | `~/.pd/transactions/` unusable (missing or not writable) |
| `installer_missing` | install-layout components for the authority module are not resolvable in this build |
| `rollback_not_available` | structural: ReleaseManager rollback refuses until Phase 4 activation lands |
| `release_manager_shadow_disabled` | wiring-level: the `release_manager_shadow` flag is off (default) — the authority is not even attempted |
| `authority_module_unavailable` | the authority module could not be loaded in this installation (delivery surface gap — must be surfaced, never silent) |

Per-kind rules:

- `check` — ready when: metadata source configured ∧ layout ≠ none ∧ active record readable ∧ journal dir usable ∧ digest verification available (build-time property of this package, exercised by `tests/release-manager.test.ts`) ∧ controller connected (true by construction once registered).
- `apply` / `apply-full` / `rollback` — check-criteria **and** rollback availability; `rollback_not_available` is a hard structural false until Phase 4, so these kinds always report not-ready in this task. They stay on the legacy updater via explicit fallback.

## 2. Lifecycle map

| Phase | Owner today | Owner at full adoption (post Phase 4) |
|---|---|---|
| check | legacy updater (npm registry + installer bundle stamp) | **ReleaseManager** `check()` (TUF-verified channel + release metadata) with legacy shadow comparison — wired in this task, flag-gated |
| prepare | legacy updater (preflight: legacy rule contract, staged identity guard) | ReleaseManager decision → installer preflight (digest verify) |
| stage | legacy updater (temp dir + diff-apply) | installer journal `planned → staged` |
| activate | legacy updater (backup-rename swap) | installer journal `probed → activated` (`active.json` generation chain — ReleaseManager responsibility, PRI-664 §2) |
| rollback | legacy updater backup/restore (ad hoc) | installer journal `rolled_back` + backup/restore, ReleaseManager `rollback()` |
| confirm | n/a (legacy has no journal) | installer journal `confirmed` (commit point = backup cleanup) |

This task moves only `check` governance; the prepare→confirm chain converges when shadow mode exits (Phase 4, separate gate). The journal already covers installer mutations end-to-end (PRI-664) and remains the single source of truth.

## 3. Compatibility — contracts that must not change

1. **`/api/update/check` response body** — unchanged shape: `{ success, data: { hasUpdate, currentVersion, latestVersion, changelog?, pluginLatestVersion?, syncPending?, codexInstalled, error? } }` (degraded ERR-002 shape included). Under flag-on ready check, the body is still computed by the legacy path (`doCheckForUpdates`); ReleaseManager adds governance and parity logging only.
2. **Desktop Companion polling** — consumes only `hasUpdate` + `latestVersion` via `parseUpdateCheckResponse` (`packages/pd-companion/src/lib/poller.ts`), 6h interval, tolerant of extra fields. Response-body invariance (item 1) keeps this green; new response headers are ignored by the Companion.
3. **Installer behavior** — untouched. No installer code moves into ReleaseManager; no journal schema change; no new runtime writer.
4. **Delivery surfaces** — the new runtime dependency (pd-console → `create-principles-disciple` authority module) is handled on all three surfaces (S1 bundle-plugin.mjs, S2 installer, S3 `/apply-full`), enforced by the updated `delivery-surface-parity.test.ts` and `release-target-matrix.test.ts`. The data-driven link pass in `ensureRuntimeResolutionLinks` picks up the staged `file:` dep; explicit copy/link steps are added for the component. On updates from tarballs published before this change, the component is simply absent — the wiring's dynamic import reports `authority_module_unavailable` and falls back explicitly (graceful, observable).
5. **Existing guards stay intact** — `staged_package_invalid` identity guard (#1500), `installer_bundle_stale` advancement checks, PRI-561 link ordering, quick-check pins (#1501), the 2,300-line `update.test.ts` characterization suite, and the Companion `poller.test.ts` contract test.

## 4. Explicit fallback semantics

- `X-PD-Mutation-Authority` header semantics unchanged (PRI-659 contract).
- New: `X-PD-Mutation-Fallback-Reason` header, set only when the resolved authority is the fallback and a reason is known. Values: `release_manager_shadow_disabled`, `release_manager_unavailable:<reason[,reason…]>`, `authority_module_unavailable`.
- `describeGovernance()` gains an optional `fallbackReason` field (additive; existing fields unchanged).
- Mid-dispatch degradation (ReleaseManager `check()` throws) re-annotates the authority header to the legacy authority and sets the fallback reason before responding — the response body stays the legacy contract. No silent fallback anywhere (rc-9).

## 5. Explicit exclusions (deviation from PRI-664's broader PRI-661 assignment, per Owner task constraints)

- Exiting shadow mode / `apply()` orchestration through the installer (SPEC 2026-08-25 §15 Phase 4 has its own go/no-go gate).
- Journal recovery wiring (`readTransactionJournalForRecovery` / `recoverUnfinishedTransaction` stay consumer-less; no repair executor in this task). The pinned semantic contract (crash-before-activation ⇒ `old_confirmed`; journaled-activated-without-active-record ⇒ `explicit_refusal`, re-run official installer) is inherited unchanged.
- `active.json` generation continuity; `releaseId` identity-chain convergence; D-7 update-history unification (console `appendUpdateHistory` stays the Owner-facing history until ReleaseManager owns mutations).
- Legacy updater deletion (Gate C; replace-then-delete ordering).

## 6. Verification plan

- Authority module: readiness matrix + zero-write assertion scoped to readiness probing (the governed shadow check writes only ReleaseManager-owned verified-metadata caches under `~/.pd/trust` and `~/.pd/channels`, never `~/.pd/runtime`) + governed-check outcome tests against the local signed TUF fixture (extracted to `tests/helpers/shadow-release-fixture.ts`).
- Console: authority routing (flag off ⇒ legacy only, unchanged production wiring assertion; flag on ⇒ readiness-gated registration with structured fallback reasons), compatibility (check body deep-equality on both paths, 404/405 characterization), failure (metadata failure ⇒ explicit fallback, legacy body, no partial mutation), no-third-authority assertions.
- Gates: package test suites + `npm run verify:merge`.
