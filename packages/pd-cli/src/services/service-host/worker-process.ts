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
  /**
   * The run settled before the child's stdio fully closed: a descendant that
   * inherited our pipes kept them open past the drain deadline. The exit
   * facts above come from the 'exit' event, not 'close' — observability for a
   * cleanup leak, never silently a clean finish (CodeRabbit review fix).
   */
  readonly closePending?: boolean;
  /**
   * P2-05 (final-remediation review): honest termination state. `exit` is
   * the direct child leaving the run state; `close` is all stdio released;
   * `terminationConfirmed` is only true when close was observed — when
   * close is pending we cannot claim the process tree is fully gone.
   */
  readonly exitObserved?: boolean;
  readonly closeObserved?: boolean;
  readonly terminationConfirmed?: boolean;
  readonly durationMs: number;
}
const DEFAULT_KILL_GRACE_MS = 5_000;
/** Function indirection keeps the abort check un-narrowed across the two checkpoints. */
function signalAborted(signal: AbortSignal | undefined): boolean {
  return signal?.aborted === true;
}

const DEFAULT_MAX_STDOUT_BYTES = 8 * 1024 * 1024;
const STDERR_TAIL_BYTES = 16 * 1024;
/**
 * How long to keep draining stdio after the child 'exit's before settling.
 * A Worker descendant that inherited our stdout/stderr pipes can otherwise
 * keep 'close' pending FOREVER — after SIGKILL the direct child is dead but
 * the coordinator would hang (and never release the install lock) waiting
 * for a close event that never arrives (CodeRabbit review fix).
 */
const STDIO_DRAIN_DEADLINE_MS = 2_000;

interface RunState {
  settled: boolean;
  exitCode: number | null;
  termSignal: string | null;
  spawnError?: string;
  timedOut: boolean;
  cancelled: boolean;
  sawExit: boolean;
  sawClose: boolean;
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
    const state: RunState = { settled: false, exitCode: null, termSignal: null, timedOut: false, cancelled: false, sawExit: false, sawClose: false };
    // R2 review fix: an already-cancelled signal returns the cancelled
    // outcome BEFORE spawn — otherwise an interrupt delivered between two
    // queued workspaces would still start the next Worker just to kill it.
    if (signalAborted(options.signal)) {
      state.settled = true;
      state.cancelled = true;
      resolve({
        exitCode: null, termSignal: null, stdout: '', stdoutTruncated: false, stderrTail: '',
        timedOut: false, cancelled: true,
        exitObserved: false, closeObserved: false, terminationConfirmed: false,
        durationMs: Date.now() - startedAt,
      });
      return;
    }
    let child: ChildProcess;
    try {
      child = doSpawn(options.nodePath ?? process.execPath, [options.cliEntry, ...options.args], {
        env: options.env,
        stdio: ['ignore', 'pipe', 'pipe'],
        windowsHide: true,
        // P2-05: on POSIX the child becomes a process-group leader so the
        // termination ladder can signal the whole group (same-group
        // descendants are killed with their parent). Windows has no
        // process-group signaling — `taskkill /T` equivalents belong to the
        // platform path; there the direct-child SIGKILL plus the stdio drain
        // deadline are what bound the coordinator, and a detached
        // descendant can outlive the run (recorded via closePending).
        detached: process.platform !== 'win32',
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      resolve({
        exitCode: null, termSignal: null, stdout: '', stdoutTruncated: false, stderrTail: '',
        timedOut: false, cancelled: false, spawnError: `spawn_threw:${message}`,
        exitObserved: false, closeObserved: false, terminationConfirmed: false,
        durationMs: Date.now() - startedAt,
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
    let drainTimer: ReturnType<typeof setTimeout> | undefined;
    let terminated = false;
    // Forward-declared so the terminate ladder and the drain settle can reach
    // each other's helpers without a use-before-define cycle.
    let finish: () => void;
    let scheduleDrainSettle: () => void;

    /**
     * Signal the child's process GROUP when we lead one (POSIX `detached`),
     * falling back to the direct child — ESRCH/EACCES mean the group is
     * already gone or non-signalable, not a kill failure to fabricate over.
     */
    const signalTree = (sig: 'SIGTERM' | 'SIGKILL'): void => {
      if (process.platform !== 'win32' && child.pid !== undefined) {
        try {
          process.kill(-child.pid, sig);
          return;
        } catch {
          // Group already gone — try the direct child anyway.
        }
      }
      try {
        child.kill(sig);
      } catch {
        // Already gone — the close handler will settle.
      }
    };

    const terminate = (timedOut: boolean, cancelled: boolean): void => {
      if (terminated || state.settled) return;
      terminated = true;
      state.timedOut = timedOut;
      state.cancelled = cancelled;
      signalTree('SIGTERM');
      // Bounded forced termination after the grace window (task §8.5), and
      // then a bounded settle even if 'exit' never arrives at all.
      graceTimer = setTimeout(() => {
        signalTree('SIGKILL');
        scheduleDrainSettle();
      }, killGraceMs);
    };

    const onAbort = (): void => {
      terminate(false, true);
    };

    scheduleDrainSettle = (): void => {
      if (drainTimer !== undefined || state.settled) return;
      drainTimer = setTimeout(() => finish(), STDIO_DRAIN_DEADLINE_MS);
    };

    finish = (): void => {
      if (state.settled) return;
      state.settled = true;
      if (deadlineTimer !== undefined) clearTimeout(deadlineTimer);
      if (graceTimer !== undefined) clearTimeout(graceTimer);
      if (drainTimer !== undefined) clearTimeout(drainTimer);
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
        ...(state.sawClose === false ? { closePending: true } : {}),
        // P2-05: report the observed facts, never an inferred "tree dead".
        exitObserved: state.sawExit,
        closeObserved: state.sawClose,
        terminationConfirmed: state.sawClose,
        durationMs: Date.now() - startedAt,
      });
      // Settled without 'close': release our pipe ends so a leaked
      // descendant cannot keep fd handles (and this process) alive.
      child.stdout?.destroy();
      child.stderr?.destroy();
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
    // 'exit' fires on process termination; 'close' additionally waits for
    // the piped stdio to close — which a leaked descendant can delay forever.
    // Capture the exit facts immediately and bound the remaining drain.
    child.on('exit', (code, signal) => {
      state.exitCode = code;
      state.termSignal = signal;
      state.sawExit = true;
      scheduleDrainSettle();
    });
    child.on('close', (code, signal) => {
      state.exitCode = code;
      state.termSignal = signal;
      state.sawClose = true;
      finish();
    });

    if (options.timeoutMs > 0) {
      deadlineTimer = setTimeout(() => terminate(true, false), options.timeoutMs);
    }
    if (signalAborted(options.signal)) {
      terminate(false, true);
    } else {
      options.signal?.addEventListener('abort', onAbort, { once: true });
    }
  });
}
