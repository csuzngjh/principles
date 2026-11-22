/**
 * PRI-1281 Phase 3 (task §6): the installer→CLI scheduler bridge.
 *
 * Contract under test:
 *  - the bridge invokes the JUST-INSTALLED CLI entry with the authoritative
 *    pdHome (never an env-derived home), a cleaned environment
 *    (PD_EXPERIMENT_ROOT / PD_WORKSPACE_DIR stripped) and NO credentials;
 *  - consent gating: no flags → refresh-if-registered only (never silently
 *    creates a registration); register → install; enable → install+enable;
 *  - every bridge failure is a WARNING for the caller — the committed
 *    install is never turned into a reported failure (ERR-197).
 */
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { ChildProcess } from 'node:child_process';
import { reconcileServiceHostScheduler, maybeSchedulerRegistrationExists, runServiceHostCli } from '../src/service-host-bridge.js';

const dirs: string[] = [];
function tempHome(prefix = 'cpd-sh-bridge-'): string {
  const dir = mkdtempSync(path.join(os.tmpdir(), prefix));
  dirs.push(dir);
  return dir;
}
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

interface RecordedCall {
  readonly command: string;
  readonly args: readonly string[];
  readonly env: NodeJS.ProcessEnv;
}

/** Fake spawn: records calls, answers from a per-subcommand script. */
function fakeSpawn(
  replies: Record<string, { code: number; stdout: string }>,
  calls: RecordedCall[],
): typeof import('node:child_process').spawn {
  const childLike = (reply: { code: number; stdout: string }): ChildProcess => {
    // A minimal event-emitter child sufficient for the bridge's contract.
    const listeners: Record<string, Array<(payload: unknown) => void>> = {};
    const emit = (event: string, payload: unknown): void => {
      for (const fn of listeners[event] ?? []) fn(payload);
    };
    const processLike = {
      on(event: string, fn: (payload: unknown) => void): void {
        (listeners[event] ??= []).push(fn);
        if (event === 'close') {
          // Deliver stdout then close asynchronously.
          setTimeout(() => {
            emit('data' in listeners ? 'data' : 'noop', null);
            (listeners['data'] ?? []).forEach(() => undefined);
            // stdout pipe is read via the .stdout.on('data') below.
            fn(reply.code);
          }, 0);
        }
      },
      kill(): boolean { return true; },
      stdout: {
        on(event: string, fn: (chunk: Buffer) => void): void {
          if (event === 'data') setTimeout(() => fn(Buffer.from(reply.stdout, 'utf8')), 0);
        },
      },
      stderr: { on(): void { /* no stderr in fixtures */ } },
    } as unknown as ChildProcess;
    return processLike;
  };
  return ((command: string, args: readonly string[], options: { env?: NodeJS.ProcessEnv }) => {
    calls.push({ command, args: [...args], env: options.env ?? {} });
    // args = [entry, 'service', '<op>', ...] — the op is the third token.
    const subcommand = args[2] ?? '';
    const reply = replies[subcommand] ?? { code: 1, stdout: '{"ok":false,"reason":"unscripted"}' };
    return childLike(reply);
  }) as unknown as typeof import('node:child_process').spawn;
}

/** Materialize a fake installed CLI entry so the entry check passes. */
function fakeInstalledCli(home: string): string {
  const pdHome = path.join(home, '.pd');
  const entry = path.join(pdHome, 'runtime', 'pd-cli', 'dist', 'index.js');
  mkdirSync(path.dirname(entry), { recursive: true });
  writeFileSync(entry, '// fixture CLI entry', 'utf8');
  return pdHome;
}

/** Create the platform's scheduler-registration artifact (the cheap probe's signal). */
function fakeRegistrationArtifact(home: string): void {
  if (process.platform === 'win32') {
    const dir = path.join(home, '.pd', 'service');
    mkdirSync(dir, { recursive: true });
    writeFileSync(path.join(dir, 'scheduler-registration-win.xml'), '<Task/>', 'utf8');
  } else if (process.platform === 'darwin') {
    const dir = path.join(home, 'Library', 'LaunchAgents');
    mkdirSync(dir, { recursive: true });
    writeFileSync(path.join(dir, 'com.principles-disciple.service-host.abc1234567.plist'), '<plist/>', 'utf8');
  } else {
    const dir = path.join(home, '.config', 'systemd', 'user');
    mkdirSync(dir, { recursive: true });
    writeFileSync(path.join(dir, 'pd-service-host-abc1234567.timer'), '[Timer]\n', 'utf8');
  }
}

