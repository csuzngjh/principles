/**
 * CliProcessRunner — generic child process runner with timeout, graceful tree kill,
 * env merge, and no shell injection.
 *
 * Purpose: Foundation utility consumed by OpenClawCliRuntimeAdapter (m6-02).
 * Runs arbitrary CLI commands, captures stdout/stderr, and handles timeouts with
 * graceful tree kill (SIGTERM → grace period → SIGKILL).
 */
import { spawn, type SpawnOptions } from 'child_process';

export interface CliProcessRunnerOptions {
  command: string;
  args?: string[];
  cwd?: string;
  env?: Record<string, string>;
  timeoutMs?: number;
  killGracePeriodMs?: number;
}

export type SpawnErrorCode = 'ENOENT' | 'EACCES' | 'EMFILE' | 'UNKNOWN';

export interface CliOutput {
  stdout: string;
  stderr: string;
  exitCode: number | null;
  timedOut: boolean;
  durationMs: number;
  /**
   * Explicit spawn error type. Set when proc.on('error') is called with
   * ENOENT (binary not found), EACCES (permission denied), EMFILE (too many open files),
   * or other errors. Use this instead of parsing stderr for error detection.
   */
  spawnError?: SpawnErrorCode;
}

/**
 * Run a CLI process with timeout, graceful tree kill, and env merge.
 *
 * @param opts.command - Non-empty path to the binary to run (validated)
 * @param opts.args - Array of string arguments (no shell injection, shell: false)
 * @param opts.cwd - Working directory for the child process
 * @param opts.env - Environment variables (merged with parent process.env)
 * @param opts.timeoutMs - Optional timeout in ms; if exceeded the process tree is killed
 * @param opts.killGracePeriodMs - Grace period between SIGTERM and SIGKILL (default 3000ms)
 * @returns CliOutput with captured stdout, stderr, exitCode, timedOut flag, and durationMs
 */
export async function runCliProcess(opts: CliProcessRunnerOptions): Promise<CliOutput> {
  // ── Input validation ──────────────────────────────────────────────────────
  if (typeof opts.command !== 'string' || opts.command.trim() === '') {
    throw new TypeError('opts.command must be a non-empty string');
  }

  const {command} = opts;
  const args = opts.args ?? [];
  const {cwd} = opts;
  const {timeoutMs} = opts;
  const killGracePeriodMs = opts.killGracePeriodMs ?? 3000;

  // ── Env merge ─────────────────────────────────────────────────────────────
  const env: Record<string, string> = Object.assign({}, process.env, opts.env ?? {});

  // ── Output capture ────────────────────────────────────────────────────────
  let stdout = '';
  let stderr = '';

  // ── Spawn ─────────────────────────────────────────────────────────────────
  const proc = spawn(command, args, {
    cwd,
    env,
    shell: false,
    detached: true,
  } satisfies SpawnOptions);

  // Attach data handlers BEFORE spawning so we don't miss any output
  proc.stdout?.on('data', (chunk: Buffer) => {
    stdout += chunk.toString();
  });

  proc.stderr?.on('data', (chunk: Buffer) => {
    stderr += chunk.toString();
  });

  const startedAt = Date.now();

  // ── Timeout handling ──────────────────────────────────────────────────────
  let timeoutHandle: ReturnType<typeof setTimeout> | null = null;
  let killGraceHandle: ReturnType<typeof setTimeout> | null = null;
  // Flag set when timeout fires; consulted in close/error handlers to set timedOut correctly
  let timedOut = false;

  function killProcessTree(): void {
    const {pid} = proc;
    if (pid === null || pid === undefined) return;

    if (process.platform === 'win32') {
      // Windows: use taskkill with /T (kill process tree) and /F (force)
      spawn('taskkill', ['/PID', String(pid), '/T', '/F']);
    } else {
      // Unix: send SIGTERM to the process group (negative pid = whole group)
      try {
        process.kill(-pid, 'SIGTERM');
      } catch {
        // Process may have already exited
      }
    }
  }

  function cancelTimers(): void {
    if (timeoutHandle !== null) {
      clearTimeout(timeoutHandle);
      timeoutHandle = null;
    }
    if (killGraceHandle !== null) {
      clearTimeout(killGraceHandle);
      killGraceHandle = null;
    }
  }

  if (timeoutMs != null) {
    timeoutHandle = setTimeout(() => {
      // Mark timedOut=true FIRST so close/error handlers know the process was killed by timeout
      timedOut = true;
      // First, attempt graceful termination
      killProcessTree();

      // Then schedule SIGKILL after grace period (only on non-Windows)
      if (process.platform !== 'win32') {
        const {pid} = proc;
        killGraceHandle = setTimeout(() => {
          if (pid != null) {
            try {
              process.kill(-pid, 'SIGKILL');
            } catch {
              // Already exited
            }
          }
        }, killGracePeriodMs);
      }
    }, timeoutMs);
  }

  // ── Completion promise ─────────────────────────────────────────────────────
  return new Promise<CliOutput>((resolve) => {
    let resolved = false;

    function resolveOnce(output: CliOutput): void {
      if (!resolved) {
        resolved = true;
        cancelTimers();
        resolve(output);
      }
    }

    proc.on('close', (code: number | null) => {
      const durationMs = Date.now() - startedAt;
      resolveOnce({
        stdout,
        stderr,
        // When killed by timeout, exitCode is non-null (OS-level kill exit code).
        // Normal exit uses the actual code; timeout kills set exitCode=null per CliOutput contract.
        exitCode: timedOut ? null : code,
        timedOut,
        durationMs,
      });
    });

    proc.on('error', (err: Error) => {
      // ENOENT, EACCES, EMFILE, etc. — resolve with null exit code and empty output
      // so callers can handle "command not found" gracefully
      const durationMs = Date.now() - startedAt;
      const errWithCode = err as Error & { code?: string };
      // Map common spawn error codes to explicit spawnError field
      let spawnError: SpawnErrorCode | undefined;
      if (errWithCode.code === 'ENOENT') {
        spawnError = 'ENOENT';
      } else if (errWithCode.code === 'EACCES') {
        spawnError = 'EACCES';
      } else if (errWithCode.code === 'EMFILE') {
        spawnError = 'EMFILE';
      } else if (errWithCode.code) {
        spawnError = 'UNKNOWN';
      }
      resolveOnce({
        stdout: '',
        stderr: errWithCode.code ? `ENOENT: ${errWithCode.code}` : err.message,
        exitCode: null,
        timedOut,
        durationMs,
        spawnError,
      });
    });
  });
}
