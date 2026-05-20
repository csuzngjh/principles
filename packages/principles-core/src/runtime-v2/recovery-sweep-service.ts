import { createRuntimeStateHandle } from './runtime-state-handle.js';
import type { RuntimeStateHandle } from './runtime-state-handle.js';
import type { RecoveryResult } from './store/lifecycle/recovery-sweep.js';

export interface RecoverySweepService {
  detectExpiredLeases(): Promise<string[]>;
  recoverTask(taskId: string): Promise<RecoveryResult | null>;
  close(): Promise<void>;
}

export interface RecoverySweepServiceHandle {
  service: RecoverySweepService;
  close: () => Promise<void>;
}

class RecoverySweepServiceImpl implements RecoverySweepService {
  constructor(private readonly stateManager: RuntimeStateHandle['stateManager']) {}

  async detectExpiredLeases(): Promise<string[]> {
    return this.stateManager.detectExpiredLeases();
  }

  async recoverTask(taskId: string): Promise<RecoveryResult | null> {
    return this.stateManager.recoverTask(taskId);
  }

  // eslint-disable-next-line @typescript-eslint/class-methods-use-this
  async close(): Promise<void> {
    // No-op: RuntimeStateManager lifecycle managed by handle
  }
}

export async function createRecoverySweepService(
  opts: { workspaceDir: string },
): Promise<RecoverySweepServiceHandle> {
  const handle = await createRuntimeStateHandle({ workspaceDir: opts.workspaceDir });
  const service = new RecoverySweepServiceImpl(handle.stateManager);
  return {
    service,
    close: handle.close,
  };
}
