/**
 * pd pain record command unit tests.
 *
 * Tests the CLI adapter layer: validation, service delegation, output formatting.
 * PainToPrincipleService is mocked — its own contract is tested separately.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

// ── Mock setup ──────────────────────────────────────────────────────────────

let mockRecordPainResult: PainToPrincipleOutput;
let lastRecordPainInput: PainToPrincipleInput | null = null;

vi.mock('../../src/resolve-workspace.js', () => ({
  resolveWorkspaceDir: vi.fn().mockReturnValue('/tmp/fake-workspace'),
}));

vi.mock('@principles/core/runtime-v2', () => ({
  PainToPrincipleService: vi.fn().mockImplementation(function() {
    return {
      recordPain: vi.fn(async (input: PainToPrincipleInput) => {
        lastRecordPainInput = input;
        return mockRecordPainResult;
      }),
    };
  }),
  PrincipleTreeLedgerAdapter: vi.fn().mockImplementation(function() { return {}; }),
  resolveRuntimeConfig: vi.fn().mockReturnValue({
    runtimeKind: 'pi-ai',
    provider: 'test-provider',
    model: 'test-model',
    apiKeyEnv: 'TEST_KEY',
    timeoutMs: 300000,
    agentId: 'main',
  }),
}));

import { handlePainRecord } from '../../src/commands/pain-record.js';
import type { PainToPrincipleOutput, PainToPrincipleInput, FailureCategory } from '@principles/core/runtime-v2';

// ── Helpers ─────────────────────────────────────────────────────────────────

function mockProcessExit() {
  return vi.spyOn(process, 'exit').mockImplementation((() => undefined) as () => never);
}

const SUCCEEDED_RESULT: PainToPrincipleOutput = {
  status: 'succeeded',
  painId: 'manual_123_abc',
  taskId: 'diagnosis_manual_123_abc',
  runId: 'run-001',
  artifactId: 'art-001',
  candidateIds: ['c1'],
  ledgerEntryIds: ['l1'],
  observabilityWarnings: [],
  latencyMs: 42,
};

function makeFailedResult(overrides?: Partial<PainToPrincipleOutput>): PainToPrincipleOutput {
  return {
    status: 'failed',
    painId: 'manual_123_abc',
    taskId: 'diagnosis_manual_123_abc',
    candidateIds: [],
    ledgerEntryIds: [],
    message: 'something went wrong',
    observabilityWarnings: [],
    failureCategory: 'runtime_unavailable' as FailureCategory,
    latencyMs: 10,
    ...overrides,
  };
}

function makeSkippedResult(overrides?: Partial<PainToPrincipleOutput>): PainToPrincipleOutput {
  return {
    status: 'skipped',
    painId: 'manual_123_abc',
    taskId: 'diagnosis_manual_123_abc',
    candidateIds: [],
    ledgerEntryIds: [],
    message: 'already leased',
    observabilityWarnings: [],
    latencyMs: 5,
    ...overrides,
  };
}

// ── Tests ───────────────────────────────────────────────────────────────────

describe('pd pain record', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockRecordPainResult = { ...SUCCEEDED_RESULT };
    lastRecordPainInput = null;
  });

  // 1. --reason required
  it('exits 1 when --reason is missing', async () => {
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const exitSpy = mockProcessExit();

    await handlePainRecord({ reason: undefined });

    expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining('--reason'));
    expect(exitSpy).toHaveBeenCalledWith(1);

    errorSpy.mockRestore();
    exitSpy.mockRestore();
  });

  // 2. --score out of range
  it('exits 1 when --score is out of range', async () => {
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const exitSpy = mockProcessExit();

    await handlePainRecord({ reason: 'test', score: 150 });

    expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining('--score'));
    expect(exitSpy).toHaveBeenCalledWith(1);

    errorSpy.mockRestore();
    exitSpy.mockRestore();
  });

  // 3. Happy path --json output
  it('outputs JSON with all fields on success (--json)', async () => {
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    const exitSpy = mockProcessExit();

    await handlePainRecord({ reason: 'test pain', json: true });

    expect(logSpy).toHaveBeenCalled();
    const jsonOutput = JSON.parse(logSpy.mock.calls[0][0]);
    expect(jsonOutput.status).toBe('succeeded');
    expect(jsonOutput.painId).toBe('manual_123_abc');
    expect(jsonOutput.taskId).toBe('diagnosis_manual_123_abc');
    expect(jsonOutput.runId).toBe('run-001');
    expect(jsonOutput.artifactId).toBe('art-001');
    expect(jsonOutput.candidateIds).toEqual(['c1']);
    expect(jsonOutput.ledgerEntryIds).toEqual(['l1']);
    expect(jsonOutput.observabilityWarnings).toEqual([]);
    expect(jsonOutput.latencyMs).toBe(42);
    expect(exitSpy).not.toHaveBeenCalledWith(1);

    logSpy.mockRestore();
    exitSpy.mockRestore();
  });

  // 4. Happy path text output
  it('outputs human-readable summary on success (text)', async () => {
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    const exitSpy = mockProcessExit();

    await handlePainRecord({ reason: 'test pain' });

    expect(logSpy).toHaveBeenCalledWith(expect.stringContaining('[OK]'));
    expect(logSpy).toHaveBeenCalledWith(expect.stringContaining('manual_123_abc'));
    expect(exitSpy).not.toHaveBeenCalledWith(1);

    logSpy.mockRestore();
    exitSpy.mockRestore();
  });

  // 5. Failed exits 1 with --json
  it('exits 1 on failed status (--json)', async () => {
    mockRecordPainResult = makeFailedResult();
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    const exitSpy = mockProcessExit();

    await handlePainRecord({ reason: 'test pain', json: true });

    const jsonOutput = JSON.parse(logSpy.mock.calls[0][0]);
    expect(jsonOutput.status).toBe('failed');
    expect(exitSpy).toHaveBeenCalledWith(1);

    logSpy.mockRestore();
    exitSpy.mockRestore();
  });

  // 6. Failed exits 1 (text)
  it('exits 1 on failed status (text)', async () => {
    mockRecordPainResult = makeFailedResult();
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const exitSpy = mockProcessExit();

    await handlePainRecord({ reason: 'test pain' });

    const firstErrorArg = errorSpy.mock.calls[0]?.[0] ?? '';
    expect(firstErrorArg).toContain('[FAIL]');
    expect(exitSpy).toHaveBeenCalledWith(1);

    errorSpy.mockRestore();
    exitSpy.mockRestore();
  });

  // 7. config_missing shows diagnostic guidance
  it('shows diagnostic guidance on config_missing failure', async () => {
    mockRecordPainResult = makeFailedResult({
      failureCategory: 'config_missing' as FailureCategory,
      message: 'API key not found in env',
    });
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const exitSpy = mockProcessExit();

    await handlePainRecord({ reason: 'test pain' });

    const allErrorOutput = errorSpy.mock.calls.map(c => c.join(' ')).join('\n');
    expect(allErrorOutput).toContain('Error: Pain signal failed');
    expect(exitSpy).toHaveBeenCalledWith(1);

    errorSpy.mockRestore();
    exitSpy.mockRestore();
  });

  // 8. skipped status outputs [SKIP] and does not exit 1
  it('outputs [SKIP] on skipped status (text)', async () => {
    mockRecordPainResult = makeSkippedResult();
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    const exitSpy = mockProcessExit();

    await handlePainRecord({ reason: 'test pain' });

    const allOutput = logSpy.mock.calls.map(c => c.join(' ')).join(' ');
    expect(allOutput).toContain('[SKIP]');
    expect(exitSpy).not.toHaveBeenCalledWith(1);

    logSpy.mockRestore();
    exitSpy.mockRestore();
  });

  // 9. skipped status with --json does not exit 1
  it('outputs skipped status in JSON without exit 1', async () => {
    mockRecordPainResult = makeSkippedResult();
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    const exitSpy = mockProcessExit();

    await handlePainRecord({ reason: 'test pain', json: true });

    const jsonOutput = JSON.parse(logSpy.mock.calls[0][0]);
    expect(jsonOutput.status).toBe('skipped');
    expect(exitSpy).not.toHaveBeenCalledWith(1);

    logSpy.mockRestore();
    exitSpy.mockRestore();
  });

  // 10. recordPain called with correct arguments
  it('passes correct arguments to recordPain', async () => {
    await handlePainRecord({ reason: 'test pain', score: 90, source: 'ci' });

    expect(lastRecordPainInput).toBeTruthy();
    expect(lastRecordPainInput!.painType).toBe('user_frustration');
    expect(lastRecordPainInput!.source).toBe('ci');
    expect(lastRecordPainInput!.reason).toBe('test pain');
    expect(lastRecordPainInput!.score).toBe(90);
    expect(lastRecordPainInput!.sessionId).toBe('cli');
    expect(lastRecordPainInput!.agentId).toBe('pd-cli');
  });
});
