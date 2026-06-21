/**
 * Tests for RecordReplayAdapter.
 *
 * Covers:
 *   1. computeRequestHash stability (same input → same hash)
 *   2. computeRequestHash different taskId → different hash
 *   3. computeRequestHash strips timestamps (different timestamps → same hash)
 *   4. replay mode fixture missing → fail loud (throw)
 *   5. record mode saves fixture and returns output
 *   6. replay mode loads recorded fixture and returns output
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { computeRequestHash, RecordReplayAdapter } from './record-replay-adapter.js';
import type {
  PDRuntimeAdapter,
  RuntimeKind,
  RuntimeCapabilities,
  RuntimeHealth,
  StartRunInput,
  RunHandle,
  RunStatus,
  StructuredRunOutput,
  RuntimeArtifactRef,
  ContextItem,
} from '../runtime-protocol.js';

// ── Test helpers ──

/** Build a minimal valid StartRunInput with overridable fields. */
function makeStartRunInput(overrides: Partial<StartRunInput> = {}): StartRunInput {
  return {
    agentSpec: { agentId: 'test-agent', schemaVersion: '1.0.0' },
    taskRef: { taskId: 'task-default' },
    inputPayload: { prompt: 'Hello' },
    contextItems: [],
    timeoutMs: 30_000,
    ...overrides,
  };
}

/**
 * A minimal mock real adapter for record/live mode tests.
 * Returns a canned StructuredRunOutput so record mode has something to save.
 */
/* eslint-disable @typescript-eslint/class-methods-use-this */
class MockRealAdapter implements PDRuntimeAdapter {
  private runCounter = 0;
  private readonly runs = new Map<string, { status: RunStatus; output: StructuredRunOutput | null }>();
  public cannedPayload: unknown = { valid: true, summary: 'mock-llm-output' };

  kind(): RuntimeKind {
    return 'pi-ai';
  }

  async getCapabilities(): Promise<RuntimeCapabilities> {
    return {
      supportsStructuredJsonOutput: true,
      supportsToolUse: false,
      supportsWorkingDirectory: false,
      supportsModelSelection: false,
      supportsLongRunningSessions: false,
      supportsCancellation: true,
      supportsArtifactWriteBack: false,
      supportsConcurrentRuns: false,
      supportsStreaming: false,
    };
  }

  async healthCheck(): Promise<RuntimeHealth> {
    return {
      healthy: true,
      degraded: false,
      warnings: [],
      lastCheckedAt: new Date().toISOString(),
    };
  }

  async startRun(input: StartRunInput): Promise<RunHandle> {
    this.runCounter += 1;
    const runId = `real-${this.runCounter}`;
    const now = new Date().toISOString();
    const status: RunStatus = { runId, status: 'succeeded', startedAt: now, endedAt: now };
    const output: StructuredRunOutput = { runId, payload: this.cannedPayload };
    this.runs.set(runId, { status, output });
    void input;
    return { runId, runtimeKind: 'pi-ai', startedAt: now };
  }

  async pollRun(runId: string): Promise<RunStatus> {
    const run = this.runs.get(runId);
    if (!run) {
      return { runId, status: 'failed', reason: 'unknown runId' };
    }
    return run.status;
  }

  async cancelRun(runId: string): Promise<void> {
    void runId;
  }

  async fetchOutput(runId: string): Promise<StructuredRunOutput | null> {
    const run = this.runs.get(runId);
    return run?.output ?? null;
  }

  async fetchArtifacts(runId: string): Promise<RuntimeArtifactRef[]> {
    void runId;
    return [];
  }

  async appendContext(runId: string, items: ContextItem[]): Promise<void> {
    void runId;
    void items;
  }
}

// ── Tests ──

