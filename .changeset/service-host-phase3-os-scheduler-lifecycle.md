---
"@principles/pd-cli": minor
"create-principles-disciple": minor
---

PD Service Host Phase 3 (PRI-1281, SPEC-PD-SERVICE-HOST-001 §11 Phase 3 /
§8.1 / §10, ADR-0020 §11.6): user-level OS Scheduler + the full Service
Host lifecycle command surface.

pd-cli (minor) — three layers, all inside the existing
`src/services/service-host/scheduler/` boundary (no new package; TD §11
independence-plan superseded, ERR-196):

- Scheduler Adapter Contract: ONE five-operation interface
  (install/enable/disable/status/uninstall) with three REAL platform
  implementations behind it — Windows current-user Task Scheduler task
  (PowerShell ScheduledTasks module, JSON protocol, FullyQualifiedErrorId
  classification so an access denial NEVER reads as "not installed"),
  macOS user LaunchAgent (plist + launchctl bootstrap/bootout/enable/
  disable in the caller's own `gui/<uid>` domain), Linux systemd --user
  service+timer (atomic unit writes, honest daemon-reload/bus failures,
  `is-enabled` unreadable ≠ disabled). All user-level: no elevation, no
  Windows Service / LaunchDaemon / root unit, no credentials in any
  registration; install defaults to installed_disabled; every operation
  is idempotent; a same-named registration that does not reference THIS
  install's CLI entry is FOREIGN and fail-closed (never overwritten or
  deleted). Registration identity is derived from the canonical pdHome
  (sha256 prefix) so two installs of one user cannot collide; the
  registered command pins ABSOLUTE node + active-release CLI entry paths
  (`service run-once --json --trigger scheduler --pd-home <dir>`) — no
  PATH, no cwd, no env-derived identity. Interval default 120s (existing
  worker cadence), floor 60s (the real Windows PT1M repetition minimum,
  verified live), adjustable via `--interval-ms`.
- Managed execution — `pd service run-once --json` (bare) is now the OS
  scheduler entry: the same trusted prefix (identity → install lock →
  active release → manifest → validated claims → discovery) then an
  ownership-based admission matrix (§8.4): ONLY
  `effectiveOwner=service_host` + `service_host_owned` + authorized
  verdict workspaces execute (one bounded real worker cycle per bound
  adapter via the SAME dispatch core as shadow — monotonic per-workspace
  budget, abort-before-every-dispatch, failure isolation); legacy_owned
  workspaces are skipped (legacy owner stays unique);
  handover_preparing / rollback_pending are NEVER consumed; conflicting
  owner projections and unauthorized verdicts are refused per-workspace;
  an unreadable manifest/marker refuses the whole run (never "zero
  workspaces"). Zero service_host_owned workspaces is a LEGAL empty
  completed run (`no_service_host_owned_workspaces`). `--trigger
  manual|scheduler` records the truthful trigger source (login vs
  periodic is deliberately not distinguishable — never fabricated).
  Status stays `pd.service-run-status.v1`, extended additively with a
  `managed` section. `--dry-run` and `--shadow` contracts unchanged.
- Lifecycle commands — `pd service install|enable|disable|status
  --json|uninstall` (+ `--pd-home` trusted injection on every service
  subcommand): `status` composes the unified read-only contract
  (`pd.service-status.v1`) where every clause comes from its OWN witness
  (OS registration/enabled/interval/OS last-run ← the OS; last run
  outcome/mode/triggerSource ← run-once-status.json; lastProgressAt ←
  the cross-run progress store; workspace owner states ← fresh
  read-only discovery) — registered ≠ enabled ≠ running ≠ completed ≠
  business_progress, proven in disagreeing combinations. Status reads
  start no Worker and write no business data. disable keeps the
  registration and ALL data; uninstall removes ONLY this install's
  registration (Workspace data / .pd/state.db / Ledger / Trajectory /
  evidence untouched).

create-principles-disciple (minor): installer integration through a
scheduler BRIDGE — the installer never re-implements lifecycle logic; it
spawns the just-installed CLI (`service … --json --pd-home <trusted>`),
with a cleaned child env (PD_EXPERIMENT_ROOT / PD_WORKSPACE_DIR
stripped). Post-commit reconciliation (failures are warnings, never a
reported install failure — ERR-197): with EXPLICIT consent only
(`--register-service-host` = register disabled; `--enable-service-host`
= register + enable; no flag registers NOTHING silently), register or
register+enable; without consent, upgrades REFRESH-IF-REGISTERED only
(idempotent re-install preserving the enabled state — never creates a
registration). Uninstall revokes the scheduler registration BEFORE the
shared runtime is removed and ONLY when the shared runtime is being
removed (a host-scoped uninstall keeps it while other hosts still use
the runtime); a failed revocation is a warning with manual removal
instructions.

pd-console (rides the create-principles-disciple release above — pd-console
is a private, never-versioned package): NEW read-only `GET
/api/service-host/status` — spawns `pd service status --json` (the same
single implementation); non-GET methods are refused by construction and no
lifecycle surface exists in the Console (SPEC §7: UI never owns the
scheduler lifecycle).

Real-platform verification (Windows): full lifecycle against the REAL
Task Scheduler with an isolated install identity — install→disabled,
idempotent re-install preserving state, enable, a REAL OS start of the
registered command (LastRunTime/LastTaskResult observed), disable,
uninstall, idempotent re-uninstall, zero leftover tasks. This host's
hardened policy denies unelevated registration; that path is asserted
live as the honesty contract (structured access-denied, never "not
installed") and the lifecycle runs through an elevated PowerShell bridge
documented in the test. macOS LaunchAgent and Linux systemd --user
adapters are unit-tested against faked command boundaries; real-platform
acceptance on those platforms is recorded NOT_VERIFIED until run on real
hosts (task §9.F).
