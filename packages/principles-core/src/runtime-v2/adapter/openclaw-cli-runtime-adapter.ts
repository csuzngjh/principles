/**
 * OpenClawCliRuntimeAdapter — PDRuntimeAdapter implementation for openclaw-cli.
 *
 * One-shot run: startRun() spawns 'openclaw agent', blocks until CLI exits,
 * stores CliOutput in memory. pollRun()/fetchOutput() operate on stored state.
 *
 * Error mapping (D-04):
 *   ENOENT (binary not found) → runtime_unavailable
 *   timedOut → timeout
 *   non-zero exit code → execution_failed
 *   JSON parse failure → output_invalid
 *   DiagnosticianOutputV1Schema validation failure → output_invalid
 */
import { Value } from '@sinclair/typebox/value';
import { runCliProcess, type CliOutput } from '../utils/cli-process-runner.js';
import { PDRuntimeError } from '../error-categories.js';
import { DiagnosticianOutputV1Schema } from '../diagnostician-output.js';
import type {
  PDRuntimeAdapter,
  RuntimeKind,
  RuntimeCapabilities,
  RuntimeHealth,
  RunHandle,
  RunStatus,
  StartRunInput,
  StructuredRunOutput,
  RuntimeArtifactRef,
} from '../runtime-protocol.js';

interface RunState {
  runId: string;
  startedAt: string;
  cliOutput: CliOutput | null; // null until CLI completes
  completed: boolean;
}

/**
 * Extract JSON from potentially mixed CLI output (e.g., text + JSON interleaved).
 * Tries direct parse first, then falls back to extracting first balanced {...} block.
 */
function extractJson(text: string): unknown | null {
  // Attempt 1: direct parse
  try {
    return JSON.parse(text);
  } catch { /* fall through */ }

  // Attempt 2: balanced-fragment extraction
  const match = text.match(/\{[\s\S]*\}/);
  if (match) {
    try {
      return JSON.parse(match[0]);
    } catch { /* fall through */ }
  }

  return null;
}

export class OpenClawCliRuntimeAdapter implements PDRuntimeAdapter {
  private readonly runStateMap = new Map<string, RunState>();

  // OCRA-01: kind() returns RuntimeKind literal 'openclaw-cli'
  kind(): RuntimeKind {
    return 'openclaw-cli';
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

  // OCRA-02: startRun synchronously invokes openclaw agent with correct CLI args
  async startRun(input: StartRunInput): Promise<RunHandle> {
    const runId = crypto.randomUUID();
    const startedAt = new Date().toISOString();

    // Initialize state — cliOutput null until CLI completes
    const state: RunState = { runId, startedAt, cliOutput: null, completed: false };
    this.runStateMap.set(runId, state);

    // Build CLI args per D-02
    const jsonPayload = typeof input.inputPayload === 'string'
      ? input.inputPayload
      : JSON.stringify(input.inputPayload);
    const timeoutSeconds = Math.ceil((input.timeoutMs ?? 600000) / 1000);
    const agentId = input.agentSpec?.agentId ?? 'diagnostician';

    const args = [
      'agent',
      '--agent', agentId,
      '--message', jsonPayload,
      '--json',
      '--local',
      '--timeout', String(timeoutSeconds),
    ];

    // Spawn CLI — promise resolves when CLI exits (D-01: blocks until close)
    const cliOutput = await runCliProcess({
      command: 'openclaw',
      args,
      timeoutMs: input.timeoutMs,
    });

    // Store result in memory
    state.cliOutput = cliOutput;
    state.completed = true;

    return { runId, runtimeKind: 'openclaw-cli', startedAt };
  }

  async pollRun(runId: string): Promise<RunStatus> {
    const state = this.runStateMap.get(runId);
    if (!state) {
      throw new PDRuntimeError('output_invalid', `Run ${runId} not found`);
    }

    if (!state.completed || !state.cliOutput) {
      return { runId, status: 'running', startedAt: state.startedAt };
    }

    const { cliOutput } = state;

    if (cliOutput.timedOut) {
      return {
        runId,
        status: 'timed_out',
        startedAt: state.startedAt,
        endedAt: new Date().toISOString(),
        reason: 'CLI timeout exceeded',
      };
    }

    if (cliOutput.exitCode !== null && cliOutput.exitCode !== 0) {
      return {
        runId,
        status: 'failed',
        startedAt: state.startedAt,
        endedAt: new Date().toISOString(),
        reason: `CLI exited with code ${cliOutput.exitCode}`,
      };
    }

    return {
      runId,
      status: 'succeeded',
      startedAt: state.startedAt,
      endedAt: new Date().toISOString(),
    };
  }

  // OCRA-03: fetchOutput parses CliOutput.stdout and returns DiagnosticianOutputV1
  async fetchOutput(runId: string): Promise<StructuredRunOutput> {
    const state = this.runStateMap.get(runId);
    if (!state || !state.completed || !state.cliOutput) {
      throw new PDRuntimeError('output_invalid', `Run ${runId} not completed`);
    }

    const { cliOutput } = state;

    // OCRA-04: Map ENOENT (binary not found) to runtime_unavailable
    // runCliProcess sets stderr = 'ENOENT: <code>' on ENOENT error
    if (cliOutput.exitCode === null && cliOutput.stderr.startsWith('ENOENT:')) {
      throw new PDRuntimeError('runtime_unavailable', 'openclaw binary not found');
    }

    // OCRA-04: Map timeout to timeout
    if (cliOutput.timedOut) {
      throw new PDRuntimeError('timeout', 'CLI timeout exceeded');
    }

    // OCRA-04: Map non-zero exit to execution_failed
    if (cliOutput.exitCode !== null && cliOutput.exitCode !== 0) {
      throw new PDRuntimeError('execution_failed', `CLI exited with code ${cliOutput.exitCode}`);
    }

    // OCRA-03/OCRA-04: Parse JSON from stdout
    let parsed: unknown;
    try {
      parsed = JSON.parse(cliOutput.stdout);
    } catch {
      // D-05: Fall back to balanced-fragment extraction
      parsed = extractJson(cliOutput.stdout);
      if (!parsed) {
        // OCRA-04: JSON parse failure → output_invalid
        throw new PDRuntimeError('output_invalid', 'Failed to parse CLI output as JSON');
      }
    }

    // OCRA-03: Validate DiagnosticianOutputV1Schema
    // OCRA-04: Schema mismatch → output_invalid
    if (!Value.Check(DiagnosticianOutputV1Schema, parsed)) {
      throw new PDRuntimeError('output_invalid', 'CLI output does not match DiagnosticianOutputV1 schema');
    }

    return { runId, payload: parsed };
  }

  async cancelRun(runId: string): Promise<void> {
    // For one-shot run: if still in-flight, mark as cancelled
    const state = this.runStateMap.get(runId);
    if (state && !state.completed) {
      state.completed = true;
    }
  }

  async fetchArtifacts(_runId: string): Promise<RuntimeArtifactRef[]> {
    // No artifact refs produced by openclaw-cli adapter directly
    return [];
  }
}
