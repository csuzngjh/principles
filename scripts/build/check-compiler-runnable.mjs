// PRI-928 guard: every TypeScript compiler installed in this tree must actually
// RUN on the current platform.
//
// npm treats optionalDependencies as best-effort: when the tarball fetch of an
// optional package fails, `npm ci` still exits 0 and logs nothing that names the
// gap. TypeScript 7 ships its compiler as such an optional package, one per
// OS/CPU, and resolves it lazily inside `lib/tsc.js`. So a silently dropped
// fetch survives the install step and surfaces minutes later as
//   Error: Unable to resolve @typescript/typescript-darwin-arm64. Either your
//   platform is unsupported, or you are missing the package on disk.
// Observed 2026-09-26 on the release-metadata darwin/arm64 leg (run
// 36232435033, job 108378015444): `npm ci` reported 988 packages in 2m where the
// same commit/runner/npm reported 989 in 26s an hour earlier, and the build leg
// died on that error while the real cause was an incomplete install.
//
// This probe closes the gap between "install exited 0" and "the compiler the
// build is about to exec exists and runs", platform-generically: it names no
// package, no OS and no CPU, so the same check is valid on linux/x64, win32/x64
// and darwin/arm64 alike.
//
// CLI (flag-triggered rather than entry-module detection — portable on Windows):
//   node scripts/build/check-compiler-runnable.mjs --root .

import { existsSync, readdirSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { join, relative, resolve } from 'node:path';
import { argv } from 'node:process';

/**
 * Every `typescript` install in the tree: the hoisted root copy plus each
 * workspace's own copy. npm may nest several compiler versions at once (this
 * repository does), and any of them can be the one a build step execs.
 */
export function compilerInstallDirs(rootDir) {
  const dirs = [];
  const hoisted = join(rootDir, 'node_modules', 'typescript');
  if (existsSync(hoisted)) dirs.push(hoisted);

  const packagesDir = join(rootDir, 'packages');
  if (existsSync(packagesDir)) {
    for (const entry of readdirSync(packagesDir, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const nested = join(packagesDir, entry.name, 'node_modules', 'typescript');
      if (existsSync(nested)) dirs.push(nested);
    }
  }
  return dirs;
}

/** Exec the compiler's own entry the same way an `npm run build` does. */
export function probeCompiler(compilerDir) {
  const bin = join(compilerDir, 'bin', 'tsc');
  if (!existsSync(bin)) return { ok: false, reason: 'bin/tsc is not on disk' };

  const result = spawnSync(process.execPath, [bin, '--version'], {
    encoding: 'utf8',
    windowsHide: true,
  });
  if (result.status === 0) return { ok: true, detail: (result.stdout || '').trim() };

  const output = `${result.stderr ?? ''}\n${result.stdout ?? ''}`
    .split('\n')
    .filter((line) => line.trim() !== '')
    .slice(-3)
    .join(' | ');
  return { ok: false, reason: output || `exited with code ${result.status}` };
}

/** Every installed compiler with its verdict — entries with `ok: false` are the gap. */
export function inspectCompilers(rootDir) {
  return compilerInstallDirs(rootDir).map((dir) => ({ dir, probe: probeCompiler(dir) }));
}

export function runCli(rootDir) {
  const inspected = inspectCompilers(rootDir);
  const failures = inspected.filter((entry) => !entry.probe.ok);
  const platform = `${process.platform}/${process.arch}`;

  if (inspected.length === 0) {
    // Vacuous passes are how this guard would itself rot: no compiler on disk
    // means the install never populated the tree, which is the same defect.
    console.error(`[check-compiler-runnable] no TypeScript compiler found under ${rootDir}`);
    process.exitCode = 1;
    return 1;
  }

  if (failures.length > 0) {
    console.error(
      `[check-compiler-runnable] ${failures.length}/${inspected.length} installed TypeScript ` +
        `compilers cannot run on ${platform}:`,
    );
    for (const failure of failures) {
      console.error(`  ${relative(rootDir, failure.dir)}: ${failure.probe.reason}`);
    }
    console.error(
      'nextAction: run `npm ci` again — npm skips an optional dependency it failed to ' +
        'fetch without failing the install, and TypeScript 7 ships its native compiler ' +
        'as one such package per platform (PRI-928).',
    );
    process.exitCode = 1;
    return 1;
  }

  console.log(
    `[check-compiler-runnable] ${inspected.length} installed TypeScript compilers run on ${platform}`,
  );
  return 0;
}

if (argv.includes('--root')) {
  const idx = argv.indexOf('--root');
  const rootArg = argv[idx + 1];
  if (!rootArg || rootArg.startsWith('-')) {
    console.error('Usage: node scripts/build/check-compiler-runnable.mjs --root <project-dir>');
    process.exitCode = 2;
  } else {
    runCli(resolve(rootArg));
  }
}
