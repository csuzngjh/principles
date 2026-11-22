/**
 * Production I/O boundaries for the scheduler adapters: a spawn-based
 * command runner (no shell, bounded output, bounded time) and a Node fs
 * file boundary (atomic writes). Both are injectable so unit tests never
 * touch a real OS scheduler.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import { spawn, type ChildProcess } from 'node:child_process';
import type { SchedulerCommandResult, SchedulerCommandRunner, SchedulerFileIo } from './contract.js';

const DEFAULT_COMMAND_TIMEOUT_MS = 60_000;
const MAX_STREAM_BYTES = 2 * 1024 * 1024;

export interface SpawnSchedulerRunnerOptions {
  readonly timeoutMs?: number;
  /** Test injection for the spawn boundary (same seam as worker-process). */
  readonly spawnFn?: typeof spawn;
  readonly now?: () => number;
}

/** Real command runner — spawns without a shell, kills on timeout. */
export function createSpawnSchedulerRunner(options: SpawnSchedulerRunnerOptions = {}): SchedulerCommandRunner {
  const doSpawn = options.spawnFn ?? spawn;
  const timeoutMs = options.timeoutMs ?? DEFAULT_COMMAND_TIMEOUT_MS;
  const now = options.now ?? Date.now;
  return {
    async run(command, args, extraEnv) {
      return new Promise<SchedulerCommandResult>((resolve) => {
        const startedAt = now();
        let child: ChildProcess;
        let stdout = '';
        let stderr = '';
        let stdoutBytes = 0;
        let stderrBytes = 0;
        let settled = false;
        let timedOut = false;
        let timer: ReturnType<typeof setTimeout> | undefined;
        const settle = (result: SchedulerCommandResult): void => {
          if (settled) return;
          settled = true;
          if (timer !== undefined) clearTimeout(timer);
          resolve(result);
        };
        timer = setTimeout(() => {
          timedOut = true;
          try {
            child.kill();
          } catch {
            // Already gone — the exit handler below settles.
          }
        }, timeoutMs);
        try {
          child = doSpawn(command, [...args], {
            env: extraEnv === undefined ? process.env : { ...process.env, ...extraEnv },
            stdio: ['ignore', 'pipe', 'pipe'],
            windowsHide: true,
          });
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          settle({ code: null, stdout: '', stderr: '', spawnError: `spawn_threw:${message}` });
          return;
        }
        child.on('error', (error: Error & { code?: string }) => {
          settle({ code: null, stdout: '', stderr: '', spawnError: `spawn_error:${error.code ?? error.message}` });
        });
        child.stdout?.on('data', (chunk: Buffer) => {
          if (stdoutBytes < MAX_STREAM_BYTES) {
            stdout += chunk.toString('utf8');
            stdoutBytes += chunk.length;
          }
        });
        child.stderr?.on('data', (chunk: Buffer) => {
          if (stderrBytes < MAX_STREAM_BYTES) {
            stderr += chunk.toString('utf8');
            stderrBytes += chunk.length;
          }
        });
        child.on('close', (code) => {
          settle({
            code,
            stdout,
            stderr,
            ...(timedOut ? { timedOut: true } : {}),
            durationMs: now() - startedAt,
          });
        });
      });
    },
  };
}

/** Node fs implementation of the scheduler file boundary (atomic writes). */
export const nodeSchedulerFileIo: SchedulerFileIo = {
  readIfExists(file) {
    try {
      return { ok: true, content: fs.readFileSync(file, 'utf8') };
    } catch (error) {
      const { code } = error as Error & { code?: string };
      if (code === 'ENOENT') return { ok: false, reason: 'missing' };
      return { ok: false, reason: 'unreadable', detail: code ?? 'unknown' };
    }
  },
  writeAtomic(file, content) {
    try {
      fs.mkdirSync(path.dirname(file), { recursive: true });
      const temp = `${file}.tmp-${process.pid}-${Date.now()}`;
      fs.writeFileSync(temp, content, 'utf8');
      fs.renameSync(temp, file);
      return { ok: true };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return { ok: false, reason: message.slice(0, 120) };
    }
  },
  remove(file) {
    try {
      fs.rmSync(file, { force: true });
      return { ok: true };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return { ok: false, reason: message.slice(0, 120) };
    }
  },
  exists(file) {
    try {
      return fs.statSync(file).isFile();
    } catch {
      return false;
    }
  },
  mkdirs(dir) {
    try {
      fs.mkdirSync(dir, { recursive: true });
      return { ok: true };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return { ok: false, reason: message.slice(0, 120) };
    }
  },
};
