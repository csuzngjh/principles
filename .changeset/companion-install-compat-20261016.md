---
'@principles/install-layout': minor
'create-principles-disciple': patch
---

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
