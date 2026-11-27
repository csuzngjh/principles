# PRI-1278 Service-Host-Only Consolidation — Session State

> Continuity document. Update as work progresses. Read this first after any compaction.

## Directive (Owner, authoritative)

PD Service Host becomes the ONLY background runtime. Companion loses ALL background execution capability (worker start/supervision/scheduling/polling/consumer mgmt/respawn/retry/recovery/lease), keeps only UI/Control Plane. BREAKING CHANGE — single user, no legacy compat, no migration framework, no companion fallback. Host adapters (openclaw/codex/workbuddy) survive as Service-Host-called adapters only. OS Scheduler + bounded run-once model continues. Implement in **PR #2810** (branch `ai/PRI-1278-phase5-p0-deferred-provisioning-guard`). Do NOT pause for approval; execute end-to-end autonomously: audit → design → implement → test → build → real-run → accept → PR. Final report must answer "is PD彻底 Service Host Only?" — no PASS_WITH_LIMITATIONS.

## Fixed facts

- Worktree: `D:\Code\_worktrees\principles\PRI-1278-phase5-p0-guard-20261127` (WSL: `/mnt/d/Code/_worktrees/principles/PRI-1278-phase5-p0-guard-20261127`)
- Branch HEAD before consolidation: `cf3caadf0` (P0 guard), merge-base with main `a7a3479c6`
- origin/main moved to `e3ddf901d` (PRI-1299 merged) — branch needs rebase before/at implementation start
- Lease owner: `devin:pri-1278-service-host-only` (renew periodically)
- Error Context pre-routing: HIGH EP-04 (real entry evidence), EP-02/EP-03 (CLI contract/cross-package) — reconcile in final report
- PR #2811 (consumer-safety substrate, ownership gate+mutex) is OPEN in parallel — its handover-state matrix becomes mostly moot in the new world, but per-cycle mutex discipline survives. Coordination note for final report.
- PR #2811 CI round 2 was running when pivoted (T13 shadow test fixed via `1bc9b6f4c`).

## Environment traps (hard-won)

- exec layer ALWAYS expands backticks/`$()` even inside quoted heredocs — corrupted files twice. NEVER use heredoc for content containing code symbols; use write/edit tools.
- WSL git needs `-c http.sslBackend=gnutls` for push.
- git-lfs missing in WSL — worktrees created manually.
- `/mnt/d` is slow: full pd-cli suite ~15 min, many env-flaky failures locally (real-CLI spawn timeouts). CI Linux is authoritative.
- Test suite pollutes `Z:\pd-nonexistent...` files on WSL — pre-existing, clean before commit.

## Phase progress

- [x] Todo list established (9 items)
- [x] Lease acquired, worktree cleaned, main drift detected
- [x] Error Context pre-routing
- [x] Phase 1 audit COMPLETE — all 4 agents reported; integrated into `PRI-1278-SERVICE-HOST-ONLY-DESIGN.md` (READ THIS — disposition table, boundary decisions D1-D8, OD-1..OD-5 locked, wave plan)
- [x] origin/main e3ddf901d merged clean into branch
- [x] Bootstrap done (node_modules ready)
- [ ] **Implementation IN PROGRESS — 6 parallel agents editing disjoint packages in THIS worktree (uncommitted!)**:
  - SA-1 `6914f118` install-layout: transition machine collapse to provision_fresh_install-only (from ANY state), delete freshInstall flag, rewrite tests
  - SA-2 `d0929557` pd-companion: delete workspace-workers.ts+main.ts worker wiring+worker tests, keep console supervision, new negative guards
  - SA-3 `8f3fd8ee` openclaw-plugin: delete auto-consumer service+registration+gateway-consumer-lease+quiesce ack, keep hooks/tool-declaration/openclaw-worker/correction-observer
  - SA-4 `772e3276` pd-cli: delete continuous mode+worker-drain+handover+shadow, add binary gate+mutex to codex/workbuddy --once, rewrite tests incl. shadow-real-cli→managed
  - SA-5 `ca3d4087` create-principles-disciple: delete legacy-consumer guards, simplify pending registry, legacy_worker_still_running probe (~80 lines max), rewrite tests
  - SA-6 `d6a7493b` codex/workbuddy-adapter+host-runtime+plugin setup: attribution copy, owner labels→service-host-worker, companion driver collapse
- [ ] Wave 4 integration: typecheck/build ALL packages, resolve cross-package breakage (pd-cli compile vs install-layout API, quiesce-ack refs), copy sweep, then commit logical chunks
- [ ] Wave 5 regression matrix + Wave 6 E2E + report/PR

## Integration watch-list (from audits)

- pd-cli references to install-layout deleted transition kinds (workspace-handover.ts deleted by SA-4 — verify nothing else imports them)
- pd.gateway-quiesce.v1 readers possibly in pd-cli (SA-4 told to delete) — SA-3 doesn't edit outside plugin
- PD_COMPANION_WORKER_IPC deny-lists in worker-env.ts/adapter.ts KEEP (permanent defense)
- console release-handover 'companion' branch in pd-console + UpdatePage.tsx — NOT yet assigned! Evaluate in wave 4 (D1 says companion keeps console supervision → these stay correct)
- pd-console diagnostician.ts detached diagnose-run — KEEP per D2, document
- installer.ts:463-466 companion comment — SA-5 covers
- host=all = openclaw+codex only at install (workbuddy excluded by design) — unchanged
- changeset needed for: install-layout, pd-cli, pd-companion, openclaw-plugin, codex-adapter, workbuddy-adapter, host-runtime, create-principles-disciple — write in wave 4

## Key design constraints from directive

- No second scheduler/queue/daemon/system-service. No new abstractions for hypothetical futures.
- `host=none` → `waiting_for_host_binding` state, NOT companion consumer. Service Host owns workspace but doesn't start workers until binding.
- `host=all` = multi-adapter fan-out, NOT multiple runtimes.
- OpenClaw Gateway running ≠ PD second consumer (Gateway is just host adapter environment).
- Provisioning success → `service_host_owned` only. Scheduler not enabled → fail-closed, NO companion fallback.
- pending-provisioning.json: simplify to Service Host init state only (workspaceDir/recordedAt/reason).
- Section 4.3: review/delete P0-guard pieces that only protected Companion consumers (pendingHost/guardHosts/legacy_consumer_unproven/legacy_consumer_running/bindingVerification parts/resolveResumeProvisioningHost parts/OpenClaw-gateway-as-consumer branch).
- One-time switch: currently-running old PD workers must be stopped + autostart entries removed; must not create dual-consumer window; minimal safety verification only, not a long-term migration framework.
- Don't delete real task data/knowledge/credentials/API keys. Workspace isolation/security boundaries intact.
