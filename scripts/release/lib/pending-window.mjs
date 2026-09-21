/**
 * Pending-publish-window probe (changesets cutover, SPEC v1.2) — shared logic
 * for the published-bundle contract test
 * (packages/openclaw-plugin/tests/package/published-host-runtime-bundle.test.ts),
 * which decides its own skip in-process instead of being told by the workflow.
 *
 * "true" during the window between "a changesets Version PR materialized new
 * component versions" and "the release train published them": a package's
 * INTERNAL runtime dependency range resolves to nothing on the registry, yet
 * the Version PR has already written that exact version into the dependency's
 * own CHANGELOG. Consumers that install the packed artifact FROM the registry
 * skip that probe (it would ETARGET by design); the publish-ordering guarantee
 * itself is owned by the train's dependency-ordered preflight.
 *
 * Requiring the CHANGELOG materialization proof — not just "the range equals
 * this workspace's version" — keeps an ordinary broken version (e.g. a mistyped
 * 9.9.9 no Version PR produced) from being silently read as a future publish
 * window: registry-absent AND not changesets-materialized is a genuinely
 * unresolvable publish range and this throws (fail loud).
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

/**
 * True when `version` was materialized by a changesets Version PR, which writes
 * exactly one `## <version>` heading per release into the package CHANGELOG.
 * Legacy/manual bracket headings (`## [0.1.0] - date`) never match — fine,
 * because a publish window only ever exists for a version a Version PR just
 * wrote, and that write always uses the `## <version>` form.
 */
export function changelogHasVersion(changelogText, version) {
  if (!changelogText || !version) return false;
  const escaped = version.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`^## ${escaped}$`, 'm').test(changelogText);
}

/**
 * Pure, network-free decision for one internal dependency range — the
 * fail-loud contract the probe enforces:
 *
 *   'published' — the range matches a version already on the registry; a
 *                 consumer install resolves normally, there is no window.
 *   'pending'   — registry-absent, the range's base equals the workspace
 *                 version, AND that version is proven materialized by the
 *                 Version PR (changelogHasVersion): the publish window.
 *   'broken'    — registry-absent and NOT a materialized version: a genuinely
 *                 unresolvable publish range (a mistyped/abandoned version),
 *                 which callers must surface rather than skip around.
 */
export function decidePending({ range, registryVersions, workspaceVersion, changelogText }) {
  if (rangeHasRegistryMatch(range, registryVersions ?? [])) return 'published';
  const base = range.replace(/^[~^]/, '');
  const materialized =
    workspaceVersion !== undefined &&
    base === workspaceVersion &&
    changelogHasVersion(changelogText, workspaceVersion);
  return materialized ? 'pending' : 'broken';
}

function workspacePackageMap(repoRoot) {
  const map = new Map();
  for (const entry of fs.readdirSync(path.join(repoRoot, 'packages'), { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    try {
      const pkg = JSON.parse(fs.readFileSync(path.join(repoRoot, 'packages', entry.name, 'package.json'), 'utf8'));
      if (pkg.name && pkg.version && !pkg.private) map.set(pkg.name, { version: pkg.version, dir: `packages/${entry.name}` });
    } catch {
      // not a package directory
    }
  }
  return map;
}

function readChangelog(changelogPath) {
  try {
    return fs.readFileSync(changelogPath, 'utf8');
  } catch {
    return null;
  }
}

export async function isPendingPublishWindow(repoRoot, pkgDirRel) {
  const manifest = JSON.parse(fs.readFileSync(path.join(repoRoot, pkgDirRel, 'package.json'), 'utf8'));
  const internalDeps = Object.entries(manifest.dependencies ?? {}).filter(
    ([name]) => name.startsWith('@principles/') || name === 'principles-disciple',
  );
  const workspacePackages = workspacePackageMap(repoRoot);
  for (const [name, range] of internalDeps) {
    const packument = await fetchPackument(name); // throws on registry errors (never read as absent)
    const pkg = workspacePackages.get(name);
    const decision = decidePending({
      range,
      registryVersions: Object.keys(packument?.versions ?? {}),
      workspaceVersion: pkg?.version,
      changelogText: pkg ? readChangelog(path.join(repoRoot, pkg.dir, 'CHANGELOG.md')) : null,
    });
    if (decision === 'published') continue;
    if (decision === 'pending') {
      console.warn(
        `${name}@${range} is pending publication (a Version PR materialized ${pkg.version} but the registry has no match); the release train's dependency-ordered preflight owns the post-publish guarantee.`,
      );
      return true;
    }
    throw new Error(
      `${name}@${range} resolves to nothing on the registry and is not a changesets-materialized version of this workspace (${pkg?.version ?? 'absent'}) — a genuinely unresolvable publish range.`,
    );
  }
  return false;
}
