import { describe, it, expect, vi, beforeEach } from 'vitest';

const mockInitialize = vi.fn().mockResolvedValue(undefined);
const mockClose = vi.fn().mockResolvedValue(undefined);

vi.mock('../store/runtime-state-manager.js', () => ({
  RuntimeStateManager: vi.fn().mockImplementation(function (this: Record<string, unknown>, opts: { workspaceDir: string; readonly?: boolean }) {
    this.initialize = mockInitialize;
    this.close = mockClose;
    this.isInitialized = true;
    this._opts = opts;
  }),
}));

describe('createRuntimeStateHandle', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    mockInitialize.mockResolvedValue(undefined);
    mockClose.mockResolvedValue(undefined);
  });

  it('initializes RuntimeStateManager once', async () => {
    const { createRuntimeStateHandle } = await import('../runtime-state-handle.js');
    const handle = await createRuntimeStateHandle({ workspaceDir: '/tmp/test-ws' });
    expect(handle.stateManager).toBeDefined();
    expect(mockInitialize).toHaveBeenCalledTimes(1);
    await handle.close();
  });

  it('passes readonly=true to RuntimeStateManager', async () => {
    const { RuntimeStateManager } = await import('../store/runtime-state-manager.js');
    const { createRuntimeStateHandle } = await import('../runtime-state-handle.js');
    const ctor = RuntimeStateManager as unknown as ReturnType<typeof vi.fn>;
    ctor.mockClear();

    await createRuntimeStateHandle({ workspaceDir: '/tmp/test-ws', readonly: true });

    expect(ctor).toHaveBeenCalledWith(
      expect.objectContaining({ workspaceDir: '/tmp/test-ws', readonly: true }),
    );
  });

  it('defaults readonly to false', async () => {
    const { RuntimeStateManager } = await import('../store/runtime-state-manager.js');
    const { createRuntimeStateHandle } = await import('../runtime-state-handle.js');
    const ctor = RuntimeStateManager as unknown as ReturnType<typeof vi.fn>;
    ctor.mockClear();

    await createRuntimeStateHandle({ workspaceDir: '/tmp/test-ws' });

    expect(ctor).toHaveBeenCalledWith(
      expect.objectContaining({ workspaceDir: '/tmp/test-ws', readonly: false }),
    );
  });

  it('close() delegates to stateManager.close()', async () => {
    const { createRuntimeStateHandle } = await import('../runtime-state-handle.js');
    const handle = await createRuntimeStateHandle({ workspaceDir: '/tmp/test-ws' });
    mockClose.mockClear();

    await handle.close();
    expect(mockClose).toHaveBeenCalledTimes(1);
  });

  it('close() is idempotent — second call is a no-op', async () => {
    const { createRuntimeStateHandle } = await import('../runtime-state-handle.js');
    const handle = await createRuntimeStateHandle({ workspaceDir: '/tmp/test-ws' });
    mockClose.mockClear();

    await handle.close();
    await handle.close();
    await handle.close();

    expect(mockClose).toHaveBeenCalledTimes(1);
  });

  it('initialize failure calls close and re-throws', async () => {
    const { createRuntimeStateHandle } = await import('../runtime-state-handle.js');
    const initError = new Error('DB init failed');
    mockInitialize.mockRejectedValueOnce(initError);
    mockClose.mockClear();

    await expect(createRuntimeStateHandle({ workspaceDir: '/tmp/test-ws' }))
      .rejects.toThrow('DB init failed');

    expect(mockClose).toHaveBeenCalled();
  });

  it('initialize failure swallows close error — original error propagates', async () => {
    const { createRuntimeStateHandle } = await import('../runtime-state-handle.js');
    const initError = new Error('DB init failed');
    const closeError = new Error('close also failed');
    mockInitialize.mockRejectedValueOnce(initError);
    mockClose.mockRejectedValueOnce(closeError);

    await expect(createRuntimeStateHandle({ workspaceDir: '/tmp/test-ws' }))
      .rejects.toThrow('DB init failed');
  });
});
