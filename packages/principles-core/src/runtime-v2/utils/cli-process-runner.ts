/**
 * CliProcessRunner — generic child process runner with timeout, graceful tree kill,
 * env merge, and no shell injection.
 *
 * Purpose: Foundation utility consumed by OpenClawCliRuntimeAdapter (m6-02).
 * Runs arbitrary CLI commands, captures stdout/stderr, and handles timeouts with
 * graceful tree kill (SIGTERM → grace period → SIGKILL).
 */
import { spawn, execSync, type SpawnOptions } from 'child_process';

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
 * Resolve a command on Windows when it may be a npm shim (.cmd/.bat/.exe).
 *
 * On Windows, `spawn('openclaw', [], {shell:false})` fails with ENOENT because
 * Node's spawn() with shell:false does not consult the PATHEXT associations that
 * cmd.exe uses. `where.exe` (equivalent to `which` on Unix) resolves the actual
 * executable path including .cmd/.bat shims created by npm.
 *
 * When running under Git Bash (MSYS), `where.exe` returns Unix-style paths
 * (e.g. /c/Users/.../openclaw) which spawn() cannot use. This function converts
 * them to Windows paths and prefers Windows-native executables (.cmd, .bat, .exe).
 *
 * @returns The resolved command path, or the original if not Windows or already absolute.
 */
function resolveCommandForWindows(command: string): string {
  if (process.platform !== 'win32') {
    return command;
  }
  // If the command already contains a path separator, it is already resolved
  if (command.includes('/') || command.includes('\\')) {
    return command;
  }

  try {
    // Use where.exe to resolve the command — works for .cmd, .bat, .exe shims
    const result = execSync(`where.exe ${command}`, {
      encoding: 'utf-8',
      timeout: 5000,
      windowsHide: true,
    });
    // where.exe returns all matches, one per line
    const lines = result.split('\n').map((l: string) => l.trim()).filter(Boolean);

    // Prefer Windows-native executables (.cmd, .bat, .exe) over Unix scripts
    const windowsNative = lines.find((l: string) => /\.(cmd|bat|exe)$/i.test(l));
    if (windowsNative) {
      return windowsNative;
    }

    // No Windows-native result found. The first line may be a Unix-style path
    // (e.g. /c/Users/.../openclaw) returned by Git Bash's where.exe.
    // Convert it to a Windows absolute path so spawn() can use it.
    if (lines.length > 0) {
      const firstResult = lines[0] ?? command;
      // Convert MSYS/Git Bash Unix-style path to Windows path
      // /c/Users/... → C:\Users\...
      // /d/Program Files/... → D:\Program Files\...
      if (/^[A-Z]:/i.test(firstResult)) {
        // Already a Windows absolute path (e.g. C:\Users\...)
        return firstResult;
      }
      if (/^\/[a-z]\//i.test(firstResult)) {
        // MSYS Unix-style path: /c/Users/... → C:\Users\...
        const msysPath = /** @type {string} */ (firstResult);
        const driveLetter = msysPath[1] ?? 'C';
        const winPath = driveLetter.toUpperCase() + ':' + msysPath.slice(2).replace(/\//g, '\\');
        return winPath;
      }
      return firstResult;
    }
  } catch {
    // where.exe failed — fall through to original command
  }

  return command;
}

function quoteWindowsCmdArg(arg: string): string {
  if (arg === '') return '""';
  if (!/[\s"&|<>^()]/.test(arg)) return arg;

  // This path is only used for Windows .cmd/.bat shims. Keep quoting narrow:
  // wrap the token and escape cmd metacharacters so argv boundaries survive
  // without turning arbitrary args into shell syntax.
  return `"${arg.replace(/(["&|<>^])/g, '^$1')}"`;
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
  const rawArgs = opts.args ?? [];
  if (!Array.isArray(rawArgs) || rawArgs.some((a) => typeof a !== 'string')) {
    throw new TypeError('opts.args must be an array of strings');
  }
  const args = rawArgs;
  const {cwd} = opts;
  const {timeoutMs} = opts;
  const killGracePeriodMs = opts.killGracePeriodMs ?? 3000;

  // ── Env merge ─────────────────────────────────────────────────────────────
  const env: Record<string, string> = Object.assign({}, process.env, opts.env ?? {});

  // ── Output capture ────────────────────────────────────────────────────────
  let stdout = '';
  let stderr = '';

  // ── Resolve command on Windows (npm shim resolution) ─────────────────────
  const resolved = resolveCommandForWindows(command);

  // ── Windows: detect if resolved command is a .cmd/.bat shim ─────────────
  const isWindowsCmdShim = process.platform === 'win32' && /\.(cmd|bat)$/i.test(resolved);

  // ── Spawn configuration ──────────────────────────────────────────────────
  const spawnConfig: { command: string; args: string[]; shell: boolean } = (() => {
    if (process.platform !== 'win32') {
      return { command: resolved, args, shell: false };
    }

    if (isWindowsCmdShim) {
      // Windows batch files (.cmd/.bat) via npm shims require command-string mode.
      // The working pattern (confirmed by experiment) is:
      //   spawn('cmd.exe /c "path/to/file.cmd args..."', [], {shell:true})
      // NOT spawn('cmd.exe', ['/c', 'path/to/file.cmd args...'], {shell:true})
      const normalizedPath = resolved.replace(/\\/g, '/');
      const allArgsStr = [quoteWindowsCmdArg(normalizedPath), ...args.map(quoteWindowsCmdArg)].join(' ');
      return { command: `cmd.exe /c ${allArgsStr}`, args: [], shell: true };
    }

    // Non-batch Windows executables can be spawned directly. Keeping shell=false
    // preserves argv boundaries and keeps ENOENT handling deterministic.
    return { command: resolved, args, shell: false };
  })();

  // ── Spawn ─────────────────────────────────────────────────────────────────
  const proc = spawn(spawnConfig.command, spawnConfig.args, {
    cwd,
    env,
    shell: spawnConfig.shell,
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
      // taskkill /F is SIGKILL equivalent — force kill without grace period
      const killer = spawn('taskkill', ['/PID', String(pid), '/T', '/F']);
      killer.on('error', () => {
        // Process may have already exited — taskkill itself failed
      });
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
    let settled = false;

    function resolveOnce(output: CliOutput): void {
      if (!settled) {
        settled = true;
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
      let spawnError: SpawnErrorCode | undefined = undefined;
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
