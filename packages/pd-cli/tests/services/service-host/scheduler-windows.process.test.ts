/**
 * REAL Windows Task Scheduler acceptance (task §9.F / §10): the only mock is
 * the pdHome (an isolated temp install identity so the task name cannot
 * collide with any real PD install). Everything else is the REAL OS:
 * powershell.exe, the ScheduledTasks module and the task store.
 *
 * TWO real regimes, auto-detected once:
 *  - STANDARD hosts (incl. CI runners): the UNELEVATED production path works
 *    end-to-end — the whole lifecycle uses the real spawn runner.
 *  - HARDENED hosts (this dev box: machine policy denies unelevated task
 *    registration — verified live): that denial is first asserted as the
 *    honesty contract (task §5: permission denial must NEVER read as "not
 *    installed"), then the SAME adapter scripts run through an elevated
 *    PowerShell bridge (silent-elevation host) for the rest of the
 *    lifecycle. On standard machines the bridge is never used.
 */
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { afterAll, describe, expect, it } from 'vitest';
import { schedulerIdentityFor, type SchedulerAdapter, type SchedulerCommandResult, type SchedulerCommandRunner, type SchedulerRegistration } from '../../../src/services/service-host/scheduler/contract.js';
import { createWindowsSchedulerAdapter } from '../../../src/services/service-host/scheduler/windows.js';
import { createSpawnSchedulerRunner, nodeSchedulerFileIo } from '../../../src/services/service-host/scheduler/runtime-io.js';

const home = mkdtempSync(path.join(os.tmpdir(), 'pd-scheduler-win-real-'));
const pdHome = path.join(home, '.pd');
// A deliberately missing CLI entry: the OS-side trigger machinery is under
// test, not a real PD run (the real install acceptance does that).
const registration: SchedulerRegistration = {
  pdHome,
  homeDir: path.dirname(pdHome),
  cliEntry: path.join(pdHome, 'runtime', 'pd-cli', 'dist', 'index.js'),
  nodePath: process.execPath,
  intervalMs: 60_000,
  identity: schedulerIdentityFor(pdHome),
};

const unelevatedAdapter = createWindowsSchedulerAdapter({
  runner: createSpawnSchedulerRunner({ timeoutMs: 90_000 }),
  fileIo: nodeSchedulerFileIo,
});

/** Set by the regime probe (first test): which adapter the lifecycle uses. */
let lifecycleAdapter: SchedulerAdapter = unelevatedAdapter;
/** True when the probe's unelevated install already registered the task (standard hosts). */
let probeInstalled = false;
/**
 * Set when the hardened-host regime cannot reach an elevated context (UAC
 * consent unavailable in a headless/disconnected session — observed live):
 * the remaining lifecycle tests SKIP with this reason instead of failing.
 * On standard hosts (CI) the unelevated path never sets this.
 */
let elevationUnavailableReason: string | null = null;

/**
 * Elevated PowerShell bridge (HARDENED hosts only): runs the EXACT script
 * the adapter produced inside an elevated process and returns its stdout.
 * Output crosses the boundary via a temp file because an elevated child
 * cannot inherit our stdio pipes.
 */