describe('runServiceHostCli — trusted invocation shape', () => {
  it('invokes the installed entry with --json and the authoritative --pd-home, cleaned env, no credentials', async () => {
    const home = tempHome();
    const pdHome = fakeInstalledCli(home);
    const calls: RecordedCall[] = [];
    const spawnFn = fakeSpawn({ install: { code: 0, stdout: '{"schemaVersion":"pd.service-scheduler-op.v1","operation":"install","ok":true,"changed":true,"registered":true,"enabled":false}' } }, calls);
    // Poison the ambient env: identity must come from the trusted pdHome.
    const previousExperimentRoot = process.env.PD_EXPERIMENT_ROOT;
    const previousWorkspaceDir = process.env.PD_WORKSPACE_DIR;
    process.env.PD_EXPERIMENT_ROOT = 'D:\\untrusted-experiment';
    process.env.PD_WORKSPACE_DIR = 'D:\\untrusted-ws';
    try {
      const result = await runServiceHostCli(pdHome, ['service', 'install'], { spawnFn });
      expect(result.ok).toBe(true);
      expect(calls).toHaveLength(1);
      expect(calls[0]?.command ?? '').toBe(process.execPath);
      expect(calls[0]?.args[0]).toBe(path.join(pdHome, 'runtime', 'pd-cli', 'dist', 'index.js'));
      expect(calls[0]?.args.join(' ')).toContain('service install');
      expect(calls[0]?.args.join(' ')).toContain('--json');
      // --pd-home carries the HOME ROOT (the CLI derives <home>/.pd itself).
      expect(calls[0]?.args.join(' ')).toContain(`--pd-home ${home}`);
      expect(calls[0]?.args.join(' ')).not.toContain(`--pd-home ${pdHome}`);
      expect(calls[0]?.env.PD_EXPERIMENT_ROOT).toBeUndefined();
      expect(calls[0]?.env.PD_WORKSPACE_DIR).toBeUndefined();
      // No credential-shaped argument ever crosses the boundary.
      expect(calls[0]?.args.join(' ')).not.toMatch(/sk-|Bearer\s|api[_-]?key/i);
    } finally {
      if (previousExperimentRoot === undefined) delete process.env.PD_EXPERIMENT_ROOT;
      else process.env.PD_EXPERIMENT_ROOT = previousExperimentRoot;
      if (previousWorkspaceDir === undefined) delete process.env.PD_WORKSPACE_DIR;
      else process.env.PD_WORKSPACE_DIR = previousWorkspaceDir;
    }
  });

  it('treats the unified status DOCUMENT (not an ok envelope) as the status reply', async () => {
    const home = tempHome();
    const pdHome = fakeInstalledCli(home);
    const spawnFn = fakeSpawn({
      status: { code: 0, stdout: '{"schemaVersion":"pd.service-status.v1","scheduler":{"registered":true,"enabled":false}}' },
    }, []);
    const result = await runServiceHostCli(pdHome, ['service', 'status'], { spawnFn });
    expect(result.ok).toBe(true);
    expect(result.registered).toBe(true);
  });

  it('reports a refused op truthfully (never success)', async () => {
    const home = tempHome();
    const pdHome = fakeInstalledCli(home);
    const spawnFn = fakeSpawn({
      enable: { code: 1, stdout: '{"schemaVersion":"pd.service-scheduler-op.v1","operation":"enable","ok":false,"reason":"scheduler_not_registered","nextAction":"x"}' },
    }, []);
    const result = await runServiceHostCli(pdHome, ['service', 'enable'], { spawnFn });
    expect(result.ok).toBe(false);
    expect(result.detail).toContain('scheduler_not_registered');
  });

  it('missing CLI entry is a structured failure with a manual next action', async () => {
    const home = tempHome();
    const result = await runServiceHostCli(path.join(home, '.pd'), ['service', 'install'], {});
    expect(result.ok).toBe(false);
    expect(result.detail).toContain('service_host_cli_entry_missing');
    expect(result.nextAction ?? '').toContain('pd service install');
  });
});

