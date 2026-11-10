# @principles/install-layout

## 0.7.0

### Minor Changes

- 1042164: PRI-1165: make PD's `openclawHome` follow OpenClaw's explicit state dir, and move the experiment instance's runtime cache into its root.
  
  - `resolvePdHome()` now treats `OPENCLAW_STATE_DIR` as authoritative over `OPENCLAW_HOME` in production (matching OpenClaw) and requires it to stay inside the experiment root in experiment mode. A relative `OPENCLAW_STATE_DIR` is refused fail-closed (`openclaw_state_dir_not_absolute`); in experiment mode a value outside the root is refused (`openclaw_state_dir_outside_experiment`).
  - `pd config doctor` follows an explicit `OPENCLAW_STATE_DIR` for the OpenClaw home (instead of always `<home>/.openclaw`) and honours an explicit `OPENCLAW_CONFIG_PATH`.
  - `dev:console:experiment` now sets `XDG_CACHE_HOME=<root>/.cache` — OpenClaw's private SQLite snapshot staging root and rolling logs resolve through it instead of `%LOCALAPPDATA%\openclaw` — and `OPENCLAW_PROFILE=experiment` so the rolling log filename is namespaced. `%LOCALAPPDATA%\OpenClaw\locks` stays shared but is safe: lock files are keyed by the canonical state-db path.

## 0.6.0

### Minor Changes

- 93288c7: PRI-872: add a fail-closed PD home contract so a second (experiment) instance can run on the same user account without touching the production installation.
  
  - `resolvePdHome()` / `PD_EXPERIMENT_ROOT` (install-layout): the single authority for "which PD home does this process own". Production keeps the historical `os.homedir()` derivation; an experiment root derives `.pd`, `.pd-console`, `.openclaw` and `.codex` under itself. Unusable values (empty, relative, missing, not a directory, overlapping `~/.pd`/`~/.pd-console`/`~/.openclaw`, or a derived path linked outside the root) return a structured refusal — never a silent fallback to the real user home.
  - `create-principles-disciple`: the detached bootstrap executor resolves its PD home through the same contract, so an experiment console's update transaction can never target the production runtime.
  - pd-console: every user-level path (workspace registry, update page/history, bootstrap executor lookup, backups, gateway config) now derives from that resolution instead of `os.homedir()`; an experiment instance defaults to console port 13100, refuses product updates (`experimental_instance`) and refuses machine-level `openclaw gateway stop|start` (its gateway is a foreground `openclaw gateway run` owned by the launcher). New `npm run dev:console:experiment -- --root <abs dir>` starts the isolated instance with port preflight and child-process lifecycle.

## 0.5.0

### Minor Changes

- bbdcb50: Separate the four independent WorkBuddy host facts in `pd health --host workbuddy` — plugin registration (registry), plugin enablement (settings enabledPlugins), governance flag state (ENABLED / EXPLICITLY_DISABLED / DEFAULT_OFF / UNKNOWN, an explicit Owner opt-out is never folded into a generic OFF), and an explicit runtime boundary (RUNTIME_PROBE_NOT_PERFORMED + MODEL_TOOL_CALL_NOT_VERIFIED; pd health stays read-only, never starts the host or the MCP server). The registration/enablement judgment and the host config paths move to @principles/install-layout as the single authority (getWorkbuddyHostConfigPaths / interpretWorkbuddyPluginState) — installer, `status` and `pd health` now resolve the same paths and apply the same rules; the installer delegates instead of owning a second judgment. A complete MCP payload implies nothing about registration or enablement. Verified: a WorkBuddy-only machine reports INSTALLED at the top level (negative control included).

## 0.4.1

### Patch Changes

- fb70a87: Gate 4 (PRI-1071): expose the canonical MCP server component path (`mcpServerDir` + `getMcpServerEntry`) so PD-owned binding writers derive `~/.pd/runtime/pd-mcp-server/dist/index.js` from the install-layout SSoT instead of repeating the segment list. The installer keeps a local twin until this version is on the registry (0.4.0 predates the export); the twin is removed in the follow-up release.

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
