# Commercial-Grade PD Update System Design

> Date: 2026-08-25
> Status: Approved design
> Scope: PD release identity, installation layout, update execution, rollback, observability, and development isolation

## 1. Outcome

PD will replace its in-place, multi-directory overlay updater with an immutable-release, dual-slot update system. An update is prepared and verified outside the active runtime, activated through one atomic pointer change, observed after startup, and automatically rolled back when the new release is unhealthy.

The design gives the Owner one trustworthy product version while preserving internal component versions for diagnostics. It fixes the observed failure where a development deployment silently changed the installed plugin from `1.218.0` to the source-tree placeholder `1.76.1`, temporarily broke CLI dependency resolution, and was later presented as an ordinary `1.76.1 -> 1.221.2` update.

## 2. Product and MVP Alignment

This work does not add a new behavior-governance subsystem or activation channel. It repairs the existing installation and update foundation required to deliver the MVP safely.

### MVP questions

1. **`mvp-q-1-what-if-skip`**: If skipped, development installs can overwrite production, component mixtures can remain after partial updates, and a displayed version cannot prove which bytes are running. These failures have already occurred and are likely to recur within 30 days.
2. **`mvp-q-2-how-observed`**: Companion and Console show the active product version, immutable release ID, component consistency, update phase, verification result, and rollback outcome. `pd version --json` exposes the same canonical state.
3. **`mvp-q-3-how-disabled`**: The new updater is registered as a quiet, default-off subsystem during migration. Disabling it leaves the active slot untouched and routes the Owner to the official installer. Activation preserves the previous confirmed slot for immediate rollback. No disable path requires a PR revert.
4. **`mvp-q-4-emotional-value`**: The feature reduces loss of control and distrust by making every installed release identifiable, verified, observable, and reversible. It creates reassurance, control, and clarity without exposing ordinary users to component-version noise.

## 3. Decision and Alternatives

### Selected: immutable releases with dual-slot activation

Each release is installed into an inactive version directory. The updater verifies that directory before changing a small active pointer. The last confirmed release remains intact until the new release is confirmed healthy.

This approach is selected because it prevents mixed-component installations, gives rollback a complete target, supports crash recovery, and separates update execution from the runtime being replaced.

### Rejected: continue hardening in-place overlay updates

This minimizes initial code change but cannot make a sequence of independent copies atomic. It also preserves stale files by construction and leaves dependency reconciliation coupled to a live runtime.

### Rejected: remove in-app updates and require reinstall

This reduces updater complexity but gives up the Owner experience expected from desktop software and does not solve release identity, development isolation, or reproducible publication.

## 4. Canonical Release Identity

PD has one Owner-facing `productVersion`. Internal packages retain their own versions but do not independently answer whether PD is current.

Every published release contains an immutable, runtime-validated `release-manifest.json` with:

- product version and immutable release ID;
- source Git SHA and build timestamp;
- release channel;
- installer version;
- layout and journal schema versions;
- supported host, Node.js, config, and database compatibility ranges;
- each required component's name, internal version, entry point, size, and SHA-256 digest;
- complete archive digest and registry integrity metadata.

The release ID is derived from the product version and release content identity. Published bytes are immutable: any component-byte change requires a new product version and release ID. The build fails if the manifest, archive, package metadata, Git tag, or release channel disagree.

`pd --version` remains compatible but reports the product version. `pd version --json` returns the canonical manifest plus the observed active layout and health. Component versions are diagnostic fields, not competing product versions.

## 5. Installation Layout

The canonical layout is PD-owned and host-neutral:

```text
~/.pd/
  install.json
  active.json
  update-journal.jsonl
  update.lock
  releases/
    <release-id>/
      release-manifest.json
      plugin/
      console/
      core/
      pd-cli/
      host-runtime/
      install-layout/
  staging/
    <operation-id>/
  hosts/
    openclaw/
    codex/
```

Host-managed paths contain only stable adapters or links to the active PD runtime. Backups, staging content, update journals, and inactive releases never enter OpenClaw discovery roots.

The active release is selected by an atomically replaced `active.json` pointer. Host adapters resolve the active release at process start. Platform-specific pointer replacement is hidden behind the install-layout boundary and tested on Windows, Linux, and macOS.

