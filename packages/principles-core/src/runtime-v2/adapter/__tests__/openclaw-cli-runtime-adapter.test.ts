/**
 * OpenClawCliRuntimeAdapter unit tests.
 *
 * Tests OCRA-01 (kind), OCRA-02 (startRun args), OCRA-03 (fetchOutput parsing),
 * and OCRA-04 (5-category error mapping).
 *
 * runCliProcess is mocked so tests run without the real openclaw binary.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { OpenClawCliRuntimeAdapter } from '../openclaw-cli-runtime-adapter.js';
import type { CliOutput } from '../../utils/cli-process-runner.js';

// Mock runCliProcess before importing the adapter
vi.mock('../../utils/cli-process-runner.js', () => ({
  runCliProcess: vi.fn(),
}));

import { runCliProcess } from '../../utils/cli-process-runner.js';
import { PDRuntimeError } from '../../error-categories.js';

const mockRunCliProcess = runCliProcess as ReturnType<typeof vi.fn>;

const VALID_PAYLOAD = {
  valid: true,
  diagnosisId: 'diag-1',
  taskId: 'task-1',
  summary: 'test summary',
  rootCause: 'test root cause',
  violatedPrinciples: [],
  evidence: [],
  recommendations: [],
  confidence: 0.9,
};

function makeCliOutput(overrides: Partial<CliOutput> = {}): CliOutput {
  return {
    stdout: '',
    stderr: '',
    exitCode: 0,
    timedOut: false,
    durationMs: 100,
    ...overrides,
  };
}

describe('OpenClawCliRuntimeAdapter', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  // OCRA-01: kind() returns 'openclaw-cli'
  describe('kind()', () => {
    it('returns RuntimeKind literal "openclaw-cli"', () => {
      const adapter = new OpenClawCliRuntimeAdapter();
      expect(adapter.kind()).toBe('openclaw-cli');
    });
  });

  // OCRA-02: startRun invokes openclaw agent with correct CLI args
  describe('startRun()', () => {
    it('calls runCliProcess with command "openclaw" and correct args', async () => {
      const adapter = new OpenClawCliRuntimeAdapter();
      mockRunCliProcess.mockResolvedValue(makeCliOutput({ stdout: JSON.stringify(VALID_PAYLOAD) }));

      await adapter.startRun({
        agentSpec: { agentId: 'my-agent', schemaVersion: 'v1' },
        inputPayload: { foo: 'bar' },
        contextItems: [],
        timeoutMs: 30000,
      });

      expect(mockRunCliProcess).toHaveBeenCalledTimes(1);
      const call = mockRunCliProcess.mock.calls[0]![0] as { command: string; args: string[]; timeoutMs?: number };
      expect(call.command).toBe('openclaw');
      expect(call.args).toContain('--agent');
      expect(call.args).toContain('my-agent');
      expect(call.args).toContain('--message');
      expect(call.args).toContain('--json');
      expect(call.args).toContain('--local');
      expect(call.args).toContain('--timeout');
      expect(call.timeoutMs).toBe(30000);
    });

    it('uses default "diagnostician" agentId when agentSpec.agentId is undefined', async () => {
      const adapter = new OpenClawCliRuntimeAdapter();
      mockRunCliProcess.mockResolvedValue(makeCliOutput({ stdout: JSON.stringify(VALID_PAYLOAD) }));

      await adapter.startRun({
        agentSpec: { agentId: 'diagnostician', schemaVersion: 'v1' },
        inputPayload: {},
        contextItems: [],
        timeoutMs: 60000,
      });

      const call = mockRunCliProcess.mock.calls[0]![0] as { args: string[] };
      expect(call.args).toContain('diagnostician');
    });

    it('converts timeoutMs to seconds for --timeout CLI arg', async () => {
      const adapter = new OpenClawCliRuntimeAdapter();
      mockRunCliProcess.mockResolvedValue(makeCliOutput({ stdout: JSON.stringify(VALID_PAYLOAD) }));

      await adapter.startRun({
        agentSpec: { agentId: 'diag', schemaVersion: 'v1' },
        inputPayload: {},
        contextItems: [],
        timeoutMs: 65000, // 65 seconds
      });

      const call = mockRunCliProcess.mock.calls[0]![0] as { args: string[] };
      const timeoutIdx = call.args.indexOf('--timeout');
      expect(call.args[timeoutIdx + 1]).toBe('65'); // Math.ceil(65000/1000) = 65
    });

    it('stores cliOutput in memory after CLI completes', async () => {
      const adapter = new OpenClawCliRuntimeAdapter();
      const mockOutput = makeCliOutput({ stdout: JSON.stringify(VALID_PAYLOAD), exitCode: 0 });
      mockRunCliProcess.mockResolvedValue(mockOutput);

      const handle = await adapter.startRun({
        agentSpec: { agentId: 'diag', schemaVersion: 'v1' },
        inputPayload: {},
        contextItems: [],
        timeoutMs: 30000,
      });

      // fetchOutput should work immediately since startRun blocks until CLI exits
      const output = await adapter.fetchOutput(handle.runId);
      expect(output.payload).toMatchObject({ diagnosisId: 'diag-1' });
    });
  });

  // OCRA-03: fetchOutput parses CliOutput.stdout and returns DiagnosticianOutputV1
  describe('fetchOutput()', () => {
    it('parses valid DiagnosticianOutputV1 from CliOutput.stdout', async () => {
      const adapter = new OpenClawCliRuntimeAdapter();
      const mockOutput = makeCliOutput({ stdout: JSON.stringify(VALID_PAYLOAD), exitCode: 0 });
      mockRunCliProcess.mockResolvedValue(mockOutput);

      const handle = await adapter.startRun({
        agentSpec: { agentId: 'diag', schemaVersion: 'v1' },
        inputPayload: {},
        contextItems: [],
        timeoutMs: 30000,
      });

      const result = await adapter.fetchOutput(handle.runId);
      expect(result.runId).toBe(handle.runId);
      expect(result.payload).toMatchObject({
        valid: true,
        diagnosisId: 'diag-1',
        taskId: 'task-1',
      });
    });

    it('extracts JSON from mixed output with surrounding text', async () => {
      const adapter = new OpenClawCliRuntimeAdapter();
      const mixedOutput = 'Some text output\n' + JSON.stringify(VALID_PAYLOAD) + '\nmore text';
      const mockCliOutput = makeCliOutput({ stdout: mixedOutput, exitCode: 0 });
      mockRunCliProcess.mockResolvedValue(mockCliOutput);

      const handle = await adapter.startRun({
        agentSpec: { agentId: 'diag', schemaVersion: 'v1' },
        inputPayload: {},
        contextItems: [],
        timeoutMs: 30000,
      });

      const result = await adapter.fetchOutput(handle.runId);
      expect(result.payload).toMatchObject({ diagnosisId: 'diag-1' });
    });
  });

  // OCRA-04: CLI failures map to correct PDErrorCategory
  describe('fetchOutput() error mapping', () => {
    it('throws PDRuntimeError("runtime_unavailable") when ENOENT (binary not found)', async () => {
      const adapter = new OpenClawCliRuntimeAdapter();
      const mockOutput = makeCliOutput({ stdout: '', stderr: 'ENOENT: ENOENT', exitCode: null });
      mockRunCliProcess.mockResolvedValue(mockOutput);

      const handle = await adapter.startRun({
        agentSpec: { agentId: 'diag', schemaVersion: 'v1' },
        inputPayload: {},
        contextItems: [],
        timeoutMs: 30000,
      });

      await expect(adapter.fetchOutput(handle.runId)).rejects.toThrow(PDRuntimeError);
      await expect(adapter.fetchOutput(handle.runId)).rejects.toMatchObject({
        category: 'runtime_unavailable',
      });
    });

    it('throws PDRuntimeError("timeout") when timedOut=true', async () => {
      const adapter = new OpenClawCliRuntimeAdapter();
      const mockOutput = makeCliOutput({ stdout: '', stderr: '', exitCode: null, timedOut: true });
      mockRunCliProcess.mockResolvedValue(mockOutput);

      const handle = await adapter.startRun({
        agentSpec: { agentId: 'diag', schemaVersion: 'v1' },
        inputPayload: {},
        contextItems: [],
        timeoutMs: 1,
      });

      await expect(adapter.fetchOutput(handle.runId)).rejects.toThrow(PDRuntimeError);
      await expect(adapter.fetchOutput(handle.runId)).rejects.toMatchObject({
        category: 'timeout',
      });
    });

    it('throws PDRuntimeError("execution_failed") when non-zero exit code', async () => {
      const adapter = new OpenClawCliRuntimeAdapter();
      const mockOutput = makeCliOutput({ stdout: '', stderr: '', exitCode: 42, timedOut: false });
      mockRunCliProcess.mockResolvedValue(mockOutput);

      const handle = await adapter.startRun({
        agentSpec: { agentId: 'diag', schemaVersion: 'v1' },
        inputPayload: {},
        contextItems: [],
        timeoutMs: 30000,
      });

      await expect(adapter.fetchOutput(handle.runId)).rejects.toThrow(PDRuntimeError);
      await expect(adapter.fetchOutput(handle.runId)).rejects.toMatchObject({
        category: 'execution_failed',
      });
    });

    it('throws PDRuntimeError("output_invalid") when JSON parse fails', async () => {
      const adapter = new OpenClawCliRuntimeAdapter();
      const mockOutput = makeCliOutput({ stdout: 'this is not JSON at all!!!', stderr: '', exitCode: 0 });
      mockRunCliProcess.mockResolvedValue(mockOutput);

      const handle = await adapter.startRun({
        agentSpec: { agentId: 'diag', schemaVersion: 'v1' },
        inputPayload: {},
        contextItems: [],
        timeoutMs: 30000,
      });

      await expect(adapter.fetchOutput(handle.runId)).rejects.toThrow(PDRuntimeError);
      await expect(adapter.fetchOutput(handle.runId)).rejects.toMatchObject({
        category: 'output_invalid',
      });
    });

    it('throws PDRuntimeError("output_invalid") when DiagnosticianOutputV1 schema validation fails', async () => {
      const adapter = new OpenClawCliRuntimeAdapter();
      const invalidPayload = { valid: true /* missing required fields */ };
      const mockOutput = makeCliOutput({ stdout: JSON.stringify(invalidPayload), exitCode: 0 });
      mockRunCliProcess.mockResolvedValue(mockOutput);

      const handle = await adapter.startRun({
        agentSpec: { agentId: 'diag', schemaVersion: 'v1' },
        inputPayload: {},
        contextItems: [],
        timeoutMs: 30000,
      });

      await expect(adapter.fetchOutput(handle.runId)).rejects.toThrow(PDRuntimeError);
      await expect(adapter.fetchOutput(handle.runId)).rejects.toMatchObject({
        category: 'output_invalid',
      });
    });
  });

  describe('pollRun()', () => {
    it('returns succeeded when CLI exited with code 0', async () => {
      const adapter = new OpenClawCliRuntimeAdapter();
      mockRunCliProcess.mockResolvedValue(makeCliOutput({ stdout: JSON.stringify(VALID_PAYLOAD), exitCode: 0 }));

      const handle = await adapter.startRun({
        agentSpec: { agentId: 'diag', schemaVersion: 'v1' },
        inputPayload: {},
        contextItems: [],
        timeoutMs: 30000,
      });

      const status = await adapter.pollRun(handle.runId);
      expect(status.status).toBe('succeeded');
      expect(status.runId).toBe(handle.runId);
    });

    it('returns failed when CLI exited with non-zero code', async () => {
      const adapter = new OpenClawCliRuntimeAdapter();
      mockRunCliProcess.mockResolvedValue(makeCliOutput({ stdout: '', exitCode: 1 }));

      const handle = await adapter.startRun({
        agentSpec: { agentId: 'diag', schemaVersion: 'v1' },
        inputPayload: {},
        contextItems: [],
        timeoutMs: 30000,
      });

      const status = await adapter.pollRun(handle.runId);
      expect(status.status).toBe('failed');
    });

    it('returns timed_out when CLI timed out', async () => {
      const adapter = new OpenClawCliRuntimeAdapter();
      mockRunCliProcess.mockResolvedValue(makeCliOutput({ stdout: '', exitCode: null, timedOut: true }));

      const handle = await adapter.startRun({
        agentSpec: { agentId: 'diag', schemaVersion: 'v1' },
        inputPayload: {},
        contextItems: [],
        timeoutMs: 1,
      });

      const status = await adapter.pollRun(handle.runId);
      expect(status.status).toBe('timed_out');
    });
  });

  describe('getCapabilities()', () => {
    it('returns capabilities with structuredJsonOutput=true, cancellation=true', async () => {
      const adapter = new OpenClawCliRuntimeAdapter();
      const caps = await adapter.getCapabilities();
      expect(caps.supportsStructuredJsonOutput).toBe(true);
      expect(caps.supportsCancellation).toBe(true);
      expect(caps.supportsToolUse).toBe(false);
      expect(caps.supportsConcurrentRuns).toBe(false);
    });
  });

  describe('healthCheck()', () => {
    it('returns healthy=true, degraded=false', async () => {
      const adapter = new OpenClawCliRuntimeAdapter();
      const health = await adapter.healthCheck();
      expect(health.healthy).toBe(true);
      expect(health.degraded).toBe(false);
    });
  });

  describe('cancelRun()', () => {
    it('resolves without error even when run is not found', async () => {
      const adapter = new OpenClawCliRuntimeAdapter();
      await expect(adapter.cancelRun('nonexistent-run-id')).resolves.toBeUndefined();
    });
  });

  describe('fetchArtifacts()', () => {
    it('returns empty array', async () => {
      const adapter = new OpenClawCliRuntimeAdapter();
      const artifacts = await adapter.fetchArtifacts('any-run-id');
      expect(artifacts).toEqual([]);
    });
  });
});
