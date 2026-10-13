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
import { getDefaultPdConfig } from '@principles/core/runtime-v2';
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
  it('registers `pd workbuddy worker` with the documented options', () => {
    const help = runPdHelp(['workbuddy', 'worker', '--help']);
    expect(help).toContain('--workspace');
    expect(help).toContain('--once');
    expect(help).toContain('--interval');
    expect(help).toContain('--status');
    expect(help).toContain('--json');
    expect(help).toContain('reconciliation');
  });

  it('registers the workbuddy command group (pd workbuddy --help)', () => {
    const help = runPdHelp(['workbuddy', '--help']);
    expect(help).toContain('worker');
  });
});

describe('workbuddy worker handler (functional)', () => {
  let workspaceDir: string;
  let logSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    workspaceDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pd-cli-wb-worker-'));
    fs.mkdirSync(path.join(workspaceDir, '.pd'), { recursive: true });
    fs.mkdirSync(path.join(workspaceDir, '.state'), { recursive: true });
    const config = getDefaultPdConfig();
    config.features['host.workbuddy'].enabled = true;
    config.features.internalization_auto_consumer.enabled = false;
    fs.writeFileSync(path.join(workspaceDir, '.pd', 'config.yaml'), JSON.stringify(config));
    logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
  });

  afterEach(() => {
    logSpy.mockRestore();
    process.exitCode = 0;
    fs.rmSync(workspaceDir, { recursive: true, force: true });
  });

  it('--once reports paused with reason+nextAction when the consumer flag is off', { timeout: 20_000 }, async () => {
    const { handleWorkbuddyWorker } = await import('../../src/commands/workbuddy-worker.js');
    await handleWorkbuddyWorker({ workspace: workspaceDir, once: true, json: true });
    expect(logSpy).toHaveBeenCalledTimes(1);
    const report = JSON.parse(logSpy.mock.calls[0]?.[0] as string) as { mode: string; reason: string; nextAction: string };
    expect(report.mode).toBe('paused');
    expect(report.reason).toBe('internalization_auto_consumer_disabled');
    expect(report.nextAction).toContain('pd diagnose');
    expect(process.exitCode ?? 0).toBe(0);
  });

  it('--json without --once/--status is refused (cli-1: continuous mode is not one JSON document)', async () => {
    const { handleWorkbuddyWorker } = await import('../../src/commands/workbuddy-worker.js');
    await handleWorkbuddyWorker({ workspace: workspaceDir, json: true });
    expect(logSpy).toHaveBeenCalledTimes(1);
    const error = JSON.parse(logSpy.mock.calls[0]?.[0] as string) as { error: string; reason: string; nextAction: string };
    expect(error.error).toBe('cli_contract');
    expect(error.reason).toBe('json_without_once_or_status');
    expect(error.nextAction).toContain('--once');
    expect(process.exitCode).toBe(1);
  });

  it('--once without --json prints the human-readable cycle report (no Codex catch-up line)', { timeout: 20_000 }, async () => {
    const { handleWorkbuddyWorker } = await import('../../src/commands/workbuddy-worker.js');
    await handleWorkbuddyWorker({ workspace: workspaceDir, once: true, json: false });
    const output = logSpy.mock.calls.map((call) => String(call[0])).join('\n');
    expect(output).toContain('WorkBuddy governance worker');
    expect(output).toContain('mode: paused');
    expect(output).toContain('reconcile:');
    expect(output).not.toContain('catch-up:');
    expect(output).toContain('next action:');
    expect(process.exitCode ?? 0).toBe(0);
  });

  it('--status reports manual_action_required for a governance workspace absent from the install manifest', async () => {
    const { handleWorkbuddyWorker } = await import('../../src/commands/workbuddy-worker.js');
    const config = getDefaultPdConfig();
    config.features['host.workbuddy'].enabled = true;
    config.features.internalization_auto_consumer.enabled = true;
    fs.writeFileSync(path.join(workspaceDir, '.pd', 'config.yaml'), JSON.stringify(config));
    await handleWorkbuddyWorker({ workspace: workspaceDir, status: true, json: true });
    expect(logSpy).toHaveBeenCalledTimes(1);
    const report = JSON.parse(logSpy.mock.calls[0]?.[0] as string) as { host: string; mode: string; reason: string; registeredInInstallManifest: boolean };
    expect(report.host).toBe('workbuddy');
    expect(report.mode).toBe('manual_action_required');
    expect(report.reason).toBe('workspace_not_in_install_manifest');
    expect(report.registeredInInstallManifest).toBe(false);
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