## 6. Update Coordinator

An independent Update Coordinator owns the update lifecycle. Companion and Console request operations from it but do not perform file replacement themselves. The coordinator must remain runnable when the active Console or CLI is broken.

The durable state machine is:

```text
planned -> downloaded -> staged -> verified -> activated -> confirmed
       \-> failed                         \-> rolled_back
```

For each operation the coordinator:

1. Resolves and records the observed active release.
2. Acquires an installation-root lock.
3. Fetches a specific release manifest and pins its release ID, URL, and integrity values.
4. Downloads with bounded retries and verifies registry integrity and archive SHA-256.
5. Rejects unsafe archive entries, excessive sizes, missing components, or manifest mismatches.
6. Extracts only into the operation's staging directory.
7. Installs dependencies inside the staged release from the locked release graph.
8. Runs structural, module-resolution, CLI, Console, host-adapter, config, and database compatibility probes.
9. Moves the verified directory into `releases/<release-id>` and atomically switches `active.json`.
10. Restarts affected hosts and begins a bounded health observation window.
11. Confirms the release when healthy or atomically restores the previous pointer when unhealthy.

Every early return writes a structured reason and next action. No path reports success until post-switch health is confirmed.

## 7. Data and Configuration Compatibility

The first implementation supports additive, backward-readable migrations only. A release must declare the database and config versions it can read and write.

Before activation, the staged runtime performs read-only compatibility checks against the real workspace. If activation requires an irreversible or backward-incompatible migration, automatic update is refused with an Owner-visible explanation and manual migration path.

Where an additive migration is required, it runs through the existing migration authority with a database backup and transaction. The previous runtime must remain capable of reading the migrated state throughout the rollback window. A release cannot be marked rollback-safe unless this is proven by tests.

## 8. Failure Recovery

The journal is append-only and records operation ID, actor, source channel, installation root, prior and target release IDs, current phase, timestamps, verification results, failure reason, next action, activation result, and rollback result.

On startup, the coordinator recovers interrupted operations deterministically:

- incomplete download or staging: keep the active release and safely discard the isolated operation directory;
- verified but not activated: keep the active release and allow retry;
- activated but not confirmed: restore the previous confirmed pointer before starting hosts;
- rollback interrupted: complete restoration from the journal's recorded release IDs;
- journal malformed or authority ambiguous: fail closed and keep the last valid active pointer.

At least the current and previous confirmed releases are retained. Cleanup is bounded, journal-driven, and never recursively targets unresolved paths or host discovery roots.

## 9. Development Isolation

Development deployment uses an explicitly configured development home and cannot default to the user's production home.

The development sync command must:

- require a dev installation marker in the target home;
- reject a target containing a stable-channel active release;
- refuse downgrade before the first mutation;
- require separate explicit production-target, overwrite, and downgrade grants for exceptional manual recovery;
- record an external-install journal event when it changes an installation;
- never delete the active production directory in place.

Companion watches the canonical active release. If files, manifests, or the active pointer change outside the coordinator, it records `external_modification_detected`, stops claiming the installation is healthy, and gives one recovery action.

## 10. Owner Experience

The default update view shows only:

- current product version and channel;
- installation health and component consistency;
- available update and risk/compatibility summary;
- current update phase;
- last successful update or rollback;
- whether Owner action is required and the single next action.

Component versions, hashes, paths, and journal details are available in an expandable diagnostics section. External modification or downgrade is displayed as such, not as a normal update.

The UI never equates registry latest with installed health. “Up to date” means the active release ID equals the stable channel target and all required components match the active manifest.

## 11. Release Pipeline

All components for one release are built from one commit in one release workflow. The pipeline:

1. Builds core, host runtime, install layout, plugin, CLI, Console, and installer in dependency order.
2. Creates the release manifest from final artifacts, not source package versions.
3. Packs the exact release archive and computes integrity values.
4. Installs that archive into a clean, isolated home and runs production-entry smoke tests.
5. Runs upgrade, downgrade refusal, rollback, interruption recovery, and legacy-layout migration tests.
6. Publishes to a candidate channel.
7. Promotes the exact candidate digest to stable without rebuilding.
8. Updates the stable pointer only after all publication targets refer to the same release ID.

