/**
 * G2 payload trim (SPEC-PD-RELEASE-FOOTPRINT-001; artifact-size-audit D8/P6).
 *
 * The `release-manager/` payload component is the RUNTIME update seam, not a
 * second copy of the installer CLI. Its real consumers are:
 *   - the installed console, which resolves `create-principles-disciple/update-console`
 *     (exports map → dist/update/console-surface.js) through the junction
 *     installer.ts:2522 creates;
 *   - the deployed bootstrap executor (bootstrap-entry.js → update/bootstrap-executor.js),
 *     whose dist is copied FROM this payload component (installer.ts:544);
 *   - the install-time authority probe (installer.ts:2461 dynamic-imports the
 *     same console-surface entry).
 *
 * Everything those entries reach at runtime must ship; everything else in the
 * package dist (CLI entry index.js, uninstaller.js, prompts.js, test-only
 * update modules, release-metadata-publisher.js, .d.ts/.js.map artifacts)
 * belongs to the npm CLI package only. The keep-set below is therefore the
 * transitive RELATIVE-import closure of the entry modules computed from the
 * compiled dist — including the DYNAMIC `import('../installer.js')` in
 * release-manager.js/apply-payload.js (the update transaction applier), which
 * is why installer.js and its static closure stay.
 *
 * This module exists so the bundle step (bundle-plugin.mjs) and its guard
 * test share ONE definition of "the release-manager subset" instead of two
 * drifting lists — same pattern as scripts/build/lab-payload.mjs.
 */
import { existsSync, readFileSync } from 'node:fs';
import { join, posix } from 'node:path';

/** Runtime entry modules of the release-manager payload component. */
export const RELEASE_MANAGER_ENTRY_MODULES = [
  'dist/update/console-surface.js',
  'dist/bootstrap-entry.js',
];

/**
 * Modules that must NEVER appear in the closure. Each was verified consumer-
 * free on baseline 99b3a1143 (audit 2026-11-02): reached by no runtime entry,
 * only by the CLI (index.js) or tests/publish tooling. The guard test asserts
 * their absence so a new edge resurrecting them is a loud decision, not a
 * silent regression of this trim.
 */
export const RELEASE_MANAGER_KNOWN_ORPHANS = [
  'dist/index.js',
  'dist/uninstaller.js',
  'dist/prompts.js',
  'dist/update/update-history.js',
  'dist/update/rollback-policy.js',
  'dist/update/channel-promotion.js',
  'dist/update/data-compatibility.js',
  'dist/update/release-metadata-publisher.js',
];

// Static `from '...'` and dynamic `import('...')` relative specifiers.
// Emitted code always carries explicit extensions (NodeNext), but an
// extensionless specifier still resolves by appending `.js`.
const RELATIVE_IMPORT = /(?:from|import)\s*\(?\s*['"](\.[^'"]+)['"]/g;

function resolveSpecifier(fromRel, specifier) {
  const joined = posix.normalize(posix.join(posix.dirname(fromRel), specifier));
  return joined.endsWith('.js') ? joined : `${joined}.js`;
}

/**
 * Transitive closure over the compiled dist. Fails loud on a missing module —
 * a payload assembled around a broken closure assumption must not ship.
 * Bare specifiers (node:*, tuf-js, …) resolve from node_modules and are
 * intentionally not tracked here.
 */
export function collectReleaseManagerPayload(packageRoot) {
  const root = String(packageRoot);
  const seen = new Set();
  const queue = [...RELEASE_MANAGER_ENTRY_MODULES];
  for (;;) {
    const rel = queue.shift();
    if (rel === undefined) break;
    if (seen.has(rel)) continue;
    const abs = join(root, rel);
    if (!existsSync(abs)) {
      throw new Error(`release-manager payload module not found: ${abs} — run npm run build --workspace=create-principles-disciple`);
    }
    seen.add(rel);
    const source = readFileSync(abs, 'utf8');
    for (const match of source.matchAll(RELATIVE_IMPORT)) {
      const target = resolveSpecifier(rel, match[1]);
      if (!target.startsWith('dist/')) {
        throw new Error(`release-manager module ${rel} imports outside dist/: ${match[1]} (${target})`);
      }
      queue.push(target);
    }
  }
  for (const orphan of RELEASE_MANAGER_KNOWN_ORPHANS) {
    if (seen.has(orphan)) {
      throw new Error(`release-manager closure gained a consumer of trimmed module ${orphan} — re-run the payload consumer audit and update RELEASE_MANAGER_KNOWN_ORPHANS deliberately`);
    }
  }
  return [...seen].sort();
}
