/**
 * Tests for the Failed Tasks detail connection — PRI-747 F22 / PRI-749.
 *
 * The server endpoint GET /api/v1/failed-tasks/:id (task record + run
 * history via SqliteTaskStore.getFailedTaskDetail) has existed since the
 * failed-task observability spec; the UI never consumed it. These tests pin
 * the restored connection:
 *
 * - api.ts exposes the validated fetchFailedTaskDetail GET wrapper
 *   (behavioral: mocked fetch, mirrors recover-task-api.test.ts)
 * - validateFailedTaskDetail enforces the server contract incl. per-element
 *   run validation (rc-1/rc-2/rc-4/rc-5)
 * - FailedTasksPage lazily fetches the detail on row expand, guards stale
 *   responses (rc-7), surfaces error reason + next action (rc-9)
 * - i18n keys exist with en/zh parity (EP-11)
 *
 * EP-02 (Production Path Wiring): GET /api/v1/failed-tasks/:id
 * EP-09 (Test Reality): assertions reflect the real implementation.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { getNestedRecord, parseJsonRecord } from '../i18n-test-helper.js';
import { validateFailedTaskDetail } from '../../../src/ui/utils/validators.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
// __dirname = packages/pd-console/tests/ui/pages
// SRC_ROOT  = packages/pd-console/src
const SRC_ROOT = join(__dirname, '..', '..', '..', 'src');

const pageSource = readFileSync(
  join(SRC_ROOT, 'ui', 'pages', 'failed-tasks', 'FailedTasksPage.tsx'),
  'utf8',
);
const apiSource = readFileSync(join(SRC_ROOT, 'ui', 'api.ts'), 'utf8');
const enJson = parseJsonRecord(
  readFileSync(join(SRC_ROOT, 'ui', 'i18n', 'en.json'), 'utf8'),
);
const zhJson = parseJsonRecord(
  readFileSync(join(SRC_ROOT, 'ui', 'i18n', 'zh-CN.json'), 'utf8'),
);

/** Realistic server payload for GET /api/v1/failed-tasks/:id (route sends
 *  { task: TaskRecord, runs: RunRecord[], lastError, pendingAgentDraft }). */
function serverDetailPayload(): Record<string, unknown> {
  return {
    task: {
      taskId: 'task-detail-1',
      taskKind: 'diagnostician',
      status: 'failed',
      createdAt: '2026-09-11T08:00:00.000Z',
      updatedAt: '2026-09-11T09:30:00.000Z',
      attemptCount: 2,
      maxAttempts: 3,
      lastError: 'runtime_unavailable',
    },
    runs: [
      {
        runId: 'run-2',
        runtimeKind: 'pi-ai',
        startedAt: '2026-09-11T09:20:00.000Z',
        endedAt: '2026-09-11T09:30:00.000Z',
        taskId: 'task-detail-1',
        attemptNumber: 2,
        executionStatus: 'failed',
        reason: 'LLM adapter timeout after 3 retries',
        errorCategory: 'runtime_unavailable',
      },
      {
        runId: 'run-1',
        runtimeKind: 'pi-ai',
        startedAt: '2026-09-11T08:10:00.000Z',
        endedAt: '2026-09-11T08:25:00.000Z',
        taskId: 'task-detail-1',
        attemptNumber: 1,
        executionStatus: 'failed',
        reason: 'output_invalid: validator rejected malformed JSON',
        errorCategory: 'output_invalid',
      },
    ],
    lastError: 'runtime_unavailable',
    pendingAgentDraft: null,
  };
}

