import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { execFileSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, mkdtempSync, rmSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/**
 * PRI-1061: a workbuddy-host install ships no @principles/codex-adapter, and
 * a codex-host install ships no @principles/workbuddy-adapter. The CLI's
 * STARTUP module graph must therefore never statically import a host adapter
 * — not even `pd --help` may resolve one.
 *
 * This test runs the REAL built CLI from a sandbox copy where both adapters
 * are shadowed by EMPTY node_modules entries. Node resolution stops at the
 * first node_modules hit and does NOT fall back to parent directories, so an
 * empty shadow directory yields ERR_MODULE_NOT_FOUND — the exact failure
 * signature reported in the wild ("pd --help dies on a workbuddy-only
 * install"). Everything else (core, host-runtime, better-sqlite3, …)
 * resolves through a junction to the repository node_modules.
 */

function buildSandbox(): string {
  const pkgRoot = process.cwd(); // packages/pd-cli (vitest cwd)
  const sandbox = mkdtempSync(join(tmpdir(), 'pd-cli-no-adapters-'));
  cpSync(join(pkgRoot, 'dist'), join(sandbox, 'pd-cli', 'dist'), { recursive: true });
  cpSync(join(pkgRoot, 'package.json'), join(sandbox, 'pd-cli', 'package.json'));
  mkdirSync(join(sandbox, 'pd-cli', 'node_modules', '@principles', 'codex-adapter'), { recursive: true });
  mkdirSync(join(sandbox, 'pd-cli', 'node_modules', '@principles', 'workbuddy-adapter'), { recursive: true });
  // All remaining dependencies resolve through the repository's node_modules
  // (workspace symlinks for @principles/*, hoisted third-party packages).
  symlinkSync(join(pkgRoot, '..', '..', 'node_modules'), join(sandbox, 'node_modules'), process.platform === 'win32' ? 'junction' : 'dir');
  if (!existsSync(join(sandbox, 'pd-cli', 'dist', 'index.js'))) {
    throw new Error('sandbox setup failed: built pd-cli dist was not copied — run the pd-cli build first');
  }
  return sandbox;
}

/** Runs the sandboxed CLI; a non-zero exit does not throw — the captured
 * stdout/stderr is returned so degraded paths can be asserted. */
function runPd(sandbox: string, args: string[]): { status: number; stdout: string; stderr: string } {
  try {
    const output = execFileSync('node', [join(sandbox, 'pd-cli', 'dist', 'index.js'), ...args], { encoding: 'utf8' });
    return { status: 0, stdout: output, stderr: '' };
  } catch (error) {
    const err = error as { status?: number; stdout?: string; stderr?: string };
    return { status: typeof err.status === 'number' ? err.status : -1, stdout: err.stdout ?? '', stderr: err.stderr ?? '' };
  }
}

describe('pd CLI startup must not require any host adapter (PRI-1061)', () => {
  // Built (not registered) in hooks: the sandbox must exist only for the
  // execution phase — describe bodies run at collection time.
  let sandbox = '';
  beforeAll(() => {
    sandbox = buildSandbox();
  });
  afterAll(() => {
    if (sandbox) rmSync(sandbox, { recursive: true, force: true });
  });

  it('pd --help works when no host adapter can be resolved', () => {
    const run = runPd(sandbox, ['--help']);
    expect(run.status).toBe(0);
    expect(run.stdout).toContain('Usage: pd');
  });

  it('pd pain explicit --help works without @principles/codex-adapter', () => {
    const run = runPd(sandbox, ['pain', 'explicit', '--help']);
    expect(run.status).toBe(0);
    expect(run.stdout.length).toBeGreaterThan(0);
  });

  it('pd health --help works without @principles/codex-adapter', () => {
    const run = runPd(sandbox, ['health', '--help']);
    expect(run.status).toBe(0);
    expect(run.stdout.length).toBeGreaterThan(0);
  });

  it('pd health --host codex degrades observably instead of crashing with ERR_MODULE_NOT_FOUND', () => {
    const run = runPd(sandbox, ['health', '--host', 'codex']);
    expect(run.status).toBe(1);
    const combined = run.stdout + run.stderr;
    expect(combined).toContain('codex_adapter_unavailable');
    expect(combined).not.toContain('ERR_MODULE_NOT_FOUND');
  });
});
