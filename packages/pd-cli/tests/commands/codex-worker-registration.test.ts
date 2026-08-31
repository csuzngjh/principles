/**
 * Command-registration / parser + functional tests for the PRI-624 Slice C
 * Codex commands (cli-7): `pd codex ingest catch-up` and `pd codex worker`.
 *
 * Registration mirrors src/index.ts. Functional tests exercise the real
 * handlers against a temp workspace: --json emits exactly one parseable
 * JSON object (cli-1), flag-off skips carry reason + nextAction (cli-6), and
 * failed paths mutate nothing.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Command } from 'commander';
import { getDefaultPdConfig } from '@principles/core/runtime-v2';

function buildTestProgram(): Command {
  const program = new Command();
  const codex = program.command('codex');
  codex.command('reconcile');
  const ingest = codex.command('ingest');
  ingest
    .command('catch-up')
    .option('-w, --workspace <path>', 'Workspace directory')
    .option('--max-rollouts <n>', 'Maximum rollouts to catch up per pass (1-32, default 8)')
    .option('--json', 'Output raw JSON')
    .action(() => {});
  codex
    .command('worker')
    .option('-w, --workspace <path>', 'Workspace directory')
    .option('--once', 'Run exactly one bounded cycle and exit')
    .option('--interval <ms>', 'Cycle interval for continuous mode')
    .option('--status', 'Report the SPEC §15 worker mode without executing anything')
    .option('--json', 'Output raw JSON')
    .action(() => {});
  return program;
}

describe('codex Slice C command registration (cli-7)', () => {
  it('parses codex ingest catch-up flags', () => {
    const program = buildTestProgram();
    program.parse(['node', 'pd', 'codex', 'ingest', 'catch-up', '--workspace', '/tmp/ws', '--max-rollouts', '4', '--json']);
    const codex = program.commands.find((c) => c.name() === 'codex');
    const ingest = codex?.commands.find((c) => c.name() === 'ingest');
    const catchUp = ingest?.commands.find((c) => c.name() === 'catch-up');
    expect(catchUp).toBeDefined();
    expect(catchUp?.opts().workspace).toBe('/tmp/ws');
    expect(catchUp?.opts().maxRollouts).toBe('4');
    expect(catchUp?.opts().json).toBe(true);
  });

  it('parses codex worker flags including --once and --status', () => {
    const program = buildTestProgram();
    program.parse(['node', 'pd', 'codex', 'worker', '--workspace', '/tmp/ws', '--once', '--json']);
    const codex = program.commands.find((c) => c.name() === 'codex');
    const worker = codex?.commands.find((c) => c.name() === 'worker');
    expect(worker).toBeDefined();
    expect(worker?.opts().workspace).toBe('/tmp/ws');
    expect(worker?.opts().once).toBe(true);
    expect(worker?.opts().json).toBe(true);

    const program2 = buildTestProgram();
    program2.parse(['node', 'pd', 'codex', 'worker', '--status']);
    const worker2 = program2.commands.find((c) => c.name() === 'codex')?.commands.find((c) => c.name() === 'worker');
    expect(worker2?.opts().status).toBe(true);
    // --interval is registered for continuous mode
    const intervalOption = worker?.options.find((o) => o.long === '--interval');
    expect(intervalOption).toBeDefined();
  });
});

describe('codex ingest catch-up handler (functional)', () => {
  let workspaceDir: string;
  let logSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    workspaceDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pd-cli-catchup-'));
    fs.mkdirSync(path.join(workspaceDir, '.pd'), { recursive: true });
    fs.mkdirSync(path.join(workspaceDir, '.state'), { recursive: true });
    fs.writeFileSync(path.join(workspaceDir, '.state', 'trajectory.db'), '');
    const config = getDefaultPdConfig();
    config.features['host.codex'].enabled = true;
    config.features.codex_conversation_ingestion.enabled = false;
    fs.writeFileSync(path.join(workspaceDir, '.pd', 'config.yaml'), JSON.stringify(config));
    logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
  });

  afterEach(() => {
    logSpy.mockRestore();
    fs.rmSync(workspaceDir, { recursive: true, force: true });
  });

  it('emits exactly one JSON object and skips with reason+nextAction when ingestion is off', { timeout: 20_000 }, async () => {
    const { handleCodexIngestCatchUp } = await import('../../src/commands/codex-ingest-catchup.js');
    await handleCodexIngestCatchUp({ workspace: workspaceDir, json: true });
    expect(logSpy).toHaveBeenCalledTimes(1);
    const report = JSON.parse(logSpy.mock.calls[0]?.[0] as string) as { status: string; reason: string; nextAction: string };
    expect(report.status).toBe('skipped');
    expect(report.reason).toBe('feature_disabled');
    expect(report.nextAction).toContain('codex_conversation_ingestion');
    expect(process.exitCode ?? 0).toBe(0);
  });
});

describe('codex worker handler (functional)', () => {
  let workspaceDir: string;
  let logSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    workspaceDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pd-cli-worker-'));
    fs.mkdirSync(path.join(workspaceDir, '.pd'), { recursive: true });
    fs.mkdirSync(path.join(workspaceDir, '.state'), { recursive: true });
    fs.writeFileSync(path.join(workspaceDir, '.state', 'trajectory.db'), '');
    const config = getDefaultPdConfig();
    config.features['host.codex'].enabled = true;
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
    const { handleCodexWorker } = await import('../../src/commands/codex-worker.js');
    await handleCodexWorker({ workspace: workspaceDir, once: true, json: true });
    expect(logSpy).toHaveBeenCalledTimes(1);
    const report = JSON.parse(logSpy.mock.calls[0]?.[0] as string) as { mode: string; reason: string; nextAction: string };
    expect(report.mode).toBe('paused');
    expect(report.reason).toBe('internalization_auto_consumer_disabled');
    expect(report.nextAction).toContain('pd diagnose');
    expect(process.exitCode ?? 0).toBe(0);
  });

  it('--json without --once/--status is refused (continuous mode streams, it is not one JSON document)', async () => {
    const { handleCodexWorker } = await import('../../src/commands/codex-worker.js');
    await handleCodexWorker({ workspace: workspaceDir, json: true });
    expect(logSpy).toHaveBeenCalledTimes(1);
    const error = JSON.parse(logSpy.mock.calls[0]?.[0] as string) as { error: string; reason: string; nextAction: string };
    expect(error.error).toBe('cli_contract');
    expect(error.reason).toBe('json_without_once_or_status');
    expect(error.nextAction).toContain('--once');
    expect(process.exitCode).toBe(1);
  });

  it('--status reports manual_action_required for a workspace absent from the install manifest', async () => {
    const { handleCodexWorker } = await import('../../src/commands/codex-worker.js');
    // Execution enabled — the manifest absence is then the deciding fact.
    const config = getDefaultPdConfig();
    config.features['host.codex'].enabled = true;
    config.features.internalization_auto_consumer.enabled = true;
    fs.writeFileSync(path.join(workspaceDir, '.pd', 'config.yaml'), JSON.stringify(config));
    await handleCodexWorker({ workspace: workspaceDir, status: true, json: true });
    expect(logSpy).toHaveBeenCalledTimes(1);
    const report = JSON.parse(logSpy.mock.calls[0]?.[0] as string) as { mode: string; reason: string; registeredInInstallManifest: boolean; nextAction: string };
    expect(report.mode).toBe('manual_action_required');
    expect(report.reason).toBe('workspace_not_in_install_manifest');
    expect(report.registeredInInstallManifest).toBe(false);
    expect(report.nextAction).toContain('pd codex ingest catch-up');
    expect(process.exitCode ?? 0).toBe(0);
  });
});
