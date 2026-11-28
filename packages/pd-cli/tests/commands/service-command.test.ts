/**
 * Real command-registration and handler contract for `pd service run-once`
 * in the Service-Host-only architecture. The tests exercise the shipped
 * Commander program object, not a hand-copied parser: managed and dry-run
 * modes remain, while shadow and ownership-transition commands are absent.
 */
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Command, Option } from 'commander';
import { buildPdProgram } from '../../src/program.js';

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

function findCommand(parent: Command, name: string): Command {
  const found = parent.commands.find((cmd) => cmd.name() === name);
  expect(found, `${name} command must be registered`).toBeDefined();
  return found as Command;
}

function findService(): Command {
  return findCommand(buildPdProgram(), 'service');
}

function findServiceRunOnce(): Command {
  return findCommand(findService(), 'run-once');
}

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  vi.restoreAllMocks();
  process.exitCode = 0;
  pinnedHomedir = undefined;
  // buildPdProgram() returns a module singleton; reset parsed option values
  // so tests remain order-independent.
  const runOnce = findServiceRunOnce();
  for (const opt of runOnce.options) {
    if (opt.long !== undefined) {
      runOnce.setOptionValue(opt.long.replace(/^--/, '').replace(/-([a-z])/g, (_m, c: string) => c.toUpperCase()), opt.defaultValue);
    }
  }
});

function writeInstall(home: string, workspace: string, ownershipState: string): void {
  const pdDir = path.join(home, '.pd');
  mkdirSync(pdDir, { recursive: true });
  writeFileSync(path.join(pdDir, 'install.json'), JSON.stringify({
    layoutVersion: 1,
    mode: 'canonical',
    hosts: ['codex'],
    workspaces: [workspace],
    backgroundExecutions: {
      [workspace]: {
        state: ownershipState,
        effectiveOwner: ownershipState === 'service_host_owned' ? 'service_host' : 'legacy',
        generation: 1,
        operationId: ownershipState === 'handover_preparing' ? 'op-fixture' : null,
        previousOwner: ownershipState === 'handover_preparing' ? 'legacy' : null,
        targetOwner: ownershipState === 'handover_preparing' ? 'service_host' : null,
        updatedAt: '2026-11-20T00:00:00.000Z',
      },
    },
  }), 'utf8');
  writeFileSync(path.join(pdDir, 'active.json'), JSON.stringify({
    schemaVersion: 1,
    generation: 5,
    releaseId: 'bundled-9.9.9-cli',
    releaseMetadataDigest: 'a'.repeat(64),
    previousReleaseId: null,
    transactionId: 'txn-1',
    productVersion: '9.9.9',
  }), 'utf8');
}

async function parseOneJson(runOnce: Command, args: string[]): Promise<Record<string, unknown>> {
  const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
  try {
    await runOnce.parseAsync(args, { from: 'user' });
    const jsonLines = logSpy.mock.calls.filter((call) => typeof call[0] === 'string' && call[0].startsWith('{'));
    expect(jsonLines, 'cli-1: exactly one stdout JSON document').toHaveLength(1);
    return JSON.parse(jsonLines[0]?.[0] as string) as Record<string, unknown>;
  } finally {
    logSpy.mockRestore();
  }
}

describe('registration (cli-7: the shipped program object)', () => {
  it('run-once keeps managed/dry-run inputs and exposes no shadow-mode inputs', () => {
    const runOnce = findServiceRunOnce();
    const names = runOnce.options.map((option: Option) => option.long);
    expect(names).toEqual(expect.arrayContaining(['--dry-run', '--trigger', '--pd-home', '--timeout-ms', '--json']));
    expect(names).not.toContain('--shadow');
    expect(names).not.toContain('--workspace');
    expect(names).not.toContain('--host');
  });

  it('service handover and rollback are no longer registered', () => {
    const names = findService().commands.map((command) => command.name());
    expect(names).toEqual(expect.arrayContaining(['run-once', 'install', 'enable', 'disable', 'uninstall', 'status']));
    expect(names).not.toContain('handover');
    expect(names).not.toContain('rollback');
  });
});

describe('run-once managed/dry-run behavior through the real action', () => {
  it('a bare managed run over a legacy-only install is a legal empty completed run (exit 0, no worker)', async () => {
    const home = tempHome();
    const ws = path.join(home, 'legacy-ws');
    mkdirSync(path.join(ws, '.pd'), { recursive: true });
    writeInstall(home, ws, 'legacy_owned');
    pinnedHomedir = home;
    const parsed = await parseOneJson(findServiceRunOnce(), ['--json', '--trigger', 'scheduler']) as {
      outcome: string;
      managed?: { emptyReason?: string; executions?: Array<{ admission: string; skipReason?: string }> };
    };
    expect(parsed.outcome).toBe('completed');
    expect(parsed.managed?.emptyReason).toBe('no_service_host_owned_workspaces');
    expect(parsed.managed?.executions?.[0]?.admission).toBe('skipped');
    expect(parsed.managed?.executions?.[0]?.skipReason).toBe('workspace_not_service_host_owned:legacy_owned');
    expect(process.exitCode).toBe(0);
  });

  it('transition-state residue is skipped by binary admission, never consumed as service-host-owned', async () => {
    const home = tempHome();
    const ws = path.join(home, 'residue-ws');
    mkdirSync(path.join(ws, '.pd'), { recursive: true });
    writeInstall(home, ws, 'handover_preparing');
    pinnedHomedir = home;
    const parsed = await parseOneJson(findServiceRunOnce(), ['--json']) as {
      outcome: string;
      managed?: { executions?: Array<{ admission: string; skipReason?: string; skipNextAction?: string }> };
    };
    expect(parsed.outcome).toBe('completed');
    expect(parsed.managed?.executions?.[0]?.admission).toBe('skipped');
    expect(parsed.managed?.executions?.[0]?.skipReason).toBe('workspace_not_service_host_owned:handover_preparing');
    expect(parsed.managed?.executions?.[0]?.skipNextAction).toContain('installer/provisioning repair');
    expect(process.exitCode).toBe(0);
  });

  it('an invalid trigger is refused fail-closed', async () => {
    const parsed = await parseOneJson(findServiceRunOnce(), ['--json', '--trigger', 'login']);
    expect(parsed).toMatchObject({ outcome: 'refused', reason: 'invalid_trigger:login' });
    expect(process.exitCode).toBe(1);
    process.exitCode = 0;
  });

  it('an invalid timeout is refused before any execution', async () => {
    const parsed = await parseOneJson(findServiceRunOnce(), ['--json', '--timeout-ms', '5m']);
    expect(parsed).toMatchObject({ outcome: 'refused', reason: 'invalid_timeout_ms:5m' });
    expect(process.exitCode).toBe(1);
    process.exitCode = 0;
  });

  it('dry-run keeps the fail-closed read-only contract for a missing install', async () => {
    pinnedHomedir = tempHome();
    const parsed = await parseOneJson(findServiceRunOnce(), ['--dry-run', '--json']);
    expect(parsed).toMatchObject({ outcome: 'refused', dryRun: true });
    expect(String(parsed.reason)).toMatch(/^install_manifest_missing|^active_release_missing/);
    expect(process.exitCode).toBe(1);
    process.exitCode = 0;
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
      process.kill(process.pid, 'SIGHUP');
      const result = await run;
      expect(controller.signal.aborted).toBe(true);
      expect(result.cancelled).toBe(true);
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
