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
import { mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runCliProcess, type CliOutput } from '../utils/cli-process-runner.js';
import { PDRuntimeError } from '../error-categories.js';
import { DiagnosticianOutputV1Schema } from '../diagnostician-output.js';
import type { StoreEventEmitter} from '../store/event-emitter.js';
import { storeEmitter } from '../store/event-emitter.js';
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

/**
 * OpenClawCliRuntimeAdapterOptions — constructor options for OpenClawCliRuntimeAdapter.
 *
 * Per DPB-09 (LOCKED): No silent fallback. Calling code must specify runtimeMode.
 * Per HG-03 (HARD GATE): --openclaw-local/--openclaw-gateway must be explicit.
 */
export interface OpenClawCliRuntimeAdapterOptions {
  /**
   * Runtime mode — must be explicitly 'local' or 'gateway'.
   * Per DPB-09 (LOCKED): No silent fallback. Calling code must specify.
   * Per HG-03 (HARD GATE): --openclaw-local/--openclaw-gateway must be explicit.
   */
  runtimeMode: 'local' | 'gateway';
  /**
   * PD workspace directory — used as cwd for the CLI process.
   * Per DPB-08 (LOCKED): Three-layer control includes cwd passed to CliProcessRunner.
   * Per HG-02 (HARD GATE): Two distinct boundaries — PD workspace vs OpenClaw workspace.
   * If undefined, runCliProcess uses process.cwd() as default.
   */
  workspaceDir?: string;
  /**
   * Agent ID to invoke when running the diagnostician (default: 'diagnostician').
   * Used in healthCheck to verify the agent is available.
   */
  agentId?: string;
  /**
   * Optional StoreEventEmitter for telemetry event emission.
   * If not provided, falls back to the global storeEmitter singleton.
   */
  eventEmitter?: StoreEventEmitter;
}

interface RunState {
  runId: string;
  startedAt: string;
  cliOutput: CliOutput | null; // null until CLI completes
  completed: boolean;
}

interface MessageFileRef {
  arg: string;
  dir: string;
}

async function writeMessageFile(message: string, workspaceDir?: string): Promise<MessageFileRef> {
  // Write to workspace/.pd/tmp/ so the agent (which runs with workspace cwd) can find it.
  // The agent interprets @path as relative to its working directory, not an absolute path.
  const baseDir = workspaceDir
    ? join(workspaceDir, '.pd', 'tmp')
    : tmpdir();
  await mkdir(baseDir, { recursive: true });
  const filePath = join(baseDir, `msg-${Date.now()}-${Math.random().toString(36).slice(2, 7)}.json`);
  await writeFile(filePath, message, 'utf8');

  // OpenClaw supports --message @file. Forward slashes avoid cmd.exe treating
  // backslashes inside the @file token as escaping/quoting boundaries.
  return { arg: `@${filePath.replace(/\\/g, '/')}`, dir: baseDir };
}

async function cleanupMessageFile(ref: MessageFileRef | undefined): Promise<void> {
  if (!ref) return;
  // Extract the file path from the @arg (e.g. "@D:/workspace/.pd/tmp/msg-123.json" → file path)
  const filePath = ref.arg.replace(/^@/, '');
  try {
    await rm(filePath, { force: true });
  } catch {
    // File may already be gone; ignore cleanup errors
  }
}

/**
 * Parse CliOutput stdout into the runtime's native result structure.
 *
 * OCRA-03 (revised): OpenClaw `--json` produces a CliOutput object (from openclaw's own
 * output.ts), NOT DiagnosticianOutputV1 directly. The LLM's diagnosis JSON lives inside
 * CliOutput.text as a string that may be:
 *
 *  1. Bare DiagnosticianOutputV1 JSON — { "valid": true, ... }
 *  2. Local envelope — { payloads: [{ text: "<json>" }], meta: ... }
 *  3. Gateway envelope — { result: { payloads: [{ text: "<json>" }] }, ... }
 *
 * This function normalises all three into a raw JSON value (string or object) that
 * DiagnosticianOutputV1Schema can validate.
 *
 * @returns The parsed JSON value, or null if stdout could not be parsed at all.
 */