describe('computeRequestHash', () => {
  it('produces the same hash for identical inputs (stability)', () => {
    const input1 = makeStartRunInput();
    const input2 = makeStartRunInput();
    const hash1 = computeRequestHash(input1);
    const hash2 = computeRequestHash(input2);
    expect(hash1).toBe(hash2);
    expect(hash1).toMatch(/^[0-9a-f]{64}$/);
  });

  it('produces different hashes for different taskIds', () => {
    const inputA = makeStartRunInput({ taskRef: { taskId: 'task-A' } });
    const inputB = makeStartRunInput({ taskRef: { taskId: 'task-B' } });
    const hashA = computeRequestHash(inputA);
    const hashB = computeRequestHash(inputB);
    expect(hashA).not.toBe(hashB);
  });

  it('strips volatile timestamp fields so different timestamps produce the same hash', () => {
    const input1 = makeStartRunInput({
      inputPayload: { prompt: 'Hello', timestamp: '2024-01-01T00:00:00Z', startedAt: '2024-01-01T00:00:00Z' },
      idempotencyKey: 'key-1',
    });
    const input2 = makeStartRunInput({
      inputPayload: { prompt: 'Hello', timestamp: '2025-06-15T12:30:45Z', startedAt: '2025-06-15T12:30:45Z' },
      idempotencyKey: 'key-2',
    });
    const hash1 = computeRequestHash(input1);
    const hash2 = computeRequestHash(input2);
    expect(hash1).toBe(hash2);
  });

  it('produces different hashes when semantic content differs', () => {
    const input1 = makeStartRunInput({ inputPayload: { prompt: 'Hello' } });
    const input2 = makeStartRunInput({ inputPayload: { prompt: 'Goodbye' } });
    expect(computeRequestHash(input1)).not.toBe(computeRequestHash(input2));
  });
});

