/**
 * Local twin of install-layout's `installManifestHostsForPersist()`.
 *
 * WHY A COPY EXISTS (2026-10-16): `create-principles-disciple` is published
 * to npm and resolves `@principles/install-layout` from the REGISTRY — which
 * still serves 0.3.x without the new export. Importing the export here made
 * the packed installer crash at import time while the declared `^0.3.1`
 * range was still satisfied by the registry (the registry-parity smoke
 * caught it). With 0.3.x the parsed manifest never carries `unknownHosts`,
 * so this union degrades to exactly the pre-change behavior — no
 * regression, and full unknown-host preservation as soon as the workspace
 * (or a published ≥0.4.0) parser supplies the field.
 *
 * RETIRE WHEN: install-layout's published version reaches the release that
 * ships `installManifestHostsForPersist` and this package's dependency range
 * is raised to it — switch both call sites back to the shared export and
 * delete this file (tracked in the companion-install-compat changeset note).
 */
export function manifestHostsUnionForPersist(manifest: { hosts?: readonly string[]; unknownHosts?: readonly string[] } | undefined): string[] {
  return [...new Set([...(manifest?.hosts ?? []), ...(manifest?.unknownHosts ?? [])])];
}
