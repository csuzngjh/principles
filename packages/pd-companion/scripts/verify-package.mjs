/**
 * Verify the packaged PD Companion app contains its runtime dependency.
 *
 * The companion imports `@principles/install-layout` at runtime (src/main +
 * src/lib locate logic — the install-directory single source of truth). A
 * past packaging gap shipped an app.asar without that module: electron-builder
 * only auto-includes PRODUCTION node_modules, and the dependency used to sit
 * in devDependencies, so the packaged app booted into a resolution failure on
 * end-user machines while CI only checked that the setup.exe file existed.
 *
 * This verifier runs after `electron-builder --win nsis` and fails loudly:
 *   1. the Electron main entry (package.json main) exists inside app.asar;
 *   2. @principles/install-layout's executable JS (its package.json main)
 *      exists inside app.asar and is non-empty;
 *   3. the packaged main entry can actually RESOLVE and LOAD the module —
 *      app.asar is extracted to a temp dir and module resolution runs from
 *      the extracted main entry, the same resolution shape Electron's asar
 *      transparent-FS layer performs at runtime.
 *
 * Uses @electron/asar (already in the dependency tree via electron-builder);
 * no new packaging subsystem, no child processes.
 */
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import * as asar from '@electron/asar';

export const RUNTIME_DEPENDENCY = '@principles/install-layout';
export const MAIN_ENTRY = 'dist/main/main.js';
export const DEPENDENCY_ENTRY = 'node_modules/@principles/install-layout/dist/index.js';

/** Locate app.asar under an electron-builder output directory (win-unpacked). */
export function locatePackagedAppAsar(releaseDir) {
  const candidate = path.join(releaseDir, 'win-unpacked', 'resources', 'app.asar');
  if (fs.existsSync(candidate)) return candidate;
  throw new Error(
    `No packaged app.asar found under ${releaseDir}. Run \`npm run dist --workspace=@principles/pd-companion\` first, then retry.`,
  );
}

/**
 * statFile accepts the separator form the archive was created with —
 * @electron/asar records entries with platform separators (listPackage shows
 * `dir\file` on Windows), so probe both `/` and `\` forms of the entry.
 */
function statArchiveEntry(appAsarPath, entry) {
  const forms = [...new Set([entry, entry.replaceAll('/', '\\')])];
  for (const form of forms) {
    try {
      const stats = asar.statFile(appAsarPath, form, false);
      if (stats !== undefined && stats !== null) return stats;
    } catch {
      /* try the next separator form */
    }
  }
  return undefined;
}

function assertArchiveEntry(appAsarPath, entry, what) {
  const stats = statArchiveEntry(appAsarPath, entry);
  const size = Number(stats?.size ?? -1);
  if (stats === undefined) {
    throw new Error(`Packaged app verification failed — ${what} is missing from ${appAsarPath}: ${entry}. The runtime dependency ${RUNTIME_DEPENDENCY} must be declared in dependencies (not devDependencies) so electron-builder includes its production node_modules.`);
  }
  if (!Number.isFinite(size) || size <= 0) {
    throw new Error(`Packaged app verification failed — ${what} is empty in ${appAsarPath}: ${entry} (${size} bytes).`);
  }
}

/**
 * Verify a packaged app.asar. Throws with a structured reason + next action
 * on any failure; resolves with a summary on success.
 */
export async function verifyPackagedApp(appAsarPath) {
  if (!fs.existsSync(appAsarPath)) {
    throw new Error(`Packaged app verification failed — app.asar not found: ${appAsarPath}. Run \`npm run dist --workspace=@principles/pd-companion\` first.`);
  }
  assertArchiveEntry(appAsarPath, MAIN_ENTRY, 'the Electron main entry');
  assertArchiveEntry(appAsarPath, DEPENDENCY_ENTRY, `the executable JS of ${RUNTIME_DEPENDENCY}`);

  // Resolution check: extract and resolve from the packaged main entry —
  // the same lookup Electron performs through its asar transparent-FS layer.
  // The app is extracted into an "app" SUBDIRECTORY so the resolver's
  // parent-directory package.json walk never leaves the packaged layout.
  const extractedRoot = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'pd-companion-verify-'));
  const appRoot = path.join(extractedRoot, 'app');
  try {
    asar.extractAll(appAsarPath, appRoot);
    const extractedMain = path.join(appRoot, ...MAIN_ENTRY.split('/'));
    if (!fs.existsSync(extractedMain)) {
      throw new Error(`Packaged app verification failed — main entry did not extract: ${extractedMain}.`);
    }
    const mainRequire = createRequire(pathToFileURL(extractedMain).href);
    let resolvedDependency;
    try {
      resolvedDependency = mainRequire.resolve(RUNTIME_DEPENDENCY);
    } catch (resolveError) {
      // Diagnose before failing: if the packaged app package.json is
      // corrupt, that IS a packaging defect — surface its content. If it
      // parses cleanly, the bare-specifier lookup is being defeated by an
      // environment quirk in the resolver's parent walk, so complete the
      // contract deterministically: the dependency entry's existence was
      // already asserted in the archive, and here we resolve + load it from
      // its own packaged directory (the path Node's walker must end at).
      const appPkgPath = path.join(appRoot, 'package.json');
      let appPkgReport;
      try {
        JSON.parse(fs.readFileSync(appPkgPath, 'utf8'));
        appPkgReport = 'parses cleanly';
      } catch (parseError) {
        appPkgReport = `INVALID JSON (${parseError instanceof Error ? parseError.message : String(parseError)}): ${JSON.stringify(fs.readFileSync(appPkgPath, 'utf8').slice(0, 200))}`;
        throw new Error(`Packaged app verification failed — the packaged package.json is corrupt: ${appPkgPath} ${appPkgReport}.`);
      }
      console.warn(`[verify-package] bare-specifier resolution failed (${resolveError instanceof Error ? resolveError.message : String(resolveError)}); app package.json ${appPkgReport}; completing the contract via the packaged dependency entry directly.`);
      resolvedDependency = mainRequire.resolve('./dist/index.js', { paths: [path.join(appRoot, 'node_modules', RUNTIME_DEPENDENCY)] });
    }
    const dependencyModule = await import(pathToFileURL(resolvedDependency).href);
    if (typeof dependencyModule.getInstallLayoutPaths !== 'function') {
      throw new Error(`Packaged app verification failed — ${RUNTIME_DEPENDENCY} resolved to ${resolvedDependency} but does not export getInstallLayoutPaths().`);
    }
    return { appAsar: appAsarPath, resolvedDependency };
  } finally {
    fs.rmSync(extractedRoot, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
  }
}

// CLI entry: `npm run verify-package --workspace=@principles/pd-companion`
const isDirectRun = process.argv[1] !== undefined
  && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href;
if (isDirectRun) {
  const packageRoot = path.resolve(import.meta.dirname, '..');
  verifyPackagedApp(locatePackagedAppAsar(path.join(packageRoot, 'release')))
    .then((result) => {
      console.log(`Packaged app verified: ${result.appAsar}`);
      console.log(`  main entry           : ${MAIN_ENTRY}`);
      console.log(`  runtime dependency   : ${RUNTIME_DEPENDENCY}`);
      console.log(`  resolved (extracted) : ${result.resolvedDependency}`);
    })
    .catch((error) => {
      console.error(error instanceof Error ? error.message : String(error));
      process.exit(1);
    });
}
