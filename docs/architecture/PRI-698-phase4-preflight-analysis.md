# PRI-698 Phase 4 Preflight Analysis — ReleaseManager apply orchestration through installer + journal

- Date: 2026-09-06
- Baseline: public `9bbb041e4` (branch `ai/PRI-698-rm-apply-orchestration`)
- Governing intent: ADR-0023, ADR-0024 (D-1/D-2/D-6/D-7), PRI-659 (console migration boundary), PRI-664 (installer journal), PRI-672 (authority routing), PRI-698 (this task)
- Scope of this document: Phase 0 re-verification required by the PRI-698 implementation instruction. Facts below were re-derived from source at the baseline above; narrative docs were treated as hints, not truth.

---

## 1. Current mutation chain (verified, per kind)

```
Console HTTP  /api/update/{check,apply,apply-full,rollback}
      ↓
handleUpdateRoute (routes/update.ts:1964)
      ↓ syncReleaseManagerAuthority (flag + readiness + dynamic import)
updateMutationController.dispatch (server/update/mutation-controller.ts:159)
      ↓ resolveAuthority: preferred 'release-manager' when registered, else fallback
Authority handler
      ↓
[check, flag ON + ready]  ReleaseManager.check()  — governed shadow check;
      response body still computed by the legacy path (byte-identical contract)
[apply]                   legacyApplyMutation  → doApplyUpdate()            (console-owned deploy, NO journal)
[apply-full]              legacyApplyFullMutation → doInlineFullUpdate()    (console-owned deploy, NO journal)
[rollback]                legacyRollbackMutation → doRollbackUpdate()      (console-owned deploy, NO journal)
```

- `apply` (plugin diff update), `apply-full` (full runtime replace) and `rollback` remain 100% legacy console-updater implementations in `routes/update.ts`. They are self-contained: own tarball staging, backup dirs, node_modules link reconciliation, OpenClaw extension copy sync, private `appendUpdateHistory` — zero digest verification against release metadata, zero transaction journal (the exact debt ADR-0024 §1.2 F2 names).
- Fallback is explicit and observable: `X-PD-Mutation-Authority` + `X-PD-Mutation-Fallback-Reason` headers (`release_manager_shadow_disabled`, `release_manager_unavailable:<reasons>`, `installer_missing`, `authority_module_unavailable`).
- Authority flag state: `release_manager_shadow` (quiet, default **off**, feature-flag-contract.ts:227). `PD_RELEASE_METADATA_URL` env must be set for the authority module to be constructed at all.

## 2. Installer capability confirmation (nothing needs re-implementing)

| Capability | Status | Evidence |
| --- | --- | --- |
| Digest / integrity verification | YES | `preflightSelfContainedReleaseAsset` (installer.ts:497) — `_release/asset.json` identity + whole-payload sha256 manifest; TUF seam `resolveTrustedReleaseTarget` / `downloadTrustedReleasePayload` (trust-metadata.ts:97/173, in-flight length+sha256 verification) |
| Backup swap + restore-on-failure | YES | `backupExistingInstall` (installer.ts:658) renames runtime + extension dirs to `~/.pd/backups` / `~/.openclaw/pd-backups`; private `restoreBackup` (686) in install() catch; `cleanupBackup` (732) is the commit point |
| Journal write | YES (partial states) | `beginInstallerJournal` (2212) + `journalInstallerTransition` (2226, append+fsync, journal-first). Writes planned → staged → probed → activated → confirmed, failure → rolled_back \| failed (exactly one terminal). `downloaded`/`verified`/`host_verified` are never written today |
| Full-runtime deploy entry | YES | `install(options, pluginDir, mode)` (2276) — the only exported verify→backup→deploy→probe→confirm cycle; deploys core, host-runtime, codex-adapter, install-layout, release-manager, plugin, pd-cli, console + host installers |
| Rollback as standalone operation | NO (private) | `restoreBackup` is not exported; rollback executes only inside install()'s catch. ReleaseManager.rollback() stays Phase 2 |

Installer limitations relevant to orchestration: `install()` consumes a **local extracted payload directory** (no version/tarball input); it derives journal identity from the payload (`install-<ts>-<uuid>`, `bundled-<version>-<digest12>`, hardcoded `generation: 1`, installer.ts:2241-2244 comment: "generation continuity becomes ReleaseManager's responsibility when it takes over mutations"); it never writes `active.json`.

## 3. ReleaseManager current state (quoted from source)

`release-manager.ts:279-295` — both methods still refuse:

```ts
async apply(): Promise<never> {
  throw new ReleaseManagerError('shadow_mode_read_only', '...', '...');
}
async rollback(): Promise<never> { /* same refusal */ }
```

