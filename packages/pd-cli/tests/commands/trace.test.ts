/**
 * pd runtime trace show command unit tests.
 *
 * Tests the trace command's external contract via mocked PainChainReadModel.
 * Tests pain-to-ledger chain tracing, latency reporting, consistency checks,
 * and failure classification output.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const mockTraceByPainId = vi.fn();
const mockPainChainClose = vi.fn().mockResolvedValue(undefined);

vi.mock('@principles/core/runtime-v2', () => ({
  PainChainReadModel: vi.fn().mockImplementation(function () {
    return { traceByPainId: mockTraceByPainId, close: mockPainChainClose };
  }),
}));

vi.mock('../../src/resolve-workspace.js', () => ({
  resolveWorkspaceDir: vi.fn().mockReturnValue('/fake/workspace'),
}));

import { handleTraceShow } from '../../src/commands/trace.js';

const WS = '/fake/workspace';

function fullChainTrace() {
  return {
    painId: 'pain_001',
    taskId: 'diagnosis_pain_001',
    runId: 'run_001',
    artifactId: 'art_001',
    candidateIds: ['c1', 'c2'],
    ledgerEntryIds: ['l1'],
    status: 'succeeded',
    latencyMs: {
      painToTask: 100,
      taskToRun: 200,
      runToArtifact: 50,
      artifactToCandidate: 30,
      candidateToLedger: 20,
    },
    failureCategory: null,
    checkedAt: '2026-05-03T12:00:00.000Z',
    missingLinks: [],
  };
}

function mockProcessExit() {
  return vi.spyOn(process, 'exit').mockImplementation((() => undefined) as () => never);
}

describe('handleTraceShow', () => {
  let consoleLogSpy: ReturnType<typeof vi.spyOn>;
  let consoleErrorSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    vi.clearAllMocks();
    consoleLogSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
  });

  afterEach(() => {
    consoleLogSpy.mockRestore();
    consoleErrorSpy.mockRestore();
  });

  it('outputs full chain trace with all fields (--json)', async () => {
    mockTraceByPainId.mockResolvedValue(fullChainTrace());

    await handleTraceShow({ painId: 'pain_001', workspace: WS, json: true });

    expect(consoleLogSpy).toHaveBeenCalled();
    const jsonOutput = JSON.parse(consoleLogSpy.mock.calls[0][0]);
    expect(jsonOutput.painId).toBe('pain_001');
    expect(jsonOutput.taskId).toBe('diagnosis_pain_001');
    expect(jsonOutput.runId).toBe('run_001');
    expect(jsonOutput.artifactId).toBe('art_001');
    expect(jsonOutput.candidateIds).toEqual(['c1', 'c2']);
    expect(jsonOutput.ledgerEntryIds).toEqual(['l1']);
    expect(jsonOutput.status).toBe('succeeded');
    expect(jsonOutput.latencyMs).toBeDefined();
  });

  it('outputs readable text with latency breakdown', async () => {
    mockTraceByPainId.mockResolvedValue(fullChainTrace());

    await handleTraceShow({ painId: 'pain_001', workspace: WS, json: false });

    const allOutput = consoleLogSpy.mock.calls.map(c => c.join(' ')).join('\n');
    expect(allOutput).toContain('Pain ID:       pain_001');
    expect(allOutput).toContain('Task ID:       diagnosis_pain_001');
    expect(allOutput).toContain('Status:        succeeded');
    expect(allOutput).toContain('Run ID:        run_001');
    expect(allOutput).toContain('Artifact ID:   art_001');
    expect(allOutput).toContain('Candidate IDs:  c1, c2');
    expect(allOutput).toContain('Latency:');
    expect(allOutput).toContain('pain→task:          100ms');
    expect(allOutput).toContain('task→run:           200ms');
  });

  it('handles not_found status with exit code 1', async () => {
    mockTraceByPainId.mockResolvedValue({
      painId: 'pain_001',
      taskId: 'diagnosis_pain_001',
      status: 'not_found',
      failureCategory: 'runtime_unavailable',
      checkedAt: '2026-05-03T12:00:00.000Z',
      missingLinks: ['task'],
    });

    await handleTraceShow({ painId: 'pain_001', workspace: WS, json: false });

    expect(consoleErrorSpy).toHaveBeenCalledWith(expect.stringContaining('No task found'));
    expect(process.exitCode).toBe(1);
  });

  it('handles error status with config_missing', async () => {
    mockTraceByPainId.mockResolvedValue({
      painId: 'pain_001',
      taskId: 'diagnosis_pain_001',
      status: 'error',
      failureCategory: 'config_missing',
      checkedAt: '2026-05-03T12:00:00.000Z',
      missingLinks: ['state_manager_init'],
    });

    await handleTraceShow({ painId: 'pain_001', workspace: WS, json: true });

    const jsonOutput = JSON.parse(consoleLogSpy.mock.calls[0][0]);
    expect(jsonOutput.status).toBe('error');
    expect(jsonOutput.failureCategory).toBe('config_missing');
    expect(process.exitCode).toBe(1);
  });

  it('reports missing links in text output', async () => {
    mockTraceByPainId.mockResolvedValue({
      ...fullChainTrace(),
      status: 'degraded',
      failureCategory: 'ledger_write_failed',
      missingLinks: ['candidate:c1 consumed but missing from ledger'],
    });

    await handleTraceShow({ painId: 'pain_001', workspace: WS, json: false });

    const allOutput = consoleLogSpy.mock.calls.map(c => c.join(' ')).join('\n');
    expect(allOutput).toContain('Missing links');
    expect(allOutput).toContain('candidate:c1 consumed but missing from ledger');
    expect(process.exitCode).toBe(1);
  });

  it('outputs all latency segments', async () => {
    mockTraceByPainId.mockResolvedValue(fullChainTrace());

    await handleTraceShow({ painId: 'pain_001', workspace: WS, json: false });

    const allOutput = consoleLogSpy.mock.calls.map(c => c.join(' ')).join('\n');
    expect(allOutput).toContain('run→artifact:       50ms');
    expect(allOutput).toContain('artifact→candidate: 30ms');
    expect(allOutput).toContain('candidate→ledger:   20ms');
  });

  it('handles missing painId gracefully', async () => {
    await handleTraceShow({ painId: '', workspace: WS, json: false });

    expect(consoleErrorSpy).toHaveBeenCalledWith(expect.stringContaining('--pain-id'));
    expect(process.exitCode).toBe(1);
  });

  it('reports failed status with exit code 1', async () => {
    mockTraceByPainId.mockResolvedValue({
      ...fullChainTrace(),
      status: 'failed',
      failureCategory: 'runtime_timeout',
    });

    await handleTraceShow({ painId: 'pain_001', workspace: WS, json: false });

    expect(process.exitCode).toBe(1);
  });

  it('reports degraded status with exit code 1', async () => {
    mockTraceByPainId.mockResolvedValue({
      ...fullChainTrace(),
      status: 'degraded',
      failureCategory: 'candidate_missing',
      missingLinks: ['No candidates generated for succeeded task'],
    });

    await handleTraceShow({ painId: 'pain_001', workspace: WS, json: false });

    expect(process.exitCode).toBe(1);
  });

  it('closes PainChainReadModel after use', async () => {
    mockTraceByPainId.mockResolvedValue(fullChainTrace());

    await handleTraceShow({ painId: 'pain_001', workspace: WS, json: true });

    expect(mockPainChainClose).toHaveBeenCalled();
  });

  it('handles traceByPainId throwing an error', async () => {
    mockTraceByPainId.mockRejectedValue(new Error('Database connection failed'));

    await handleTraceShow({ painId: 'pain_001', workspace: WS, json: true });

    const jsonOutput = JSON.parse(consoleLogSpy.mock.calls[0][0]);
    expect(jsonOutput.status).toBe('error');
    expect(jsonOutput.failureCategory).toBe('runtime_unavailable');
    expect(process.exitCode).toBe(1);
  });

  it('outputs not_found in JSON format with correct fields', async () => {
    mockTraceByPainId.mockResolvedValue({
      painId: 'pain_001',
      taskId: 'diagnosis_pain_001',
      status: 'not_found',
      failureCategory: 'runtime_unavailable',
      checkedAt: '2026-05-03T12:00:00.000Z',
      missingLinks: ['task'],
    });

    await handleTraceShow({ painId: 'pain_001', workspace: WS, json: true });

    const jsonOutput = JSON.parse(consoleLogSpy.mock.calls[0][0]);
    expect(jsonOutput.painId).toBe('pain_001');
    expect(jsonOutput.taskId).toBe('diagnosis_pain_001');
    expect(jsonOutput.status).toBe('not_found');
    expect(jsonOutput.message).toContain('No task found');
    expect(jsonOutput.workspace).toBe(WS);
    expect(process.exitCode).toBe(1);
  });
});