describe('RecordReplayAdapter', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pd-rr-'));
  });

  afterEach(() => {
    try {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    } catch (err) {
      console.warn(`[afterEach] Failed to clean ${tmpDir}: ${err instanceof Error ? err.message : String(err)}`);
    }
  });

  describe('replay mode (default)', () => {
    it('fails loud when fixture is missing (does not silently return null)', async () => {
      const adapter = new RecordReplayAdapter({ fixtureDir: tmpDir, mode: 'replay' });
      const input = makeStartRunInput({ taskRef: { taskId: 'no-fixture-task' } });

      await expect(adapter.startRun(input)).rejects.toThrow(/Fixture not found/);
    });

    it('loads a recorded fixture and returns the recorded output', async () => {
      // Step 1: record a fixture using a mock real adapter.
      const realAdapter = new MockRealAdapter();
      const recordAdapter = new RecordReplayAdapter({
        realAdapter,
        fixtureDir: tmpDir,
        mode: 'record',
      });
      const input = makeStartRunInput({
        taskRef: { taskId: 'replay-test-task' },
        inputPayload: { prompt: 'What is 2+2?' },
      });
      const recordedHandle = await recordAdapter.startRun(input);
      const recordedOutput = await recordAdapter.fetchOutput(recordedHandle.runId);
      expect(recordedOutput).not.toBeNull();
      expect(recordedOutput?.payload).toEqual({ valid: true, summary: 'mock-llm-output' });

      // Step 2: replay the fixture using a new adapter (no realAdapter needed).
      const replayAdapter = new RecordReplayAdapter({
        fixtureDir: tmpDir,
        mode: 'replay',
      });
      const replayHandle = await replayAdapter.startRun(input);
      expect(replayHandle.runtimeKind).toBe('pi-ai');

      const replayStatus = await replayAdapter.pollRun(replayHandle.runId);
      expect(replayStatus.status).toBe('succeeded');

      const replayOutput = await replayAdapter.fetchOutput(replayHandle.runId);
      expect(replayOutput).not.toBeNull();
      expect(replayOutput?.runId).toBe(replayHandle.runId);
      expect(replayOutput?.payload).toEqual({ valid: true, summary: 'mock-llm-output' });

      const replayArtifacts = await replayAdapter.fetchArtifacts(replayHandle.runId);
      expect(replayArtifacts).toEqual([]);
    });

    it('reports kind as test-double when no realAdapter is provided', () => {
      const adapter = new RecordReplayAdapter({ fixtureDir: tmpDir, mode: 'replay' });
      expect(adapter.kind()).toBe('test-double');
    });

    it('returns default capabilities when no realAdapter is provided', async () => {
      const adapter = new RecordReplayAdapter({ fixtureDir: tmpDir, mode: 'replay' });
      const caps = await adapter.getCapabilities();
      expect(caps.supportsStructuredJsonOutput).toBe(true);
      expect(caps.supportsCancellation).toBe(true);
    });

    it('returns healthy status when no realAdapter is provided', async () => {
      const adapter = new RecordReplayAdapter({ fixtureDir: tmpDir, mode: 'replay' });
      const health = await adapter.healthCheck();
      expect(health.healthy).toBe(true);
      expect(health.degraded).toBe(false);
    });
  });

  describe('record mode', () => {
    it('saves a fixture file to disk and returns the real adapter output', async () => {
      const realAdapter = new MockRealAdapter();
      const adapter = new RecordReplayAdapter({
        realAdapter,
        fixtureDir: tmpDir,
        mode: 'record',
      });
      const input = makeStartRunInput({
        taskRef: { taskId: 'record-test-task' },
        inputPayload: { prompt: 'Record me' },
      });

      const handle = await adapter.startRun(input);
      expect(handle.runtimeKind).toBe('pi-ai');

      const output = await adapter.fetchOutput(handle.runId);
      expect(output).not.toBeNull();
      expect(output?.payload).toEqual({ valid: true, summary: 'mock-llm-output' });

      // Verify fixture file was written to disk.
      const hash = computeRequestHash(input);
      const fixturePath = path.join(tmpDir, `${hash}.json`);
      expect(fs.existsSync(fixturePath)).toBe(true);

      // Verify fixture content is valid JSON with expected fields.
      const fixtureRaw = fs.readFileSync(fixturePath, 'utf8');
      const fixture = JSON.parse(fixtureRaw) as Record<string, unknown>;
      expect(fixture.version).toBe(1);
      expect(fixture.hash).toBe(hash);
      expect(fixture.runtimeKind).toBe('pi-ai');
      expect(fixture.runHandle).toBeDefined();
      expect(fixture.runStatus).toBeDefined();
      expect(fixture.output).toBeDefined();
      expect(fixture.artifacts).toEqual([]);
    });

    it('reports the real adapter kind', () => {
      const realAdapter = new MockRealAdapter();
      const adapter = new RecordReplayAdapter({
        realAdapter,
        fixtureDir: tmpDir,
        mode: 'record',
      });
      expect(adapter.kind()).toBe('pi-ai');
    });

    it('throws if realAdapter is not provided', () => {
      expect(() => {
        new RecordReplayAdapter({ fixtureDir: tmpDir, mode: 'record' });
      }).toThrow(/realAdapter is required/);
    });
  });

  describe('live mode', () => {
    it('delegates to the real adapter without saving fixtures', async () => {
      const realAdapter = new MockRealAdapter();
      const adapter = new RecordReplayAdapter({
        realAdapter,
        fixtureDir: tmpDir,
        mode: 'live',
      });
      const input = makeStartRunInput({
        taskRef: { taskId: 'live-test-task' },
        inputPayload: { prompt: 'Live debug' },
      });

      const handle = await adapter.startRun(input);
      expect(handle.runtimeKind).toBe('pi-ai');

      const output = await adapter.fetchOutput(handle.runId);
      expect(output).not.toBeNull();
      expect(output?.payload).toEqual({ valid: true, summary: 'mock-llm-output' });

      // Verify NO fixture file was written.
      const files = fs.readdirSync(tmpDir);
      expect(files.length).toBe(0);
    });

    it('throws if realAdapter is not provided', () => {
      expect(() => {
        new RecordReplayAdapter({ fixtureDir: tmpDir, mode: 'live' });
      }).toThrow(/realAdapter is required/);
    });
  });

  describe('record → replay round-trip', () => {
    it('replay produces the same payload that record captured, even with different volatile fields', async () => {
      const realAdapter = new MockRealAdapter();
      realAdapter.cannedPayload = { valid: true, principle: 'Be explicit', confidence: 0.95 };

      // Record with one set of volatile fields.
      const recordAdapter = new RecordReplayAdapter({
        realAdapter,
        fixtureDir: tmpDir,
        mode: 'record',
      });
      const recordInput = makeStartRunInput({
        taskRef: { taskId: 'round-trip-task' },
        inputPayload: { prompt: 'Generate a principle', timestamp: '2024-01-01T00:00:00Z' },
        idempotencyKey: 'record-key-001',
      });
      await recordAdapter.startRun(recordInput);

      // Replay with different volatile fields — same hash, same fixture.
      const replayAdapter = new RecordReplayAdapter({
        fixtureDir: tmpDir,
        mode: 'replay',
      });
      const replayInput = makeStartRunInput({
        taskRef: { taskId: 'round-trip-task' },
        inputPayload: { prompt: 'Generate a principle', timestamp: '2025-12-31T23:59:59Z' },
        idempotencyKey: 'replay-key-999',
      });
      const handle = await replayAdapter.startRun(replayInput);
      const output = await replayAdapter.fetchOutput(handle.runId);

      expect(output).not.toBeNull();
      expect(output?.payload).toEqual({ valid: true, principle: 'Be explicit', confidence: 0.95 });
    });
  });
});
