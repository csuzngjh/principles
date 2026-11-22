/**
 * The unified read-only status contract (PRI-1281 task §5): every clause
 * derives from its OWN witness (ERR-182) and the DISAGREEING combinations
 * are asserted — registered ≠ enabled ≠ last-run ≠ progress. Permission
 * denial never renders as "not installed"; a corrupt status file never
 * renders as "never ran".
 */
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, readFileSync } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { composeServiceHostStatus } from '../../../src/services/service-host/scheduler/service-status.js';
import type { SchedulerCommandRunner, SchedulerFileIo } from '../../../src/services/service-host/scheduler/contract.js';
import { schedulerIdentityFor } from '../../../src/services/service-host/scheduler/contract.js';
import { serviceRunStatusPath } from '../../../src/services/service-host/status/service-run-status.js';

const dirs: string[] = [];
function tempHome(prefix = 'pd-sh-status-'): string {
  const dir = mkdtempSync(path.join(os.tmpdir(), prefix));
  dirs.push(dir);
  return dir;
}
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

/** Windows-flavoured fake runner: answers the query script from a script. */
function fakeRunner(script: (args: readonly string[]) => { code: number; stdout: string; stderr: string }): SchedulerCommandRunner {
  return {
    async run(_command, args) {
      const reply = script(args);
      return { code: reply.code, stdout: reply.stdout, stderr: reply.stderr };
    },
  };
}

function mapFileIo(files: Map<string, string>): SchedulerFileIo {
  return {
    readIfExists(file) {
      const content = files.get(file);
      if (content === undefined) return { ok: false, reason: 'missing' };
      return { ok: true, content };
    },
    writeAtomic(file, content) {
      files.set(file, content);
      return { ok: true };
    },
    remove(file) {
      files.delete(file);
      return { ok: true };
    },
    exists(file) {
      return files.has(file);
    },
    mkdirs() {
      return { ok: true };
    },
  };
}

function activeRecord(): Record<string, unknown> {
  return {
    schemaVersion: 1, generation: 5, releaseId: 'bundled-9.9.9-status',
    releaseMetadataDigest: 'a'.repeat(64), previousReleaseId: null,
    transactionId: 'txn-status-1', productVersion: '9.9.9',
  };
}

function installSandbox(home: string, workspaces: string[], backgroundExecutions: Record<string, unknown> = {}): string {
  const pdDir = path.join(home, '.pd');
  mkdirSync(pdDir, { recursive: true });
  writeFileSync(path.join(pdDir, 'install.json'), JSON.stringify({
    layoutVersion: 1, mode: 'canonical', hosts: ['codex'], workspaces, backgroundExecutions,
  }), 'utf8');
  writeFileSync(path.join(pdDir, 'active.json'), JSON.stringify(activeRecord()), 'utf8');
  return pdDir;
}

function statusOptions(home: string, runner: SchedulerCommandRunner, files: Map<string, string>): Parameters<typeof composeServiceHostStatus>[0] {
  const identity = schedulerIdentityFor(path.join(home, '.pd'));
  const ours = `cli-entry-for-${identity.installKey}`;
  return {
    trustedHomeDir: home,
    probes: {
      platform: 'win32',
      runner,
      fileIo: mapFileIo(files),
      nodePath: 'C:\\node\\node.exe',
      resolveCliEntry: () => ({ kind: 'entry', entry: ours, source: 'canonical' as const }),
    },
  };
}

function queryReply(facts: { found: boolean; state?: string; xml?: string }): { code: number; stdout: string; stderr: string } {
  return {
    code: 0,
    stdout: JSON.stringify({
      ...(facts.found
        ? { found: true, state: facts.state ?? 'Ready', xml: facts.xml ?? `<Task><Actions><Command>C:\\node\\node.exe</Command><Arguments>"cli" --pd-home x</Arguments><Interval>PT2M</Interval></Actions></Task>` }
        : { found: false }),
    }),
    stderr: '',
  };
}