`release-manager-authority.ts:62` — `ACTIVATION_AVAILABLE = false` keeps apply/apply-full/rollback structurally not-ready (every dispatch falls back with `rollback_not_available`). What already works: `inspect()` (layout/productVersion/generation/channel) and `check()` (TUF channel refresh → signed channel doc → local release metadata validation → policy decision → legacy shadow comparison). check() writes only RM-owned caches (`~/.pd/trust`, `~/.pd/channels`).

## 4. Migration gaps (what Phase 1 must close)

1. **No artifact acquisition path.** The signed channel doc names `releaseId` + `releaseMetadataDigest`; release metadata (seeded locally in tests) declares per-platform `assets[] {archiveSha256, archiveSizeBytes}` — but nothing downloads the artifact. Phase 1 defines the TUF artifact-target convention `releases/<releaseId>/release-asset-<platform>-<arch>.tar.gz` (TUF `custom: {releaseId, channel, platform}`), downloads with in-flight sha256 verification, extracts into `~/.pd/staging`, and validates via the installer's own `preflightSelfContainedReleaseAsset`. The release pipeline does not publish these targets yet — that alignment is a documented follow-up dependency; the flag stays off in production until it lands.
2. **Two-transaction hazard.** If ReleaseManager journaled its own acquisition transaction and then called `install()` unmodified, one logical update would produce two journal files. Phase 1 injects a single transaction context into `install()` (additive optional 4th parameter; default path byte-identical) so one update = one journal file: RM writes planned → downloaded → verified, installer continues staged → probed → activated → confirmed (failure: rolled_back | failed from `journal.lastState`).
3. **Generation continuity.** Injected context carries `generation = activeRecord.generation + 1` (or 1 when absent, matching the pre-activation dual-slot convention); standalone installer keeps `generation: 1`.
4. **Authority readiness.** `apply-full` becomes ready when the structural write path exists (base readiness: metadata source + install state + journal support). `apply` (plugin diff — a mechanism RM does not implement) and `rollback` (Phase 2) stay explicitly not-ready. A new machine-readable fallback reason `release_manager_write_disabled` distinguishes "flag off" from "not ready".
5. **Feature flag.** New quiet flag `release_manager_write_authority` (default off; tests enable it) gates the console routing of `apply-full` to ReleaseManager. Flag off = today's behavior exactly.

## 5. Risks and mitigations

| Risk | Mitigation |
| --- | --- |
| RM write path destabilizes current updates | Flag default off; legacy registrations untouched (replace-then-delete); fallback reason on every not-served dispatch |
| Partial update on failure | Deployment stays inside install()'s existing backup-swap + restore; failure journals rolled_back/failed; RM refuses success unless the installer reports success with a terminal journal state |
| RM accidentally mutating runtime | RM/acquisition writes bounded to `~/.pd/staging` + `~/.pd/releases` + `~/.pd/transactions`; deployment writes (`~/.pd/runtime`, extension dirs) remain installer-only; release-manager.ts contains no `fs.copyFile`/`rename`/`rm` |
| Wire contract drift | RM apply-full response maps into the legacy `{success, message, reason?, nextAction?, newVersion?, requiresRestart}` shape; `/api/update/check` untouched; Companion polls status/history only |
| Layout ambiguity | apply() refuses non-dual-slot installs (`legacy_layout_not_supported`) — legacy fallback serves them |
| Codex-host copies | Phase 1 deploys with `host: 'openclaw'` (matches legacy apply-full sync behavior + current live topology); codex-only installs are served by the legacy path until a later slice takes them |

## 6. Phase 1 implementation plan (this PR)

1. `release_manager_write_authority` quiet flag (default off) in the feature-flag SSoT.
2. `installer.ts`: export `InstallerJournal`, add `beginInstallerJournalFromExternal(identity)`, optional injected `transaction` parameter for `install()`; `from` values read `journal.lastState`; `generation` from context. Standalone behavior unchanged (existing installer/journal tests must stay green unmodified).
3. New `src/update/apply-payload.ts`: artifact target resolution + verified download + extraction + `preflightSelfContainedReleaseAsset` — staging-scoped writes only.
4. `release-manager.ts`: real `apply(options)` — readiness → check → acquisition (journaled) → `install()` with injected transaction → result; errors as typed `ReleaseManagerError` with reason + nextAction (rc-9). `rollback()` unchanged (Phase 2).
5. `release-manager-authority.ts`: apply-full readiness = base readiness; new `write_authority` capability surface.
6. Console `routes/update.ts`: write-flag gating; RM apply-full dispatch mapping into the legacy response contract; fallback reasons `release_manager_write_disabled` / `release_manager_unavailable:…`.
7. Tests: RM apply orchestration suite (happy path journal chain planned→…→confirmed, installer failure → terminal journal + no success claim, layout/identity refusals) + console authority-wiring suite (flag on → RM serves apply-full; flag off → explicit `release_manager_write_disabled` fallback; legacy path byte-identical when unmodified).

Explicit non-goals (per instruction): no rollback migration, no journal recovery executor, no repair executor, no legacy updater deletion, no production flag flip, no real-environment mutation.
