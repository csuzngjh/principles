/**
 * Workspace inventory for release governance scripts (SPEC v1.2 §7, §14).
 *
 * The repository layout is the only authority: publishability is a manifest
 * fact (the `private` flag), and the product-assembly (C4) rules are the
 * two confirmed hard edges from the PRI-878 dependency audit.
 */
import fs from 'node:fs';
import path from 'node:path';

export const PUBLISHABLE_DIRS = [
  'principles-core',
  'install-layout',
  'host-runtime',
  'codex-adapter',
  'pd-cli',
  'openclaw-plugin',
  'create-principles-disciple',
];

// C4 hard rules (SPEC §14): left package entering the final release plan
// REQUIRES the right package to be in it too. This list is deliberately the
// CONFIRMED set, not the whole C4 universe (SPEC §14.5).
export const PRODUCT_ASSEMBLY_RULES = [
  { when: 'principles-disciple', requires: 'create-principles-disciple' },
];

// C4 payload sources: changes under these private trees ship inside the
// installer bundle, so a change here puts the installer in the final plan.
export const ASSEMBLY_PAYLOAD_SOURCES = [{ path: 'packages/pd-console/', requires: 'create-principles-disciple' }];

export function loadWorkspace(cwd) {
  const packages = [];
  for (const dir of fs.readdirSync(path.join(cwd, 'packages'))) {
    const manifestPath = path.join(cwd, 'packages', dir, 'package.json');
    if (!fs.existsSync(manifestPath)) continue;
    const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
    packages.push({
      dir,
      manifestPath,
      name: manifest.name,
      version: manifest.version,
      private: manifest.private === true,
      manifest,
    });
  }
  return {
    packages,
    byDir: new Map(packages.map((p) => [p.dir, p])),
    byName: new Map(packages.map((p) => [p.name, p])),
    publishable: packages.filter((p) => !p.private),
  };
}

const NON_RELEASE_PATH_PATTERNS = [
  /(^|\/)__tests__\//, // bundled test directories
  /(^|\/)tests?\//, // test directories (fixtures live inside them)
  /\.test\.[cm]?[jt]sx?$/, // test files
  /\.spec\.[cm]?[jt]sx?$/,
  /\.md$/, // docs
  /(^|\/)fixtures?\//, // fixture directories outside tests
];

/**
 * Conservative path rule (SPEC §10): everything under a package directory
 * counts as release-affecting EXCEPT the test/docs/fixture patterns above.
 * False positives are the intended direction — the escape hatch is an
 * official empty changeset, not a waiver database (SPEC §10.2).
 */
export function isReleaseRelevantPath(relPath) {
  return !NON_RELEASE_PATH_PATTERNS.some((re) => re.test(relPath));
}

export function packageDirForPath(relPath) {
  const m = /^packages\/([^/]+)\//.exec(relPath);
  return m ? m[1] : null;
}

/**
 * Publishable packages whose source changed (release-relevant paths only)
 * among the given diff paths.
 */
export function changedPublishablePackages(cwd, diffPaths) {
  const ws = loadWorkspace(cwd);
  const dirs = new Set();
  for (const rel of diffPaths) {
    if (!isReleaseRelevantPath(rel)) continue;
    const dir = packageDirForPath(rel);
    if (!dir) continue;
    const pkg = ws.byDir.get(dir);
    if (pkg && !pkg.private) dirs.add(dir);
  }
  return [...dirs].map((dir) => ws.byDir.get(dir));
}
