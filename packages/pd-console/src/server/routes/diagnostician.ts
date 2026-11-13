/**
 * SPEC v0.8 §9.2 (L2) and §9.4 (L2b) — Console execution + backlog visibility.
 *
 * Two routes, one owner module:
 *
 *   POST /api/diagnostician/:taskId/run   spawn `pd diagnose run` (L2)
 *   GET  /api/diagnostician/backlog       backlog snapshot (L2b)
 *
 * Boundaries this module must not cross:
 *   - L2 does not execute the diagnosis in-process. It must not copy runtime
 *     resolution (the single production entry lives in pd-cli, P4), so check 7
 *     spawns `pd diagnose run --preflight` and only spawns the real run when
 *     that verdict is ok.
 *   - A 202 means "a child process was started", never "the diagnosis
 *     succeeded". The CLI re-checks everything and owns the lease.
 *   - L2b reports observed activity (`runs.started_at`) only. It never claims
 *     the executor is alive.
 */
import { spawn } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import type { IncomingMessage, ServerResponse } from 'http';
import { fileURLToPath } from 'url';
import {
  RuntimeStateManager,
  StalledDiagnosticianTaskReadModel,
  isRetryWaitBackoffElapsed,
  resolveAgentRuntimeBinding,
  resolveDiagnosticianCapability,
} from '@principles/core/runtime';
import type { DiagnosticianBacklogConfiguration } from '@principles/core/runtime';
import { resolveStateDbPath } from '@principles/core/runtime/storage-paths';
import { loadPdConfig } from '../config/pd-config-store.js';
import { resolveUpdateLayout } from '../utils/installed-layout.js';
import { errorMessage, sendError, sendJson, sendMethodNotAllowed, sendNotFound } from '../utils/response.js';

/** Contract limits (TD §8.2.4). */
const PREFLIGHT_TIMEOUT_MS = 3_000;
const SPAWN_CONFIRM_TIMEOUT_MS = 2_000;

export interface DiagnosticianPreflightVerdict {
  ok: boolean;
  reason?: string;
  message?: string;
  nextAction?: string;
}

export type DiagnosticianPreflightOutcome = DiagnosticianPreflightVerdict | 'timeout';

export interface DiagnosticianSpawnOutcome {
  outcome: 'spawned' | 'failed' | 'unconfirmed';
  message?: string;
}

/** The two external effects of L2, injectable so tests never launch Node. */
export interface DiagnosticianRuntime {
  preflight(input: { taskId: string; workspaceDir: string }): Promise<DiagnosticianPreflightOutcome>;
  spawnRun(input: { taskId: string; workspaceDir: string }): Promise<DiagnosticianSpawnOutcome>;
}

export interface DiagnosticianRuntimeOptions {
  /** Absolute pd-cli dist/index.js entry. Defaults to installed-layout + dev fallback. */
  pdCliEntry?: string;
  preflightTimeoutMs?: number;
  spawnConfirmTimeoutMs?: number;
}

/**
 * Resolve the pd-cli entry from the installed layout (`pdCliDir`), falling back
 * to the monorepo sibling only when no installation can be resolved.
 */
export function resolvePdCliInvocation(): { rootDir: string; entryPath: string } {
  const layout = resolveUpdateLayout();
  if (layout !== undefined) {
    const rootDir = path.resolve(layout.pdCliDir);
    return { rootDir, entryPath: path.join(rootDir, 'dist', 'index.js') };
  }
  const entryPath = path.resolve(
    path.dirname(fileURLToPath(import.meta.url)),
    '../../../../pd-cli/dist/index.js',
  );
  return { rootDir: path.dirname(path.dirname(entryPath)), entryPath };
}

function collectChild(limit: number): { append: (chunk: unknown) => void; text: () => string } {
  let buffer = '';
  return {
    append(chunk: unknown): void {
      if (buffer.length >= limit) return;
      const text = typeof chunk === 'string' ? chunk : Buffer.isBuffer(chunk) ? chunk.toString('utf8') : '';
      buffer += text.slice(0, limit - buffer.length);
    },
    text: () => buffer,
  };
}

function parsePreflightStdout(stdout: string): DiagnosticianPreflightVerdict | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(stdout);
  } catch {
    return null;
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return null;
  const field = (key: string): unknown => (Object.hasOwn(parsed, key) ? Reflect.get(parsed, key) : undefined);
  const ok = field('ok');
  if (ok === true) return { ok: true };
  if (ok !== false) return null;
  const reason = field('reason');
  const message = field('message');
  const nextAction = field('nextAction');
  return {
    ok: false,
    reason: typeof reason === 'string' ? reason : undefined,
    message: typeof message === 'string' ? message : undefined,
    nextAction: typeof nextAction === 'string' ? nextAction : undefined,
  };
}