describe('fetchFailedTaskDetail (PRI-747 F22)', () => {
  beforeEach(() => {
    const store = new Map<string, string>();
    vi.stubGlobal(
      'sessionStorage',
      {
        getItem: (key: string) => store.get(key) ?? null,
        setItem: (key: string, value: string) => store.set(key, value),
        removeItem: (key: string) => store.delete(key),
      } as Storage,
    );
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('GETs the detail endpoint (no /recover suffix) and validates the payload', async () => {
    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ success: true, data: serverDetailPayload() }),
    });
    vi.stubGlobal('fetch', mockFetch);

    const { fetchFailedTaskDetail } = await import('../../../src/ui/api.js');
    const result = await fetchFailedTaskDetail('task-detail-1');

    expect(result.success).toBe(true);
    if (!result.success) return;
    expect(result.data.taskId).toBe('task-detail-1');
    expect(result.data.taskKind).toBe('diagnostician');
    expect(result.data.attemptCount).toBe(2);
    expect(result.data.maxAttempts).toBe(3);
    expect(result.data.lastError).toBe('runtime_unavailable');
    // Run history is the value the list view cannot show (rc-4: elements)
    expect(result.data.runs).toHaveLength(2);
    expect(result.data.runs[0].reason).toBe('LLM adapter timeout after 3 retries');
    expect(result.data.runs[1].executionStatus).toBe('failed');

    expect(mockFetch).toHaveBeenCalledTimes(1);
    const [calledPath, calledInit] = mockFetch.mock.calls[0];
    expect(calledPath).toBe('/api/v1/failed-tasks/task-detail-1');
    expect(calledInit?.method).toBeUndefined(); // GET — no method override
  });

  it('encodes the task id into the path', async () => {
    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ success: true, data: serverDetailPayload() }),
    });
    vi.stubGlobal('fetch', mockFetch);

    const { fetchFailedTaskDetail } = await import('../../../src/ui/api.js');
    await fetchFailedTaskDetail('task/with spaces');

    const [calledPath] = mockFetch.mock.calls[0];
    expect(calledPath).toBe('/api/v1/failed-tasks/task%2Fwith%20spaces');
    // Round trip: the server route decodes the segment before the store
    // lookup (failed-tasks.test.ts pins the server half of this contract).
  });

  it('surfaces a 404 (task recovered / changed state) with the server reason', async () => {
    const mockFetch = vi.fn().mockResolvedValue({
      ok: false,
      status: 404,
      json: async () => ({
        success: false,
        error: 'not_found',
        message: "Task task-detail-1 not found (or it is not in 'failed' / 'needs_human_review' status)",
      }),
    });
    vi.stubGlobal('fetch', mockFetch);

    const { fetchFailedTaskDetail } = await import('../../../src/ui/api.js');
    const result = await fetchFailedTaskDetail('task-detail-1');

    expect(result.success).toBe(false);
    if (result.success) return;
    expect(result.error).toContain('not found');
  });
});

describe('validateFailedTaskDetail (server contract, rc-1/rc-2/rc-4/rc-5)', () => {
  it('accepts the real server payload and projects task + runs', () => {
    const validated = validateFailedTaskDetail(serverDetailPayload());
    expect(validated).not.toBeNull();
    if (!validated) return;
    expect(validated.taskId).toBe('task-detail-1');
    expect(validated.runs.map((r) => r.runId)).toEqual(['run-2', 'run-1']);
    expect(validated.runs[0].endedAt).toBe('2026-09-11T09:30:00.000Z');
    expect(validated.runs[0].errorCategory).toBe('runtime_unavailable');
  });

  it('accepts a task with an empty runs array (no run records yet)', () => {
    const payload = serverDetailPayload();
    (payload as Record<string, unknown>)['runs'] = [];
    const validated = validateFailedTaskDetail(payload);
    expect(validated).not.toBeNull();
    if (!validated) return;
    expect(validated.runs).toEqual([]);
  });

  it('rejects a payload without a task object (rc-3 fail loud)', () => {
    const payload = serverDetailPayload();
    delete (payload as Record<string, unknown>)['task'];
    expect(validateFailedTaskDetail(payload)).toBeNull();
  });

  it('rejects a payload without a runs array (rc-3 fail loud)', () => {
    const payload = serverDetailPayload();
    delete (payload as Record<string, unknown>)['runs'];
    expect(validateFailedTaskDetail(payload)).toBeNull();
  });

  it('rejects a malformed run element instead of the whole array passing (rc-4)', () => {
    const payload = serverDetailPayload();
    const runs = payload['runs'] as Record<string, unknown>[];
    // Second run lost its required startedAt string
    delete runs[1]['startedAt'];
    expect(validateFailedTaskDetail(payload)).toBeNull();
  });

  it('rejects a payload whose run names a DIFFERENT task (rc-6 lineage)', () => {
    const payload = serverDetailPayload();
    const runs = payload['runs'] as Record<string, unknown>[];
    // A mixed response would display another task's failure reason under
    // this task — the validator must reject the whole detail.
    (runs[1] as Record<string, unknown>)['taskId'] = 'some-other-task';
    expect(validateFailedTaskDetail(payload)).toBeNull();
  });

  it('rejects a run element without a taskId (rc-6 lineage)', () => {
    const payload = serverDetailPayload();
    const runs = payload['runs'] as Record<string, unknown>[];
    delete (runs[0] as Record<string, unknown>)['taskId'];
    expect(validateFailedTaskDetail(payload)).toBeNull();
  });

  it('rejects a task record without updatedAt (required server field, rc-3)', () => {
    const payload = serverDetailPayload();
    const task = payload['task'] as Record<string, unknown>;
    delete task['updatedAt'];
    expect(validateFailedTaskDetail(payload)).toBeNull();
  });

  it('rejects a null updatedAt (required server field, rc-3)', () => {
    const payload = serverDetailPayload();
    const task = payload['task'] as Record<string, unknown>;
    task['updatedAt'] = null;
    expect(validateFailedTaskDetail(payload)).toBeNull();
  });

  it('rejects a non-object payload', () => {
    expect(validateFailedTaskDetail(null)).toBeNull();
    expect(validateFailedTaskDetail('task-detail-1')).toBeNull();
    expect(validateFailedTaskDetail([1, 2, 3])).toBeNull();
  });
});

