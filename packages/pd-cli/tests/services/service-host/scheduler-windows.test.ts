/**
 * Windows scheduler adapter — PowerShell protocol tests against a faked
 * command boundary (task §9.F): install/enable/disable/uninstall/status call
 * sequencing, the PD_TASK_XML environment hand-off, fail-closed foreign-task
 * handling, and the honest failure mapping (AccessDenied must never read as
 * "not installed"; spawn failure reads as unavailable, not success).
 */
import * as os from 'node:os';
import * as path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  schedulerIdentityFor,
  type SchedulerCommandResult,
  type SchedulerCommandRunner,
  type SchedulerFileIo,
  type SchedulerRegistration,
} from '../../../src/services/service-host/scheduler/contract.js';
import { createWindowsSchedulerAdapter } from '../../../src/services/service-host/scheduler/windows.js';

interface RecordedCall {
  readonly command: string;
  readonly args: readonly string[];
  readonly extraEnv: Readonly<Record<string, string>> | undefined;
}

function psResult(body: unknown): SchedulerCommandResult {
  return { code: 0, stdout: JSON.stringify(body), stderr: '' };
}

/** Sequential scripting: the Nth adapter command returns the Nth result. */
function sequentialRunner(results: readonly SchedulerCommandResult[]): {
  runner: SchedulerCommandRunner;
  calls: RecordedCall[];
} {
  const calls: RecordedCall[] = [];
  let next = 0;
  const runner: SchedulerCommandRunner = {
    async run(command, args, extraEnv) {
      calls.push({ command, args, extraEnv });
      const result = results[next];
      next += 1;
      if (result === undefined) {
        throw new Error(`unexpected extra command #${next}: ${command} ${args.join(' ')}`);
      }
      return result;
    },
  };
  return { runner, calls };
}

/** In-memory file boundary implementing the SchedulerFileIo contract. */
class FakeFileIo implements SchedulerFileIo {
  readonly files = new Map<string, string>();
  readonly writeLog: Array<{ file: string; content: string }> = [];
  readonly removeLog: string[] = [];
  readonly mkdirLog: string[] = [];

  readIfExists(file: string): ReturnType<SchedulerFileIo['readIfExists']> {
    const content = this.files.get(file);
    if (content === undefined) return { ok: false, reason: 'missing' };
    return { ok: true, content };
  }

  writeAtomic(file: string, content: string): ReturnType<SchedulerFileIo['writeAtomic']> {
    this.files.set(file, content);
    this.writeLog.push({ file, content });
    return { ok: true };
  }

  remove(file: string): ReturnType<SchedulerFileIo['remove']> {
    this.removeLog.push(file);
    if (!this.files.delete(file)) return { ok: false, reason: 'missing' };
    return { ok: true };
  }

  exists(file: string): boolean {
    return this.files.has(file);
  }

  mkdirs(dir: string): ReturnType<SchedulerFileIo['mkdirs']> {
    this.mkdirLog.push(dir);
    return { ok: true };
  }
}

/** The PowerShell script text is the last `-Command` argument. */
function scriptAt(calls: readonly RecordedCall[], index: number): string {
  const call = calls[index];
  if (call === undefined) throw new Error(`missing recorded call #${index}`);
  const script = call.args[call.args.length - 1];
  if (script === undefined) throw new Error(`recorded call #${index} carries no script`);
  return script;
}

const BASE_DIR = path.join(os.tmpdir(), 'pd-scheduler-windows-tests');

function makeRegistration(): SchedulerRegistration {
  const pdHome = path.join(BASE_DIR, 'home-a', '.pd');
  const cliEntry = path.join(BASE_DIR, 'releases', 'active', 'index.js');
  const nodePath = path.join(BASE_DIR, 'runtime', 'node.exe');
  return { pdHome, homeDir: path.dirname(pdHome), cliEntry, nodePath, intervalMs: 120_000, identity: schedulerIdentityFor(pdHome) };
}

/** Exported task XML the ownership check accepts as OURS (entry + pdHome). */
function oursXml(registration: SchedulerRegistration, triggers = ''): string {
  return (
    `<Task><Actions><Exec><Command>${registration.nodePath}</Command>` +
    `<Arguments>"${registration.cliEntry}" service run-once --json --trigger scheduler --pd-home ${registration.homeDir}</Arguments>` +
    `<WorkingDirectory>${registration.pdHome}</WorkingDirectory>` +
    `</Exec></Actions>${triggers}</Task>`
  );
}