function createElevatedRunner(scratchDir: string): SchedulerCommandRunner {
  return {
    async run(command, args, extraEnv): Promise<SchedulerCommandResult> {
      const script = args[args.length - 1] ?? '';
      const id = randomUUID().slice(0, 8);
      const scriptFile = path.join(scratchDir, `op-${id}.ps1`);
      const outFile = path.join(scratchDir, `op-${id}.out`);
      // The wrapper re-exports the adapter's extraEnv (PD_TASK_XML) because
      // the elevated process does not inherit our environment; the & { … }
      // wrap keeps the pipe bound to the whole multi-statement script.
      const envLines = extraEnv === undefined
        ? ''
        : Object.entries(extraEnv).map(([k, v]) => `$env:${k} = '${v.replace(/'/g, "''")}'`).join('; ') + '; ';
      writeFileSync(scriptFile, `& { ${envLines}${script} } | Out-File -FilePath '${outFile}' -Encoding utf8`, 'utf8');
      const code = await new Promise<number | null>((resolve) => {
        const child = spawn('powershell.exe', [
          '-NoProfile', '-NonInteractive', '-Command',
          `$p = Start-Process powershell.exe -Verb RunAs -WindowStyle Hidden -PassThru -Wait -ArgumentList @('-NoProfile','-NonInteractive','-ExecutionPolicy','Bypass','-File','${scriptFile.replace(/'/g, "''")}'); exit $p.ExitCode`,
        ], { stdio: 'ignore', windowsHide: true });
        child.on('close', (c) => resolve(c));
        child.on('error', () => resolve(null));
      });
      let stdout = '';
      try {
        stdout = readFileSync(outFile, 'utf8');
      } catch {
        stdout = '';
      }
      return { code, stdout, stderr: '' };
    },
  };
}

const elevatedAdapter = createWindowsSchedulerAdapter({
  runner: createElevatedRunner(home),
  fileIo: nodeSchedulerFileIo,
});

afterAll(() => {
  // Unconditional cleanup with BOTH adapters: the temp identity's task must
  // not survive the suite even when an assertion failed earlier.
  void elevatedAdapter.uninstall(registration)
    .then(() => unelevatedAdapter.uninstall(registration))
    .finally(() => {
      rmSync(home, { recursive: true, force: true });
    });
});

