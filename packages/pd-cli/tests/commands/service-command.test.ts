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
  process.exitCode = 0;
  // buildPdProgram() returns the module-level singleton: commander KEEPS
  // parsed option values between parseAsync calls on one instance, so a
  // test that parsed --shadow/--host would leak into every later parse.
  // Reset each option back to its declared default (public API) so the
  // tests stay order-independent.
  const runOnce = findServiceRunOnce();
  for (const opt of runOnce.options) {
    if (opt.long !== undefined) {
      runOnce.setOptionValue(opt.long.replace(/^--/, '').replace(/-([a-z])/g, (_m, c: string) => c.toUpperCase()), opt.defaultValue);
    }
  }
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

  it('Phase 2 options are registered: --shadow (default off), repeatable --workspace, --host, --timeout-ms', () => {
    const runOnce = findServiceRunOnce();
    const shadow = runOnce.options.find((o: Option) => o.long === '--shadow');
    expect(shadow, '--shadow must be registered').toBeDefined();
    expect(shadow?.defaultValue).toBe(false);
    expect(runOnce.options.find((o: Option) => o.long === '--workspace')).toBeDefined();
    expect(runOnce.options.find((o: Option) => o.long === '--host')).toBeDefined();
    expect(runOnce.options.find((o: Option) => o.long === '--timeout-ms')).toBeDefined();
  });
});