describe('composeServiceHostStatus — each clause from its own witness (ERR-182)', () => {
  it('registered+enabled with NO run yet: lastRun null, lastRunRead missing — registration is not completion', async () => {
    const home = tempHome();
    installSandbox(home, []);
    const files = new Map<string, string>();
    const runner = fakeRunner(() => queryReply({ found: true, state: 'Ready' }));
    const result = await composeServiceHostStatus(statusOptions(home, runner, files));
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.status.scheduler.available).toBe(true);
    expect(result.status.scheduler.registered).toBe(true);
    expect(result.status.scheduler.enabled).toBe(true);
    expect(result.status.scheduler.triggerConfiguration?.intervalMs).toBe(120000);
    expect(result.status.lastRun).toBeNull();
    expect(result.status.lastRunRead).toBe('missing');
    expect(result.status.lastProgressAt).toBeNull();
    expect(result.status.nextAction).toContain('no run-once has completed');
  });

  it('registered but DISABLED: the disabled fact stays visible and actionable', async () => {
    const home = tempHome();
    installSandbox(home, []);
    const runner = fakeRunner(() => queryReply({ found: true, state: 'Disabled' }));
    const result = await composeServiceHostStatus(statusOptions(home, runner, new Map()));
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.status.scheduler.registered).toBe(true);
    expect(result.status.scheduler.enabled).toBe(false);
    expect(result.status.nextAction).toContain('DISABLED');
  });

  it('not registered: nextAction points at install; workspace owner states still listed', async () => {
    const home = tempHome();
    const ws = `${home}${path.sep}ws-a`;
    mkdirSync(path.join(ws, '.pd'), { recursive: true });
    installSandbox(home, [ws], {
      [ws]: { state: 'legacy_owned', effectiveOwner: 'legacy', generation: 1, operationId: null, previousOwner: null, targetOwner: null, updatedAt: '2026-11-20T00:00:00.000Z' },
    });
    const runner = fakeRunner(() => queryReply({ found: false }));
    const result = await composeServiceHostStatus(statusOptions(home, runner, new Map()));
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.status.scheduler.registered).toBe(false);
    expect(result.status.nextAction).toContain('pd service install');
    const wsRow = result.status.workspaces.find((w) => w.canonicalDir === ws || w.canonicalDir.toLowerCase() === ws.toLowerCase());
    expect(wsRow, 'workspace owner state from the discovery witness').toBeDefined();
    expect(wsRow?.ownerState).toBe('legacy_owned');
    expect(wsRow?.effectiveOwner).toBe('legacy');
  });

  it('permission denial is NOT "not installed": scheduler.available=false, registered=null, degraded reason recorded', async () => {
    const home = tempHome();
    installSandbox(home, []);
    const runner = fakeRunner(() => ({
      code: 0,
      stdout: JSON.stringify({ ok: false, errorId: 'AccessDenied', message: 'denied' }),
      stderr: '',
    }));
    const result = await composeServiceHostStatus(statusOptions(home, runner, new Map()));
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.status.scheduler.available).toBe(false);
    expect(result.status.scheduler.registered).toBeNull();
    expect(result.status.scheduler.enabled).toBeNull();
    expect(result.status.degradedReasons.join(' ')).toContain('scheduler:');
    expect(result.status.scheduler.reason ?? '').toContain('AccessDenied');
  });

  it('a CORRUPT status file is corrupt, never "never ran": lastRunRead=corrupt + degraded reason', async () => {
    const home = tempHome();
    const pdDir = installSandbox(home, []);
    mkdirSync(path.join(pdDir, 'service'), { recursive: true });
    writeFileSync(serviceRunStatusPath(pdDir), '{ broken json', 'utf8');
    const runner = fakeRunner(() => queryReply({ found: true, state: 'Ready' }));
    const result = await composeServiceHostStatus(statusOptions(home, runner, new Map()));
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.status.lastRun).toBeNull();
    expect(result.status.lastRunRead).toBe('corrupt');
    expect(result.status.degradedReasons.join(' ')).toContain('last_run_status:corrupt');
  });

  it('a valid managed status file feeds lastRun with mode/triggerSource; progress store feeds lastProgressAt', async () => {
    const home = tempHome();
    const pdDir = installSandbox(home, []);
    mkdirSync(path.join(pdDir, 'service'), { recursive: true });
    writeFileSync(serviceRunStatusPath(pdDir), JSON.stringify({
      schemaVersion: 'pd.service-run-status.v1',
      runId: 'run-42', outcome: 'completed', dryRun: false, triggerSource: 'scheduler',
      startedAt: '2026-11-22T00:00:00.000Z', completedAt: '2026-11-22T00:00:05.000Z', durationMs: 5000,
      managed: { triggerSource: 'scheduler', perWorkspaceTimeoutMs: 2700000, progressCarryVerdict: 'ok', executions: [] },
      nextAction: 'Managed run complete.',
    }), 'utf8');
    writeFileSync(path.join(pdDir, 'service', 'shadow-progress.json'), JSON.stringify({
      schemaVersion: 'pd.shadow-progress.v1',
      entries: { 'C:\\ws': { lastProgressAt: '2026-11-22T00:00:04.000Z', source: 'task_state_change', updatedAt: '2026-11-22T00:00:05.000Z' } },
    }), 'utf8');
    const runner = fakeRunner(() => queryReply({ found: true, state: 'Ready' }));
    const result = await composeServiceHostStatus(statusOptions(home, runner, new Map()));
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.status.lastRun?.runId).toBe('run-42');
    expect(result.status.lastRun?.mode).toBe('managed');
    expect(result.status.lastRun?.triggerSource).toBe('scheduler');
    expect(result.status.lastRunRead).toBe('ok');
    expect(result.status.lastProgressAt).toBe('2026-11-22T00:00:04.000Z');
    expect(result.status.degradedReasons).toHaveLength(0);
  });

  it('status never mutates business data: the manifest stays byte-identical through the composer', async () => {
    const home = tempHome();
    const pdDir = installSandbox(home, []);
    const manifestFile = path.join(pdDir, 'install.json');
    const before = readFileSync(manifestFile, 'utf8');
    const runner = fakeRunner(() => queryReply({ found: true, state: 'Ready' }));
    await composeServiceHostStatus(statusOptions(home, runner, new Map()));
    expect(readFileSync(manifestFile, 'utf8')).toBe(before);
  });
});
