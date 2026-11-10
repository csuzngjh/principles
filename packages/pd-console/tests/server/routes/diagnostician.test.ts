/**
 * SPEC v0.8 §9.2 (L2) / §9.4 (L2b) — Console route tests.
 *
 * Acceptance coverage: T31 (202 means "child started", not "diagnosis done"),
 * T32 (403/415/404/409 leave state untouched), T34/T35 (backlog wiring).
 * T33's exactly-once lease decision is covered by
 * packages/principles-core/src/runtime/store/concurrent-lease.test.ts; this
 * file only proves the console does not serialize or short-circuit it.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as crypto from 'crypto';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import type { IncomingMessage, ServerResponse } from 'http';
import { RuntimeStateManager } from '@principles/core/runtime';
import {
  handleDiagnosticianRoute,
  type DiagnosticianRuntime,
  type DiagnosticianRouteDeps,
} from '../../../src/server/routes/diagnostician.js';

interface MockResponseState {
  statusCode: number;
  body: string;
}

function createMockResponse(): { res: ServerResponse; state: MockResponseState } {
  const state: MockResponseState = { statusCode: 0, body: '' };
  const res = {
    headersSent: false,
    writableEnded: false,
    writeHead(code: number) {
      state.statusCode = code;
      this.headersSent = true;
    },
    end(chunk?: string) {
      state.body = chunk ?? '';
      this.writableEnded = true;
    },
  };
  return { res: res as unknown as ServerResponse, state };
}

function createMockRequest(init: {
  method?: string;
  headers?: Record<string, string>;
}): IncomingMessage {
  return {
    method: init.method ?? 'POST',
    headers: init.headers ?? {},
    resume: () => undefined,
  } as unknown as IncomingMessage;
}

function fakeRuntime(overrides: Partial<DiagnosticianRuntime> = {}): DiagnosticianRuntime {
  return {
    preflight: vi.fn(async () => ({ ok: true })),
    spawnRun: vi.fn(async () => ({ outcome: 'spawned' as const })),
    ...overrides,
  };
}

function digestWorkspace(workspaceDir: string): string {
  const pdDir = path.join(workspaceDir, '.pd');
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(pdDir, { withFileTypes: true });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return 'missing';
    throw error;
  }
  const hash = crypto.createHash('sha256');
  for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
    if (!entry.isFile()) continue;
    hash.update(entry.name);
    try {
      hash.update(fs.readFileSync(path.join(pdDir, entry.name)));
    } catch (error) {
      // A file vanishing mid-scan is not a state change we caused; skip it
      // instead of stat-then-read, which CodeQL flags as a filesystem race.
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') continue;
      throw error;
    }
  }
  return hash.digest('hex');
}

const JSON_HEADERS = { host: '127.0.0.1:3100', 'content-type': 'application/json' };

describe('Console L2 — POST /api/diagnostician/:taskId/run', () => {
  let tmpDir: string;
  let stateManager: RuntimeStateManager;

  beforeEach(async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pd-console-diagnostician-'));
    stateManager = new RuntimeStateManager({ workspaceDir: tmpDir });
    await stateManager.initialize();
  });

  afterEach(async () => {
    await stateManager.close();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  async function seedTask(input: {
    taskId?: string;
    taskKind?: string;
    status?: 'pending' | 'retry_wait' | 'leased' | 'succeeded';
    leaseExpiresAt?: string;
  } = {}): Promise<string> {
    const taskId = input.taskId ?? 'diagnosis_task-1';
    await stateManager.taskStore.createTask({
      taskId,
      taskKind: input.taskKind ?? 'diagnostician',
      status: input.status ?? 'pending',
      attemptCount: 0,
      maxAttempts: 3,
      inputRef: 'pain-1',
      leaseOwner: input.status === 'leased' ? 'another-runner' : undefined,
      leaseExpiresAt: input.leaseExpiresAt,
    });
    return taskId;
  }

  async function invoke(
    taskId: string,
    options: {
      method?: string;
      headers?: Record<string, string>;
      runtime?: DiagnosticianRuntime;
      workspaceDir?: string;
    } = {},
  ): Promise<MockResponseState> {
    const { res, state } = createMockResponse();
    const deps: DiagnosticianRouteDeps = {
      workspaceDir: options.workspaceDir ?? tmpDir,
      subPath: `/${encodeURIComponent(taskId)}/run`,
      runtime: options.runtime ?? fakeRuntime(),
    };
    await handleDiagnosticianRoute(
      createMockRequest({ method: options.method, headers: options.headers ?? JSON_HEADERS }),
      res,
      deps,
    );
    return state;
  }

  it('T31: accepts a pending task with 202 and spawns the CLI without mutating state itself', async () => {
    const taskId = await seedTask();
    const before = digestWorkspace(tmpDir);
    const runtime = fakeRuntime();

    const state = await invoke(taskId, { runtime });

    expect(state.statusCode).toBe(202);
    const payload = JSON.parse(state.body);
    expect(payload.success).toBe(true);
    expect(payload.data.state).toBe('diagnosis_accepted');
    expect(payload.data.taskId).toBe(taskId);
    expect(runtime.preflight).toHaveBeenCalledWith({ taskId, workspaceDir: tmpDir });
    expect(runtime.spawnRun).toHaveBeenCalledWith({ taskId, workspaceDir: tmpDir });
    // The console acknowledge-only path must not write; the spawned CLI does.
    expect(digestWorkspace(tmpDir)).toBe(before);
  });

  it('T32: cross-origin Origin is rejected with 403 and nothing is spawned', async () => {
    const taskId = await seedTask();
    const before = digestWorkspace(tmpDir);
    const runtime = fakeRuntime();

    const state = await invoke(taskId, {
      runtime,
      headers: { ...JSON_HEADERS, origin: 'http://evil.example' },
    });

    expect(state.statusCode).toBe(403);
    expect(JSON.parse(state.body).error).toBe('cross_origin_rejected');
    expect(runtime.preflight).not.toHaveBeenCalled();
    expect(runtime.spawnRun).not.toHaveBeenCalled();
    expect(digestWorkspace(tmpDir)).toBe(before);
  });

  it('T32: a cross-site browser request without Origin is rejected with 403', async () => {
    const taskId = await seedTask();
    const runtime = fakeRuntime();

    const state = await invoke(taskId, {
      runtime,
      headers: { ...JSON_HEADERS, 'sec-fetch-site': 'cross-site' },
    });

    expect(state.statusCode).toBe(403);
    expect(runtime.spawnRun).not.toHaveBeenCalled();
  });

  it('T32: a same-origin Origin is accepted', async () => {
    const taskId = await seedTask();
    const runtime = fakeRuntime();

    const state = await invoke(taskId, {
      runtime,
      headers: { ...JSON_HEADERS, origin: 'http://127.0.0.1:3100' },
    });

    expect(state.statusCode).toBe(202);
    expect(runtime.spawnRun).toHaveBeenCalledTimes(1);
  });

  it('T32: a non-JSON content type is rejected with 415', async () => {
    const taskId = await seedTask();
    const before = digestWorkspace(tmpDir);
    const runtime = fakeRuntime();

    const state = await invoke(taskId, {
      runtime,
      headers: { host: '127.0.0.1:3100', 'content-type': 'text/plain' },
    });

    expect(state.statusCode).toBe(415);
    expect(JSON.parse(state.body).error).toBe('unsupported_media_type');
    expect(runtime.spawnRun).not.toHaveBeenCalled();
    expect(digestWorkspace(tmpDir)).toBe(before);
  });

  it('T32: a missing state.db is rejected with 404 workspace_state_missing and is not bootstrapped', async () => {
    const emptyDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pd-console-empty-'));
    try {
      const runtime = fakeRuntime();
      const state = await invoke('diagnosis_task-1', { runtime, workspaceDir: emptyDir });

      expect(state.statusCode).toBe(404);
      expect(JSON.parse(state.body).error).toBe('workspace_state_missing');
      expect(fs.existsSync(path.join(emptyDir, '.pd'))).toBe(false);
      expect(runtime.spawnRun).not.toHaveBeenCalled();
    } finally {
      fs.rmSync(emptyDir, { recursive: true, force: true });
    }
  });

  it('T32: an unknown task is rejected with 404 task_not_found', async () => {
    // Seed one task so state.db exists; the lookup still targets a missing id.
    await seedTask();
    const before = digestWorkspace(tmpDir);
    const runtime = fakeRuntime();

    const state = await invoke('diagnosis_missing', { runtime });

    expect(state.statusCode).toBe(404);
    expect(JSON.parse(state.body).error).toBe('task_not_found');
    expect(runtime.spawnRun).not.toHaveBeenCalled();
    expect(digestWorkspace(tmpDir)).toBe(before);
  });

  it('T32: a non-diagnostician task is rejected with 404 task_not_found', async () => {
    await seedTask({ taskId: 'intake-1', taskKind: 'principle_candidate_intake' });
    const runtime = fakeRuntime();

    const state = await invoke('intake-1', { runtime });

    expect(state.statusCode).toBe(404);
    expect(JSON.parse(state.body).error).toBe('task_not_found');
    expect(runtime.spawnRun).not.toHaveBeenCalled();
  });

  it('T32: a succeeded task is rejected with 409 not_runnable', async () => {
    await seedTask({ status: 'succeeded' });
    const before = digestWorkspace(tmpDir);
    const runtime = fakeRuntime();

    const state = await invoke('diagnosis_task-1', { runtime });

    expect(state.statusCode).toBe(409);
    expect(JSON.parse(state.body).error).toBe('not_runnable');
    expect(runtime.preflight).not.toHaveBeenCalled();
    expect(digestWorkspace(tmpDir)).toBe(before);
  });

  it('T32: a task holding a valid lease is rejected with 409 already_leased', async () => {
    await seedTask({
      status: 'leased',
      leaseExpiresAt: new Date(Date.now() + 10 * 60 * 1000).toISOString(),
    });
    const runtime = fakeRuntime();

    const state = await invoke('diagnosis_task-1', { runtime });

    expect(state.statusCode).toBe(409);
    expect(JSON.parse(state.body).error).toBe('already_leased');
    expect(runtime.spawnRun).not.toHaveBeenCalled();
  });

  it('maps a preflight refusal to 409 with the CLI reason and next action', async () => {
    await seedTask();
    const runtime = fakeRuntime({
      preflight: vi.fn(async () => ({
        ok: false,
        reason: 'capability_disabled',
        message: 'diagnostician capability is disabled',
        nextAction: 'pd config set diagnostician.enabled true',
      })),
    });
    const before = digestWorkspace(tmpDir);

    const state = await invoke('diagnosis_task-1', { runtime });

    expect(state.statusCode).toBe(409);
    const payload = JSON.parse(state.body);
    expect(payload.error).toBe('capability_disabled');
    expect(payload.nextAction).toBe('pd config set diagnostician.enabled true');
    expect(runtime.spawnRun).not.toHaveBeenCalled();
    expect(digestWorkspace(tmpDir)).toBe(before);
  });

  it('maps a preflight timeout to 504 and never spawns', async () => {
    await seedTask();
    const runtime = fakeRuntime({ preflight: vi.fn(async () => 'timeout' as const) });

    const state = await invoke('diagnosis_task-1', { runtime });

    expect(state.statusCode).toBe(504);
    expect(JSON.parse(state.body).error).toBe('preflight_timeout');
    expect(runtime.spawnRun).not.toHaveBeenCalled();
  });

  it('reports spawn_failed and spawn_unconfirmed separately', async () => {
    await seedTask();

    const failed = await invoke('diagnosis_task-1', {
      runtime: fakeRuntime({ spawnRun: vi.fn(async () => ({ outcome: 'failed' as const, message: 'ENOENT' })) }),
    });
    expect(failed.statusCode).toBe(500);
    expect(JSON.parse(failed.body).error).toBe('spawn_failed');

    const unconfirmed = await invoke('diagnosis_task-1', {
      runtime: fakeRuntime({ spawnRun: vi.fn(async () => ({ outcome: 'unconfirmed' as const })) }),
    });
    expect(unconfirmed.statusCode).toBe(500);
    expect(JSON.parse(unconfirmed.body).error).toBe('spawn_unconfirmed');
  });

  it('does not serialize concurrent accepts — the CLI lease decides, not the console', async () => {
    const taskId = await seedTask();
    const runtime = fakeRuntime();

    const [first, second] = await Promise.all([invoke(taskId, { runtime }), invoke(taskId, { runtime })]);

    expect(first.statusCode).toBe(202);
    expect(second.statusCode).toBe(202);
    expect(runtime.spawnRun).toHaveBeenCalledTimes(2);
  });

  it('rejects non-POST methods and unknown sub-paths', async () => {
    expect((await invoke('diagnosis_task-1', { method: 'GET' })).statusCode).toBe(405);

    const { res, state } = createMockResponse();
    await handleDiagnosticianRoute(
      createMockRequest({ method: 'GET', headers: JSON_HEADERS }),
      res,
      { workspaceDir: tmpDir, subPath: '/unknown' },
    );
    expect(state.statusCode).toBe(404);
  });
});

describe('Console L2b — GET /api/diagnostician/backlog', () => {
  let tmpDir: string;
  let stateManager: RuntimeStateManager;

  beforeEach(async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pd-console-backlog-'));
    stateManager = new RuntimeStateManager({ workspaceDir: tmpDir });
    await stateManager.initialize();
  });

  afterEach(async () => {
    await stateManager.close();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('returns the backlog snapshot with configuration facts', async () => {
    await stateManager.taskStore.createTask({
      taskId: 'diagnosis_task-1',
      taskKind: 'diagnostician',
      status: 'pending',
      attemptCount: 0,
      maxAttempts: 3,
      inputRef: 'pain-1',
    });

    const { res, state } = createMockResponse();
    await handleDiagnosticianRoute(
      createMockRequest({ method: 'GET', headers: JSON_HEADERS }),
      res,
      { workspaceDir: tmpDir, subPath: '/backlog' },
    );

    expect(state.statusCode).toBe(200);
    const payload = JSON.parse(state.body);
    expect(payload.success).toBe(true);
    expect(payload.data.pendingCount).toBe(1);
    expect(payload.data.oldestPendingTaskId).toBe('diagnosis_task-1');
    expect(payload.data.oldestPendingPainId).toBe('pain-1');
    expect(payload.data.health).toBe('stalled');
    expect(payload.data.configuration).toMatchObject({
      l3FlagEnabled: expect.any(Boolean),
      capabilityAvailable: expect.any(Boolean),
      runtimeBound: expect.any(Boolean),
    });
  });

  it('is read-only: reading the backlog does not change state', async () => {
    await stateManager.taskStore.createTask({
      taskId: 'diagnosis_task-1',
      taskKind: 'diagnostician',
      status: 'pending',
      attemptCount: 0,
      maxAttempts: 3,
      inputRef: 'pain-1',
    });
    const before = digestWorkspace(tmpDir);

    const { res, state } = createMockResponse();
    await handleDiagnosticianRoute(
      createMockRequest({ method: 'GET', headers: JSON_HEADERS }),
      res,
      { workspaceDir: tmpDir, subPath: '/backlog' },
    );

    expect(state.statusCode).toBe(200);
    expect(digestWorkspace(tmpDir)).toBe(before);
  });

  it('returns 404 workspace_state_missing when no state.db exists', async () => {
    const emptyDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pd-console-backlog-empty-'));
    try {
      const { res, state } = createMockResponse();
      await handleDiagnosticianRoute(
        createMockRequest({ method: 'GET', headers: JSON_HEADERS }),
        res,
        { workspaceDir: emptyDir, subPath: '/backlog' },
      );
      expect(state.statusCode).toBe(404);
      expect(JSON.parse(state.body).error).toBe('workspace_state_missing');
    } finally {
      fs.rmSync(emptyDir, { recursive: true, force: true });
    }
  });

  it('rejects non-GET methods', async () => {
    const { res, state } = createMockResponse();
    await handleDiagnosticianRoute(
      createMockRequest({ method: 'POST', headers: JSON_HEADERS }),
      res,
      { workspaceDir: tmpDir, subPath: '/backlog' },
    );
    expect(state.statusCode).toBe(405);
  });
});
