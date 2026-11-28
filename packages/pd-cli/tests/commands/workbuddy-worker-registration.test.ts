/**
 * Command-registration / parser + functional tests for the WorkBuddy worker
 * command (cli-7, SPEC workbuddy-host-adapter §5 Part 5): `pd workbuddy
 * worker`.
 *
 * cli-7: the registration assertions spawn the REAL built CLI (`pd workbuddy
 * worker --help`) — a hand-built copy of the program would stay green through
 * any src/index.ts drift (review P2). Functional tests exercise the real
 * handler against a temp governance workspace: --json emits exactly one
 * parseable JSON object (cli-1), paused paths carry reason + nextAction
 * (cli-6), and failed paths mutate nothing.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { getDefaultPdConfig } from '@principles/core/runtime';
import { getBuiltPdCliPath } from '../helpers/pd-cli-path.js';

function runPdHelp(args: string[]): string {
  try {
    return execFileSync('node', [getBuiltPdCliPath(), ...args], { encoding: 'utf8' });
  } catch (err: unknown) {
    if (err && typeof err === 'object' && Object.hasOwn(err, 'stdout')) {
      return String(Reflect.get(err, 'stdout'));
    }
    throw err;
  }
}

describe('workbuddy worker command registration (cli-7, real built CLI)', () => {
  it('registers `pd workbuddy worker` with the documented options', { timeout: 60_000 }, () => {
    const help = runPdHelp(['workbuddy', 'worker', '--help']);
    expect(help).toContain('--workspace');
    expect(help).toContain('--once');
    expect(help).not.toContain('--interval');
    expect(help).toContain('--status');
    expect(help).toContain('--json');
    expect(help).toContain('Service-Host-owned');
  });

  it('registers the workbuddy command group (pd workbuddy --help)', { timeout: 60_000 }, () => {
    const help = runPdHelp(['workbuddy', '--help']);
    expect(help).toContain('worker');
  });
});

describe('workbuddy worker handler (functional)', () => {
  let workspaceDir: string;
  let pdHomeDir: string;
  let logSpy: ReturnType<typeof vi.spyOn>;

  function writeOwnership(state: 'service_host_owned' | 'legacy_owned' | 'rollback_pending' | 'no_record'): void {
    const record = state === 'no_record' ? undefined : {
      state,
      effectiveOwner: state === 'service_host_owned' || state === 'rollback_pending' ? 'service_host' : 'legacy',
      generation: 1,
      operationId: state === 'rollback_pending' ? 'op-fixture' : null,
      previousOwner: state === 'rollback_pending' ? 'service_host' : null,
      targetOwner: state === 'rollback_pending' ? 'legacy' : null,
      updatedAt: '2026-11-20T00:00:00.000Z',
    };
    fs.writeFileSync(path.join(pdHomeDir, 'install.json'), JSON.stringify({
      layoutVersion: 1,
      mode: 'canonical',
      hosts: ['workbuddy'],
      workspaces: [workspaceDir],
      ...(record !== undefined ? { backgroundExecutions: { [workspaceDir]: record } } : {}),
    }), 'utf8');
  }

  beforeEach(() => {
    workspaceDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pd-cli-wb-worker-'));
    pdHomeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pd-cli-wb-home-'));
    process.env.PD_SERVICE_PD_HOME = pdHomeDir;
    fs.mkdirSync(path.join(workspaceDir, '.pd'), { recursive: true });
    fs.mkdirSync(path.join(workspaceDir, '.state'), { recursive: true });
    writeOwnership('service_host_owned');
    const config = getDefaultPdConfig();
    config.features['host.workbuddy'].enabled = true;
    config.features.internalization_auto_consumer.enabled = false;
    fs.writeFileSync(path.join(workspaceDir, '.pd', 'config.yaml'), JSON.stringify(config));
    logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
  });

  afterEach(() => {
    logSpy.mockRestore();
    process.exitCode = 0;
    delete process.env.PD_SERVICE_PD_HOME;
    fs.rmSync(workspaceDir, { recursive: true, force: true });
    fs.rmSync(pdHomeDir, { recursive: true, force: true });
  });

  // P2-01: this fixture's workspace has a config but no trajectory.db, so the
  // pre-pause reconcile stage really fails — the honest result is `degraded`
  // aggregating the stage failure, never a clean `paused`.
  it('--once reports degraded aggregating pre-pause stage failures when the consumer flag is off', { timeout: 20_000 }, async () => {
    const { handleWorkbuddyWorker } = await import('../../src/commands/workbuddy-worker.js');
    await handleWorkbuddyWorker({ workspace: workspaceDir, once: true, json: true });
    expect(logSpy).toHaveBeenCalledTimes(1);
    const report = JSON.parse(logSpy.mock.calls[0]?.[0] as string) as { mode: string; reason: string; nextAction: string };
    expect(report.mode).toBe('degraded');
    expect(report.reason).toContain('paused_stage_failures:');
    expect(report.reason).toContain('reconcile:trajectory_db_not_found');
    expect(report.nextAction).toContain('pd runtime init');
    expect(process.exitCode).toBe(1);
  });

  it('--json without --once/--status is refused (cli-1: continuous mode is not one JSON document)', async () => {
    const { handleWorkbuddyWorker } = await import('../../src/commands/workbuddy-worker.js');
    await handleWorkbuddyWorker({ workspace: workspaceDir, json: true });
    expect(logSpy).toHaveBeenCalledTimes(1);
    const error = JSON.parse(logSpy.mock.calls[0]?.[0] as string) as { error: string; reason: string; nextAction: string };
    expect(error.error).toBe('cli_contract');
    expect(error.reason).toBe('mode_required');
    expect(error.nextAction).toContain('no continuous mode');
    expect(process.exitCode).toBe(1);
  });

  it('--once without --json prints the WorkBuddy transcript catch-up line (not the absent Codex one)', { timeout: 20_000 }, async () => {
    const { handleWorkbuddyWorker } = await import('../../src/commands/workbuddy-worker.js');
    await handleWorkbuddyWorker({ workspace: workspaceDir, once: true, json: false });
    const output = logSpy.mock.calls.map((call) => String(call[0])).join('\n');
    expect(output).toContain('WorkBuddy governance worker');
    // P2-01: the failed pre-pause reconcile stage downgrades paused to
    // degraded with the real stage category preserved.
    expect(output).toContain('mode: degraded (paused_stage_failures:reconcile:');
    expect(output).toContain('reconcile:');
    // The worker DOES run a bounded WorkBuddy transcript catch-up; with the
    // ingestion flag off (beforeEach default) it is skipped with a reason. The
    // old `not.toContain('catch-up:')` assertion was written before catch-up
    // existed and would pass even if the step silently disappeared.
    expect(output).toContain('catch-up:    skipped');
    expect(output).toContain('reason=feature_disabled');
    expect(output).toContain('next action:');
    expect(process.exitCode).toBe(1);
  });

  it('--status reports a no-record ownership projection as paused, with Service Host provisioning copy', async () => {
    const { handleWorkbuddyWorker } = await import('../../src/commands/workbuddy-worker.js');
    const config = getDefaultPdConfig();
    config.features['host.workbuddy'].enabled = true;
    config.features.internalization_auto_consumer.enabled = true;
    fs.writeFileSync(path.join(workspaceDir, '.pd', 'config.yaml'), JSON.stringify(config));
    writeOwnership('no_record');
    await handleWorkbuddyWorker({ workspace: workspaceDir, status: true, json: true });
    expect(logSpy).toHaveBeenCalledTimes(1);
    const report = JSON.parse(logSpy.mock.calls[0]?.[0] as string) as {
      host: string; mode: string; reason: string; registeredInInstallManifest: boolean; serviceHostManaged: boolean;
      ownership: { state: string; source?: string }; nextAction: string;
    };
    expect(report.host).toBe('workbuddy');
    expect(report.mode).toBe('paused');
    expect(report.reason).toBe('workbuddy_workspace_not_service_host_owned:legacy_owned');
    expect(report.registeredInInstallManifest).toBe(true);
    expect(report.serviceHostManaged).toBe(false);
    expect(report.ownership).toMatchObject({ state: 'legacy_owned', source: 'no_record' });
    expect(report.nextAction).toContain('service_host_owned');
    expect(report.nextAction).not.toContain('Companion');
    expect(process.exitCode ?? 0).toBe(0);
  });

  it('ownership gates --once: service_host_owned reaches the cycle, legacy/rollback residue pause, and held mutex pauses non-fatally', async () => {
    const { handleWorkbuddyWorker } = await import('../../src/commands/workbuddy-worker.js');
    const { acquireWorkspaceServiceRunLock, releaseServiceRunLock } = await import('../../src/services/service-host/locking/service-run-lock.js');

    // Baseline fixture is service_host_owned: the report is the normal config
    // pause/degradation shape, never the ownership-admission reason.
    await handleWorkbuddyWorker({ workspace: workspaceDir, once: true, json: true });
    let report = JSON.parse(logSpy.mock.calls.at(-1)?.[0] as string) as { mode: string; reason: string };
    expect(report.reason).not.toContain('workspace_not_service_host_owned');

    writeOwnership('legacy_owned');
    await handleWorkbuddyWorker({ workspace: workspaceDir, once: true, json: true });
    report = JSON.parse(logSpy.mock.calls.at(-1)?.[0] as string) as { mode: string; reason: string };
    expect(report).toMatchObject({ mode: 'paused', reason: 'workbuddy_workspace_not_service_host_owned:legacy_owned' });

    writeOwnership('rollback_pending');
    await handleWorkbuddyWorker({ workspace: workspaceDir, once: true, json: true });
    report = JSON.parse(logSpy.mock.calls.at(-1)?.[0] as string) as { mode: string; reason: string };
    expect(report).toMatchObject({ mode: 'paused', reason: 'workbuddy_workspace_not_service_host_owned:rollback_pending' });

    writeOwnership('service_host_owned');
    process.exitCode = 0;
    const lock = acquireWorkspaceServiceRunLock(pdHomeDir, workspaceDir);
    if (!lock.ok) throw new Error(`fixture lock failed: ${lock.kind}`);
    try {
      await handleWorkbuddyWorker({ workspace: workspaceDir, once: true, json: true });
      report = JSON.parse(logSpy.mock.calls.at(-1)?.[0] as string) as { mode: string; reason: string };
      expect(report).toMatchObject({ mode: 'paused', reason: 'workbuddy_worker_run_in_progress' });
      expect(process.exitCode ?? 0).toBe(0);
    } finally {
      releaseServiceRunLock(lock.handle);
    }
  });

  it('an unreadable ownership manifest degrades --once and exits 1', async () => {
    const { handleWorkbuddyWorker } = await import('../../src/commands/workbuddy-worker.js');
    fs.writeFileSync(path.join(pdHomeDir, 'install.json'), '{ not json', 'utf8');
    await handleWorkbuddyWorker({ workspace: workspaceDir, once: true, json: true });
    const report = JSON.parse(logSpy.mock.calls.at(-1)?.[0] as string) as { mode: string; reason: string; nextAction: string };
    expect(report.mode).toBe('degraded');
    expect(report.reason).toContain('workbuddy_owner_marker_unreadable:');
    expect(report.nextAction.length).toBeGreaterThan(10);
    expect(process.exitCode).toBe(1);
  });

  it('--status human output says automatic Pain detection is unavailable and names the explicit prefix', async () => {
    const { handleWorkbuddyWorker } = await import('../../src/commands/workbuddy-worker.js');
    const config = getDefaultPdConfig();
    config.features['host.workbuddy'].enabled = true;
    config.features.internalization_auto_consumer.enabled = true;
    fs.writeFileSync(path.join(workspaceDir, '.pd', 'config.yaml'), JSON.stringify(config));
    await handleWorkbuddyWorker({ workspace: workspaceDir, status: true, json: false });
    const output = logSpy.mock.calls.map((call) => String(call[0])).join('\n');
    expect(output).toContain('automatic Pain detection: NOT AVAILABLE in WorkBuddy');
    expect(output).toContain('PD记录痛苦：');
    expect(output).not.toContain('auto keyword Pain');
    expect(process.exitCode ?? 0).toBe(0);
  });

  it('--status --json keeps the documented single-object contract and reports the default-OFF keyword gate', async () => {
    const { handleWorkbuddyWorker } = await import('../../src/commands/workbuddy-worker.js');
    // beforeEach config: host.workbuddy=true, workbuddy_live_keyword_pain absent
    // → its contract default is OFF. The JSON contract must stay unchanged.
    await handleWorkbuddyWorker({ workspace: workspaceDir, status: true, json: true });
    expect(logSpy).toHaveBeenCalledTimes(1);
    const report = JSON.parse(logSpy.mock.calls[0]?.[0] as string) as {
      host: string;
      mode: string;
      keywordPain: { enabled: boolean; mode: string; source: string };
    };
    expect(report.host).toBe('workbuddy');
    expect(report.keywordPain).toEqual({ enabled: false, mode: 'off', source: expect.any(String) });
    expect(Object.keys(report)).toEqual(expect.arrayContaining([
      'generatedAt',
      'host',
      'workspace',
      'mode',
      'registeredInInstallManifest',
      'keywordPain',
    ]));
    expect(process.exitCode ?? 0).toBe(0);
  });

  it('host.workbuddy=false → paused with the WorkBuddy-specific reason (no Codex borrowing)', { timeout: 20_000 }, async () => {
    const { handleWorkbuddyWorker } = await import('../../src/commands/workbuddy-worker.js');
    const config = getDefaultPdConfig();
    config.features['host.workbuddy'].enabled = false;
    config.features['host.codex'].enabled = true;
    config.features.internalization_auto_consumer.enabled = true;
    fs.writeFileSync(path.join(workspaceDir, '.pd', 'config.yaml'), JSON.stringify(config));
    await handleWorkbuddyWorker({ workspace: workspaceDir, once: true, json: true });
    expect(logSpy).toHaveBeenCalledTimes(1);
    const report = JSON.parse(logSpy.mock.calls[0]?.[0] as string) as { mode: string; reason: string };
    expect(report.mode).toBe('paused');
    expect(report.reason).toBe('host.workbuddy_disabled');
  });
});
