/**
 * Freshness gate for PD_BUNDLE_SKIP_CONSOLE_BUILD (G3.2).
 *
 * The flag lets a release path that has JUST built @principles/pd-console
 * with the official chain (release-metadata asset legs) avoid paying for a
 * second identical build inside bundle-plugin. It is a skip of a verified
 * build, never a way to avoid building: every caller must fail loud here
 * when the dist is missing, incomplete, stale, or a dev build.
 *
 * Fresh means ALL of:
 *   1. the required runtime artifacts exist (same contract as
 *      packages/pd-console/scripts/verify-build.mjs);
 *   2. the browser bundle is the production build (no inline sourcemap —
 *      same contract as the payload gate in bundle-plugin.mjs, OPT-001);
 *   3. no source file is newer than the newest dist artifact (a stale
 *      dist predating a source edit is rejected);
 *   4. the dist passed the compiled-test-artifact hygiene check.
 * Anything else throws with a repair instruction; bundle-plugin then
 * refuses to ship (rc-9 observable, fail-closed).
 */
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { isTestArtifact } from '../../../scripts/build/test-artifacts.mjs';

const REQUIRED_ARTIFACTS = ['dist/server.js', 'dist/server/index.js', 'dist/web/index.html'];
const PRODUCTION_APP_JS = join('dist', 'web', 'assets', 'app.js');

function newestMtime(dir, filter) {
  let newest = 0;
  const visit = (current) => {
    let entries;
    try {
      entries = readdirSync(current, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const child = join(current, entry.name);
      if (entry.isDirectory()) visit(child);
      else if (!filter || filter(child, entry.name)) {
        try {
          newest = Math.max(newest, statSync(child).mtimeMs);
        } catch {
          // unreadable file — not newer than what we have seen
        }
      }
    }
  };
  visit(dir);
  return newest;
}

/**
 * @param {string} consoleSrc packages/pd-console/src
 * @param {string} consoleDist packages/pd-console/dist
 * @param {string} consoleRoot packages/pd-console
 * @returns {void} throws on any failed freshness condition
 */
export function assertConsoleDistFresh(consoleRoot, consoleSrc = join(consoleRoot, 'src'), consoleDist = join(consoleRoot, 'dist')) {
  // 1. required runtime artifacts
  const missing = REQUIRED_ARTIFACTS.filter((rel) => !existsSync(join(consoleRoot, rel)));
  if (missing.length > 0) {
    throw new Error(
      `PD_BUNDLE_SKIP_CONSOLE_BUILD: console dist is incomplete — missing ${missing.join(', ')}. `
      + 'nextAction: unset PD_BUNDLE_SKIP_CONSOLE_BUILD and let bundle-plugin run the official console build chain.',
    );
  }

  // 2. production browser bundle
  const appJs = join(consoleRoot, PRODUCTION_APP_JS);
  if (!existsSync(appJs)) {
    throw new Error(
      'PD_BUNDLE_SKIP_CONSOLE_BUILD: dist/web/assets/app.js is missing (UI was not built with build:ui:production). '
      + 'nextAction: unset PD_BUNDLE_SKIP_CONSOLE_BUILD and let bundle-plugin run the official console build chain.',
    );
  }
  if (readFileSync(appJs, 'utf8').includes('sourceMappingURL')) {
    throw new Error(
      'PD_BUNDLE_SKIP_CONSOLE_BUILD: console web bundle is a DEV build (inline sourcemap detected). '
      + 'nextAction: unset PD_BUNDLE_SKIP_CONSOLE_BUILD and let bundle-plugin run the official console build chain.',
    );
  }

  // 3. staleness — a source file newer than every dist artifact means the
  // dist predates a source edit and must not be reused.
  const srcNewest = newestMtime(consoleSrc);
  const distNewest = newestMtime(consoleDist);
  if (srcNewest > distNewest) {
    throw new Error(
      'PD_BUNDLE_SKIP_CONSOLE_BUILD: console dist is STALE (a file under src/ is newer than every file under dist/). '
      + 'nextAction: unset PD_BUNDLE_SKIP_CONSOLE_BUILD and let bundle-plugin run the official console build chain.',
    );
  }

  // 4. hygiene — no compiled test artifacts in the dist being reused
  const offenders = [];
  const visit = (current, rel) => {
    let entries;
    try {
      entries = readdirSync(current, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const child = join(current, entry.name);
      const childRel = join(rel, entry.name);
      if (isTestArtifact(child)) offenders.push(childRel.split('\\').join('/'));
      else if (entry.isDirectory()) visit(child, childRel);
    }
  };
  visit(consoleDist, 'dist');
  if (offenders.length > 0) {
    throw new Error(
      `PD_BUNDLE_SKIP_CONSOLE_BUILD: console dist contains ${offenders.length} compiled test artifact(s) (e.g. ${offenders[0]}). `
      + 'nextAction: unset PD_BUNDLE_SKIP_CONSOLE_BUILD and let bundle-plugin run the official console build chain.',
    );
  }
}
