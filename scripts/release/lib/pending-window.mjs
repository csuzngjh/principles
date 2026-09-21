/**
 * Pending-publish-window probe (changesets cutover, SPEC v1.2) — shared
 * logic for the CLI (scripts/release/is-pending-publish-window.mjs) and
 * the openclaw-plugin vitest config (which needs a sync-decided exclusion
 * at config-load time and runs this in-process via async config).
 *
 * "true" when the package's INTERNAL runtime dependencies include a range
 * that resolves to nothing on the registry BUT is satisfied by the same
 * workspace's own (not-yet-published) version — the window between "the
 * Version PR materialized new versions" and "the release train published
 * them". Consumers skip checks that install the packed artifact from the
 * registry (they would ETARGET by design); the publish-ordering guarantee
 * itself is owned by the train's dependency-ordered preflight.
 *
 * A range with no registry match that is NOT satisfied by the workspace is
 * a genuinely broken publish range: this throws (fail loud).
 */
import fs from 'node:fs';
import path from 'node:path';
import { fetchPackument } from './registry-client.mjs';

function parseSemver(v) {
  const m = /^(\d+)\.(\d+)\.(\d+)/.exec(v);
  return m ? [Number(m[1]), Number(m[2]), Number(m[3])] : null;
}

/**
 * Range matching for the shapes PD manifests declare (^X.Y.Z, ~X.Y.Z,
 * X.Y.Z): caret matches same major >= base, tilde matches same
 * major.minor >= base patch, exact is equality. (A same-minor-prefix-only
 * check misses that ^1.74.1 legitimately matches 1.286.x — the registry
 * never published 1.74.1 at all.)
 */
export function rangeHasRegistryMatch(range, versions) {
  const base = parseSemver(range.replace(/^[~^]/, ''));
  if (!base) return false;
  const isCaret = range.startsWith('^');
  const isTilde = range.startsWith('~');
  return versions.some((v) => {
    const p = parseSemver(v);
    if (!p) return false;
    if (p[0] !== base[0]) return false;
    if (!isCaret && !isTilde) return v === range;
    if (isTilde && p[1] !== base[1]) return false;
    return p[1] > base[1] || (p[1] === base[1] && p[2] >= base[2]);
  });
}

function workspaceVersionMap(repoRoot) {
  const map = new Map();
  for (const entry of fs.readdirSync(path.join(repoRoot, 'packages'), { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    try {
      const pkg = JSON.parse(fs.readFileSync(path.join(repoRoot, 'packages', entry.name, 'package.json'), 'utf8'));
      if (pkg.name && pkg.version && !pkg.private) map.set(pkg.name, pkg.version);
    } catch {
      // not a package directory
    }
  }
  return map;
}

export async function isPendingPublishWindow(repoRoot, pkgDirRel) {
  const manifest = JSON.parse(fs.readFileSync(path.join(repoRoot, pkgDirRel, 'package.json'), 'utf8'));
  const internalDeps = Object.entries(manifest.dependencies ?? {}).filter(
    ([name]) => name.startsWith('@principles/') || name === 'principles-disciple',
  );
  const workspaceVersions = workspaceVersionMap(repoRoot);
  for (const [name, range] of internalDeps) {
    const packument = await fetchPackument(name); // throws on registry errors (never read as absent)
    if (rangeHasRegistryMatch(range, Object.keys(packument?.versions ?? {}))) continue;
    const pending = workspaceVersions.get(name);
    if (pending !== undefined && range.replace(/^[~^]/, '') === pending) {
      console.warn(
        `${name}@${range} is pending publication (workspace has ${pending}); the release train's dependency-ordered preflight owns the post-publish guarantee.`,
      );
      return true;
    }
    throw new Error(
      `${name}@${range} resolves to nothing on the registry and does not match this workspace's own version (${pending ?? 'absent'}) — a genuinely unresolvable publish range.`,
    );
  }
  return false;
}