export function createDiagnosticianRuntime(opts: DiagnosticianRuntimeOptions = {}): DiagnosticianRuntime {
  const preflightTimeoutMs = opts.preflightTimeoutMs ?? PREFLIGHT_TIMEOUT_MS;
  const spawnConfirmTimeoutMs = opts.spawnConfirmTimeoutMs ?? SPAWN_CONFIRM_TIMEOUT_MS;
  const invocation = opts.pdCliEntry === undefined
    ? resolvePdCliInvocation()
    : { entryPath: path.resolve(opts.pdCliEntry), rootDir: path.dirname(path.dirname(path.resolve(opts.pdCliEntry))) };

  const entryInsideRoot = invocation.entryPath.startsWith(invocation.rootDir + path.sep);

  return {
    preflight({ taskId, workspaceDir }) {
      if (!entryInsideRoot) {
        return Promise.resolve({
          ok: false,
          reason: 'preflight_failed',
          message: `pd CLI entry ${invocation.entryPath} is outside the pd-cli component dir ${invocation.rootDir}`,
          nextAction: 'Reinstall PD so the console and pd-cli come from the same component set.',
        });
      }
      return new Promise<DiagnosticianPreflightOutcome>((resolve) => {
        let settled = false;
        const stdout = collectChild(64 * 1024);
        const stderr = collectChild(8 * 1024);
        const child = spawn(
          process.execPath,
          [
            invocation.entryPath,
            'diagnose',
            'run',
            '--task-id',
            taskId,
            '--workspace',
            workspaceDir,
            '--preflight',
            '--json',
          ],
          { shell: false, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] },
        );
        const timer = setTimeout(() => {
          if (settled) return;
          settled = true;
          child.kill();
          resolve('timeout');
        }, preflightTimeoutMs);
        child.stdout?.on('data', (chunk: unknown) => stdout.append(chunk));
        child.stderr?.on('data', (chunk: unknown) => stderr.append(chunk));
        child.on('error', (error: Error) => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          resolve({
            ok: false,
            reason: 'preflight_failed',
            message: error.message,
            nextAction: 'Run `pd diagnose run --task-id <id> --workspace <ws> --preflight --json` manually.',
          });
        });
        child.on('close', (code: number | null) => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          const verdict = parsePreflightStdout(stdout.text());
          if (verdict !== null) {
            resolve(verdict);
            return;
          }
          const detail = stderr.text().trim();
          resolve({
            ok: false,
            reason: 'preflight_failed',
            message: detail.length > 0 ? detail.slice(0, 400) : `pd diagnose --preflight exited with code ${code ?? 'unknown'}`,
            nextAction: 'Run `pd diagnose run --task-id <id> --workspace <ws> --preflight --json` manually.',
          });
        });
      });
    },

    spawnRun({ taskId, workspaceDir }) {
      if (!entryInsideRoot) {
        return Promise.resolve({
          outcome: 'failed',
          message: `pd CLI entry ${invocation.entryPath} is outside the pd-cli component dir ${invocation.rootDir}`,
        });
      }
      return new Promise<DiagnosticianSpawnOutcome>((resolve) => {
        let settled = false;
        const child = spawn(
          process.execPath,
          [invocation.entryPath, 'diagnose', 'run', '--task-id', taskId, '--workspace', workspaceDir, '--json'],
          { detached: true, stdio: 'ignore', shell: false, windowsHide: true },
        );
        const timer = setTimeout(() => {
          if (settled) return;
          settled = true;
          resolve({ outcome: 'unconfirmed' });
        }, spawnConfirmTimeoutMs);
        child.on('error', (error: Error) => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          resolve({ outcome: 'failed', message: error.message });
        });
        child.on('spawn', () => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          child.unref();
          resolve({ outcome: 'spawned' });
        });
      });
    },
  };
}

function isSameOriginRequest(req: IncomingMessage): boolean {
  const { host, origin } = req.headers;
  if (typeof origin === 'string' && origin.length > 0) {
    if (typeof host !== 'string' || host.length === 0) return false;
    try {
      return new URL(origin).host === host;
    } catch {
      return false;
    }
  }
  const site = req.headers['sec-fetch-site'];
  if (typeof site === 'string' && site.length > 0) {
    return site === 'same-origin' || site === 'none';
  }
  // No browser provenance headers: a CLI/script client (TD §8.2.3).
  return true;
}

