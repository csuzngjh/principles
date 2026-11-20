/**
 * PRI-1279 (cli-7 / cli-1): real command-registration contract for
 * `pd service run-once`, plus handler behavior through the REAL program
 * wiring (not a hand-copied parser).
 */
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Command, Option } from 'commander';
import { buildPdProgram } from '../../src/program.js';

/**
 * The coordinator's identity authority is the OS account record — env HOME
 * is deliberately ignored (P1-1) — so tests pin the OS record itself rather
 * than polluting env. `node:os` is a native namespace; vi.spyOn cannot
 * redefine it, hence a module-level mock with a mutable pin.
 */
let pinnedHomedir: string | undefined;
vi.mock('node:os', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:os')>();
  return {
    ...actual,
    userInfo: (options?: Parameters<typeof actual.userInfo>[0]) => {
      const info = actual.userInfo(options);
      return pinnedHomedir === undefined ? info : { ...info, homedir: pinnedHomedir };
    },
  };
});

const dirs: string[] = [];
function tempHome(): string {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'pd-cli-service-'));
  dirs.push(dir);
  return dir;
}
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  vi.restoreAllMocks();
});

function findServiceRunOnce(): Command {
  const program = buildPdProgram();
  const service = program.commands.find((c) => c.name() === 'service');
  expect(service, 'service command must be registered').toBeDefined();
  const runOnce = service?.commands.find((c) => c.name() === 'run-once');
  expect(runOnce, 'service run-once subcommand must be registered').toBeDefined();
  return runOnce as Command;
}

describe('registration (cli-7: the shipped program object)', () => {
  it('service run-once is registered with --dry-run (default off) and --json', () => {
    const runOnce = findServiceRunOnce();
    const dryRun = runOnce.options.find((o: Option) => o.long === '--dry-run');
    expect(dryRun, '--dry-run must be registered').toBeDefined();
    expect(dryRun?.defaultValue).toBe(false);
    const json = runOnce.options.find((o: Option) => o.long === '--json');
    expect(json).toBeDefined();
  });
});

describe('handler behavior through the real action', () => {
  it('without --dry-run the coordinator refuses with dry_run_required_phase1 (exit 1, one JSON doc)', async () => {
    const runOnce = findServiceRunOnce();
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    await runOnce.parseAsync(['--json'], { from: 'user' });
    // cli-1: exactly ONE machine-readable document on stdout.
    const jsonLines = logSpy.mock.calls.filter((args) => typeof args[0] === 'string' && args[0].startsWith('{'));
    expect(jsonLines).toHaveLength(1);
    const parsed = JSON.parse(jsonLines[0]?.[0] as string) as { outcome: string; reason: string; nextAction: string };
    expect(parsed.outcome).toBe('refused');
    expect(parsed.reason).toBe('dry_run_required_phase1');
    expect(parsed.nextAction).toContain('--dry-run');
    expect(process.exitCode).toBe(1);
    logSpy.mockRestore();
    process.exitCode = 0;
  });

  it('a completed dry-run prints exactly one JSON document with workspace verdicts', async () => {
    const home = tempHome();
    const ws = path.join(home, 'clawd');
    mkdirSync(path.join(ws, '.pd'), { recursive: true });
    mkdirSync(path.join(home, '.pd'), { recursive: true });
    writeFileSync(
      path.join(home, '.pd', 'install.json'),
      JSON.stringify({ layoutVersion: 1, mode: 'canonical', hosts: ['openclaw'], workspaces: [ws] }),
      'utf8',
    );
    writeFileSync(
      path.join(home, '.pd', 'active.json'),
      JSON.stringify({
        schemaVersion: 1,
        generation: 1,
        releaseId: 'test-release',
        releaseMetadataDigest: 'b'.repeat(64),
        previousReleaseId: null,
        transactionId: 'txn-cli-test',
        productVersion: '1.0.0',
      }),
      'utf8',
    );
    pinnedHomedir = home;
    try {
      const runOnce = findServiceRunOnce();
      const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
      await runOnce.parseAsync(['--dry-run', '--json'], { from: 'user' });
      const jsonLines = logSpy.mock.calls.filter((args) => typeof args[0] === 'string' && args[0].startsWith('{'));
      expect(jsonLines).toHaveLength(1);
      const parsed = JSON.parse(jsonLines[0]?.[0] as string) as {
        outcome: string;
        installation: { pdHome: string };
        workspaces: { canonicalDir: string; verdict: string }[];
      };
      expect(parsed.outcome).toBe('completed');
      expect(parsed.installation.pdHome).toBe(path.join(home, '.pd'));
      const wsEntry = parsed.workspaces.find((w) => path.resolve(w.canonicalDir) === path.resolve(ws));
      expect(wsEntry?.verdict).toBe('authorized');
      expect(process.exitCode).toBe(0);
      logSpy.mockRestore();
    } finally {
      pinnedHomedir = undefined;
      process.exitCode = 0;
    }
  });
});
