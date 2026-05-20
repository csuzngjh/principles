import { RuntimeStateManager } from './store/runtime-state-manager.js';

export interface RuntimeStateHandle {
  stateManager: RuntimeStateManager;
  close(): Promise<void>;
}

export async function createRuntimeStateHandle(opts: {
  workspaceDir: string;
  readonly?: boolean;
}): Promise<RuntimeStateHandle> {
  const stateManager = new RuntimeStateManager({
    workspaceDir: opts.workspaceDir,
    readonly: opts.readonly ?? false,
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
