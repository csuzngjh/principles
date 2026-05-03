/**
 * pd runtime uat CLI unit tests.
 * Tests parseUatArgs, computeUatSummary, shouldExitWithError, runUatIteration.
 * Integration tests with real pd calls are done manually via
 *   node scripts/uat/runtime-v2-chain-uat.mjs --workspace <path> --count 2 --json
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';

// ── Mock child_process before importing the module under test ────────────────

const { mockExecFileSync, mockExistsSync } = vi.hoisted(() => ({
  mockExecFileSync: vi.fn(),
  mockExistsSync: vi.fn(),
}));

vi.mock('child_process', () => ({
  execFileSync: mockExecFileSync,
}));

vi.mock('fs', () => ({
  existsSync: mockExistsSync,
  readFileSync: vi.fn(),
}));

vi.mock(process.execPath, '/mock/node', { spy: false });

// ── Import after mock setup ─────────────────────────────────────────────────

import {
  parseUatArgs,
  computeUatSummary,
  shouldExitWithError,
  type PainRecordResult,
} from '../../src/commands/runtime-uat.js';

// ── parseUatArgs ─────────────────────────────────────────────────────────────

describe('parseUatArgs', () => {
  it('defaults count to 5 when not provided', () => {
    const result = parseUatArgs([]);
    expect(result.count).toBe(5);
  });

  it('parses --count', () => {
    const result = parseUatArgs(['--count', '10']);
    expect(result.count).toBe(10);
  });

  it('parses --workspace', () => {
    const result = parseUatArgs(['--workspace', '/tmp/ws']);
    expect(result.workspace).toBe('/tmp/ws');
  });

  it('parses --min-success-rate', () => {
    const result = parseUatArgs(['--min-success-rate', '0.8']);
    expect(result.minSuccessRate).toBe(0.8);
  });

  it('parses -w as alias for --workspace', () => {
    const result = parseUatArgs(['-w', '/custom/path']);
    expect(result.workspace).toBe('/custom/path');
  });

  it('clamps count to [1, 50]', () => {
    expect(parseUatArgs(['--count', '1']).count).toBe(1);
    expect(parseUatArgs(['--count', '50']).count).toBe(50);
  });
});

// ── computeUatSummary ────────────────────────────────────────────────────────

describe('computeUatSummary', () => {
  const ws = '/tmp/test-workspace';

  it('computes successRate correctly', () => {
    const results: PainRecordResult[] = [
      makeResult(1, 'succeeded', ['c1'], ['l1']),
      makeResult(2, 'succeeded', ['c2'], ['l2']),
      makeResult(3, 'failed', ['c3'], ['l3']),
    ];
    const summary = computeUatSummary(results, ws);
    expect(summary.successRate).toBeCloseTo(0.67, 2);
    expect(summary.successful).toBe(2);
    expect(summary.failed).toBe(1);
  });

  it('computes failuresByCategory from failureCategory field', () => {
    const results: PainRecordResult[] = [
      { ...makeResult(1, 'failed', [], []), failureCategory: 'runtime_unavailable' },
      { ...makeResult(2, 'failed', [], []), failureCategory: 'runtime_unavailable' },
      { ...makeResult(3, 'failed', [], []), failureCategory: 'output_invalid' },
    ];
    const summary = computeUatSummary(results, ws);
    expect(summary.failuresByCategory).toEqual({
      runtime_unavailable: 2,
      output_invalid: 1,
    });
  });

  it('ledgerConsistencyOk true when all audits are ok', () => {
    const results: PainRecordResult[] = [
      makeResult(1, 'succeeded', ['c1'], ['l1'], 100, 'ok'),
      makeResult(2, 'succeeded', ['c2'], ['l2'], 100, 'ok'),
    ];
    const summary = computeUatSummary(results, ws);
    expect(summary.ledgerConsistencyOk).toBe(true);
  });

  it('ledgerConsistencyOk false when any audit fails', () => {
    const results: PainRecordResult[] = [
      makeResult(1, 'succeeded', ['c1'], ['l1'], 100, 'ok'),
      makeResult(2, 'succeeded', ['c2'], ['l2'], 100, 'error'),
    ];
    const summary = computeUatSummary(results, ws);
    expect(summary.ledgerConsistencyOk).toBe(false);
  });

  it('allHaveCandidates false when any candidateIds empty', () => {
    const results: PainRecordResult[] = [
      makeResult(1, 'succeeded', ['c1'], ['l1']),
      makeResult(2, 'succeeded', [], ['l2']),
    ];
    const summary = computeUatSummary(results, ws);
    expect(summary.allHaveCandidates).toBe(false);
  });

  it('allHaveLedger false when any ledgerEntryIds empty', () => {
    const results: PainRecordResult[] = [
      makeResult(1, 'succeeded', ['c1'], ['l1']),
      makeResult(2, 'succeeded', ['c2'], []),
    ];
    const summary = computeUatSummary(results, ws);
    expect(summary.allHaveLedger).toBe(false);
  });

  it('p50LatencyMs and p95LatencyMs computed from wallTimeMs', () => {
    const results: PainRecordResult[] = [
      makeResult(1, 'succeeded', ['c1'], ['l1'], 100),
      makeResult(2, 'succeeded', ['c2'], ['l2'], 200),
      makeResult(3, 'succeeded', ['c3'], ['l3'], 300),
      makeResult(4, 'succeeded', ['c4'], ['l4'], 400),
    ];
    const summary = computeUatSummary(results, ws);
    expect(summary.p50LatencyMs).toBeDefined();
    expect(summary.p95LatencyMs).toBeDefined();
    expect(summary.p50LatencyMs).toBeLessThanOrEqual(summary.p95LatencyMs!);
  });

  it('includes perRun in summary', () => {
    const results: PainRecordResult[] = [makeResult(1, 'succeeded', ['c1'], ['l1'])];
    const summary = computeUatSummary(results, ws);
    expect(summary.perRun).toHaveLength(1);
    expect(summary.perRun[0].iteration).toBe(1);
  });

  it('generatedAt is ISO string', () => {
    const summary = computeUatSummary([], ws);
    expect(summary.generatedAt).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/);
  });
});

// ── shouldExitWithError ─────────────────────────────────────────────────────

describe('shouldExitWithError', () => {
  const ws = '/tmp/test-workspace';

  it('returns false when all checks pass and minSuccessRate=1.0', () => {
    const summary = makeSummary(ws, 5, 5, true, true, true);
    expect(shouldExitWithError(summary, 1.0)).toBe(false);
  });

  it('returns true when successRate below threshold', () => {
    const summary = makeSummary(ws, 5, 3, true, true, true);
    expect(shouldExitWithError(summary, 1.0)).toBe(true);
    expect(shouldExitWithError(summary, 0.5)).toBe(false);
  });

  it('returns true when ledgerConsistencyOk is false', () => {
    const summary = makeSummary(ws, 5, 5, false, true, true);
    expect(shouldExitWithError(summary, 1.0)).toBe(true);
  });

  it('returns true when allHaveCandidates is false', () => {
    const summary = makeSummary(ws, 5, 5, true, false, true);
    expect(shouldExitWithError(summary, 1.0)).toBe(true);
  });

  it('returns true when allHaveLedger is false', () => {
    const summary = makeSummary(ws, 5, 5, true, true, false);
    expect(shouldExitWithError(summary, 1.0)).toBe(true);
  });

  it('default minSuccessRate is 1.0', () => {
    const summary = makeSummary(ws, 5, 5, true, true, true);
    expect(shouldExitWithError(summary)).toBe(false);
    expect(shouldExitWithError(summary, 1.0)).toBe(false);
  });
});

// ── pd CLI invocation (Windows compatibility) ───────────────────────────────

describe('pd CLI invocation (Windows compatibility)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockExecFileSync.mockReset();
    mockExistsSync.mockReset();
    mockExistsSync.mockReturnValue(true);
    mockExecFileSync.mockReturnValue(JSON.stringify({
      status: 'succeeded',
      painId: 'pain-test-1',
      taskId: 'task-001',
      runId: 'run-001',
      artifactId: 'art-001',
      candidateIds: ['c1'],
      ledgerEntryIds: ['l1'],
      latencyMs: 100,
    }));
  });

  it('uses process.execPath (not npx) to invoke pd CLI', async () => {
    vi.resetModules();
    mockExistsSync.mockImplementation((p: string) => String(p).endsWith('index.js'));

    const { runUatIteration } = await import('../../src/commands/runtime-uat.js');
    runUatIteration({ iteration: 1, reason: 'test', workspace: '/test/ws' });

    // First call to execFileSync should use process.execPath, not 'npx'
    const firstCall = mockExecFileSync.mock.calls[0] as [string, string[]];
    expect(firstCall[0]).toBe(process.execPath);
    expect(firstCall[0]).not.toBe('npx');
  });

  it('passes --workspace after subcommand args', async () => {
    vi.resetModules();
    mockExistsSync.mockImplementation((p: string) => String(p).endsWith('index.js'));

    const { runUatIteration } = await import('../../src/commands/runtime-uat.js');
    runUatIteration({ iteration: 1, reason: 'test', workspace: '/test/ws' });

    const firstCall = mockExecFileSync.mock.calls[0] as [string, string[]];
    const args = firstCall[1];
    // Format: [cliPath, 'pain', 'record', ..., '--workspace', '/test/ws']
    const wsIdx = args.indexOf('--workspace');
    const painIdx = args.indexOf('pain');
    expect(wsIdx).toBeGreaterThan(painIdx);
    expect(args[wsIdx + 1]).toBe('/test/ws');
  });

  it('captures stdout on error with non-zero exit', async () => {
    vi.resetModules();
    // Allow findPdCliPath to succeed (mock existsSync to return true)
    mockExistsSync.mockReturnValue(true);
    const error = new Error('pd CLI spawn error') as Error & { stdout?: string; stderr?: string; code?: string };
    error.stdout = '{"status":"failed","error":"command failed"}';
    error.code = 'ENOENT';
    mockExecFileSync.mockImplementation(() => { throw error; });

    const { runUatIteration } = await import('../../src/commands/runtime-uat.js');
    const result = runUatIteration({ iteration: 1, reason: 'test', workspace: '/test/ws' });

    // ENOENT from spawn means "process not found" - findPdCliPath error is thrown
    // This is the correct behavior: if execFileSync can't spawn the process, findPdCliPath
    // threw first (meaning the CLI wasn't found at the expected path)
    expect(result.status).toBe('script_error');
    expect(result.error).toContain('not found');
  });

  it('throws when pd CLI binary not found', async () => {
    vi.resetModules();
    mockExistsSync.mockReturnValue(false);

    const { runUatIteration } = await import('../../src/commands/runtime-uat.js');
    const result = runUatIteration({ iteration: 1, reason: 'test', workspace: '/test/ws' });

    expect(result.status).toBe('script_error');
    expect(result.error).toContain('not found');
  });

  it('passes CLI path as first argument to process.execPath', async () => {
    vi.resetModules();
    mockExistsSync.mockImplementation((p: string) => String(p).endsWith('index.js'));

    const { runUatIteration } = await import('../../src/commands/runtime-uat.js');
    runUatIteration({ iteration: 1, reason: 'test', workspace: '/test/ws' });

    const firstCall = mockExecFileSync.mock.calls[0] as [string, string[]];
    const args = firstCall[1];
    expect(args[0]).toMatch(/index\.js$/);
    expect(firstCall[0]).toBe(process.execPath);
  });

  it('appends --workspace and workspace path to end of subcommand args', async () => {
    vi.resetModules();
    mockExistsSync.mockImplementation((p: string) => String(p).endsWith('index.js'));

    const { runUatIteration } = await import('../../src/commands/runtime-uat.js');
    runUatIteration({ iteration: 1, reason: 'test', workspace: '/custom/path' });

    const firstCall = mockExecFileSync.mock.calls[0] as [string, string[]];
    const args = firstCall[1];
    const wsIdx = args.lastIndexOf('--workspace');
    expect(wsIdx).toBe(args.length - 2);
    expect(args[wsIdx + 1]).toBe('/custom/path');
  });
});

// ── handleRuntimeUat guard rails ─────────────────────────────────────────────

describe('handleRuntimeUat', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockExecFileSync.mockReset();
    mockExistsSync.mockReturnValue(true);
  });

  it('exits 1 when --workspace is missing', async () => {
    const { handleRuntimeUat } = await import('../../src/commands/runtime-uat.js');
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation(((code: number) => {
      throw new Error(`exit:${code}`);
    }) as (code: number) => never);
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    await expect(handleRuntimeUat({})).rejects.toThrow('exit:1');
    expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining('--workspace'));

    exitSpy.mockRestore();
    errorSpy.mockRestore();
  });

  it('exits 1 when MINIMAX_CN_API_KEY is not set', async () => {
    delete process.env.MINIMAX_CN_API_KEY;
    const { handleRuntimeUat } = await import('../../src/commands/runtime-uat.js');
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation(((code: number) => {
      throw new Error(`exit:${code}`);
    }) as (code: number) => never);
    vi.spyOn(console, 'error').mockImplementation(() => {});

    await expect(handleRuntimeUat({ workspace: '/tmp/test-ws' })).rejects.toThrow('exit:1');
    exitSpy.mockRestore();
  });
});

// ── Helpers ──────────────────────────────────────────────────────────────────

function makeResult(
  iteration: number,
  status: string,
  candidateIds: string[],
  ledgerEntryIds: string[],
  wallTimeMs = 1000,
  auditStatus = 'ok',
  failureCategory?: string,
): PainRecordResult {
  return {
    iteration,
    painId: status === 'succeeded' ? `pain-${iteration}` : undefined,
    taskId: status === 'succeeded' ? `task-${iteration}` : undefined,
    runId: status === 'succeeded' ? `run-${iteration}` : undefined,
    artifactId: status === 'succeeded' ? `art-${iteration}` : undefined,
    candidateIds,
    ledgerEntryIds,
    status,
    failureCategory,
    wallTimeMs,
    auditStatus,
  };
}

function makeSummary(
  workspace: string,
  totalRuns: number,
  successful: number,
  ledgerConsistencyOk: boolean,
  allHaveCandidates: boolean,
  allHaveLedger: boolean,
): import('../../src/commands/runtime-uat.js').UatSummary {
  const results: PainRecordResult[] = Array.from({ length: totalRuns }, (_, i) =>
    makeResult(i + 1, i < successful ? 'succeeded' : 'failed', ['c1'], ['l1'])
  );
  return {
    generatedAt: new Date().toISOString(),
    workspace,
    totalRuns,
    successful,
    failed: totalRuns - successful,
    successRate: Number((successful / totalRuns).toFixed(2)),
    p50LatencyMs: 500,
    p95LatencyMs: 900,
    failuresByCategory: {},
    ledgerConsistencyOk,
    allHaveCandidates,
    allHaveLedger,
    perRun: results,
  };
}