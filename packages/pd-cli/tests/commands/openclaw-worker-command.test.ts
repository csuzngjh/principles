/**
 * PRI-1282 Phase 4 — CLI wiring for `pd openclaw worker` and
 * `pd service handover|rollback` (cli-1/cli-2/cli-6/cli-7: REAL Commander
 * registration, single-JSON contract, fail-closed argument validation).
 *
 * The worker command lazy-imports the plugin subpath; the mock intercepts
 * that specifier so the contract tests never load the plugin bundle. The
 * program object is the module singleton (buildPdProgram), so option values
 * are reset between parses and commander exits are converted to thrown
 * errors via exitOverride (the established service-command test posture).
 */
import { Command } from 'commander';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { buildPdProgram } from '../../src/program.js';

vi.mock('principles-disciple/openclaw-worker', () => ({
  runOpenClawWorkspaceWorkerCycle: vi.fn(async () => ({
    workspaceDir: '/mock/openclaw-ws',
    mode: 'ready',
    report: {
      ownership: { state: 'service_host_owned', generation: 2, source: 'record' },
      declaration: { persisted: true, validated: true },
      downstream: { ran: false, skipReason: 'test' },
      diagnostician: { served: false, status: 'no_candidate' },
    },
  })),
  computeOpenClawWorkerReadiness: vi.fn(() => ({
    mode: 'ready',
    workspaceDir: '/mock/openclaw-ws',
    checks: { workspaceDirectory: true, ownership: true, declaration: true, evidencePort: true, credentials: true },
  })),
}));

let logs: string[];
let errors: string[];
let program: Command;

beforeEach(() => {
  logs = [];
  errors = [];
  process.exitCode = undefined;
  vi.spyOn(console, 'log').mockImplementation((...args: unknown[]) => { logs.push(args.map(String).join(' ')); });
  vi.spyOn(console, 'error').mockImplementation((...args: unknown[]) => { errors.push(args.map(String).join(' ')); });
  program = buildPdProgram();
  program.exitOverride();
  // buildPdProgram() returns the module-level singleton: commander KEEPS
  // parsed option values between parseAsync calls on one instance (a --once
  // parsed by test 1 would leak into every later parse). Reset each option
  // back to its declared default — the established service-command posture.
  const worker = program.commands.find((c) => c.name() === 'openclaw')?.commands.find((c) => c.name() === 'worker');
  for (const opt of worker?.options ?? []) {
    if (opt.long !== undefined) {
      worker?.setOptionValue(opt.long.replace(/^--/, '').replace(/-([a-z])/g, (_m, c: string) => c.toUpperCase()), opt.defaultValue);
    }
  }
});

afterEach(() => {
  vi.restoreAllMocks();
  process.exitCode = undefined;
});

async function run(argv: string[]): Promise<void> {
  // from:'user' — the argv contains NO program name; the first token is the
  // subcommand (the root program's name is not 'pd').
  await program.parseAsync(argv, { from: 'user' });
}

function firstJson(): Record<string, unknown> {
  const line = logs.find((entry) => entry.startsWith('{'));
  expect(line).toBeDefined();
  return JSON.parse(line ?? '{}') as Record<string, unknown>;
}

function findCommand(parent: Command, name: string): Command {
  const found = parent.commands.find((cmd) => cmd.name() === name);
  expect(found, `${name} command must be registered`).toBeDefined();
  return found as Command;
}

describe('pd openclaw worker — registration + contract', () => {
  it('is registered under the openclaw command group with the expected options', () => {
    const worker = findCommand(findCommand(program, 'openclaw'), 'worker');
    expect(worker.options.map((option) => option.long)).toEqual(expect.arrayContaining(['--workspace', '--once', '--readiness', '--json']));
  });

  it('cli-1: --json with --once prints exactly one parseable JSON document', async () => {
    await run(['openclaw', 'worker', '--once', '--json', '--workspace', '/mock/openclaw-ws']);
    expect(logs.filter((line) => line.startsWith('{'))).toHaveLength(1);
    expect(firstJson()).toMatchObject({ mode: 'ready' });
    expect(process.exitCode).toBeUndefined();
  });

  it('refuses --json without --once/--readiness (continuous mode does not exist)', async () => {
    await run(['openclaw', 'worker', '--json', '--workspace', '/mock/openclaw-ws']);
    expect(firstJson()).toMatchObject({ reason: 'json_without_once_or_readiness' });
    expect(process.exitCode).toBe(1);
  });

  it('refuses --once and --readiness together', async () => {
    await run(['openclaw', 'worker', '--once', '--readiness', '--json', '--workspace', '/ws']);
    expect(firstJson()).toMatchObject({ reason: 'once_and_readiness_mutually_exclusive' });
    expect(process.exitCode).toBe(1);
  });

  it('requires an explicit mode (no continuous loop)', async () => {
    await run(['openclaw', 'worker', '--workspace', '/ws']);
    expect(firstJson()).toMatchObject({ reason: 'mode_required' });
    expect(process.exitCode).toBe(1);
  });

  it('readiness prints the no-consume self-check document and stays exit-0 on ready', async () => {
    await run(['openclaw', 'worker', '--readiness', '--json', '--workspace', '/mock/openclaw-ws']);
    const parsed = firstJson() as { mode: string; checks: Record<string, boolean> };
    expect(parsed.mode).toBe('ready');
    expect(parsed.checks.declaration).toBe(true);
    expect(process.exitCode).toBeUndefined();
  });

  it('cli-6: a degraded worker result exits 1 with reason + nextAction', async () => {
    const pluginMock = await import('principles-disciple/openclaw-worker');
    vi.mocked(pluginMock.runOpenClawWorkspaceWorkerCycle).mockResolvedValueOnce({
      workspaceDir: '/mock/openclaw-ws',
      mode: 'degraded',
      reason: 'openclaw_owner_marker_unreadable:install_manifest_missing',
      nextAction: 'Restore the manifest.',
    } as never);
    await run(['openclaw', 'worker', '--once', '--json', '--workspace', '/mock/openclaw-ws']);
    expect(firstJson()).toMatchObject({ mode: 'degraded', reason: expect.stringContaining('owner_marker_unreadable') });
    expect(process.exitCode).toBe(1);
  });
});

describe('pd service handover / rollback — registration', () => {
  it('are registered under the service command group with the expected options', () => {
    const handover = findCommand(findCommand(program, 'service'), 'handover');
    const rollback = findCommand(findCommand(program, 'service'), 'rollback');
    expect(handover.options.map((option) => option.long)).toEqual(expect.arrayContaining(['--workspace', '--pd-home', '--ack-wait-ms', '--abort', '--resume', '--json']));
    expect(rollback.options.map((option) => option.long)).toEqual(expect.arrayContaining(['--workspace', '--pd-home', '--json']));
  });
});
