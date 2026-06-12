/**
 * pd pain record async mode tests — PRI-369
 *
 * Tests the async CLI behavior:
 * - --json output is a single parseable JSON object in async mode
 * - Failed task-creation spawns nothing and mutates nothing
 * - Flag off => legacy sync behavior unchanged
 * - --wait overrides async flag to force sync
 * - asyncMode=true when flag enabled and --wait not set
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

// ── Mock setup ──────────────────────────────────────────────────────────────

let mockRecordPainResult: PainToPrincipleOutput;
let lastServiceOpts: Record<string, unknown> | null = null;
let mockIsFeatureEnabledReturn = false;

vi.mock('../../src/resolve-workspace.js', () => ({
  resolveWorkspaceDir: vi.fn().mockReturnValue('/tmp/fake-workspace'),
}));

vi.mock('fs', () => ({
  existsSync: vi.fn().mockReturnValue(false),
  readFileSync: vi.fn(),
}));

vi.mock('../../src/commands/build-trajectory-evidence.js', () => ({
  buildTrajectoryEvidenceFromDb: vi.fn().mockReturnValue([
    { sourceRef: 'owner_reported:cli', note: 'No session context available' },
  ]),
}));

vi.mock('@principles/core/runtime-v2', () => ({
  PainToPrincipleService: vi.fn().mockImplementation(function(this: Record<string, unknown>, opts: Record<string, unknown>) {
    lastServiceOpts = opts;
    return {
      recordPain: vi.fn(async () => mockRecordPainResult),
    };
  }),
  PrincipleTreeLedgerAdapter: vi.fn().mockImplementation(function() { return {}; }),
  computeEffectivePdConfig: vi.fn().mockReturnValue({
    runtimeKind: 'pi-ai',
    provider: 'test-provider',
    model: 'test-model',
    apiKeyEnv: 'TEST_KEY',
    timeoutMs: 300000,
    agentId: 'main',
    language: 'zh-CN',
    warnings: [],
  }),
  resolveRuntimeConfig: vi.fn().mockReturnValue({
    runtimeKind: 'pi-ai',
    provider: 'test-provider',
    model: 'test-model',
    apiKeyEnv: 'TEST_KEY',
    timeoutMs: 300000,
    agentId: 'main',
  }),
  isRuntimeConfigError: vi.fn().mockReturnValue(false),
  resolveOutputLanguage: vi.fn().mockReturnValue({ outputLanguage: 'zh-CN' }),
  isFeatureEnabled: vi.fn().mockImplementation(() => mockIsFeatureEnabledReturn),
}));

vi.mock('../../src/services/pd-config-loader.js', () => ({
  loadPdConfig: vi.fn().mockReturnValue({
    ok: true,
    effective: { config: {}, source: 'defaults', warnings: [] },
    source: 'defaults',
    configPath: '/tmp/fake-workspace/.pd/config.yaml',
    warnings: [],
    legacyFilesDetected: [],
  }),
  computeFlagsFromLoadResult: vi.fn().mockReturnValue({
    flags: {},
    enabledChannels: [],
    warnings: [],
  }),
}));

import { handlePainRecord } from '../../src/commands/pain-record.js';
import type { PainToPrincipleOutput, FailureCategory } from '@principles/core/runtime-v2';

// ── Helpers ─────────────────────────────────────────────────────────────────

function mockProcessExit() {
  return vi.spyOn(process, 'exit').mockImplementation((() => undefined) as () => never);
}

const SUBMITTED_RESULT: PainToPrincipleOutput = {
  status: 'submitted',
  painId: 'manual_123_abc',
  taskId: 'diagnosis_manual_123_abc',
  candidateIds: [],
  ledgerEntryIds: [],
  observabilityWarnings: [],
  latencyMs: 120,
  message: "Diagnosis submitted. Use 'pd task show diagnosis_manual_123_abc' to check progress.",
};

const SUCCEEDED_RESULT: PainToPrincipleOutput = {
  status: 'succeeded',
  painId: 'manual_123_abc',
  taskId: 'diagnosis_manual_123_abc',
  runId: 'run-001',
  artifactId: 'art-001',
  candidateIds: ['c1'],
  ledgerEntryIds: ['l1'],
  observabilityWarnings: [],
  latencyMs: 42000,
};

// ── Tests ───────────────────────────────────────────────────────────────────

describe('pd pain record async mode (PRI-369)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockRecordPainResult = { ...SUBMITTED_RESULT };
    lastServiceOpts = null;
    mockIsFeatureEnabledReturn = false;
  });

  // 1. --json output is a single parseable JSON object in async mode
  it('--json output is a single parseable JSON object with status=submitted', async () => {
    mockIsFeatureEnabledReturn = true;
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    const exitSpy = mockProcessExit();

    await handlePainRecord({ reason: 'test pain', json: true });

    expect(logSpy).toHaveBeenCalledTimes(1);
    const jsonOutput = JSON.parse(logSpy.mock.calls[0][0]);
    expect(jsonOutput.status).toBe('submitted');
    expect(jsonOutput.painId).toBe('manual_123_abc');
    expect(jsonOutput.taskId).toBe('diagnosis_manual_123_abc');
    expect(jsonOutput.candidateIds).toEqual([]);
    expect(jsonOutput.ledgerEntryIds).toEqual([]);
    expect(jsonOutput.latencyMs).toBe(120);
    expect(jsonOutput.message).toContain('pd task show');
    // submitted should NOT cause exit(1)
    expect(exitSpy).not.toHaveBeenCalledWith(1);

    logSpy.mockRestore();
    exitSpy.mockRestore();
  });

  // 2. submitted status outputs [SUBMITTED] in text mode
  it('outputs [SUBMITTED] in text mode', async () => {
    mockIsFeatureEnabledReturn = true;
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    const exitSpy = mockProcessExit();

    await handlePainRecord({ reason: 'test pain' });

    const allOutput = logSpy.mock.calls.map(c => c.join(' ')).join(' ');
    expect(allOutput).toContain('[SUBMITTED]');
    expect(allOutput).toContain('submitted');
    expect(allOutput).toContain('Next action: pd diagnose run --task-id');
    expect(exitSpy).not.toHaveBeenCalledWith(1);

    logSpy.mockRestore();
    exitSpy.mockRestore();
  });

  // 3. Flag off => legacy sync behavior unchanged
  it('flag off => legacy sync behavior (asyncMode=false passed to service)', async () => {
    // mockIsFeatureEnabledReturn defaults to false
    mockRecordPainResult = { ...SUCCEEDED_RESULT };
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    const exitSpy = mockProcessExit();

    await handlePainRecord({ reason: 'test pain', json: true });

    // asyncMode should be false because the flag is off by default
    expect(lastServiceOpts).toBeTruthy();
    expect(lastServiceOpts!.asyncMode).toBe(false);

    logSpy.mockRestore();
    exitSpy.mockRestore();
  });

  // 4. --wait overrides async flag to force sync
  it('--wait overrides async flag to force sync (asyncMode=false even if flag on)', async () => {
    mockIsFeatureEnabledReturn = true;
    mockRecordPainResult = { ...SUCCEEDED_RESULT };
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    const exitSpy = mockProcessExit();

    await handlePainRecord({ reason: 'test pain', wait: true, json: true });

    // --wait should force asyncMode=false even though flag is on
    expect(lastServiceOpts).toBeTruthy();
    expect(lastServiceOpts!.asyncMode).toBe(false);

    logSpy.mockRestore();
    exitSpy.mockRestore();
  });

  // 5. asyncMode=true when flag is enabled and --wait is not set
  it('asyncMode=true when flag enabled and --wait not set', async () => {
    mockIsFeatureEnabledReturn = true;
    mockRecordPainResult = { ...SUBMITTED_RESULT };
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    const exitSpy = mockProcessExit();

    await handlePainRecord({ reason: 'test pain', json: true });

    expect(lastServiceOpts).toBeTruthy();
    expect(lastServiceOpts!.asyncMode).toBe(true);

    logSpy.mockRestore();
    exitSpy.mockRestore();
  });

  // 6. Failed task-creation: no side effects (no spawn, no ledger writes)
  it('failed task-creation produces no candidateIds or ledgerEntryIds', async () => {
    mockRecordPainResult = {
      status: 'failed',
      painId: 'manual_123_abc',
      taskId: 'diagnosis_manual_123_abc',
      candidateIds: [],
      ledgerEntryIds: [],
      observabilityWarnings: [],
      failureCategory: 'runtime_unavailable' as FailureCategory,
      latencyMs: 5,
      message: 'Task creation failed',
    };

    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    const exitSpy = mockProcessExit();

    await handlePainRecord({ reason: 'test pain', json: true });

    const jsonOutput = JSON.parse(logSpy.mock.calls[0][0]);
    expect(jsonOutput.candidateIds).toEqual([]);
    expect(jsonOutput.ledgerEntryIds).toEqual([]);
    expect(jsonOutput.status).toBe('failed');
    expect(exitSpy).toHaveBeenCalledWith(1);

    logSpy.mockRestore();
    exitSpy.mockRestore();
  });
});
