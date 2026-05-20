import { RuntimeStateManager } from './store/runtime-state-manager.js';
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
  constructor(private readonly stateManager: RuntimeStateManager) {}

  async detectExpiredLeases(): Promise<string[]> {
    return this.stateManager.detectExpiredLeases();
  }

  async recoverTask(taskId: string): Promise<RecoveryResult | null> {
    return this.stateManager.recoverTask(taskId);
  }

  async close(): Promise<void> {
    await this.stateManager.close();
  }
}

export async function createRecoverySweepService(
  opts: { workspaceDir: string },
): Promise<RecoverySweepServiceHandle> {
  const stateManager = new RuntimeStateManager({ workspaceDir: opts.workspaceDir });
  await stateManager.initialize();
  const service = new RecoverySweepServiceImpl(stateManager);
  return {
    service,
    close: async () => {
      await stateManager.close();
    },
  };
}