function isJsonContentType(value: string | string[] | undefined): boolean {
  const raw = Array.isArray(value) ? value[0] : value;
  if (typeof raw !== 'string') return false;
  const [mediaType] = raw.split(';');
  return mediaType?.trim().toLowerCase() === 'application/json';
}

function stateDbPath(workspaceDir: string): string {
  return resolveStateDbPath(workspaceDir);
}

function resolveConfiguration(deps: DiagnosticianRouteDeps): DiagnosticianBacklogConfiguration {
  const loadResult = loadPdConfig(deps.workspaceDir);
  const effective = loadResult.ok ? loadResult.effective : loadResult.defaults;
  return {
    l3FlagEnabled: deps.featureFlags?.openclaw_diagnostician_consumer?.enabled ?? true,
    capabilityAvailable: resolveDiagnosticianCapability(effective).available,
    runtimeBound: resolveAgentRuntimeBinding(effective, 'diagnostician').ok,
  };
}

export interface DiagnosticianRouteDeps {
  workspaceDir: string;
  subPath: string;
  /** Console feature flags; `openclaw_diagnostician_consumer` defaults on. */
  featureFlags?: Record<string, { enabled: boolean }>;
  /** Defaults to the real subprocess runtime. */
  runtime?: DiagnosticianRuntime;
  now?: () => Date;
}

async function handleBacklog(res: ServerResponse, deps: DiagnosticianRouteDeps): Promise<void> {
  if (!fs.existsSync(stateDbPath(deps.workspaceDir))) {
    sendError(res, 404, 'workspace_state_missing', `Workspace state.db not found at ${stateDbPath(deps.workspaceDir)}`, {
      nextAction: 'Run any PD command in this workspace once to create .pd/state.db.',
    });
    return;
  }

  const manager = new RuntimeStateManager({
    workspaceDir: deps.workspaceDir,
    readonly: true,
    bootstrapIfMissing: false,
  });
  try {
    await manager.initialize();
    const readModel = new StalledDiagnosticianTaskReadModel({ stateManager: manager });
    const snapshot = await readModel.getBacklog({
      configuration: resolveConfiguration(deps),
      now: deps.now?.() ?? new Date(),
    });
    sendJson(res, 200, { success: true, data: snapshot });
  } catch (error) {
    // rc-9: degraded reads stay observable, never a silent empty backlog.
    sendError(res, 500, 'backlog_unavailable', errorMessage(error), {
      nextAction: 'Check .pd/state.db integrity, then retry GET /api/diagnostician/backlog.',
    });
  } finally {
    await manager.close().catch(() => undefined);
  }
}

