/**
 * Cross-version compatibility gate for the install-layout parser that ships
 * INSIDE the packaged PD Companion (Fix C, 2026-10-16).
 *
 * The 0.1.2 release bundled install-layout 0.1.0, whose parser rejected the
 * production 3-host manifest (workbuddy) as install_manifest_malformed — the
 * app booted into "未找到已安装的 PD / console_runtime_not_installed" on a
 * healthy install and mass-stopped its workers. Repository source being
 * correct is NOT enough: the artifact must be verified, so this module is
 * executed twice:
 *
 *   1. by scripts/verify-package.mjs against the parser extracted from the
 *      built app.asar (the release gate), and
 *   2. by tests/lib/bundled-parser-compat.test.ts against the workspace
 *      source (keeps the contract honest between releases).
 *
 * Failure classes that must stay LOUD (fail-closed): incompatible
 * layoutVersion, structurally damaged manifests. Everything here runs pure —
 * no fs, no home-dir state.
 */

/** The production manifest shape (2026-10-16): three registered hosts. */
export const PRODUCTION_SHAPED_MANIFEST = Object.freeze({
  layoutVersion: 1,
  mode: 'canonical',
  hosts: ['openclaw', 'codex', 'workbuddy'],
  workspaces: ['C:\\pd\\ws-codex', 'C:\\Users\\demo\\.workbuddy\\pd-workspace'],
});

/**
 * Run the compatibility matrix against a parser implementation. `layout` is
 * the module under test ({ parseInstallManifest, resolveInstallLayout,
 * installManifestHostsForPersist }) — either the repo source or the bundled
 * dist code extracted from an app.asar.
 *
 * Returns a human-readable summary; throws with a structured reason on the
 * first violated row.
 */
export function assertInstallManifestCompat(layout) {
  const { parseInstallManifest, resolveInstallLayout, installManifestHostsForPersist } = layout;
  for (const [name, fn] of [['parseInstallManifest', parseInstallManifest], ['resolveInstallLayout', resolveInstallLayout], ['installManifestHostsForPersist', installManifestHostsForPersist]]) {
    if (typeof fn !== 'function') {
      throw new Error(`Bundled parser compatibility failed — ${name}() is missing from the packaged @principles/install-layout. The shipped parser is older than the manifest contract requires; rebuild the Companion against the current workspace package.`);
    }
  }

  // Row 1 — the production 3-host manifest loads (the exact incident shape).
  const threeHost = parseInstallManifest(PRODUCTION_SHAPED_MANIFEST);
  if (threeHost.manifest === undefined) {
    throw new Error(`Bundled parser compatibility failed — the production 3-host manifest (openclaw+codex+workbuddy) was rejected: ${threeHost.error ?? 'unknown'}. This is the 2026-10-16 incident shape; the shipped parser is too old for current installs.`);
  }
  if (threeHost.manifest.hosts.join(',') !== 'openclaw,codex,workbuddy') {
    throw new Error(`Bundled parser compatibility failed — 3-host manifest parsed with wrong hosts: ${JSON.stringify(threeHost.manifest.hosts)}.`);
  }

  // Row 2 — canonical wins over legacy when the runtime exists (no wrong
  // legacy fallback on a healthy canonical install).
  const resolved = resolveInstallLayout({
    homeDir: 'C:\\Users\\demo',
    manifest: PRODUCTION_SHAPED_MANIFEST,
    canonicalRuntimeExists: true,
    legacyExtensionExists: true,
  });
  if (resolved.mode !== 'canonical') {
    throw new Error(`Bundled parser compatibility failed — a valid canonical install resolved to mode "${resolved.mode}" (reason: ${resolved.reason ?? 'n/a'}); the Companion would fall back to the legacy extension dir and report the runtime as not installed.`);
  }

  // Row 3 — an unknown FUTURE host warns instead of bricking (forward compat).
  const future = parseInstallManifest({ ...PRODUCTION_SHAPED_MANIFEST, hosts: [...PRODUCTION_SHAPED_MANIFEST.hosts, 'some-future-host'] });
  if (future.manifest === undefined) {
    throw new Error(`Bundled parser compatibility failed — an unknown 4th host was rejected as ${future.error ?? 'unknown'} instead of warning. The next new host would re-brick this Companion build the same way workbuddy did.`);
  }
  if (!Array.isArray(future.warnings) || !future.warnings.some((w) => w.code === 'install_manifest_unknown_host' && w.host === 'some-future-host')) {
    throw new Error('Bundled parser compatibility failed — an unknown host was tolerated SILENTLY; the structured warning (install_manifest_unknown_host) is missing (rc-9).');
  }

  // Row 4 — writer helper reunites known + unknown hosts (no registration loss).
  const persisted = installManifestHostsForPersist(future.manifest);
  if (persisted.join(',') !== 'openclaw,codex,workbuddy,some-future-host') {
    throw new Error(`Bundled parser compatibility failed — installManifestHostsForPersist lost registrations: ${JSON.stringify(persisted)}.`);
  }

  // Row 5 — incompatible layoutVersion stays fail-closed.
  const futureVersion = parseInstallManifest({ ...PRODUCTION_SHAPED_MANIFEST, layoutVersion: 2 });
  if (futureVersion.manifest !== undefined || !(futureVersion.error ?? '').startsWith('install_manifest_unsupported_version')) {
    throw new Error(`Bundled parser compatibility failed — layoutVersion 2 did not fail closed (manifest: ${futureVersion.manifest !== undefined}, error: ${futureVersion.error ?? 'none'}).`);
  }

  // Row 6 — structurally damaged manifests stay fail-closed (relative
  // workspace paths must never read as "zero workspaces").
  const damaged = parseInstallManifest({ ...PRODUCTION_SHAPED_MANIFEST, workspaces: ['relative/path'] });
  if (damaged.manifest !== undefined || !(damaged.error ?? '').includes('workspaces')) {
    throw new Error(`Bundled parser compatibility failed — a corrupt workspaces field did not fail closed (manifest: ${damaged.manifest !== undefined}, error: ${damaged.error ?? 'none'}).`);
  }

  return [
    `3-host production manifest: parsed (hosts=${threeHost.manifest.hosts.join(',')})`,
    'canonical preference over legacy: ok',
    "unknown 4th host: tolerated with 'install_manifest_unknown_host' warning",
    'writer host reunification (known+unknown): ok',
    `layoutVersion 2: rejected (${futureVersion.error})`,
    `corrupt workspaces: rejected (${damaged.error})`,
  ];
}
