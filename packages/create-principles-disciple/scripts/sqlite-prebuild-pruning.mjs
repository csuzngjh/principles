// SPEC-P0: self-contained release assets must carry only the better-sqlite3
// prebuild binary for the asset's own platform+arch (audit
// docs/release/asset-deduplication-feasibility-audit.md §5, measured on a real
// win32-x64 build: 7 materialized copies ship all 8 platform prebuilds each;
// 7/8 are unreachable code on any single platform — 104,349,056 B ≈ 99.5 MiB
// of dead weight per platform asset).
//
// This module is a pure filesystem filter used by build-release-asset.mjs
// AFTER component staging and BEFORE the per-file _release/manifest.json is
// generated, so the signed manifest always describes the pruned tree
// (no post-hoc manifest mutation). It never touches binding.gyp, package
// metadata, the JS loader, or any file outside better-sqlite3/prebuilds/.
//
// Safety net that makes pruning load-safe: the installer's own
// prepareBundledComponentDependencies -> verifyNativeModules require probe
// runs per component at install time, so a wrong prune fails loud BEFORE any
// deployment. This module adds the build-side half of that guarantee:
// resolveKeepPrebuildName is the single source of the keep rule, and a
// prebuilds directory missing its keep file throws instead of silently
// shipping an unloadable native module.

import { existsSync, readdirSync, readFileSync, rmSync, statSync } from 'node:fs';
import { basename, join } from 'node:path';

/** The only native package this filter knows about (see release-target-matrix). */
export const PRUNED_NATIVE_PACKAGE = 'better-sqlite3';

/**
 * node-gyp-build resolves the loaded binary from
 * `prebuilds/<platform>[-musl merged as "linuxmusl"]-<arch>.node`.
 * linuxmusl-* are the musl (Alpine) builds of linux; every other platform is
 * a plain `<platform>-<arch>`.
 * @param {{ platform: string, arch: string, musl?: boolean }} target
 * @returns {string} file name to KEEP, e.g. 'win32-x64.node'
 */
export function resolveKeepPrebuildName({ platform, arch, musl = false }) {
  if (typeof platform !== 'string' || platform.length === 0 || typeof arch !== 'string' || arch.length === 0) {
    throw new Error(`[sqlite-prebuild-pruning] target requires platform and arch, got: ${JSON.stringify({ platform, arch })}`);
  }
  const base = platform === 'linux' && musl ? 'linuxmusl' : platform;
  return `${base}-${arch}.node`;
}

/**
 * Whether the CURRENT (build-machine) libc is musl. Local release builds are
 * the only supported mode (release-target-matrix refuses cross-targets), so
 * the build machine's libc decides which linux prebuild the runtime would
 * load. Non-linux: always false.
 * @param {NodeJS.Process} [proc]
 */
export function detectLocalMusl(proc = process) {
  if (proc.platform !== 'linux') return false;
  try {
    const header = proc.report?.getReport?.().header;
    // An unreadable report must not be guessed as musl: fail safe to glibc.
    if (header === undefined || header === null) return false;
    // glibcVersionRuntime is absent on musl builds; some report
    // implementations spell the absence as the literal string 'undefined'.
    const glibc = header.glibcVersionRuntime;
    return typeof glibc === 'string' && glibc !== 'undefined' ? false : true;
  } catch {
    return false;
  }
}

/**
 * Recursively collect `.../better-sqlite3/prebuilds` directories under root.
 * Symlinks are not followed (the asset tree rejects them anyway before this
 * runs). Nested copies under materialized file: links (e.g.
 * plugin/node_modules/@principles/core/node_modules/better-sqlite3) are
 * found too — that is deliberate: they are byte-identical materializations of
 * the same package.
 * @param {string} root
 * @returns {string[]} prebuilds directory paths
 */
export function findSqlitePrebuildDirs(root) {
  const found = [];
  const walk = (directory) => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      // Dirents are lstat-based: a symlinked directory fails isDirectory() and
      // is never followed (the asset tree rejects symlinks anyway).
      if (!entry.isDirectory()) continue;
      const entryPath = join(directory, entry.name);
      if (entry.name === 'prebuilds' && basename(directory) === PRUNED_NATIVE_PACKAGE) {
        found.push(entryPath);
        continue;
      }
      walk(entryPath);
    }
  };
  if (existsSync(root)) walk(root);
  return found.sort();
}

/**
 * Delete every `*.node` file in every better-sqlite3/prebuilds tree under
 * `rootDirectory` except `keepFileName`. The keep file of EVERY site is
 * validated before ANY deletion happens (rc-3, cli-5-style no-mutation-on-
 * failure): a site missing its keep binary throws with the whole tree
 * untouched — pruning must never produce an asset whose native loader has
 * nothing to require, not even partially.
 * @param {string} rootDirectory asset payload root (post-staging)
 * @param {string} keepFileName e.g. 'win32-x64.node'
 * @returns {{ sites: number, removedFiles: number, removedBytes: number, keptSites: number }}
 */
export function pruneForeignSqlitePrebuilds(rootDirectory, keepFileName) {
  if (typeof keepFileName !== 'string' || !keepFileName.endsWith('.node')) {
    throw new Error(`[sqlite-prebuild-pruning] invalid keep file name: ${JSON.stringify(keepFileName)}`);
  }
  const dirs = findSqlitePrebuildDirs(rootDirectory);
  const siteBinaries = dirs.map((dir) => {
    const binaries = readdirSync(dir, { withFileTypes: true })
      .filter((entry) => entry.isFile() && entry.name.endsWith('.node'))
      .map((entry) => entry.name);
    if (!binaries.includes(keepFileName)) {
      const found = binaries.join(', ') || 'no .node binaries';
      throw new Error(
        `[sqlite-prebuild-pruning] ${dir} has no ${keepFileName} (found: ${found}) — ` +
        'refusing to prune a tree that lacks the target platform prebuild. Check the release target triple.',
      );
    }
    return binaries;
  });
  let removedFiles = 0;
  let removedBytes = 0;
  let keptSites = 0;
  dirs.forEach((dir, index) => {
    for (const binary of siteBinaries[index]) {
      if (binary === keepFileName) continue;
      const filePath = join(dir, binary);
      removedBytes += statSync(filePath).size;
      rmSync(filePath);
      removedFiles += 1;
    }
    keptSites += 1;
  });
  return { sites: dirs.length, removedFiles, removedBytes, keptSites };
}
