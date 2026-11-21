/**
 * Bounded Worker-subprocess execution (TD §5.3, SPEC §8.2 step 5).
 *
 * One `pd <host> worker --once --json --workspace <dir>` child, executed with
 * a hard per-workspace deadline and a caller-supplied AbortSignal:
 *
 *   deadline / abort → SIGTERM → bounded grace → SIGKILL.
 *
 * The run-once Worker is bounded by construction (it exits after one cycle),
 * so the terminate ladder only fires on hangs; a killed Worker leaves its
 * task lease to the EXISTING Lease TTL / Recovery Sweep — this module never
 * fabricates a success, releases a foreign lease, or writes task state
 * (SPEC §9: at-least-once + existing recovery).
 *
 * Output is bounded: stdout is capped (the `--json --once` contract is one
 * document; a runaway stream is truncated and the parse downstream fails
 * closed), stderr is kept as a bounded tail for diagnostics.
 */
import { spawn, type ChildProcess } from 'node:child_process';

export interface WorkerProcessOptions {
  /** Node executable (default: this process's Node). */
  readonly nodePath?: string;
  /** Absolute CLI entry inside the active release install (never a worktree). */
  readonly cliEntry: string;
  /** CLI arguments after the entry (e.g. ['codex','worker','--once',...]). */
  readonly args: readonly string[];
  /** Pre-built allowlist environment (worker-env.ts). */
  readonly env: Record<string, string | undefined>;
  /** Hard deadline for the whole child, in ms. */
  readonly timeoutMs: number;
  /** Caller cancellation (e.g. CLI interrupt). */
  readonly signal?: AbortSignal;
  /** Grace between SIGTERM and SIGKILL (default 5s). */
  readonly killGraceMs?: number;
  /** stdout cap in bytes (default 8 MiB). */
  readonly maxStdoutBytes?: number;
  /** Test injection for the spawn boundary. */
  readonly spawnFn?: typeof spawn;
}

export interface WorkerProcessResult {
  readonly exitCode: number | null;
  readonly termSignal: string | null;
  readonly stdout: string;
  readonly stdoutTruncated: boolean;
  readonly stderrTail: string;
  /** The deadline fired and the ladder ran. */
  readonly timedOut: boolean;
  /** The caller's AbortSignal fired. */
  readonly cancelled: boolean;
  /** Structured spawn failure (ENOENT/EACCES on node or entry) — never a fake exit. */
  readonly spawnError?: string;
  readonly durationMs: number;
}
const DEFAULT_KILL_GRACE_MS = 5_000;
const DEFAULT_MAX_STDOUT_BYTES = 8 * 1024 * 1024;
const STDERR_TAIL_BYTES = 16 * 1024;

interface RunState {
  settled: boolean;
  exitCode: number | null;
  termSignal: string | null;
  spawnError?: string;
  timedOut: boolean;
  cancelled: boolean;
}

/**
 * Execute one bounded Worker child. Never throws for process-level
 * failures — every outcome is a structured result (rc-9).
 */
export function runWorkerProcess(options: WorkerProcessOptions): Promise<WorkerProcessResult> {
  const startedAt = Date.now();
  const killGraceMs = options.killGraceMs ?? DEFAULT_KILL_GRACE_MS;
  const maxStdoutBytes = options.maxStdoutBytes ?? DEFAULT_MAX_STDOUT_BYTES;
  const doSpawn = options.spawnFn ?? spawn;

  return new Promise<WorkerProcessResult>((resolve) => {
    const state: RunState = { settled: false, exitCode: null, termSignal: null, timedOut: false, cancelled: false };
    let child: ChildProcess;
    try {
      child = doSpawn(options.nodePath ?? process.execPath, [options.cliEntry, ...options.args], {
        env: options.env,
        stdio: ['ignore', 'pipe', 'pipe'],
        windowsHide: true,
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      resolve({
        exitCode: null, termSignal: null, stdout: '', stdoutTruncated: false, stderrTail: '',
        timedOut: false, cancelled: false, spawnError: `spawn_threw:${message}`, durationMs: Date.now() - startedAt,
      });
      return;
    }

    let stdoutBytes = 0;
    let stdoutChunks: Buffer[] = [];
    let stdoutTruncated = false;
    let stderrWindow: Buffer[] = [];
    let stderrBytes = 0;
    let graceTimer: ReturnType<typeof setTimeout> | undefined;
    let deadlineTimer: ReturnType<typeof setTimeout> | undefined;
    let terminated = false;

    const terminate = (timedOut: boolean, cancelled: boolean): void => {
      if (terminated || state.settled) return;
      terminated = true;
      state.timedOut = timedOut;
      state.cancelled = cancelled;
      try {
        child.kill('SIGTERM');
      } catch {
        // Already gone — the close handler will settle.
      }
      // Bounded forced termination after the grace window (task §8.5).
      graceTimer = setTimeout(() => {
        try {
          child.kill('SIGKILL');
        } catch {
          // Already gone.
        }
      }, killGraceMs);
    };

    const onAbort = (): void => {
      terminate(false, true);
    };

    const finish = (): void => {
      if (state.settled) return;
      state.settled = true;
      if (deadlineTimer !== undefined) clearTimeout(deadlineTimer);
      if (graceTimer !== undefined) clearTimeout(graceTimer);
      options.signal?.removeEventListener('abort', onAbort);
      resolve({
        exitCode: state.exitCode,
        termSignal: state.termSignal,
        stdout: Buffer.concat(stdoutChunks).toString('utf8'),
        stdoutTruncated,
        stderrTail: Buffer.concat(stderrWindow).toString('utf8'),
        timedOut: state.timedOut,
        cancelled: state.cancelled,
        ...(state.spawnError !== undefined ? { spawnError: state.spawnError } : {}),
        durationMs: Date.now() - startedAt,
      });
    };

    child.on('error', (error: Error & { code?: string }) => {
      state.spawnError = `spawn_error:${error.code ?? error.message}`;
      finish();
    });
    child.stdout?.on('data', (chunk: Buffer) => {
      if (stdoutBytes + chunk.length > maxStdoutBytes) {
        const remaining = maxStdoutBytes - stdoutBytes;
        if (remaining > 0) stdoutChunks.push(chunk.subarray(0, remaining));
        stdoutBytes = maxStdoutBytes;
        stdoutTruncated = true;
        return;
      }
      stdoutBytes += chunk.length;
      stdoutChunks.push(chunk);
    });
    child.stderr?.on('data', (chunk: Buffer) => {
      stderrWindow.push(chunk);
      stderrBytes += chunk.length;
      while (stderrBytes > STDERR_TAIL_BYTES && stderrWindow.length > 1) {
        stderrBytes -= stderrWindow[0]?.length ?? 0;
        stderrWindow.shift();
      }
    });
    child.on('close', (code, signal) => {
      state.exitCode = code;
      state.termSignal = signal;
      finish();
    });

    if (options.timeoutMs > 0) {
      deadlineTimer = setTimeout(() => terminate(true, false), options.timeoutMs);
    }
    if (options.signal?.aborted === true) {
      terminate(false, true);
    } else {
      options.signal?.addEventListener('abort', onAbort, { once: true });
    }
  });
}
