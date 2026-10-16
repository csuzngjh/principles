import { RuntimeStateManager } from './store/runtime-state-manager.js';

export interface RuntimeStateHandle {
  stateManager: RuntimeStateManager;
  close(): Promise<void>;
}

export async function createRuntimeStateHandle(opts: {
  workspaceDir: string;
  readonly?: boolean;
  /**
   * PRI-991 (P1-01): when false, a missing state.db is never created — the
   * open fails loudly instead. Strictly-readonly inspection paths (dry-run)
   * combine `readonly: true` with `bootstrapIfMissing: false` so the handle
   * cannot create files, directories, WAL journals or schema as a side
   * effect. Default true (backward compatible).
   */
  bootstrapIfMissing?: boolean;
}): Promise<RuntimeStateHandle> {
  const stateManager = new RuntimeStateManager({
    workspaceDir: opts.workspaceDir,
    readonly: opts.readonly ?? false,
    bootstrapIfMissing: opts.bootstrapIfMissing,
  });

  let closed = false;

  try {
    await stateManager.initialize();
  } catch (error) {
    try {
      await stateManager.close();
    } catch {
      // swallow close error during cleanup — original error is more important
    }
    throw error;
  }

  return {
    stateManager,
    close: async () => {
      if (closed) return;
      closed = true;
      await stateManager.close();
    },
  };
}