async function handleRun(
  req: IncomingMessage,
  res: ServerResponse,
  input: { deps: DiagnosticianRouteDeps; taskId: string },
): Promise<void> {
  const { deps, taskId } = input;
  req.resume(); // body is `{}` / empty; drain so the socket is not reset.

  // 1. Same-origin (TD §8.2.3). The local-owner-session guard already ran upstream.
  if (!isSameOriginRequest(req)) {
    sendError(res, 403, 'cross_origin_rejected', 'Cross-origin request rejected');
    return;
  }

  // 2. JSON content type — a cross-site form cannot forge it without preflight.
  if (!isJsonContentType(req.headers['content-type'])) {
    sendError(res, 415, 'unsupported_media_type', 'Content-Type must be application/json');
    return;
  }

  // 3. state.db must exist — never bootstrap from a read route.
  if (!fs.existsSync(stateDbPath(deps.workspaceDir))) {
    sendError(res, 404, 'workspace_state_missing', `Workspace state.db not found at ${stateDbPath(deps.workspaceDir)}`, {
      nextAction: 'Run any PD command in this workspace once to create .pd/state.db.',
    });
    return;
  }

  const nowMs = (deps.now?.() ?? new Date()).getTime();
  const manager = new RuntimeStateManager({
    workspaceDir: deps.workspaceDir,
    readonly: true,
    bootstrapIfMissing: false,
  });
  try {
    await manager.initialize();

    // 4. Task exists and is a diagnostician task.
    const task = await manager.getTask(taskId);
    if (task === null || task.taskKind !== 'diagnostician') {
      sendError(res, 404, 'task_not_found', `No diagnostician task '${taskId}' in this workspace`, {
        nextAction: 'Check GET /api/diagnostician/backlog for the current task ids.',
      });
      return;
    }

    // 6. A valid lease wins over the runnable check: a leased task presents as
    // status='leased', so evaluating "not_runnable" first would make
    // `already_leased` unreachable.
    const leaseExpiresMs = typeof task.leaseExpiresAt === 'string' ? new Date(task.leaseExpiresAt).getTime() : Number.NaN;
    if (task.status === 'leased' && Number.isFinite(leaseExpiresMs) && leaseExpiresMs > nowMs) {
      sendError(res, 409, 'already_leased', `Task '${taskId}' already holds a lease until ${task.leaseExpiresAt}`, {
        taskId,
        status: task.status,
        nextAction: 'Wait for the current run to finish; the lease decides who executes.',
      });
      return;
    }

    // 5. Runnable: pending, or retry_wait whose backoff elapsed.
    const runnable =
      task.status === 'pending' ||
      (task.status === 'retry_wait' && isRetryWaitBackoffElapsed(task.status, task.leaseExpiresAt, nowMs));
    if (!runnable) {
      sendError(res, 409, 'not_runnable', `Task '${taskId}' is ${task.status}`, {
        taskId,
        status: task.status,
        nextAction:
          task.status === 'leased'
            ? 'The lease has expired; wait for lease recovery to return the task to pending.'
            : 'Only pending, or retry_wait with elapsed backoff, can start now.',
      });
      return;
    }
  } finally {
    await manager.close().catch(() => undefined);
  }

  // 7. Preflight through the CLI — the only production runtime-resolution entry.
  const runtime = deps.runtime ?? createDiagnosticianRuntime();
  const preflight = await runtime.preflight({ taskId, workspaceDir: deps.workspaceDir });
  if (preflight === 'timeout') {
    // 8. Timed-out preflight never spawns.
    sendError(res, 504, 'preflight_timeout', `pd diagnose --preflight did not exit within ${PREFLIGHT_TIMEOUT_MS}ms`, {
      taskId,
      nextAction: 'Retry, or run `pd diagnose run --task-id <id> --workspace <ws> --preflight --json` manually.',
    });
    return;
  }
  if (!preflight.ok) {
    sendError(res, 409, preflight.reason ?? 'preflight_failed', preflight.message ?? 'Diagnostician cannot run', {
      taskId,
      nextAction: preflight.nextAction,
    });
    return;
  }

  // 8. Spawn the real run only after the preflight verdict is ok.
  const spawned = await runtime.spawnRun({ taskId, workspaceDir: deps.workspaceDir });
  if (spawned.outcome === 'failed') {
    sendError(res, 500, 'spawn_failed', spawned.message ?? 'Failed to spawn pd diagnose run', {
      taskId,
      nextAction: 'Check the console logs, then run `pd diagnose run --task-id <id> --workspace <ws> --json` manually.',
    });
    return;
  }
  if (spawned.outcome === 'unconfirmed') {
    sendError(res, 500, 'spawn_unconfirmed', 'The child process neither started nor failed within 2s', {
      taskId,
      nextAction: 'Do not retry blindly; check GET /api/diagnostician/backlog for a new run before retrying.',
    });
    return;
  }

  // 202 = a child process started. It is NOT the diagnosis result.
  sendJson(res, 202, {
    success: true,
    data: {
      state: 'diagnosis_accepted',
      taskId,
      workspaceDir: deps.workspaceDir,
      nextAction: '执行已启动；用 GET /api/diagnostician/backlog 观察 runs 记录。',
    },
  });
}

export async function handleDiagnosticianRoute(
  req: IncomingMessage,
  res: ServerResponse,
  deps: DiagnosticianRouteDeps,
): Promise<void> {
  const method = req.method ?? 'GET';

  if (deps.subPath === '/backlog') {
    if (method !== 'GET') {
      sendMethodNotAllowed(res);
      return;
    }
    await handleBacklog(res, deps);
    return;
  }

  const runMatch = /^\/([^/]+)\/run$/.exec(deps.subPath);
  if (runMatch?.[1] !== undefined) {
    if (method !== 'POST') {
      sendMethodNotAllowed(res);
      return;
    }
    await handleRun(req, res, { deps, taskId: decodeURIComponent(runMatch[1]) });
    return;
  }

  sendNotFound(res, 'Unknown diagnostician route');
}
