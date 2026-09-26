/**
 * PRI-928 — the install-completeness probe.
 *
 * `npm ci` can exit 0 with an incomplete tree: an optional dependency whose
 * tarball it failed to fetch is dropped without a failing exit code or a log
 * line that names it. TypeScript 7 resolves that optional package (one per
 * OS/CPU) only when `tsc` first runs, so the release chain died minutes after a
 * "successful" install with an error that pointed at the resolver instead of the
 * install (run 36232435033, job 108378015444, darwin/arm64).
 *
 * These tests pin the two properties the guard needs: it catches "compiler
 * directory exists but cannot run", and it cannot pass vacuously. The wiring
 * into the release workflow is pinned in release-workflows.test.ts.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  compilerInstallDirs,
  probeCompiler,
  inspectCompilers,
} from '../build/check-compiler-runnable.mjs';

const TEST_DIR = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(TEST_DIR, '..', '..');
const GUARD = path.join(REPO_ROOT, 'scripts', 'build', 'check-compiler-runnable.mjs');

let tmp: string;

/** A workspace-shaped tree with the requested `typescript` installs. */
function makeTree(layout: Record<string, string | null>): string {
  const root = fs.mkdtempSync(path.join(tmp, 'tree-'));
  for (const [relativeDir, body] of Object.entries(layout)) {
    const dir = path.join(root, relativeDir);
    if (body === null) {
      fs.mkdirSync(dir, { recursive: true });
      continue;
    }
    fs.mkdirSync(path.join(dir, 'bin'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'bin', 'tsc'), body, 'utf8');
  }
  return root;
}

const RUNNABLE = "console.log('Version 7.0.2');\n";
const MISSING_PLATFORM_BINARY = [
  'const err = new Error(',
  "  'Unable to resolve @typescript/typescript-darwin-arm64. Either your platform is unsupported, '",
  "  + 'or you are missing the package on disk.',",
  ');',
  "process.stderr.write(err.message + '\\n');",
  'process.exit(1);',
  '',
].join('\n');

beforeAll(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'pd-compiler-runnable-'));
});

afterAll(() => {
  fs.rmSync(tmp, { recursive: true, force: true });
});

describe('compilerInstallDirs', () => {
  it('finds the hoisted compiler and each workspace copy, and nothing else', () => {
    const root = makeTree({
      'node_modules/typescript': RUNNABLE,
      'packages/core/node_modules/typescript': RUNNABLE,
      'packages/cli/node_modules/typescript': RUNNABLE,
      // A dependency directory that is not a compiler must not be probed.
      'packages/tool/node_modules/esbuild': null,
    });
    const dirs = compilerInstallDirs(root)
      .map((dir) => path.relative(root, dir))
      .sort();
    expect(dirs).toEqual(
      [
        path.join('node_modules', 'typescript'),
        path.join('packages', 'core', 'node_modules', 'typescript'),
        path.join('packages', 'cli', 'node_modules', 'typescript'),
      ].sort(),
    );
  });

  it('returns nothing for a tree with no compiler', () => {
    expect(compilerInstallDirs(makeTree({ 'packages/x/src': null }))).toEqual([]);
  });
});

describe('probeCompiler', () => {
  it('passes a compiler that runs and reports its version', () => {
    const root = makeTree({ 'node_modules/typescript': RUNNABLE });
    const verdict = probeCompiler(path.join(root, 'node_modules', 'typescript'));
    expect(verdict).toEqual({ ok: true, detail: 'Version 7.0.2' });
  });

  it('names the platform package that the real failure blamed on the resolver', () => {
    const root = makeTree({ 'node_modules/typescript': MISSING_PLATFORM_BINARY });
    const verdict = probeCompiler(path.join(root, 'node_modules', 'typescript'));
    expect(verdict.ok).toBe(false);
    expect(verdict.reason).toContain('Unable to resolve @typescript/typescript-darwin-arm64');
  });

  it('reports a compiler directory with no executable entry', () => {
    const root = makeTree({ 'node_modules/typescript': null });
    const verdict = probeCompiler(path.join(root, 'node_modules', 'typescript'));
    expect(verdict).toEqual({ ok: false, reason: 'bin/tsc is not on disk' });
  });
});

describe('inspectCompilers', () => {
  it('survives one broken copy among healthy ones (nested versions coexist)', () => {
    const root = makeTree({
      'node_modules/typescript': RUNNABLE,
      'packages/core/node_modules/typescript': MISSING_PLATFORM_BINARY,
    });
    const inspected = inspectCompilers(root);
    expect(inspected).toHaveLength(2);
    expect(inspected.filter((entry) => !entry.probe.ok)).toHaveLength(1);
  });
});

describe('CLI contract', () => {
  it('exits 0 on the real repository tree, on the platform running the tests', () => {
    const stdout = execFileSync('node', [GUARD, '--root', REPO_ROOT], { encoding: 'utf8' });
    expect(stdout).toMatch(/installed TypeScript compilers run on /);
  });

  it('exits 1 and names the unrunnable compiler', () => {
    const root = makeTree({
      'node_modules/typescript': RUNNABLE,
      'packages/core/node_modules/typescript': MISSING_PLATFORM_BINARY,
    });
    let captured: { status: number; stderr: string } | undefined;
    try {
      execFileSync('node', [GUARD, '--root', root], { encoding: 'utf8', stdio: 'pipe' });
    } catch (error) {
      const failure = error as { status: number; stderr: string };
      captured = { status: failure.status, stderr: failure.stderr };
    }
    expect(captured?.status).toBe(1);
    expect(captured?.stderr).toContain('1/2 installed TypeScript compilers cannot run');
    expect(captured?.stderr).toContain('Unable to resolve @typescript/typescript-darwin-arm64');
    expect(captured?.stderr).toContain('npm ci');
  });

  it('refuses to pass vacuously on a tree with no compiler at all', () => {
    const root = makeTree({ 'packages/x/src': null });
    let captured: { status: number; stderr: string } | undefined;
    try {
      execFileSync('node', [GUARD, '--root', root], { encoding: 'utf8', stdio: 'pipe' });
    } catch (error) {
      const failure = error as { status: number; stderr: string };
      captured = { status: failure.status, stderr: failure.stderr };
    }
    expect(captured?.status).toBe(1);
    expect(captured?.stderr).toContain('no TypeScript compiler found');
  });
});
