/**
 * Release version consistency guard for the PD Companion (RF-03, review
 * 2026-10-16).
 *
 * A `companion-vX.Y.Z` tag must never produce an installer whose internal
 * version disagrees with the tag or the repository. The chain enforced:
 *
 *   tag (companion-vX.Y.Z)  ==  repo package.json version
 *                           ==  package.json embedded in the built app.asar
 *
 * The repo-side check makes the release-prep PR (version field + lockfile) a
 * machine-enforced precondition of tagging instead of tribal memory: tagging
 * 0.1.3 on a commit whose package.json still says 0.1.2 fails the release
 * build before any artifact is uploaded or published.
 *
 * workflow_dispatch builds (no tag) still enforce repo ↔ artifact agreement,
 * and remain manual TEST artifacts: the GitHub Release step only runs on
 * companion-v* tags (enforced in companion-release.yml).
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import * as asar from '@electron/asar';

const SEMVER_PATTERN = /^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/;

/** Locate app.asar under an electron-builder output directory. */
export function locatePackagedAppAsar(releaseDir) {
  const candidate = path.join(releaseDir, 'win-unpacked', 'resources', 'app.asar');
  if (fs.existsSync(candidate)) return candidate;
  throw new Error(
    `Version consistency check failed — no packaged app.asar under ${releaseDir}. ` +
    `Run \`npm run dist --workspace=@principles/pd-companion\` first, then retry.`,
  );
}

/** Read the version field of the package.json embedded inside an app.asar. */
export function readAsarAppVersion(appAsarPath) {
  const forms = ['package.json', 'package.json'.replaceAll('/', '\\')];
  for (const form of forms) {
    try {
      const extracted = asar.extractFile(appAsarPath, form);
      const parsed = JSON.parse(extracted.toString('utf8'));
      if (typeof parsed.version === 'string' && parsed.version.length > 0) return parsed.version;
      throw new Error(`Version consistency check failed — ${appAsarPath} embeds a package.json without a non-empty "version" string.`);
    } catch (error) {
      if (error instanceof Error && error.message.includes('Version consistency check failed')) throw error;
      /* try the next separator form */
    }
  }
  throw new Error(`Version consistency check failed — could not read package.json from ${appAsarPath}.`);
}

/**
 * Pure core. Throws with a structured reason on any disagreement; resolves
 * with the verified version on success.
 */
export function checkVersionConsistency({ repoVersion, artifactVersion, expectedTagVersion }) {
  for (const [name, value] of [['repoVersion', repoVersion], ['artifactVersion', artifactVersion]]) {
    if (typeof value !== 'string' || !SEMVER_PATTERN.test(value)) {
      throw new Error(`Version consistency check failed — ${name} is not a valid version string: ${JSON.stringify(value)}.`);
    }
  }
  if (repoVersion !== artifactVersion) {
    throw new Error(
      `Version consistency check failed — the repository package.json says ${repoVersion} but the built app.asar embeds ${artifactVersion}. ` +
      `The artifact was not built from this source tree; rebuild before releasing.`,
    );
  }
  if (expectedTagVersion !== undefined) {
    if (typeof expectedTagVersion !== 'string' || !SEMVER_PATTERN.test(expectedTagVersion)) {
      throw new Error(
        `Version consistency check failed — tag-derived version ${JSON.stringify(expectedTagVersion)} is not a valid version string. ` +
        `Release tags must be named companion-vX.Y.Z.`,
      );
    }
    if (expectedTagVersion !== repoVersion) {
      throw new Error(
        `Version consistency check failed — tag companion-v${expectedTagVersion} does not match the package version ${repoVersion}. ` +
        `The version bump must land through a release-prep change BEFORE the tag is cut; retag the version-bump commit.`,
      );
    }
  }
  return { version: repoVersion };
}

// CLI entry: `npm run check:release-version --workspace=@principles/pd-companion [-- --expect-tag X.Y.Z]`
const isDirectRun = process.argv[1] !== undefined
  && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href;
if (isDirectRun) {
  const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
  const expectIndex = process.argv.indexOf('--expect-tag');
  const expectedTagVersion = expectIndex !== -1 ? process.argv[expectIndex + 1] : undefined;
  const appAsarPath = locatePackagedAppAsar(path.join(packageRoot, 'release'));
  const repoPackage = JSON.parse(fs.readFileSync(path.join(packageRoot, 'package.json'), 'utf8'));
  try {
    const result = checkVersionConsistency({
      repoVersion: repoPackage.version,
      artifactVersion: readAsarAppVersion(appAsarPath),
      expectedTagVersion,
    });
    console.log(`Release version consistency verified: ${result.version}`);
    console.log(`  repo package.json : ${repoPackage.version}`);
    console.log(`  app.asar embeds   : ${readAsarAppVersion(appAsarPath)}`);
    if (expectedTagVersion !== undefined) console.log(`  tag declares      : ${expectedTagVersion}`);
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  }
}
