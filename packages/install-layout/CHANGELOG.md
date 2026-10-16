# @principles/install-layout

## 0.4.0

### Minor Changes

- fec1306: > Note: `@principles/pd-companion` is private and changesets-ignored; its
  > desktop release version bump (0.1.2 → 0.1.3) belongs to the companion
  > release-prep flow, not to this changeset.
  >
  > Note (RF-02, PUBLISH_BLOCKED until install-layout 0.4.0 publishes): the
  > npm-published installer resolves its install-layout dependency from the
  > registry, which still serves 0.3.x. While that holds, the installer's
  > unknown-host compatibility is REFUSE-ONLY: a manifest carrying a host the
  > dependency cannot parse makes install/merge fail closed
  > (install_manifest_malformed) instead of dropping the registration —
  > verified against the real registry resolution by the dual-mode parity test
  > in the packaged-install smoke suite. True forward-compat write-through
  > activates when this changeset's install-layout minor publishes (0.4.0) and
  > this package's range is raised to it; the local twin
  > (`src/manifest-host-union.ts`) must then be retired in favor of the shared
  > export, and the parity test flips to its positive mode automatically.
  
  Fix the PD Companion install-compatibility brick (2026-10-16): Companion 0.1.2
  bundled install-layout 0.1.0, whose parser rejected the production 3-host
  manifest (`workbuddy` unknown) as `install_manifest_malformed` — surfacing
  "未找到已安装的 PD / console_runtime_not_installed" on a healthy canonical
  install and mass-stopping every running workspace worker as
  `removed_from_manifest`.
  
  - install-layout: an unknown host string is now a structured
    `install_manifest_unknown_host` warning (parsed into
    `manifest.unknownHosts`), never a malformed manifest; `layoutVersion`
    mismatch, structural damage and illegal workspace paths stay fail-closed;
    new `installManifestHostsForPersist()` reunifies known+unknown hosts for
    writers; the parser re-reads its own output idempotently.
  - installer / workbuddy host installer / uninstaller: manifest write-backs
    carry unknown host registrations forward instead of silently unregistering
    a newer host; an uninstall keeps the shared runtime while any unknown host
    remains registered.
  - Companion: manifest reads return an explicit ok/unavailable outcome — an
    unreadable manifest holds worker state (structured
    `workspace_worker_sync_skipped` events, one Owner-visible escalation per
    episode) instead of syncing an empty list; install-layout failure causes
    are routed distinctly (incompatible layoutVersion → update-the-Companion
    page with a release link; missing install; corrupt runtime).
  - Packaging: verify-package now gates the parser extracted FROM the built
    app.asar through the manifest cross-version compatibility matrix
    (scripts/bundled-parser-compat.mjs) and records the app + bundled
    install-layout versions; companion-release runs the package test suite
    before packaging.

## 0.3.1

### Patch Changes

- ccc04eb: Switch distributed PD packages to Apache License 2.0, ship matching LICENSE/NOTICE files, and preserve the historical MIT notice. This is a licensing and packaging release without runtime feature changes.

## 0.3.0

### Minor Changes

- 5e794be: WorkBuddy install contract: 'workbuddy' install host, workbuddyAdapterDir, getWorkbuddyWorkspaceDir (OD-07 governance workspace).

## 0.2.7

### Patch Changes

- edbbcd9: RAH-3 (PRI-907): complete the release-artifact content boundary. @principles/install-layout and principles-disciple (openclaw-plugin) production builds now exclude compiled tests (tsconfig.build.json; plugin build:types declaration emit filtered too) with the same fail-loud dist hygiene assertion as RAH-1. The installer bundle script (create-principles-disciple) filters compiled test artifacts out of every payload copy AND asserts zero test artifacts across all payload components after materialization — test code can no longer reach user machines even if a future package forgets its build-boundary guard. A repo-level scan (check:workspace-artifacts, wired into verify:merge) backstops all workspace dist trees.