function extractPayloadFromCliOutput(stdout: string, stderr?: string): unknown | null {
  for (const source of [stdout, stderr ?? '']) {
    if (!source) continue;
    // Attempt 1: direct parse — covers case 1 (bare JSON)
    try {
      return JSON.parse(source);
    } catch { /* fall through */ }

    // Attempt 2: balanced-bracket extraction — handles text that surrounds JSON.
    // When multiple JSON objects are present (e.g. probe message + agent response in
    // stderr), return the LAST complete object — the agent's response comes after the
    // probe message that was injected into the session.
    const objects: unknown[] = [];
    let depth = 0;
    let start = -1;
    for (let i = 0; i < source.length; i++) {
      const ch = source[i];
      if (!ch) continue;
      if (ch === '{') {
        if (start === -1) start = i;
        depth++;
      } else if (ch === '}') {
        depth--;
        if (depth === 0 && start !== -1) {
          try {
            objects.push(JSON.parse(source.slice(start, i + 1)));
          } catch { /* keep scanning */ }
          start = -1;
        }
      }
    }
    if (objects.length > 0) return objects[objects.length - 1];
  }

  return null;
}
/**
 * Search for a single JSON object literal inside `text` using a balanced-bracket
 * scan. Returns the parsed object, or null if no valid object is found.
 */
function extractJsonObject(text: string): unknown | null {
  let depth = 0;
  let start = -1;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (ch === '{') {
      if (start === -1) start = i;
      depth++;
    } else if (ch === '}') {
      depth--;
      if (depth === 0 && start !== -1) {
        try {
          return JSON.parse(text.slice(start, i + 1));
        } catch { /* keep scanning */ }
        start = -1;
      }
    }
  }
  return null;
}

/**
 * Navigate the three possible envelope shapes to find the payload text that
 * contains the DiagnosticianOutputV1 JSON string.
 *
 * Returns the parsed JSON object (not a string) if extraction succeeds,
 * or null if the envelope structure doesn't match any known shape.
 */
function extractDiagnosisFromEnvelope(parsed: unknown): unknown | null {
  if (typeof parsed !== 'object' || parsed === null) {
    return null;
  }

  // Case 2: local envelope — { payloads: [{ text: "<json>" }] }
  const asLocal = parsed as { payloads?: { text?: unknown }[] };
  if (Array.isArray(asLocal.payloads) && asLocal.payloads.length > 0) {
    const [first] = asLocal.payloads;
    if (first && typeof first.text === 'string') {
      const inner = first.text.trim();
      try {
        return JSON.parse(inner);
      } catch { /* fall through — try prose extraction */ }
      const extracted = extractJsonObject(inner);
      if (extracted !== null) return extracted;
    }
  }

  // Case 3: gateway envelope — { result: { payloads: [{ text: "<json>" }] } }
  const asGateway = parsed as { result?: { payloads?: { text?: unknown }[] } };
  if (
    asGateway.result &&
    typeof asGateway.result === 'object' &&
    Array.isArray(asGateway.result.payloads) &&
    asGateway.result.payloads.length > 0
  ) {
    const [first] = asGateway.result.payloads;
    if (first && typeof first.text === 'string') {
      const inner = first.text.trim();
      try {
        return JSON.parse(inner);
      } catch { /* fall through */ }
      const extracted = extractJsonObject(inner);
      if (extracted !== null) return extracted;
    }
  }

  // No matching envelope shape
  return null;
}

/**
 * Extract the inner result object from an OpenClaw agent response envelope.
 *
 * OpenClaw `--json --local` wraps the agent's response text inside an envelope:
 *   Case A — local envelope:  { payloads: [{ text: "<json or prose>" }] }
 *   Case B — gateway envelope: { result: { payloads: [{ text: "<json or prose>" }] } }
 *   Case C — bare object:     { ok: true }   (no envelope, direct response)
 *
 * The inner text may be bare JSON (`{"ok":true}`) or wrapped in a small amount
 * of prose that surrounds the JSON. We balance-bracket extract to find the JSON
 * object within the text, then return the parsed result.
 *
 * Returns the parsed inner object on success, or null if extraction fails.
 */