describe('reconcileServiceHostScheduler — consent gating + refresh (ERR-197)', () => {
  it('without consent and NO registration artifact: ZERO CLI calls (no boot cost on fresh machines)', async () => {
    const home = tempHome();
    const pdHome = fakeInstalledCli(home);
    const calls: RecordedCall[] = [];
    const spawnFn = fakeSpawn({
      status: { code: 0, stdout: '{"schemaVersion":"pd.service-status.v1","scheduler":{"registered":false}}' },
    }, calls);
    await reconcileServiceHostScheduler({
      pdHome, registerServiceHost: false, enableServiceHost: false,
      warn: () => { throw new Error('no warnings expected'); },
      probes: { spawnFn },
    });
    expect(calls).toHaveLength(0);
  });

  it('without consent (artifact present): refreshes ONLY when the CLI reports a registration; never creates one', async () => {
    const home = tempHome();
    const pdHome = fakeInstalledCli(home);
    fakeRegistrationArtifact(home);
    const calls: RecordedCall[] = [];
    const spawnFn = fakeSpawn({
      status: { code: 0, stdout: '{"schemaVersion":"pd.service-status.v1","scheduler":{"registered":false,"enabled":false}}' },
      install: { code: 0, stdout: '{"ok":true,"changed":true}' },
    }, calls);
    const infos: string[] = [];
    await reconcileServiceHostScheduler({
      pdHome, registerServiceHost: false, enableServiceHost: false,
      warn: () => { throw new Error('no warnings expected'); },
      info: (m) => infos.push(m),
      probes: { spawnFn },
    });
    const subcommands = calls.map((c) => c.args[2]);
    expect(subcommands).toEqual(['status']); // no install call — nothing existed
    expect(infos).toHaveLength(0);
  });

  it('without consent but registered: re-runs install (idempotent refresh), preserving enabled state', async () => {
    const home = tempHome();
    const pdHome = fakeInstalledCli(home);
    fakeRegistrationArtifact(home);
    const calls: RecordedCall[] = [];
    const spawnFn = fakeSpawn({
      status: { code: 0, stdout: '{"schemaVersion":"pd.service-status.v1","scheduler":{"registered":true,"enabled":true}}' },
      install: { code: 0, stdout: '{"ok":true,"changed":false}' },
    }, calls);
    const infos: string[] = [];
    await reconcileServiceHostScheduler({
      pdHome, registerServiceHost: false, enableServiceHost: false,
      warn: () => { throw new Error('no warnings expected'); },
      info: (m) => infos.push(m),
      probes: { spawnFn },
    });
    const subcommands = calls.map((c) => c.args[2]);
    expect(subcommands).toEqual(['status', 'install']); // refresh happened
    expect(infos.join(' ')).toContain('refreshed');
  });

  it('--register-service-host: registers DISABLED and does NOT enable', async () => {
    const home = tempHome();
    const pdHome = fakeInstalledCli(home);
    const calls: RecordedCall[] = [];
    const spawnFn = fakeSpawn({
      install: { code: 0, stdout: '{"ok":true,"changed":true}' },
      enable: { code: 1, stdout: '{"ok":false,"reason":"must_not_be_called"}' },
    }, calls);
    await reconcileServiceHostScheduler({
      pdHome, registerServiceHost: true, enableServiceHost: false,
      warn: () => { throw new Error('no warnings expected'); },
      probes: { spawnFn },
    });
    expect(calls.map((c) => c.args[2])).toEqual(['install']);
  });

  it('--enable-service-host: install then enable; enable failure stays a WARNING (registration stays disabled)', async () => {
    const home = tempHome();
    const pdHome = fakeInstalledCli(home);
    const calls: RecordedCall[] = [];
    const spawnFn = fakeSpawn({
      install: { code: 0, stdout: '{"ok":true,"changed":true}' },
      enable: { code: 1, stdout: '{"ok":false,"reason":"scheduler_query_failed:AccessDenied","nextAction":"inspect"}' },
    }, calls);
    const warnings: string[] = [];
    await reconcileServiceHostScheduler({
      pdHome, registerServiceHost: true, enableServiceHost: true,
      warn: (m) => warnings.push(m),
      probes: { spawnFn },
    });
    expect(calls.map((c) => c.args[2])).toEqual(['install', 'enable']);
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain('stays DISABLED');
    expect(warnings[0]).toContain('AccessDenied');
  });

  it('the file probe: a MISSING platform dir is a clean false (fresh install); artifacts present is true (ENOENT regression)', async () => {
    const home = tempHome();
    // No dir at all — the fresh-install case. This MUST be false without
    // falling into the catch-all (the first CI run regressed here: ENOENT
    // hit the fallback and every install spawned a full CLI boot, pushing
    // the suite past the job timeout).
    expect(maybeSchedulerRegistrationExists(home)).toBe(false);
    // With an artifact, true.
    fakeRegistrationArtifact(home);
    expect(maybeSchedulerRegistrationExists(home)).toBe(true);
  });

  it('an unreadable scheduler state (artifact present) is a warning, never a thrown error', async () => {
    const home = tempHome();
    const pdHome = fakeInstalledCli(home);
    fakeRegistrationArtifact(home);
    const spawnFn = fakeSpawn({
      status: { code: 1, stdout: '{"schemaVersion":"pd.service-status.v1","ok":false,"reason":"identity_refused"}' },
    }, []);
    const warnings: string[] = [];
    await reconcileServiceHostScheduler({
      pdHome, registerServiceHost: false, enableServiceHost: false,
      warn: (m) => warnings.push(m),
      probes: { spawnFn },
    });
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain('could not be verified');
  });
});
