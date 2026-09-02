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

vi.mock('fs', () => ({
  existsSync: vi.fn().mockReturnValue(false),
  readFileSync: vi.fn(),
}));

vi.mock('../../src/commands/build-trajectory-evidence.js', () => ({
  buildTrajectoryEvidenceFromDb: vi.fn().mockReturnValue([
    { sourceRef: 'owner_reported:cli', note: 'No session context available' },
  ]),
  acquireTrajectoryEvidenceFromDb: vi.fn().mockReturnValue({
    status: 'available',
    entries: [
      { sourceRef: 'owner_message:2026-01-01T10:00:00Z', note: 'Owner correction' },
      { sourceRef: 'agent_turn:2026-01-01T10:01:00Z', note: 'assistant evidence' },
    ],
  }),
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
  isBuiltinPiAiProvider: vi.fn().mockReturnValue(true),
  resolveOutputLanguage: vi.fn().mockReturnValue({ outputLanguage: 'zh-CN' }),
  isFeatureEnabled: vi.fn().mockReturnValue(false),
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
import { isBuiltinPiAiProvider, type PainToPrincipleOutput, type PainToPrincipleInput } from '@principles/core/runtime-v2';
import type { FailureCategory } from '@principles/core/runtime-v2';
import { acquireTrajectoryEvidenceFromDb } from '../../src/commands/build-trajectory-evidence.js';

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

  // 7a. config_missing with RuntimeConfigError exits non-zero (text)
  it('exits 1 on config_missing with RuntimeConfigError (text)', async () => {
    mockRecordPainResult = makeFailedResult({
      failureCategory: 'config_missing' as FailureCategory,
      message: 'API key not found in env',
    });
    const { isRuntimeConfigError, resolveRuntimeConfig } = await import('@principles/core/runtime-v2');
    vi.mocked(isRuntimeConfigError).mockReturnValueOnce(true);
    vi.mocked(resolveRuntimeConfig).mockReturnValueOnce({
      ok: false,
      reason: 'missing_openclaw_mode',
      message: 'runtimeKind is openclaw-cli but no mode specified',
      nextAction: 'Provide exactly one mode',
    });
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const exitSpy = mockProcessExit();

    await handlePainRecord({ reason: 'test pain' });

    expect(exitSpy).toHaveBeenCalledWith(1);

    errorSpy.mockRestore();
    exitSpy.mockRestore();
  });

  // 7b. config_missing with RuntimeConfigError outputs JSON (--json)
  it('outputs JSON with configError on config_missing + RuntimeConfigError (--json)', async () => {
    mockRecordPainResult = makeFailedResult({
      failureCategory: 'config_missing' as FailureCategory,
      message: 'API key not found in env',
    });
    const { isRuntimeConfigError, resolveRuntimeConfig } = await import('@principles/core/runtime-v2');
    vi.mocked(isRuntimeConfigError).mockReturnValueOnce(true);
    vi.mocked(resolveRuntimeConfig).mockReturnValueOnce({
      ok: false,
      reason: 'missing_openclaw_mode',
      message: 'runtimeKind is openclaw-cli but no mode specified',
      nextAction: 'Provide exactly one mode',
    });
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    const exitSpy = mockProcessExit();

    await handlePainRecord({ reason: 'test pain', json: true });

    const jsonOutput = JSON.parse(logSpy.mock.calls[0][0]);
    expect(jsonOutput.status).toBe('failed');
    expect(jsonOutput.failureCategory).toBe('config_missing');
    expect(jsonOutput.configError).toBeDefined();
    expect(jsonOutput.configError.reason).toBe('missing_openclaw_mode');
    expect(jsonOutput.configError.nextAction).toBe('Provide exactly one mode');
    expect(exitSpy).toHaveBeenCalledWith(1);

    logSpy.mockRestore();
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
    // PRI-642: no --session means an explicit unbound Owner report — the
    // 'cli' sentinel session must NOT be fabricated (SPEC §7.4).
    expect(lastRecordPainInput!.sessionId).toBeUndefined();
    expect(lastRecordPainInput!.agentId).toBe('pd-cli');
    // …and no placeholder evidence entry may be submitted.
    expect(lastRecordPainInput!.evidence).toEqual([]);
    expect(lastRecordPainInput!.recordObservability).toBe(false);
    expect(lastRecordPainInput!.provenance).toBe('owner_reported_no_host_trace');
  });

  // ── PRI-341 → PRI-642: evidence passthrough and --session flag ─────────────

  // 用例 C: recordPain receives bound provenance + validated evidence when a real session is provided
  it('C: passes bound provenance and evidence to recordPain when --session resolves available', async () => {
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    const exitSpy = mockProcessExit();

    await handlePainRecord({ reason: 'test pain', session: 'sess-123', json: true });

    expect(lastRecordPainInput).toBeTruthy();
    expect(acquireTrajectoryEvidenceFromDb).toHaveBeenCalled();
    expect(lastRecordPainInput!.evidence).toBeTruthy();
    expect(lastRecordPainInput!.evidence!.length).toBeGreaterThan(0);
    expect(lastRecordPainInput!.evidence![0].sourceRef).not.toBe('owner_reported:cli');
    expect(lastRecordPainInput!.sessionId).toBe('sess-123');
    // SPEC §7.3: provenance must be derived from the validated result —
    // a real session is host-context-bound, never owner_reported_no_host_trace.
    expect(lastRecordPainInput!.provenance).toBe('host_context_bound');
    // PRI-640/SPEC §8.3: the bound path attributes the OpenClaw trajectory.
    expect(lastRecordPainInput!.hostKind).toBe('openclaw');
    expect(lastRecordPainInput!.recordObservability).toBe(true);

    logSpy.mockRestore();
    exitSpy.mockRestore();
  });

  // 用例 C2 (PRI-642 rewrite): without session, no sentinel session, no
  // placeholder evidence — an honest unbound Owner report (SPEC §7.4).
  it('C2: submits an honest unbound report when no --session provided', async () => {
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    const exitSpy = mockProcessExit();

    await handlePainRecord({ reason: 'test pain', json: true });

    expect(lastRecordPainInput).toBeTruthy();
    expect(lastRecordPainInput!.sessionId).toBeUndefined();
    expect(lastRecordPainInput!.evidence).toEqual([]);
    expect(lastRecordPainInput!.recordObservability).toBe(false);
    expect(lastRecordPainInput!.provenance).toBe('owner_reported_no_host_trace');

    const jsonOutput = JSON.parse(logSpy.mock.calls[0][0]);
    // SPEC §7.4: disclose context_unbound and recommend --session.
    const warnings = JSON.stringify(jsonOutput);
    expect(warnings).toMatch(/context_unbound/);
    expect(warnings).toMatch(/--session/);

    logSpy.mockRestore();
    exitSpy.mockRestore();
  });

  // ── PRI-642 Scope A: explicit-session validation (SPEC §7.3, §12.1.3–12.1.4) ─

  it('fails with session_not_found before any task/candidate mutation when --session does not exist', async () => {
    vi.mocked(acquireTrajectoryEvidenceFromDb).mockReturnValueOnce({
      status: 'unavailable',
      reasonCode: 'session_not_found',
      detail: 'session not present in trajectory.db sessions table',
    } as any);
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const exitSpy = mockProcessExit();

    await handlePainRecord({ reason: 'test pain', session: 'missing-session', json: true });

    // cli-1: exactly one JSON object on stdout
    expect(logSpy).toHaveBeenCalledTimes(1);
    const jsonOutput = JSON.parse(logSpy.mock.calls[0][0]);
    expect(jsonOutput.status).toBe('failed');
    expect(jsonOutput.reason).toBe('session_not_found');
    expect(jsonOutput.nextAction).toBeTruthy();
    // cli-2/cli-5: execution stopped — no service mutation, exit 1
    expect(lastRecordPainInput).toBeNull();
    expect(exitSpy).toHaveBeenCalledWith(1);

    logSpy.mockRestore();
    errorSpy.mockRestore();
    exitSpy.mockRestore();
  });

  it('fails before mutation on session_not_found even when process.exit is stubbed to a no-op', async () => {
    vi.mocked(acquireTrajectoryEvidenceFromDb).mockReturnValueOnce({
      status: 'unavailable',
      reasonCode: 'session_not_found',
      detail: 'session not present',
    } as any);
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    const exitSpy = mockProcessExit();

    await handlePainRecord({ reason: 'test pain', session: 'missing-session', json: true });

    // cli-2: with process.exit stubbed, control flow must still stop —
    // recordPain was never invoked and stdout carries exactly one object.
    expect(lastRecordPainInput).toBeNull();
    expect(logSpy).toHaveBeenCalledTimes(1);
    logSpy.mockRestore();
    exitSpy.mockRestore();
  });

  it('fails/degrades with a structured reason when the trajectory DB is unreadable', async () => {
    vi.mocked(acquireTrajectoryEvidenceFromDb).mockReturnValueOnce({
      status: 'unavailable',
      reasonCode: 'evidence_read_failed',
      detail: 'trajectory.db unreadable',
    } as any);
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    const exitSpy = mockProcessExit();

    await handlePainRecord({ reason: 'test pain', session: 'sess-x', json: true });

    const jsonOutput = JSON.parse(logSpy.mock.calls[0][0]);
    expect(jsonOutput.status).toBe('failed');
    expect(jsonOutput.reason).toBe('evidence_read_failed');
    expect(lastRecordPainInput).toBeNull();
    expect(exitSpy).toHaveBeenCalledWith(1);

    logSpy.mockRestore();
    exitSpy.mockRestore();
  });

  it('reports empty_trajectory explicitly when the session exists but has no usable evidence', async () => {
    vi.mocked(acquireTrajectoryEvidenceFromDb).mockReturnValueOnce({
      status: 'unavailable',
      reasonCode: 'empty_trajectory',
      detail: 'no turns or tool calls for session',
    } as any);
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    const exitSpy = mockProcessExit();

    await handlePainRecord({ reason: 'test pain', session: 'quiet-session', json: true });

    const jsonOutput = JSON.parse(logSpy.mock.calls[0][0]);
    expect(jsonOutput.status).toBe('failed');
    expect(jsonOutput.reason).toBe('empty_trajectory');
    expect(jsonOutput.nextAction).toBeTruthy();
    expect(lastRecordPainInput).toBeNull();
    expect(exitSpy).toHaveBeenCalledWith(1);

    logSpy.mockRestore();
    exitSpy.mockRestore();
  });

  // ── PRI-642 Scope A (SPEC §12.1.6): generated-but-unadmitted candidates must
  // not be reported as completed internalization. ─────────────────────────────

  it('warns that no candidate was admitted/internalized when all candidates are gated', async () => {
    mockRecordPainResult = {
      ...SUCCEEDED_RESULT,
      candidateIds: ['c1', 'c2', 'c3', 'c4'],
      ledgerEntryIds: [],
      admissionResults: [
        { candidateId: 'c1', recommendationKind: 'prompt', admission: { decision: 'needs_evidence', reason: 'confidence_below_threshold:0.45<0.50', nextAction: 'add evidence', evidenceStatus: 'host_context_bound' } },
        { candidateId: 'c2', recommendationKind: 'prompt', admission: { decision: 'deferred', reason: 'recommendation_kind_defer_not_actionable', nextAction: 'none', evidenceStatus: 'host_context_bound' } },
        { candidateId: 'c3', recommendationKind: 'prompt', admission: { decision: 'needs_evidence', reason: 'input_evidence_empty', nextAction: 'add evidence', evidenceStatus: 'host_context_bound' } },
        { candidateId: 'c4', recommendationKind: 'prompt', admission: { decision: 'needs_evidence', reason: 'confidence_below_threshold:0.45<0.50', nextAction: 'add evidence', evidenceStatus: 'host_context_bound' } },
      ],
    } as PainToPrincipleOutput;
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    const exitSpy = mockProcessExit();

    await handlePainRecord({ reason: 'test pain', json: true });

    const allOutput = logSpy.mock.calls.map(c => c.join(' ')).join(' ');
    // Explicit admission summary; must not read as completed internalization.
    expect(allOutput).toMatch(/0 (?:of|\/) 4|admitted.*0|0.*admitted/i);
    const jsonOutput = JSON.parse(logSpy.mock.calls.at(-1)![0] ?? '{}');
    const jsonStr = JSON.stringify(jsonOutput);
    expect(jsonStr).toMatch(/no candidate was admitted|admitted:\s*0/i);

    logSpy.mockRestore();
    exitSpy.mockRestore();
  });

  // ── Bug-P fix: reason length validation ──────────────────────────────────

  // RL-01: reason length within limit processes normally
  it('RL-01: accepts reason with length ≤ 500 (boundary)', async () => {
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    const exitSpy = mockProcessExit();

    const reason500 = 'a'.repeat(500);
    await handlePainRecord({ reason: reason500, json: true });

    expect(exitSpy).not.toHaveBeenCalledWith(1);
    expect(logSpy).toHaveBeenCalled();

    logSpy.mockRestore();
    exitSpy.mockRestore();
  });

  // RL-02: reason length over limit exits 1 with error message
  it('RL-02: exits 1 when reason length > 500', async () => {
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const exitSpy = mockProcessExit();

    const reason501 = 'a'.repeat(501);
    await handlePainRecord({ reason: reason501 });

    expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining('must be at most 500 characters'));
    expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining('got 501'));
    expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining('Next action'));
    expect(exitSpy).toHaveBeenCalledWith(1);

    errorSpy.mockRestore();
    exitSpy.mockRestore();
  });

  // RL-03: short reason processes normally (smoke test)
  it('RL-03: accepts short reason without error', async () => {
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    const exitSpy = mockProcessExit();

    await handlePainRecord({ reason: 'short reason', json: true });

    expect(exitSpy).not.toHaveBeenCalledWith(1);
    expect(logSpy).toHaveBeenCalled();

    logSpy.mockRestore();
    exitSpy.mockRestore();
  });

  // RL-04: CodeRabbit review fix — --json mode emits structured JSON (cli-1, cli-2, cli-5)
  it('RL-04: --json mode emits structured JSON on reason_too_long and stops execution', async () => {
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const exitSpy = mockProcessExit();

    const reason501 = 'a'.repeat(501);
    await handlePainRecord({ reason: reason501, json: true });

    // cli-1: exactly one JSON object on stdout
    expect(logSpy).toHaveBeenCalledTimes(1);
    const jsonOutput = JSON.parse(logSpy.mock.calls[0][0]);
    expect(jsonOutput.status).toBe('failed');
    expect(jsonOutput.reason).toBe('reason_too_long');
    expect(jsonOutput.message).toContain('must be at most 500 characters');
    expect(jsonOutput.message).toContain('got 501');
    expect(jsonOutput.nextAction).toContain('Shorten the reason text');

    // cli-2: execution stopped — recordPain must NOT have been called
    expect(lastRecordPainInput).toBeNull();

    // cli-5: failure path exits 1
    expect(exitSpy).toHaveBeenCalledWith(1);

    // No text leaked to stderr
    expect(errorSpy).not.toHaveBeenCalled();

    logSpy.mockRestore();
    errorSpy.mockRestore();
    exitSpy.mockRestore();
  });

  // 9. PRI-621 PR2: the provider catalog is queried through @principles/core.
  // A provider outside the builtin pi-ai catalog without baseUrl is reported
  // as missing configuration — it must not be silently accepted.
  it('reports baseUrl as missing configuration for a non-builtin provider', async () => {
    mockRecordPainResult = makeFailedResult({
      failureCategory: 'config_missing' as FailureCategory,
      message: 'provider not in builtin catalog',
    });
    vi.mocked(isBuiltinPiAiProvider).mockReturnValue(false);
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const exitSpy = mockProcessExit();

    await handlePainRecord({ reason: 'test pain' });

    const printed = errorSpy.mock.calls.map((c) => String(c[0])).join('\n');
    expect(printed).toContain('Missing configuration:');
    expect(printed).toContain('- baseUrl');
    expect(exitSpy).toHaveBeenCalledWith(1);

    vi.mocked(isBuiltinPiAiProvider).mockReturnValue(true);
    errorSpy.mockRestore();
    exitSpy.mockRestore();
  });
});
