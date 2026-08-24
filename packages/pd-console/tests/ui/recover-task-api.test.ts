import { describe, it, expect, vi, afterEach } from 'vitest';

describe('recoverFailedTask (Governance Recovery Actions v1)', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('POSTs to the recover endpoint with reason and validates the response', async () => {
    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({
        success: true,
        data: { taskId: 't1', previousStatus: 'failed', newStatus: 'pending', result: 'recovered' },
      }),
    });
    vi.stubGlobal('fetch', mockFetch);

    const { recoverFailedTask } = await import('../../src/ui/api.js');
    const result = await recoverFailedTask('t1', 'owner reviewed');

    expect(result.success).toBe(true);
    if (!result.success) return;
    expect(result.data.taskId).toBe('t1');
    expect(result.data.result).toBe('recovered');
    expect(result.data.previousStatus).toBe('failed');
    expect(result.data.newStatus).toBe('pending');

    expect(mockFetch).toHaveBeenCalledTimes(1);
    const [calledPath, calledInit] = mockFetch.mock.calls[0];
    expect(calledPath).toBe('/api/v1/failed-tasks/t1/recover');
    expect(calledInit?.method).toBe('POST');
    const body = JSON.parse(calledInit?.body as string);
    expect(body.reason).toBe('owner reviewed');
  });

  it('omits reason from the body when not provided', async () => {
    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({
        success: true,
        data: { taskId: 't2', previousStatus: 'needs_human_review', newStatus: 'pending', result: 'requeued' },
      }),
    });
    vi.stubGlobal('fetch', mockFetch);

    const { recoverFailedTask } = await import('../../src/ui/api.js');
    const result = await recoverFailedTask('t2');

    expect(result.success).toBe(true);
    if (!result.success) return;
    expect(result.data.result).toBe('requeued');

    const [, calledInit] = mockFetch.mock.calls[0];
    const body = JSON.parse(calledInit?.body as string);
    expect(body.reason).toBeUndefined();
  });

  it('surfaces a 403 recovery-disabled error', async () => {
    const mockFetch = vi.fn().mockResolvedValue({
      ok: false,
      status: 403,
      json: async () => ({
        success: false,
        error: 'failed_task_recovery_console_disabled',
        message: 'failed_task_recovery_console feature flag is disabled. Enable it via .pd/config.yaml',
      }),
    });
    vi.stubGlobal('fetch', mockFetch);

    const { recoverFailedTask } = await import('../../src/ui/api.js');
    const result = await recoverFailedTask('t3');

    expect(result.success).toBe(false);
    if (result.success) return;
    // request() surfaces the server `message` (falling back to `error`) as
    // ApiResponse.error for the UI to display (rc-9).
    expect(result.error).toContain('failed_task_recovery_console feature flag is disabled');
  });
});