describe('FailedTasksPage detail wiring (PRI-747 F22)', () => {
  it('Given FailedTasksPage, When parsed, Then rows expand into a lazily fetched detail', () => {
    // The page consumes the new api wrapper on expand (lazy: not on load)
    expect(pageSource).toContain('fetchFailedTaskDetail(taskId)');
    // Toggle button announces expansion state (a11y)
    expect(pageSource).toContain('aria-expanded');
    expect(pageSource).toContain('pages.failedTasks.detailToggle');
  });

  it('Given FailedTasksPage, When parsed, Then stale detail responses are dropped (rc-7)', () => {
    expect(pageSource).toContain('detailRequestIdRef');
    expect(pageSource).toContain('requestId !== detailRequestIdRef.current');
  });

  it('Given FailedTasksPage, When parsed, Then the detail error path surfaces reason + next action (rc-9)', () => {
    expect(pageSource).toContain('pages.failedTasks.detailError');
    expect(pageSource).toContain('state.nextAction');
    expect(pageSource).toContain('onRetry(taskId)');
  });

  it('Given FailedTasksPage, When parsed, Then the run history renders per-attempt reasons', () => {
    expect(pageSource).toContain('pages.failedTasks.runsTitle');
    expect(pageSource).toContain('pages.failedTasks.runReason');
    expect(pageSource).toContain('run.reason');
  });

  it('Given FailedTasksPage, When parsed, Then it uses the defensive single-owner date formatter', () => {
    // utils/format.js (non-defensive: Intl.format threw RangeError on invalid
    // dates mid-render) was retired into format-date.ts, which returns the
    // raw string for invalid input — the page must not regress to it.
    expect(pageSource).toContain('utils/format-date.js');
    // Match the import statement only — the migration comment may mention the
    // retired module by name.
    expect(pageSource).not.toMatch(/from ["'][^"']*utils\/format\.js["']/);
  });

  it('Given api.ts, When parsed, Then fetchFailedTaskDetail is exported with its validator (EP-02)', () => {
    expect(apiSource).toContain('async function fetchFailedTaskDetail');
    expect(apiSource).toContain('validateFailedTaskDetail');
    expect(apiSource).toContain('fetchFailedTaskDetail,');
  });

  it('Given i18n keys, When checked, Then detail keys exist in en + zh with parity (EP-11)', () => {
    const enFailed = getNestedRecord(enJson, ['pages', 'failedTasks']);
    const zhFailed = getNestedRecord(zhJson, ['pages', 'failedTasks']);
    const detailKeys = [
      'detailToggle',
      'detailError',
      'createdAt',
      'updatedAt',
      'runsTitle',
      'runAttempt',
      'runStarted',
      'runEnded',
      'runReason',
      'runErrorCategory',
      'noRuns',
    ];
    for (const key of detailKeys) {
      expect(enFailed[key]).toBeDefined();
      expect(zhFailed[key]).toBeDefined();
      expect(String(zhFailed[key]).length).toBeGreaterThan(0);
    }
  });
});