The workflow never republishes different bytes under an existing product version. A partial npm or GitHub publication leaves the previous stable pointer unchanged and reports the failed channel.

## 12. Verification Strategy

Required test layers are:

- pure tests for manifest validation, version decisions, state transitions, journal recovery, path containment, and cleanup selection;
- package integration tests for staged dependency resolution and all required entry points;
- fault-injection tests at every download, extract, verify, move, switch, restart, confirm, and rollback boundary;
- production-tarball tests with pre-fix negative controls;
- legacy-to-canonical migration tests;
- OpenClaw-only, Codex-only, and dual-host lifecycle tests;
- Windows, Linux, and macOS CI coverage for pointer activation and filesystem behavior;
- Companion and Console BDD tests for healthy, updating, externally modified, failed, and rolled-back states;
- a release-candidate soak on the Owner environment before stable promotion.

Critical acceptance cases include same-version/different-digest rejection, stable-to-dev downgrade refusal with zero mutation, concurrent update exclusion, corrupted archive rejection, disk exhaustion, file locks, process death after every durable phase, unhealthy post-activation rollback, stale-file absence, and exact JSON output for operator commands.

## 13. Delivery and Rollout

The migration is delivered behind a registered quiet/default-off feature flag. The phases are:

1. Establish immutable release identity and artifact contract without changing installation behavior.
2. Add the coordinator, journal, staging verification, and recovery in shadow/dry-run mode.
3. Add dual-slot layout and exercise migration with synthetic homes and candidate releases.
4. Enable the new path for the Owner environment while retaining the official installer fallback.
5. Confirm a successful update and rollback drill, then promote the flag according to the existing MVP-Core approval rule.
6. Disable write access in the legacy overlay updater and retain only migration guidance.
7. Remove legacy updater code only after the supported migration window and evidence show no active legacy installations.

## 14. Error-Pattern Controls

- **ERR-041 — incomplete delivery reported as success**: success requires every required component, production entry point, and post-activation health check to pass.
- **ERR-042 — output reports requested rather than actual disk state**: all responses are reconstructed from the active manifest, observed component digests, and durable journal after writes.
- **ERR-083 — shared contract change misses consumers**: install-layout, installer, Console, CLI, Companion, host adapters, publication workflows, mocks, and clean-CI build order migrate together through explicit compatibility tests.
- **ERR-090 — package entry point differs across builds**: the release contract probes every declared entry point from the final packed archive.
- **ERR-097 — PD violates host-managed path semantics**: releases, staging, backups, and journals stay under `~/.pd`; host paths contain only contractually supported adapters or links.

Runtime-contract review applies to registry JSON, manifests, journals, archives, config, and database metadata. All remain `unknown` until validated; required fields fail loud; serialization is bounded; degradation includes reason and next action.

## 15. Emotional Value Review

The design primarily serves reassurance, control, and clarity. It reduces loss of control, fatigue, distrust, and update-related information overload.

The Owner can verify which immutable release is running, whether its components are consistent, what changed it, whether an update succeeded, and how rollback occurred. The normal view suppresses internal version noise while diagnostics remain available. The Owner retains the final update and rollback authority, and automatic rollback only restores a previously confirmed release rather than making an autonomous product-value decision.

## 16. Non-Goals

- General application deployment orchestration outside PD.
- A generic package manager or host updater.
- Automatic irreversible database migrations.
- Additional activation channels, memory systems, schedulers, or task execution.
- Silent downgrade, silent repair, or silent fallback.
- Long-term retention of every historical release.

## 17. Success Criteria

The design is complete when:

- one product version and release ID uniquely identify all installed bytes;
- development commands cannot mutate stable installations by default;
- every failed pre-activation update leaves the active release byte-for-byte unchanged;
- every failed post-activation health check restores the prior confirmed release;
- restart recovery reaches a deterministic valid state from every durable phase;
- Companion, Console, and CLI report the same canonical release and health;
- clean packaged E2E, cross-platform activation, fault injection, rollback drill, and required merge gates pass without skipped tests;
- the Owner can understand the current state and next action without interpreting component package versions.