function extractProbeResult(parsed: unknown): unknown | null {
  // Case A: local envelope — { payloads: [{ text: "..." }] }
  const asLocal = parsed as { payloads?: { text?: unknown }[] };
  if (Array.isArray(asLocal.payloads) && asLocal.payloads.length > 0) {
    const [first] = asLocal.payloads;
    if (first && typeof first.text === 'string') {
      const inner = first.text.trim();
      try {
        return JSON.parse(inner);
      } catch { /* fall through — try prose extraction */ }
      const extracted = extractJsonObject(inner);
      if (extracted !== null) return extracted;
    }
  }

  // Case B: gateway envelope — { result: { payloads: [{ text: "..." }] } }
  const asGateway = parsed as { result?: { payloads?: { text?: unknown }[] } };
  if (
    asGateway.result &&
    typeof asGateway.result === 'object' &&
    Array.isArray(asGateway.result.payloads) &&
    asGateway.result.payloads.length > 0
  ) {
    const [first] = asGateway.result.payloads;
    if (first && typeof first.text === 'string') {
      const inner = first.text.trim();
      try {
        return JSON.parse(inner);
      } catch { /* fall through */ }
      const extracted = extractJsonObject(inner);
      if (extracted !== null) return extracted;
    }
  }

  // Case C: bare object — already the result
  if (typeof parsed === 'object' && parsed !== null) {
    return parsed;
  }

  return null;
}

export class OpenClawCliRuntimeAdapter implements PDRuntimeAdapter {
  private readonly runStateMap = new Map<string, RunState>();
  private readonly runtimeMode: 'local' | 'gateway';
  private readonly workspaceDir?: string;
  private readonly agentId: string;
  private readonly eventEmitter: StoreEventEmitter;

  constructor(options: OpenClawCliRuntimeAdapterOptions) {
    this.runtimeMode = options.runtimeMode;
    this.workspaceDir = options.workspaceDir;
    this.agentId = options.agentId ?? 'diagnostician';
    this.eventEmitter = options.eventEmitter ?? storeEmitter;
  }

  // OCRA-01: kind() returns RuntimeKind literal 'openclaw-cli'
  // eslint-disable-next-line @typescript-eslint/class-methods-use-this
  kind(): RuntimeKind {
    return 'openclaw-cli';
  }

  // eslint-disable-next-line @typescript-eslint/class-methods-use-this
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