describe('handler behavior through the real action', () => {
  it('without a mode flag the coordinator refuses with mode_required_phase2 (exit 1, one JSON doc)', async () => {
    const runOnce = findServiceRunOnce();
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    await runOnce.parseAsync(['--json'], { from: 'user' });
    // cli-1: exactly ONE machine-readable document on stdout.
    const jsonLines = logSpy.mock.calls.filter((args) => typeof args[0] === 'string' && args[0].startsWith('{'));
    expect(jsonLines).toHaveLength(1);
    const parsed = JSON.parse(jsonLines[0]?.[0] as string) as { outcome: string; reason: string; nextAction: string };
    expect(parsed.outcome).toBe('refused');
    expect(parsed.reason).toBe('mode_required_phase2');
    expect(parsed.nextAction).toContain('--dry-run');
    expect(parsed.nextAction).toContain('--shadow');
    expect(process.exitCode).toBe(1);
    logSpy.mockRestore();
    process.exitCode = 0;
  });

  it('--dry-run and --shadow together are refused (cli-4 mutual exclusion)', async () => {
    const runOnce = findServiceRunOnce();
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    await runOnce.parseAsync(['--dry-run', '--shadow', '--workspace', 'X', '--json'], { from: 'user' });
    const jsonLines = logSpy.mock.calls.filter((args) => typeof args[0] === 'string' && args[0].startsWith('{'));
    expect(jsonLines).toHaveLength(1);
    const parsed = JSON.parse(jsonLines[0]?.[0] as string) as { outcome: string; reason: string };
    expect(parsed.outcome).toBe('refused');
    expect(parsed.reason).toBe('dry_run_shadow_mutually_exclusive');
    expect(process.exitCode).toBe(1);
    logSpy.mockRestore();
    process.exitCode = 0;
  });

  it('an invalid --host value is refused (fail-closed)', async () => {
    const runOnce = findServiceRunOnce();
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    await runOnce.parseAsync(['--shadow', '--workspace', 'X', '--host', 'openclaw', '--json'], { from: 'user' });
    const jsonLines = logSpy.mock.calls.filter((args) => typeof args[0] === 'string' && args[0].startsWith('{'));
    const parsed = JSON.parse(jsonLines[0]?.[0] as string) as { outcome: string; reason: string };
    expect(parsed.outcome).toBe('refused');
    expect(parsed.reason).toContain('invalid_host_kind:openclaw');
    expect(process.exitCode).toBe(1);
    logSpy.mockRestore();
    process.exitCode = 0;
  });

  it('F8: a partially-parseable --timeout-ms ("5m") is refused BEFORE any real cycle, not clamped to 1s', async () => {
    const home = tempHome();
    mkdirSync(path.join(home, '.pd'), { recursive: true });
    writeFileSync(path.join(home, '.pd', 'install.json'), JSON.stringify({ layoutVersion: 1, mode: 'canonical', hosts: ['codex'] }), 'utf8');
    writeFileSync(
      path.join(home, '.pd', 'active.json'),
      JSON.stringify({ schemaVersion: 1, generation: 1, releaseId: 'r', releaseMetadataDigest: 'b'.repeat(64), previousReleaseId: null, transactionId: 't', productVersion: '1.0.0' }),
      'utf8',
    );
    pinnedHomedir = home;
    try {
      const runOnce = findServiceRunOnce();
      const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
      await runOnce.parseAsync(['--shadow', '--workspace', path.join(home, 'ws'), '--timeout-ms', '5m', '--json'], { from: 'user' });
      const jsonLines = logSpy.mock.calls.filter((args) => typeof args[0] === 'string' && args[0].startsWith('{'));
      expect(jsonLines).toHaveLength(1);
      const parsed = JSON.parse(jsonLines[0]?.[0] as string) as { outcome: string; reason: string };
      expect(parsed.outcome).toBe('refused');
      expect(parsed.reason).toBe('invalid_timeout_ms:5m');
      expect(process.exitCode).toBe(1);
      logSpy.mockRestore();
    } finally {
      pinnedHomedir = undefined;
      process.exitCode = 0;
    }
  });

  it('F8: an unparseable --timeout-ms ("five") is refused instead of silently using the 45-minute default', async () => {
    const runOnce = findServiceRunOnce();
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    await runOnce.parseAsync(['--shadow', '--workspace', 'X', '--timeout-ms', 'five', '--json'], { from: 'user' });
    const jsonLines = logSpy.mock.calls.filter((args) => typeof args[0] === 'string' && args[0].startsWith('{'));
    const parsed = JSON.parse(jsonLines[0]?.[0] as string) as { outcome: string; reason: string };
    expect(parsed.outcome).toBe('refused');
    expect(parsed.reason).toBe('invalid_timeout_ms:five');
    expect(process.exitCode).toBe(1);
    logSpy.mockRestore();
    process.exitCode = 0;
  });

  it('F8: an out-of-range --timeout-ms is refused (below 1s and above the Node timer ceiling)', async () => {
    const runOnce = findServiceRunOnce();
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    await runOnce.parseAsync(['--shadow', '--workspace', 'X', '--timeout-ms', '999', '--json'], { from: 'user' });
    let parsed = JSON.parse(logSpy.mock.calls.filter((args) => typeof args[0] === 'string' && args[0].startsWith('{'))[0]?.[0] as string) as { outcome: string; reason: string };
    expect(parsed.reason).toBe('timeout_ms_out_of_range:999');
    expect(process.exitCode).toBe(1);
    logSpy.mockRestore();
    process.exitCode = 0;
    const logSpy2 = vi.spyOn(console, 'log').mockImplementation(() => {});
    await runOnce.parseAsync(['--shadow', '--workspace', 'X', '--timeout-ms', '99999999999', '--json'], { from: 'user' });
    parsed = JSON.parse(logSpy2.mock.calls.filter((args) => typeof args[0] === 'string' && args[0].startsWith('{'))[0]?.[0] as string) as { outcome: string; reason: string };
    expect(parsed.reason).toBe('timeout_ms_out_of_range:99999999999');
    expect(process.exitCode).toBe(1);
    logSpy2.mockRestore();
    process.exitCode = 0;
  });

  it('--shadow without --workspace is refused by the coordinator (explicit selection required)', async () => {
    pinnedHomedir = tempHome();
    try {
      const runOnce = findServiceRunOnce();
      const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
      await runOnce.parseAsync(['--shadow', '--json'], { from: 'user' });
      const jsonLines = logSpy.mock.calls.filter((args) => typeof args[0] === 'string' && args[0].startsWith('{'));
      expect(jsonLines).toHaveLength(1);
      const parsed = JSON.parse(jsonLines[0]?.[0] as string) as { outcome: string; reason: string };
      expect(parsed.outcome).toBe('refused');
      expect(parsed.reason).toBe('shadow_requires_explicit_workspace');
      expect(process.exitCode).toBe(1);
      logSpy.mockRestore();
    } finally {
      pinnedHomedir = undefined;
      process.exitCode = 0;
    }
  });

  it('repeatable --workspace selections reach the coordinator through the real parser (cli-7)', async () => {
    const home = tempHome();
    mkdirSync(path.join(home, '.pd'), { recursive: true });
    writeFileSync(
      path.join(home, '.pd', 'install.json'),
      JSON.stringify({ layoutVersion: 1, mode: 'canonical', hosts: ['codex'] }),
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
      await runOnce.parseAsync(
        ['--shadow', '--json', '--workspace', path.join(home, 'ws-a'), '-w', path.join(home, 'ws-b')],
        { from: 'user' },
      );
      const jsonLines = logSpy.mock.calls.filter((args) => typeof args[0] === 'string' && args[0].startsWith('{'));
      expect(jsonLines).toHaveLength(1);
      const parsed = JSON.parse(jsonLines[0]?.[0] as string) as {
        outcome: string;
        executions?: { admission: string; refusalReason?: string }[];
      };
      // Both selections reached the coordinator and were refused admission
      // (neither is in authorized discovery) — the collector accumulated.
      expect(parsed.outcome).toBe('completed');
      expect(parsed.executions).toHaveLength(2);
      expect(parsed.executions?.every((e) => e.admission === 'refused' && e.refusalReason === 'workspace_not_in_authorized_discovery')).toBe(true);
      expect(process.exitCode).toBe(1); // all-refused is a non-zero outcome
      logSpy.mockRestore();
    } finally {
      pinnedHomedir = undefined;
      process.exitCode = 0;
    }
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

  it('a completed run whose status write failed exits NON-ZERO (P2-3) and keeps the real outcome + reason in JSON', async () => {
    const home = tempHome();
    mkdirSync(path.join(home, '.pd'), { recursive: true });
    writeFileSync(
      path.join(home, '.pd', 'install.json'),
      JSON.stringify({ layoutVersion: 1, mode: 'canonical', hosts: ['openclaw'] }),
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
    // Deterministic write failure: the atomic-replace target exists as a
    // directory → temp write succeeds, rename fails.
    mkdirSync(path.join(home, '.pd', 'service', 'run-once-status.json'), { recursive: true });
    pinnedHomedir = home;
    try {
      const runOnce = findServiceRunOnce();
      const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
      await runOnce.parseAsync(['--dry-run', '--json'], { from: 'user' });
      const jsonLines = logSpy.mock.calls.filter((args) => typeof args[0] === 'string' && args[0].startsWith('{'));
      expect(jsonLines).toHaveLength(1);
      const parsed = JSON.parse(jsonLines[0]?.[0] as string) as {
        outcome: string;
        statusWrite: { ok: boolean; reason?: string };
        statusPath?: string;
      };
      expect(parsed.outcome).toBe('completed');
      expect(parsed.statusWrite.ok).toBe(false);
      expect(parsed.statusWrite.reason).toContain('service_status_write_failed');
      // No fake statusPath is emitted.
      expect(parsed.statusPath).toBeUndefined();
      expect(process.exitCode).toBe(1);
      logSpy.mockRestore();
    } finally {
      pinnedHomedir = undefined;
      process.exitCode = 0;
    }
  });
});

describe('P2-04 final-remediation — human output for records without a Worker execution', () => {
  it('an exception record (budget exhausted / adapter threw) shows reason + nextAction, not a bare label', async () => {
    const { printHumanShadow } = await import('../../src/commands/service-run-once.js');
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    const record = {
      requestedDir: '/ws/dual', canonicalDir: '/ws/dual', hostKind: 'workbuddy',
      admission: 'admitted', workspaceState: 'failed',
      refusalReason: 'workspace_timeout_budget_exhausted',
      refusalNextAction: 'raise --timeout-ms or select hosts in separate runs',
      lastProgressAt: null, lastProgressSource: null,
    };
    const result = {
      ok: true, outcome: 'completed', runId: 'r1',
      identity: { pdHome: '/pd', homeDir: '/h', homeSource: 'env', mode: 'sandbox', environment: { experimentRootStripped: false, ignoredIdentityEnvVars: [], inheritedHostRootEnvVars: [] } },
      activeRelease: { present: true, readable: true, valid: true, verdict: 'ok' },
      manifest: { verdict: 'ok', hosts: [], workspacesCount: 1 },
      discovery: { discoveredTotal: 1, counts: { authorized: 1 }, hostRoots: [], incomplete: false, workspaces: [] },
      executions: [record],
      statusWrite: { ok: true, path: '/pd/service/run-once-status.json' },
      status: { nextAction: 'next' },
    };
    printHumanShadow(result as unknown as Parameters<typeof printHumanShadow>[0]);
    const rendered = logSpy.mock.calls.map((c) => String(c[0])).join('\n');
    expect(rendered).toContain('workspace_timeout_budget_exhausted');
    expect(rendered).toContain('raise --timeout-ms');
    expect(rendered).not.toContain('— adapter failure\n');
    logSpy.mockRestore();
  });
});

describe('P1-01 final-closure — SIGHUP joins the terminal abort path', () => {
  it('a real SIGHUP aborts the coordinator signal and the in-flight worker process GROUP is terminated (POSIX)', async () => {
    if (process.platform === 'win32') return;
    const { wireTerminalAbortSignals } = await import('../../src/commands/service-run-once.js');
    const { runWorkerProcess } = await import('../../src/services/service-host/worker-process.js');
    const fixtures = path.join(path.dirname(new URL(import.meta.url).pathname), '..', 'services', 'service-host', 'fixtures');
    const controller = new AbortController();
    const unwire = wireTerminalAbortSignals(controller);
    try {
      const run = runWorkerProcess({
        cliEntry: path.join(fixtures, 'hang-with-descendant.mjs'),
        args: [],
        env: {},
        timeoutMs: 30_000,
        signal: controller.signal,
      });
      // A real OS signal to the coordinator process — the SAME path an SSH
      // terminal drop takes. The in-flight worker (detached group leader
      // with a same-group descendant) must die through the shared
      // SIGTERM→grace→SIGKILL→drain chain.
      process.kill(process.pid, 'SIGHUP');
      const result = await run;
      expect(controller.signal.aborted).toBe(true);
      expect(result.cancelled).toBe(true);
      // The descendant held the pipes: 'close' only settles once the whole
      // group is dead — proven here, not merely reported.
      expect(result.closeObserved).toBe(true);
      expect(result.terminationConfirmed).toBe(true);
    } finally {
      unwire();
    }
  });

  it('the teardown removes every listener it installed', async () => {
    const { wireTerminalAbortSignals } = await import('../../src/commands/service-run-once.js');
    const before = {
      sigint: process.listenerCount('SIGINT'),
      sigterm: process.listenerCount('SIGTERM'),
      sighup: process.listenerCount('SIGHUP'),
    };
    const controller = new AbortController();
    const unwire = wireTerminalAbortSignals(controller);
    expect(process.listenerCount('SIGINT')).toBe(before.sigint + 1);
    expect(process.listenerCount('SIGTERM')).toBe(before.sigterm + 1);
    if (process.platform !== 'win32') expect(process.listenerCount('SIGHUP')).toBe(before.sighup + 1);
    unwire();
    expect(process.listenerCount('SIGINT')).toBe(before.sigint);
    expect(process.listenerCount('SIGTERM')).toBe(before.sigterm);
    expect(process.listenerCount('SIGHUP')).toBe(before.sighup);
  });
});
