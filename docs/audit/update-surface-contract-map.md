# Update Surface & Contract Map — PRI-614 Gate A

**Date:** 2026-08-27
**Baseline:** `origin/main` @ `fdbab606`
**Status:** Gate A characterization — NO production updater code deleted or rewired in this gate.
**Purpose:** Freeze the supported-behavior baseline for every live update/version/release surface before any convergence (Gate B) or legacy deletion (Gate C). All facts below were re-verified against the latest main (file:line references are evidence, not instructions).

## Executive summary (authority census)

| Surface | Live? | Current authority | Target authority (post-convergence) |
|---|---|---|---|
| Console update UI + routes (`/api/update/*`) | **LIVE (primary)** | `pd-console/src/server/routes/update.ts` — self-contained inline implementation | ReleaseManager / bootstrap via thin adapter (Gate B) |
| Console update history | LIVE | `update-history.ts` route + `<workspace>/.pd/update-history.json` (last 50) | unchanged until Gate B decision |
| Companion check/notification + console restart | LIVE | `pd-companion/src/main/main.ts` (6h poll of `/api/update/check`, OS notification, `version_change_restart`) | consumes Console API — no independent update logic to converge |
| CLI version reporting | LIVE | `pd-cli/src/services/version-report.ts` (reads `~/.pd` install state; NO update commands exist) | unchanged |
| Installer updater (`create-principles-disciple/src/updater.ts`) | **REMOVED (PRI-636)** — was DEAD in production (imported only by `tests/updater.test.ts`); file + test deleted | none | done |
| ReleaseManager + bootstrap protocol (`src/update/*`) | **Test-only today** — imported by `tests/release-manager.test.ts` + BDD steps only; NOT shipped in the npm package (`files` bundle excludes it) | none (future canonical) | IS the canonical authority once Gate B wires it |
| `release_manager_shadow` feature flag | declared, default-off, **zero readers** | — | wiring arrives with Gate B (PRI-610 census: STAGED) |
| Gateway restart coordination | LIVE, **3 separate implementations** | installer `utils/env.ts`, console `server/utils/gateway.ts`, Companion supervises console process only | converge in Gate B/C scope decision |

**The live production update system today is entirely: pd-console update.ts (4 routes) + UpdatePage + Companion (check/notify/restart).** There is no CLI update command and no plugin/host-runtime self-update.

---

## Surface 1 — Web Console (PRIMARY)

**Entrypoint:** mounted in `pd-console/src/server/index.ts:429-441`; dispatcher `handleUpdateRoute` (`routes/update.ts:1178`). Server sets a 3-min timeout for full-update requests (`index.ts:217`).

### Route contracts

| Route | Handler | Input contract | Output contract (JSON) |
|---|---|---|---|
| `GET /api/update/check` | `doCheckForUpdates` (:428) | — | `{ hasUpdate, currentVersion, latestVersion, changelog, pluginLatestVersion, syncPending, codexInstalled }`; degraded: `{ hasUpdate:false, currentVersion:'unknown', latestVersion:'', error }` |
| `POST /api/update/apply` | `doApplyUpdate` (:521) | `{ targetDir?, mergeStrategy: 'smart'\|'overwrite'\|'keep' (required), createBackup? }` | `{ success, message, updatedFiles?, backupPath?, newVersion?, partialUpdate? }`; refusals carry `reason` (`legacy_rule_contract_dependency`, `installer_bundle_stale`, `file_locked`, `update_target_not_installed` 400) + `nextAction` |
| `POST /api/update/rollback` | `doRollbackUpdate` (:732) | `{ targetDir?, backupDir (required) }` | `{ success, message }` |
| `POST /api/update/apply-full` | `doInlineFullUpdate` (:841) | `{}` | `{ success, message, newVersion?, requiresRestart: bool, reason?, nextAction? }` |
| unknown subPath | :1322 | — | 404 |

### Behavior details (protected invariants)

- **check**: fetches BOTH `registry.npmjs.org/principles-disciple/latest` AND `.../create-principles-disciple/latest` (5s abort). `deliverableVersion = installer.pd.bundledPluginVersion ?? pluginLatest`; `hasUpdate = semver.gt(deliverable, current)`; `syncPending = pluginLatest > deliverable`. Changelog best-effort from GitHub releases API.
- **apply** (partial, plugin-only): legacy-rule preflight (`ActivationCompatibilityReadModel.scan()`), gateway stop (:551) → backup via `reservePdBackupsDestination` (OUTSIDE extensions dir) → tarball download → `tar xzf` argv (no shell) → diff-apply modified+added only (deletions deliberately skipped) → skill-language restore → package.json version rewrite → history append. Rejects caller `targetDir ≠ installed pluginDir`.
- **apply-full** (primary UI path): layout via `@principles/install-layout`; downloads INSTALLER tarball; verifies `pd.bundledPluginVersion` AND staged plugin version advance BEFORE stopping gateway or copying (refusal `installer_bundle_stale`); copies host-runtime/install-layout + creates resolution junctions BEFORE plugin/console/core/pd-cli (PRI-561 ordering); gateway stop only for openclaw host; version-drift check post-copy; returns `requiresRestart:true` (Companion performs the console restart).
- **rollback**: `copyDirRecursive(backupDir → targetDir)` overwrite-only, never deletes, node_modules preserved.
- **Gateway coordination**: `server/utils/gateway.ts` — port from `~/.openclaw/openclaw.json`, TCP probe + PID; `openclaw gateway stop|start` via `execFileSync` argv, 15s timeout. `/apply`: stop before mutation, restart in `finally` (:723). `/apply-full`: stop only after candidate verified, restart in `finally` (:1166).