  /**
   * Probe runtime health by running a minimal openclaw command.
   *
   * Verifies:
   *  1. openclaw binary is executable (run `openclaw --version`)
   *  2. The configured agent is available (run `openclaw agents list --json`)
   *  3. The agent can actually respond (one-shot minimal probe with --agent)
   *
   * Returns healthy=false with appropriate error category when checks fail.
   * Per DPB-09: No silent fallback — failures are reported accurately.
   * Per P1 hard gate: Binary-only check is insufficient; must verify real invocation.
   */
  async healthCheck(): Promise<RuntimeHealth> {
    const warnings: string[] = [];
    let healthy = true;
    let degraded = false;

    // Probe 1: verify openclaw binary is executable
    try {
      const versionResult = await runCliProcess({
        command: 'openclaw',
        args: ['--version'],
        cwd: this.workspaceDir,
        timeoutMs: 10_000,
      });

      if (versionResult.spawnError === 'ENOENT') {
        return {
          healthy: false,
          degraded: false,
          warnings: ['openclaw binary not found'],
          lastCheckedAt: new Date().toISOString(),
        };
      }

      if (versionResult.spawnError === 'EACCES' || versionResult.spawnError === 'EMFILE') {
        return {
          healthy: false,
          degraded: false,
          warnings: [`openclaw binary not executable: ${versionResult.spawnError}`],
          lastCheckedAt: new Date().toISOString(),
        };
      }

      if (versionResult.timedOut) {
        return {
          healthy: false,
          degraded: false,
          warnings: ['openclaw --version timed out'],
          lastCheckedAt: new Date().toISOString(),
        };
      }

      if (versionResult.exitCode !== null && versionResult.exitCode !== 0) {
        degraded = true;
        warnings.push(`openclaw --version exited with code ${versionResult.exitCode}`);
      }
    } catch (err) {
      return {
        healthy: false,
        degraded: false,
        warnings: [err instanceof Error ? err.message : String(err)],
        lastCheckedAt: new Date().toISOString(),
      };
    }

    // Probe 2: verify the configured agent is available via agents list
    // P1 fix: Must verify agent exists, not just the binary
    // Using `openclaw agents list --json` to check if agentId is registered
    try {
      const listArgs = ['agents', 'list', '--json'];
      if (this.runtimeMode === 'local') {
        listArgs.push('--local');
      }

      const listResult = await runCliProcess({
        command: 'openclaw',
        args: listArgs,
        cwd: this.workspaceDir,
        timeoutMs: 15_000,
      });

      if (listResult.spawnError === 'ENOENT') {
        return {
          healthy: false,
          degraded: false,
          warnings: ['openclaw binary not found'],
          lastCheckedAt: new Date().toISOString(),
        };
      }

      if (listResult.spawnError === 'EACCES' || listResult.spawnError === 'EMFILE') {
        return {
          healthy: false,
          degraded: false,
          warnings: [`openclaw binary not executable: ${listResult.spawnError}`],
          lastCheckedAt: new Date().toISOString(),
        };
      }

      if (listResult.timedOut) {
        degraded = true;
        warnings.push(`openclaw agents list timed out`);
      } else if (listResult.exitCode !== null && listResult.exitCode !== 0) {
        // agents list failed — degraded state
        degraded = true;
        warnings.push(`openclaw agents list exited with code ${listResult.exitCode}`);
      } else {
        // Parse agent list and check if target agent exists
        // The output may contain config warnings/ANSI codes before the JSON array
        try {
          const jsonStart = listResult.stdout.indexOf('[');
          if (jsonStart === -1) throw new Error('No JSON array found');
          const jsonStr = listResult.stdout.slice(jsonStart);
          const parsed = JSON.parse(jsonStr);
          // agents list returns an array of agent objects (each with an `id` field)
          const agentIds: string[] = parsed.map((a: unknown) =>
            typeof a === 'string' ? a : (a as { id?: string }).id
          );

          if (!agentIds.includes(this.agentId)) {
            healthy = false;
            warnings.push(`agent '${this.agentId}' not found in agents list`);
          }
        } catch {
          // JSON parse failed — cannot verify agent, treat as degraded
          degraded = true;
          warnings.push(`failed to parse agents list output`);
        }
      }
    } catch (err) {
      // Any error in the agent probe is a hard failure
      return {
        healthy: false,
        degraded: false,
        warnings: [err instanceof Error ? err.message : String(err)],
        lastCheckedAt: new Date().toISOString(),
      };
    }

    // Probe 3: One-shot minimal agent invocation (P1 hard gate)
    // Verifies the agent can actually respond, not just that it exists in the list.
    // This catches plugin loading failures, permission issues, etc.
    let probeMessageRef: MessageFileRef | undefined = undefined;
    try {
      // Unique session ID for probe to avoid lock conflicts with concurrent runs
      const probeSessionId = `pd-runtime-probe-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
      probeMessageRef = await writeMessageFile(JSON.stringify({ probe: 'pd-runtime-v2', instruction: 'reply with {"ok":true} only' }), this.workspaceDir);
      const probeArgs = [
        'agent',
        '--agent', this.agentId,
        '--message', probeMessageRef.arg,
        '--session-id', probeSessionId,
        '--timeout', '240',
        '--json',
      ];
      if (this.runtimeMode === 'local') {
        probeArgs.push('--local');
      }

      const probeResult = await runCliProcess({
        command: 'openclaw',
        args: probeArgs,
        cwd: this.workspaceDir,
        timeoutMs: 240_000, // 240s — agent init + bootstrap + skill loading can take >60s on cold start
      });

      if (probeResult.spawnError === 'ENOENT') {
        return {
          healthy: false,
          degraded: false,
          warnings: ['openclaw binary not found'],
          lastCheckedAt: new Date().toISOString(),
        };
      }

      if (probeResult.spawnError === 'EACCES' || probeResult.spawnError === 'EMFILE') {
        return {
          healthy: false,
          degraded: false,
          warnings: [`openclaw binary not executable: ${probeResult.spawnError}`],
          lastCheckedAt: new Date().toISOString(),
        };
      }

      if (probeResult.timedOut) {
        return {
          healthy: false,
          degraded: false,
          warnings: ['openclaw agent probe timed out'],
          lastCheckedAt: new Date().toISOString(),
        };
      }

      if (probeResult.exitCode !== null && probeResult.exitCode !== 0) {
        return {
          healthy: false,
          degraded: false,
          warnings: [
            `openclaw agent '${this.agentId}' probe failed with exit code ${probeResult.exitCode}`,
            ...(probeResult.stderr ? [`stderr: ${probeResult.stderr.substring(0, 2000)}`] : []),
          ],
          lastCheckedAt: new Date().toISOString(),
        };
      }

      // exit code 0 — verify the output is parseable JSON
      const rawParsed = extractPayloadFromCliOutput(probeResult.stdout, probeResult.stderr);
      if (rawParsed === null) {
        return {
          healthy: false,
          degraded: false,
          warnings: ['openclaw agent probe produced unparseable output'],
          lastCheckedAt: new Date().toISOString(),
        };
      }

      // Extract the inner result from the OpenClaw envelope and verify {ok: true}
      const result = extractProbeResult(rawParsed);
      if (
        typeof result !== 'object' ||
        result === null ||
        !('ok' in result) ||
        (result as { ok?: unknown }).ok !== true
      ) {
        const excerpt =
          rawParsed && typeof rawParsed === 'object'
            ? JSON.stringify(rawParsed).substring(0, 2000)
            : String(rawParsed).substring(0, 2000);
        return {
          healthy: false,
          degraded: false,
          warnings: [
            `openclaw agent '${this.agentId}' probe returned unexpected result: ${excerpt}`,
          ],
          lastCheckedAt: new Date().toISOString(),
        };
      }
    } catch (err) {
      return {
        healthy: false,
        degraded: false,
        warnings: [err instanceof Error ? err.message : String(err)],
        lastCheckedAt: new Date().toISOString(),
      };
    } finally {
      await cleanupMessageFile(probeMessageRef);
    }

    return {
      healthy,
      degraded,
      warnings,
      lastCheckedAt: new Date().toISOString(),
    };
  }

  /**
   * Map CLI output to telemetry event type and error category.
   */
  private static mapCliResultToTelemetry(cliOutput: CliOutput): {
    telemetryEventType: 'runtime_invocation_succeeded' | 'runtime_invocation_failed';
    errorCategory: string | undefined;
    stderrExcerpt: string | undefined;
  } {
    // spawnError is set by runCliProcess on ENOENT/EACCES/EMFILE — use it
    if (cliOutput.spawnError === 'ENOENT') {
      return { telemetryEventType: 'runtime_invocation_failed', errorCategory: 'runtime_unavailable', stderrExcerpt: cliOutput.stderr };
    }
    if (cliOutput.spawnError === 'EACCES' || cliOutput.spawnError === 'EMFILE') {
      return { telemetryEventType: 'runtime_invocation_failed', errorCategory: 'execution_failed', stderrExcerpt: cliOutput.stderr };
    }
    if (cliOutput.timedOut) {
      return { telemetryEventType: 'runtime_invocation_failed', errorCategory: 'timeout', stderrExcerpt: cliOutput.stderr };
    }
    if (cliOutput.exitCode !== null && cliOutput.exitCode !== 0) {
      return { telemetryEventType: 'runtime_invocation_failed', errorCategory: 'execution_failed', stderrExcerpt: cliOutput.stderr };
    }
    return { telemetryEventType: 'runtime_invocation_succeeded', errorCategory: undefined, stderrExcerpt: undefined };
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
    const messageRef = await writeMessageFile(jsonPayload, this.workspaceDir);

    // DPB-09 (LOCKED): --local only passed when runtimeMode === 'local'
    // HG-03 (HARD GATE): No silent fallback — must be explicit
    // Unique session ID per run — avoids session lock conflicts and context pollution
    // between concurrent or sequential PD diagnostician runs on the same agent.
    const sessionId = `pd-runtime-${runId}`;
    const args = [
      'agent',
      '--agent', agentId,
      '--message', messageRef.arg,
      '--session-id', sessionId,
      '--json',
    ];

    if (this.runtimeMode === 'local') {
      args.push('--local');
    }

    args.push('--timeout', String(timeoutSeconds));

    // DPB-08 (LOCKED): Pass workspaceDir as cwd for workspace boundary control
    // HG-02 (HARD GATE): Two distinct boundaries — cwd controls PD workspace
    // TELE-02: runtime_invocation_started — CLI process about to spawn
    this.eventEmitter.emitTelemetry({
      eventType: 'runtime_invocation_started',
      traceId: input.taskRef?.taskId ?? runId,
      timestamp: new Date().toISOString(),
      sessionId: 'openclaw-cli-adapter',
      agentId: 'openclaw-cli-adapter',
      payload: {
        runId,
        runtimeKind: 'openclaw-cli',
        runtimeMode: this.runtimeMode,
        timeoutMs: input.timeoutMs,
      },
    });

    const cliOutput: CliOutput = await (async () => {
      try {
        return await runCliProcess({
          command: 'openclaw',
          args,
          cwd: this.workspaceDir,
          timeoutMs: input.timeoutMs,
        });
      } finally {
        await cleanupMessageFile(messageRef);
      }
    })();

    // Store result in memory
    state.cliOutput = cliOutput;
    state.completed = true;

    // TELE-03: runtime_invocation_succeeded/failed — CLI process completed
    const endedAt = new Date().toISOString();
    const { telemetryEventType, errorCategory, stderrExcerpt } = OpenClawCliRuntimeAdapter.mapCliResultToTelemetry(cliOutput);

    this.eventEmitter.emitTelemetry({
      eventType: telemetryEventType,
      traceId: input.taskRef?.taskId ?? runId,
      timestamp: endedAt,
      sessionId: 'openclaw-cli-adapter',
      agentId: 'openclaw-cli-adapter',
      payload: {
        runId,
        runtimeKind: 'openclaw-cli',
        runtimeMode: this.runtimeMode,
        exitCode: cliOutput.exitCode,
        timedOut: cliOutput.timedOut,
        ...(errorCategory ? { errorCategory } : {}),
        ...(stderrExcerpt ? { stderrExcerpt } : {}),
      },
    });

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
      const stderrExcerpt = cliOutput.stderr
        ? cliOutput.stderr.substring(0, 2000)
        : undefined;
      return {
        runId,
        status: 'failed',
        startedAt: state.startedAt,
        endedAt: new Date().toISOString(),
        reason: stderrExcerpt
          ? `CLI exited with code ${cliOutput.exitCode}. stderr: ${stderrExcerpt}`
          : `CLI exited with code ${cliOutput.exitCode}`,
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
    // spawnError is set explicitly by runCliProcess when spawn fails
    if (cliOutput.spawnError === 'ENOENT') {
      throw new PDRuntimeError('runtime_unavailable', 'openclaw binary not found');
    }

    // OCRA-04: Map timeout to timeout
    if (cliOutput.timedOut) {
      throw new PDRuntimeError('timeout', 'CLI timeout exceeded');
    }

    // OCRA-04: Map non-zero exit to execution_failed
    if (cliOutput.exitCode !== null && cliOutput.exitCode !== 0) {
      const stderrExcerpt = cliOutput.stderr
        ? cliOutput.stderr.substring(0, 2000)
        : undefined;
      throw new PDRuntimeError(
        'execution_failed',
        stderrExcerpt
          ? `CLI exited with code ${cliOutput.exitCode}. stderr: ${stderrExcerpt}`
          : `CLI exited with code ${cliOutput.exitCode}`,
      );
    }

    // OCRA-03: Parse CliOutput — the stdout may be raw JSON, or wrapped in an OpenClaw envelope
    // (local or gateway). First extract the JSON value, then navigate to the diagnosis JSON.
    // eslint-disable-next-line @typescript-eslint/init-declarations
    let parsed: unknown;
    const rawParsed = extractPayloadFromCliOutput(cliOutput.stdout, cliOutput.stderr);
    if (rawParsed !== null) {
      // Try envelope extraction first (cases 2 and 3)
      const fromEnvelope = extractDiagnosisFromEnvelope(rawParsed);
      parsed = fromEnvelope ?? rawParsed;
    } else {
      parsed = null;
    }

    if (parsed === null) {
      // OCRA-04: JSON parse failure → output_invalid
      throw new PDRuntimeError('output_invalid', 'Failed to parse CLI output as JSON');
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

  // eslint-disable-next-line @typescript-eslint/class-methods-use-this
  async fetchArtifacts(_runId: string): Promise<RuntimeArtifactRef[]> {
    // No artifact refs produced by openclaw-cli adapter directly
    return [];
  }
}
