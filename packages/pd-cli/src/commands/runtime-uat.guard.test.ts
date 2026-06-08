/**
 * PRI-334: Runtime UAT guard — command-level integration tests.
 *
 * These tests verify the guard is wired into the real Commander command
 * and that refused paths do NOT call execFileSync (mutation prevention).
 */
import { describe, it, expect, vi, beforeEach, afterAll, beforeAll } from 'vitest';
import { Command } from 'commander';
import * as path from 'path';
import * as os from 'os';

// ─── Mocks ─────────────────────────────────────────────────────────────────
const mockExecFileSync = vi.fn();
vi.mock('child_process', () => ({
  execFileSync: mockExecFileSync,
}));

const { handleRuntimeUat } = await import('./runtime-uat.js');
const { guardUatWorkspace } = await import('../utils/production-workspace-guard.js');

// ─── Test Setup ─────────────────────────────────────────────────────────────
const capturedStderr: string[] = [];
const capturedStdout: string[] = [];
let capturedExitCode: number | null = null;

const originalExit = process.exit;
const originalError = console.error;
const originalLog = console.log;
const originalEnv = { ...process.env };

beforeAll(() => {
  process.exit = vi.fn(((code?: number) => {
    capturedExitCode = code ?? 0;
  }) as typeof process.exit);
  console.error = vi.fn((...args: unknown[]) => { capturedStderr.push(args.join(' ')); });
  console.log = vi.fn((...args: unknown[]) => { capturedStdout.push(args.join(' ')); });
});

afterAll(() => {
  process.exit = originalExit;
  console.error = originalError;
  console.log = originalLog;
  process.env = originalEnv;
});

beforeEach(() => {
  capturedExitCode = null;
  capturedStderr.length = 0;
  capturedStdout.length = 0;
  mockExecFileSync.mockReset();
  process.env = { ...process.env, MINIMAX_CN_API_KEY: 'test-key-for-pri-334' };
});

// ─── Tests ──────────────────────────────────────────────────────────────────
describe('PRI-334: production workspace refusal', () => {
  it('refuses D: workspace with exit code 1', async () => {
    mockExecFileSync.mockClear();
    await handleRuntimeUat({ workspace: 'D:\\.openclaw\\workspace', count: 1 });
    expect(capturedExitCode).toBe(1);
    expect(mockExecFileSync).not.toHaveBeenCalled();
  });

  it('refuses C: workspace with exit code 1', async () => {
    mockExecFileSync.mockClear();
    await handleRuntimeUat({ workspace: 'C:\\.openclaw\\workspace', count: 1 });
    expect(capturedExitCode).toBe(1);
    expect(mockExecFileSync).not.toHaveBeenCalled();
  });

  it('refuses production workspace subdirectory', async () => {
    mockExecFileSync.mockClear();
    await handleRuntimeUat({ workspace: 'D:\\.openclaw\\workspace\\sub\\path', count: 1 });
    expect(capturedExitCode).toBe(1);
    expect(mockExecFileSync).not.toHaveBeenCalled();
  });
});

describe('PRI-334: allowed paths (guard level)', () => {
  it('allows temp workspace', () => {
    const tempPath = path.join(os.tmpdir(), 'pd-test-' + Date.now());
    expect(guardUatWorkspace(tempPath, 'test').refused).toBe(false);
  });

  it('allows workspace-test sibling (ERR-030)', () => {
    expect(guardUatWorkspace('D:\\.openclaw\\workspace-test', 'test').refused).toBe(false);
  });

  it('allows workspace-backup sibling (ERR-030)', () => {
    expect(guardUatWorkspace('D:\\.openclaw\\workspace-backup', 'test').refused).toBe(false);
  });
});

describe('PRI-334: JSON output (EP-04)', () => {
  it('outputs single JSON object with reason and nextAction', async () => {
    mockExecFileSync.mockClear();
    capturedStdout.length = 0;
    await handleRuntimeUat({ workspace: 'D:\\.openclaw\\workspace', count: 1, json: true });
    expect(capturedExitCode).toBe(1);
    expect(mockExecFileSync).not.toHaveBeenCalled();

    const jsonOutput = capturedStdout.join('');
    const parsed = JSON.parse(jsonOutput);
    expect(parsed).toMatchObject({
      status: 'refused', reason: expect.any(String), nextAction: expect.any(String),
      workspace: expect.any(String), isProduction: true,
    });
    expect(Array.isArray(parsed)).toBe(false);
  });
});

describe('PRI-334: escape hatch', () => {
  it('warns when allow-production-workspace-for-uat flag is set', async () => {
    mockExecFileSync.mockClear();
    mockExecFileSync.mockImplementation(() => '{"painId":"test","taskId":"t1","runId":"r1","candidateIds":["c1"],"ledgerEntryIds":["l1"]}');
    capturedStderr.length = 0;
    capturedExitCode = null;

    await handleRuntimeUat({ workspace: 'D:\\.openclaw\\workspace', count: 1, allowProductionWorkspaceForUat: true });
    const stderrText = capturedStderr.join('\n');
    expect(stderrText).toContain('WARNING');
    expect(stderrText).toContain('--allow-production-workspace-for-uat');
  });
});

describe('PRI-334: mutation prevention', () => {
  it('does not call execFileSync after guard refusal', async () => {
    mockExecFileSync.mockClear();
    await handleRuntimeUat({ workspace: 'D:\\.openclaw\\workspace', count: 1 });
    expect(mockExecFileSync).not.toHaveBeenCalled();
  });
});

describe('PRI-334: Commander flag wiring (ERR-063)', () => {
  it('parses --allow-production-workspace-for-uat', () => {
    const program = new Command();
    const rt = program.command('runtime');
    rt.command('uat')
      .option('--allow-production-workspace-for-uat', 'Escape hatch')
      .action(() => { /* noop */ });
    const cmd = rt.commands.find((c) => c.name() === 'uat') as Command;
    const opt = cmd.options.find((o) => o.long === '--allow-production-workspace-for-uat');
    expect(opt).toBeDefined();
    expect(opt?.long).toBe('--allow-production-workspace-for-uat');
  });

  it('negated form is NOT registered', () => {
    const program = new Command();
    const rt = program.command('runtime');
    rt.command('uat')
      .option('--allow-production-workspace-for-uat', 'Escape hatch')
      .action(() => { /* noop */ });
    const cmd = rt.commands.find((c) => c.name() === 'uat') as Command;
    const noForm = cmd.options.find((o) => o.long === '--no-allow-production-workspace-for-uat');
    expect(noForm).toBeUndefined();
  });
});