**UI:** `ui/pages/settings/UpdatePage.tsx` (route `/update`); API client `ui/api.ts:766-793`. Primary button → `applyFullUpdate`; partial apply only via failure-card retry.

**History:** `GET /api/update/history` (`routes/update-history.ts`): array of `{ id, timestamp, fromVersion, toVersion, success, kind, backupPath?, reason?, nextAction? }`; kinds `update|reinstall|legacy_migration|rollback|refusal|failure|recovery|unknown`; file `<workspace>/.pd/update-history.json`, last 50. NOTE: separate from the SPEC §12 `~/.pd/logs/history.jsonl` used by update/* modules.

**Owner-data mutations:** plugin/consore/core/host-runtime code under the install layout; workspace `.pd/update-history.json`. Principles/config/state.db/governance state are NOT touched by any update route (verified: no state.db or governance paths in update.ts).

**Tests:** `tests/server/routes/update.test.ts` (2,287 lines: check/apply/rollback/history/apply-full/EPERM/merge strategies/backup location/node_modules exclusion/preflight), `update-history.test.ts`, `gateway.test.ts`, `pd-backups.test.ts`, **+ NEW `update-gateway-coordination.test.ts` (this PR)** — previously ZERO gateway assertions in the route tests (fixture never created openclaw.json); the new characterization pins: stop-before-first-mutation, restart-in-finally-on-failure, no-commands-when-not-running.

---

## Surface 2 — pd-cli

**No update/install/rollback commands exist.** Verified against the Commander registration (`src/index.ts`, ~60 command groups). `runtime activation deactivate` and `pruning rollback` are rule/data operations, not product updates.

**Version reporting (live):**
- `pd --version` / `-V` → `handleVersionFlag` (`index.ts:85-103`)
- `pd version [--json]` → `src/commands/version.ts` → `src/services/version-report.ts:133 buildVersionReport()`
- Sources: `~/.pd/active.json`, `~/.pd/bootstrap/bootstrap.json`, `~/.pd/install.json`, `~/.pd/releases/<id>/metadata.json`, per-component package.json under the release dir, `~/.pd/logs/history.jsonl`; legacy overlay fallback `~/.openclaw/extensions/principles-disciple` → `source:'official-legacy-overlay'`, `health:'deprecated'`. Never reads a checkout package.json.
- Tests: `src/commands/__tests__/version.test.ts`.

---

## Surface 3 — Installer (`create-principles-disciple`)

- **Install-time gateway coordination:** `utils/env.ts:260-347` (`checkOpenClawGateway`/`stop`/`restart`; Windows spawns `cmd.exe /c openclaw ...`). `installer.ts:1899-1938`: pre-flight `resolveGatewayAction` (`--stop-gateway` flag / interactive prompt / proceed-with-warning), restart-after-install-even-on-failure.
- **Existing-install detection / reinstall:** installer.ts detects prior install and offers reinstall flows; hermetic self-verification via `update/release-asset-manifest.ts` (imported at `installer.ts:40-46`) — **the ONLY update/* module consumed in production today**.
- **`src/updater.ts` (legacy standalone updater): DELETED in PRI-636.** Pre-deletion reachability: the only import anywhere was `tests/updater.test.ts:2`. No dynamic imports, no bundle references, no console/cli/plugin/host-runtime usage (console explicitly re-implements inline "to avoid cross-package import", update.ts:219-220). Behaviors that existed ONLY there and nowhere in production: `rmSync(targetDir, recursive)` rollback (destroys node_modules), `execSync('npm install --production')` (shell string), apply of DELETED files.
- **Contradiction recorded:** `release-manager.ts:101` claims legacyCheck is "Injected in production from the legacy updater" — no such wiring exists; only tests inject it. Comment must be corrected when Gate B wires reality.

---

## Surface 4 — ReleaseManager / bootstrap (`src/update/*`)

Module purposes: `atomic-file` (durable record writer), `bootstrap-protocol` (stdin/stdout JSON dispatch: inspect/check/apply/rollback), `channel-metadata` (signed channel pointer), `channel-promotion` (publication), `data-compatibility` (expand-migrate-contract policy), `install-layout` (`~/.pd` layout contract + strict readers), `legacy-migration` (overlay→dual-slot, dry-run default), `product-identity`, `release-identity` (sha256 releaseId), `release-metadata` (immutable + expiry), `release-policy` (advancement preflight), `rollback-policy` (host coordination + auto-rollback), `transaction-journal` (planned→…→confirmed/rolled_back + crash recovery), `trust-metadata` (TUF), `update-history` (SPEC §12 events; consumed only by legacy-migration).

**ReleaseManager API** (`release-manager.ts:157+`): `inspect()` (layout/productVersion/releaseId/generation; strict active-record reader w/ corruption mapping), `check(channel)` (TUF refresh + digest-verified channel payload; local release metadata only; `shadowComparison` vs injected legacyCheck), `apply()`/`rollback()` → always throw `shadow_mode_read_only` (activation deferred to transaction rollout). Error contract: `ReleaseManagerError { reason, nextAction }`.

**Production reachability: NONE.** Imported only by bootstrap-protocol (itself production-unreferenced), tests, and BDD steps. Not in the npm `files` bundle. No bin entry for the bootstrap protocol; the stdin/stdout transport does not exist yet. **ReleaseManager is the designated canonical authority (roadmap-approved) but is currently test-only — this is STAGED, not dead (PRI-610 census records the same for `release_manager_shadow`, which has zero readers).**

**Test coverage:** `tests/release-manager.test.ts` (incl. bootstrap protocol), `release-contracts`, `transaction-recovery`, `rollback-policy`, `trust-metadata`(+rotation), `channel-promotion`, `legacy-migration`, `release-asset-manifest`/`smoke`/`target-matrix`/`build`/`hermetic`/`self-contained-dependencies`/`smoke-packaged-install`/`backup-location`; BDD `docs/specs/features/update/commercial-update-system.feature` + `tests/bdd/update-system.steps.ts` (drives real ReleaseManager against signed local TUF fixture).

**Parity gate:** `tests/delivery-surface-parity.test.ts` asserts every `@principles/*` runtime dep is handled by all THREE delivery surfaces (bundle-plugin.mjs / installer.ts / console /apply-full) — PRI-561/ERR-040. Any Gate B rewiring must keep this green.

---

## Surface 5 — Companion / host integrations / background checks

- **pd-companion** (`src/main/main.ts`): 6-hourly `setInterval` + one-shot 15s → GET `/api/update/check`; validated via `lib/poller.ts:parseUpdateCheckResponse`; dedup via `state.notifiedUpdateVersions`; OS notification → `#/update`. **Notification only — no auto-apply.** `watchInstalledVersion` (30s approval poll): on installed-version change with console mode `managed` → restart console server (`version_change_restart`); attached mode logs `version_change_attached_no_action`. This IS the de-facto console restart after a UI full update.
- **host-runtime**: no update logic (version strings only in telemetry `pdVersion` + rulehost context-version checks).
- **openclaw-plugin**: no self-update (its `rollback`/`promote`/`archive` commands govern rule activations).
- **codex host**: NOT covered by the Web UI update — `/check` reports `codexInstalled`, `/apply` sets `partialUpdate` warning (update.ts:394-398, :699). Any Gate B must preserve this disclosure.

---

## Gateway restart coordination — duplication census

Three implementations, no shared module:
1. installer `utils/env.ts` (Windows: `cmd.exe /c openclaw ...`) — install-time
2. console `server/utils/gateway.ts` (direct `execFileSync('openclaw', argv)`) — update-time
3. Companion — supervises/restarts the **console server process** only; never touches the OpenClaw gateway

---

## Owner-data safety (all surfaces)

Update/rollback/reinstall paths touch ONLY install-layout code dirs + their own history files. Principles, `.pd/config.yaml`, `state.db`, governance state, RuleCode, approvals, activations are not written by any update surface (verified by path audit of update.ts, updater.ts, ReleaseManager, installer). **This baseline must hold through Gate B/C.**

---

## Gate A exit criteria status

- [x] All live surfaces found and recorded (Console routes+UI, history, Companion, CLI version, installer gateway+hermetic verify, ReleaseManager stage)
- [x] Supported behavior contracts recorded per route (input/output/refusal/nextAction)
- [x] Call chains verified (route → handler → npm registry/TAR/gateway; Companion → console API; version-report → ~/.pd state)
- [x] Test coverage inventoried; the one found gap (gateway coordination in route tests) CLOSED by `update-gateway-coordination.test.ts` (this PR)
- [x] Target authority explicit: ReleaseManager/bootstrap (per roadmap); legacy updater = proven-dead Gate C candidate
- [x] Owner-data impact explicit: no update surface writes Owner durable data
- [x] No production updater code deleted in Gate A

## Gate B entry notes (for the next phase)

1. Wiring ReleaseManager into the Console requires: bootstrap transport (stdin/stdout or in-process), the `release_manager_shadow` flag actually read, release metadata availability strategy (check() currently requires local `releases/<id>/metadata.json`), and parity with the existing refusal contracts (`installer_bundle_stale`, `legacy_rule_contract_dependency`, ...).
2. The delivery-surface-parity test and update.test.ts's 2,287-line contract suite are the parity harness — Gate B must keep them green.
3. updater.ts deletion (Gate C, Option B proven-dead) is independent of Gate B wiring and can proceed once this map is accepted, but per replace-before-delete discipline it lands in the Gate C PR, not now.