describe.runIf(process.platform === 'win32')('real Windows Task Scheduler lifecycle (isolated identity)', () => {
  it(
    'regime probe: unelevated install either works (standard host → unelevated lifecycle) or is denied WITHOUT reading as "not installed" (hardened host → elevated bridge)',
    { timeout: 240_000 },
    async (ctx) => {
      if (elevationUnavailableReason !== null) {
        ctx.skip({ reason: elevationUnavailableReason });
        return;
      }
      const result = await unelevatedAdapter.install(registration);
      if (result.ok) {
        // Standard host: the unelevated production path registered the task.
        lifecycleAdapter = unelevatedAdapter;
        probeInstalled = true;
        expect(result.facts.registered).toBe(true);
        expect(result.facts.enabled).toBe(false);
        return;
      }
      // Hardened host: the denial must be a structured command failure
      // carrying the failure identity — registered is never "false, all good".
      expect(result.kind).toBe('command_failed');
      expect(result.reason).toContain('scheduler_mutation_failed');
      expect(result.nextAction).not.toContain('not installed');
      // Elevation capability probe: a canceled UAC consent (headless or
      // disconnected console session) means the elevated bridge cannot run
      // — the remaining lifecycle tests skip honestly instead of failing.
      const marker = path.join(home, 'elev-capability.txt');
      const probe = await new Promise<boolean>((resolve) => {
        const child = spawn('powershell.exe', [
          '-NoProfile', '-NonInteractive', '-Command',
          `$p = Start-Process powershell.exe -Verb RunAs -WindowStyle Hidden -PassThru -Wait -ArgumentList @('-NoProfile','-Command','Set-Content -Path '${marker}' -Value ok'); exit $p.ExitCode`,
        ], { stdio: 'ignore', windowsHide: true });
        child.on('close', (code) => resolve(code === 0));
        child.on('error', () => resolve(false));
      });
      if (!probe) {
        elevationUnavailableReason = 'elevated context unavailable (UAC consent canceled/timed out in this session) — the real lifecycle needs console consent on this hardened host; standard hosts run the unelevated path';
        return;
      }
      lifecycleAdapter = elevatedAdapter;
    },
  );

  it(
    'install → registered + DISABLED (installed_disabled)',
    { timeout: 240_000 },
    async (ctx) => {
      if (elevationUnavailableReason !== null) {
        ctx.skip({ reason: elevationUnavailableReason });
        return;
      }
      const result = await lifecycleAdapter.install(registration);
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      // Standard host: the probe already registered — this re-install is the
      // idempotent no-op. Hardened host: the elevated bridge does the real
      // registration here.
      expect(result.changed).toBe(!probeInstalled);
      expect(result.facts.registered).toBe(true);
      expect(result.facts.enabled).toBe(false);
      expect(result.facts.platform).toBe('win32');
    },
  );

  it(
    're-install is idempotent and PRESERVES the disabled state',
    { timeout: 240_000 },
    async (ctx) => {
      if (elevationUnavailableReason !== null) {
        ctx.skip({ reason: elevationUnavailableReason });
        return;
      }
      const result = await lifecycleAdapter.install(registration);
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.changed).toBe(false);
      expect(result.facts.enabled).toBe(false);
    },
  );

  it(
    'enable → enabled; status reads it back from the OS',
    { timeout: 240_000 },
    async (ctx) => {
      if (elevationUnavailableReason !== null) {
        ctx.skip({ reason: elevationUnavailableReason });
        return;
      }
      const enabled = await lifecycleAdapter.enable(registration);
      expect(enabled.ok).toBe(true);
      if (!enabled.ok) return;
      expect(enabled.facts.enabled).toBe(true);

      const status = await lifecycleAdapter.status(registration);
      expect(status.ok).toBe(true);
      if (!status.ok) return;
      expect(status.facts.registered).toBe(true);
      expect(status.facts.enabled).toBe(true);
      expect(status.facts.triggerIntervalMs).toBe(60_000);
    },
  );

  it(
    'the OS REALLY starts the registered command (Start-ScheduledTask → non-null LastRunTime/LastTaskResult)',
    { timeout: 300_000 },
    async (ctx) => {
      if (elevationUnavailableReason !== null) {
        ctx.skip({ reason: elevationUnavailableReason });
        return;
      }
      // Drive the OS-side start exactly like a trigger would — unelevated
      // works for OUR own task on both regimes.
      await new Promise<void>((resolve, reject) => {
        const child = spawn('powershell.exe', [
          '-NoProfile', '-NonInteractive', '-Command',
          `Start-ScheduledTask -TaskName '${registration.identity.windowsTaskName}'; Start-Sleep -Seconds 3`,
        ], { stdio: 'ignore', windowsHide: true });
        child.on('close', (code) => (code === 0 ? resolve() : reject(new Error(`Start-ScheduledTask exited ${code ?? 'null'}`))));
        child.on('error', (error) => reject(error));
      });
      const status = await lifecycleAdapter.status(registration);
      expect(status.ok).toBe(true);
      if (!status.ok) return;
      // LastRunTime left the sentinel and LastTaskResult is a real exit
      // code — the missing CLI entry makes it non-zero (node could not load
      // the module), which is exactly the honest evidence that the OS ran
      // OUR command line.
      expect(status.facts.lastRunAt).not.toBeNull();
      expect(status.facts.lastResult).not.toBeNull();
      expect(Number(status.facts.lastResult)).not.toBe(0);
    },
  );

  it(
    'disable → disabled; uninstall → registration gone; re-uninstall is a no-op',
    { timeout: 240_000 },
    async (ctx) => {
      if (elevationUnavailableReason !== null) {
        ctx.skip({ reason: elevationUnavailableReason });
        return;
      }
      const disabled = await lifecycleAdapter.disable(registration);
      expect(disabled.ok).toBe(true);
      if (!disabled.ok) return;
      expect(disabled.facts.enabled).toBe(false);

      const removed = await lifecycleAdapter.uninstall(registration);
      expect(removed.ok).toBe(true);
      if (!removed.ok) return;
      expect(removed.changed).toBe(true);

      const status = await lifecycleAdapter.status(registration);
      expect(status.ok).toBe(true);
      if (!status.ok) return;
      expect(status.facts.registered).toBe(false);

      const again = await lifecycleAdapter.uninstall(registration);
      expect(again.ok).toBe(true);
      if (!again.ok) return;
      expect(again.changed).toBe(false);
    },
  );
});