describe('createWindowsSchedulerAdapter', () => {
  it('install registers a disabled task when none exists (query → write XML → Register → re-query)', async () => {
    const registration = makeRegistration();
    const { runner, calls } = sequentialRunner([
      psResult({ found: false }),
      psResult({ done: true }),
      psResult({ found: true, state: 'Disabled', xml: oursXml(registration), lastResult: 0 }),
    ]);
    const fileIo = new FakeFileIo();
    const adapter = createWindowsSchedulerAdapter({ runner, fileIo });

    const result = await adapter.install(registration);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.changed).toBe(true);
    expect(result.facts.platform).toBe('win32');
    expect(result.facts.taskName).toBe(registration.identity.windowsTaskName);
    expect(result.facts.registered).toBe(true);
    expect(result.facts.enabled).toBe(false);

    expect(calls.length).toBe(3);
    expect(calls[0]?.command).toBe('powershell.exe');
    expect(calls[0]?.args.slice(0, 5)).toEqual(['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command']);
    expect(scriptAt(calls, 0)).toContain('Get-ScheduledTask');
    expect(scriptAt(calls, 0)).not.toContain('Register-ScheduledTask');
    expect(scriptAt(calls, 1)).toContain('Register-ScheduledTask');
    expect(scriptAt(calls, 2)).toContain('Get-ScheduledTask');

    const xmlFile = path.join(registration.pdHome, 'service', 'scheduler-registration-win.xml');
    expect(fileIo.writeLog.length).toBe(1);
    expect(fileIo.writeLog[0]?.file).toBe(xmlFile);
    expect(fileIo.writeLog[0]?.content).toContain('__PD_TASK_USER__');
    expect(fileIo.writeLog[0]?.content).toContain(registration.cliEntry);
    expect(fileIo.writeLog[0]?.content).toContain('<Enabled>false</Enabled>');
    expect(calls[1]?.extraEnv?.PD_TASK_XML).toBe(xmlFile);
  });

  it('install is idempotent for our own Ready task (no mutation, enabled state preserved)', async () => {
    const registration = makeRegistration();
    const { runner, calls } = sequentialRunner([
      psResult({ found: true, state: 'Ready', xml: oursXml(registration), lastRunAt: '2026-11-22T00:00:00.0000000+00:00', lastResult: 0 }),
    ]);
    const fileIo = new FakeFileIo();
    const adapter = createWindowsSchedulerAdapter({ runner, fileIo });

    const result = await adapter.install(registration);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.changed).toBe(false);
    expect(result.facts.registered).toBe(true);
    expect(result.facts.enabled).toBe(true);
    expect(calls.length).toBe(1);
    expect(fileIo.writeLog.length).toBe(0);
  });

  it('install refuses a foreign task occupying our name (external_conflict)', async () => {
    const registration = makeRegistration();
    const { runner } = sequentialRunner([psResult({ found: true, state: 'Ready', xml: '<Task>someone else</Task>' })]);
    const fileIo = new FakeFileIo();
    const adapter = createWindowsSchedulerAdapter({ runner, fileIo });

    const result = await adapter.install(registration);

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.kind).toBe('external_conflict');
    expect(result.reason).toContain('foreign');
    expect(fileIo.writeLog.length).toBe(0);
  });

  it('enable refuses when no registration exists (unsafe_state scheduler_not_registered)', async () => {
    const registration = makeRegistration();
    const { runner } = sequentialRunner([psResult({ found: false })]);
    const adapter = createWindowsSchedulerAdapter({ runner, fileIo: new FakeFileIo() });

    const result = await adapter.enable(registration);

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.kind).toBe('unsafe_state');
    expect(result.reason).toBe('scheduler_not_registered');
  });

  it('enable is a no-op when the task is already Ready', async () => {
    const registration = makeRegistration();
    const { runner, calls } = sequentialRunner([psResult({ found: true, state: 'Ready', xml: oursXml(registration) })]);
    const adapter = createWindowsSchedulerAdapter({ runner, fileIo: new FakeFileIo() });

    const result = await adapter.enable(registration);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.changed).toBe(false);
    expect(result.facts.enabled).toBe(true);
    expect(calls.length).toBe(1);
    expect(scriptAt(calls, 0)).not.toContain('Enable-ScheduledTask');
  });

  it('enable flips a Disabled task to Ready (mutation + re-query)', async () => {
    const registration = makeRegistration();
    const { runner, calls } = sequentialRunner([
      psResult({ found: true, state: 'Disabled', xml: oursXml(registration) }),
      psResult({ done: true }),
      psResult({ found: true, state: 'Ready', xml: oursXml(registration) }),
    ]);
    const adapter = createWindowsSchedulerAdapter({ runner, fileIo: new FakeFileIo() });

    const result = await adapter.enable(registration);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.changed).toBe(true);
    expect(result.facts.enabled).toBe(true);
    expect(scriptAt(calls, 1)).toContain('Enable-ScheduledTask');
  });

  it('disable flips a Ready task to Disabled (mutation + re-query)', async () => {
    const registration = makeRegistration();
    const { runner, calls } = sequentialRunner([
      psResult({ found: true, state: 'Ready', xml: oursXml(registration) }),
      psResult({ done: true }),
      psResult({ found: true, state: 'Disabled', xml: oursXml(registration) }),
    ]);
    const adapter = createWindowsSchedulerAdapter({ runner, fileIo: new FakeFileIo() });

    const result = await adapter.disable(registration);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.changed).toBe(true);
    expect(result.facts.enabled).toBe(false);
    expect(scriptAt(calls, 1)).toContain('Disable-ScheduledTask');
  });

  it('disable is a no-op when the task is already Disabled', async () => {
    const registration = makeRegistration();
    const { runner, calls } = sequentialRunner([psResult({ found: true, state: 'Disabled', xml: oursXml(registration) })]);
    const adapter = createWindowsSchedulerAdapter({ runner, fileIo: new FakeFileIo() });

    const result = await adapter.disable(registration);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.changed).toBe(false);
    expect(calls.length).toBe(1);
    expect(scriptAt(calls, 0)).not.toContain('Disable-ScheduledTask');
  });

  it('uninstall is an idempotent no-op when nothing is registered', async () => {
    const registration = makeRegistration();
    const { runner, calls } = sequentialRunner([psResult({ found: false })]);
    const adapter = createWindowsSchedulerAdapter({ runner, fileIo: new FakeFileIo() });

    const result = await adapter.uninstall(registration);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.changed).toBe(false);
    expect(result.facts.registered).toBe(false);
    expect(calls.length).toBe(1);
  });

  it('uninstall of our task disables then unregisters it', async () => {
    const registration = makeRegistration();
    const { runner, calls } = sequentialRunner([
      psResult({ found: true, state: 'Ready', xml: oursXml(registration) }),
      psResult({ done: true }),
      psResult({ found: false }),
    ]);
    const adapter = createWindowsSchedulerAdapter({ runner, fileIo: new FakeFileIo() });

    const result = await adapter.uninstall(registration);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.changed).toBe(true);
    expect(result.facts.registered).toBe(false);
    expect(calls.length).toBe(3);
    const mutation = scriptAt(calls, 1);
    expect(mutation).toContain('Disable-ScheduledTask');
    expect(mutation).toContain('Unregister-ScheduledTask');
  });

  it('status maps a structured AccessDenied to command_failed and never to "not registered"', async () => {
    const registration = makeRegistration();
    const { runner } = sequentialRunner([psResult({ ok: false, errorId: 'AccessDenied', message: 'Access is denied.' })]);
    const adapter = createWindowsSchedulerAdapter({ runner, fileIo: new FakeFileIo() });

    const result = await adapter.status(registration);

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.kind).toBe('command_failed');
    expect(result.reason).toBe('scheduler_query_failed:AccessDenied');
    expect(result.facts).toBeUndefined(); // never fabricated "unregistered" facts
  });

  it('status maps a powershell spawn failure to unavailable', async () => {
    const registration = makeRegistration();
    const { runner } = sequentialRunner([{ code: null, stdout: '', stderr: '', spawnError: 'spawn_error:ENOENT' }]);
    const adapter = createWindowsSchedulerAdapter({ runner, fileIo: new FakeFileIo() });

    const result = await adapter.status(registration);

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.kind).toBe('unavailable');
    expect(result.reason).toContain('powershell_unavailable:spawn_error:ENOENT');
  });

  it('status maps a powershell timeout to command_failed/powershell_timeout', async () => {
    const registration = makeRegistration();
    const { runner } = sequentialRunner([{ code: null, stdout: '', stderr: '', timedOut: true }]);
    const adapter = createWindowsSchedulerAdapter({ runner, fileIo: new FakeFileIo() });

    const result = await adapter.status(registration);

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.kind).toBe('command_failed');
    expect(result.reason).toBe('powershell_timeout');
  });

  it('status maps unparsable stdout to command_failed', async () => {
    const registration = makeRegistration();
    const { runner } = sequentialRunner([{ code: 0, stdout: 'garbage', stderr: '' }]);
    const adapter = createWindowsSchedulerAdapter({ runner, fileIo: new FakeFileIo() });

    const result = await adapter.status(registration);

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.kind).toBe('command_failed');
    expect(result.reason.startsWith('powershell_unparsable_output:')).toBe(true);
  });

  it('status parses Disabled state, the 1899 never-run sentinel and the PT2M interval', async () => {
    const registration = makeRegistration();
    const xml = oursXml(registration, '<Triggers><Repetition><Interval>PT2M</Interval></Repetition></Triggers>');
    const { runner } = sequentialRunner([
      psResult({ found: true, state: 'Disabled', xml, lastRunAt: '1899-11-30T00:00:00.0000000+00:00', lastResult: 267009 }),
    ]);
    const adapter = createWindowsSchedulerAdapter({ runner, fileIo: new FakeFileIo() });

    const result = await adapter.status(registration);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.facts.registered).toBe(true);
    expect(result.facts.enabled).toBe(false);
    expect(result.facts.lastRunAt).toBeNull();
    expect(result.facts.triggerIntervalMs).toBe(120_000);
    expect(result.facts.lastResult).toBe('267009');
  });

  it('special-char install paths (& \' CJK) match their own XML-ESCAPED registration (ownership never misreads its own task)', async () => {
    // Regression for the sub-review finding: Task Scheduler exports the
    // definition XML-escaped; a raw-string ownership compare would classify
    // our own fresh registration as foreign for such paths (task §3.2).
    const pdHome = `${BASE_DIR}${path.sep}Tom's D&I 项目${path.sep}.pd`;
    const cliEntry = `${BASE_DIR}${path.sep}Tom's D&I 项目${path.sep}runtime${path.sep}pd-cli${path.sep}dist${path.sep}index.js`;
    const registration: SchedulerRegistration = {
      pdHome,
      homeDir: path.dirname(pdHome),
      cliEntry,
      nodePath: path.join(BASE_DIR, 'node.exe'),
      intervalMs: 120_000,
      identity: schedulerIdentityFor(pdHome),
    };
    const escapeXml = (value: string): string =>
      value.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;' })[c] ?? c);
    // The query returns the definition in Task-Scheduler's ESCAPED form; the
    // pdHome rides along in the escaped Arguments (homeDir) AND the escaped
    // WorkingDirectory so the ownership check finds BOTH facts.
    const escapedXml =
      `<Task><Actions><Exec><Command>${escapeXml(registration.nodePath)}</Command>` +
      `<Arguments>${escapeXml(`"${registration.cliEntry}" service run-once --json --trigger scheduler --pd-home ${registration.homeDir}`)}</Arguments>` +
      `<WorkingDirectory>${escapeXml(registration.pdHome)}</WorkingDirectory>` +
      `</Exec></Actions></Task>`;
    const { runner } = sequentialRunner([psResult({ found: true, state: 'Ready', xml: escapedXml, lastResult: 0 })]);
    const adapter = createWindowsSchedulerAdapter({ runner, fileIo: new FakeFileIo() });

    const result = await adapter.install(registration);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    // Idempotent reuse — NOT an external_conflict, NOT a re-register.
    expect(result.changed).toBe(false);
    expect(result.facts.registered).toBe(true);
    expect(result.facts.enabled).toBe(true);
  });
});
