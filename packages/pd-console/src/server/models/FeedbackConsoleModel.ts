import { buildGfiWorkspaceSnapshot } from '@principles/core/runtime-v2';
import type { GfiReadModelInput } from '@principles/core/runtime-v2';
import { RuntimeStateManager } from '@principles/core/runtime-v2';
import type { GateBlockItem, EmpathyEvent } from '../types/index.js';
import { GateConsoleModel } from './GateConsoleModel.js';

export interface FeedbackGfiOutput {
  current: number;
  peakToday: number;
  threshold: number;
  trend: Array<{ hour: string; value: number }>;
  sources: Record<string, number>;
}

export class FeedbackConsoleModel {
  private readonly workspaceDir: string;
  private gateModel: GateConsoleModel | null = null;
  private stateManager: RuntimeStateManager | null = null;

  constructor(workspaceDir: string) {
    this.workspaceDir = workspaceDir;
  }

  async getGfi(sessions: GfiReadModelInput['sessions']): Promise<FeedbackGfiOutput> {
    const snapshot = buildGfiWorkspaceSnapshot({
      sessions,
      nowMs: Date.now(),
    });

    const active = snapshot.active;
    const sources: Record<string, number> = {};
    if (active?.sources) {
      for (const [key, value] of Object.entries(active.sources)) {
        if (value !== undefined) {
          sources[key] = value;
        }
      }
    }

    return {
      current: active?.currentGfi ?? 0,
      peakToday: active?.dailyGfiPeak ?? 0,
      threshold: active?.policy?.criticalThreshold ?? 80,
      trend: [],
      sources,
    };
  }

  async getEmpathyEvents(_limit?: number): Promise<EmpathyEvent[]> {
    return [];
  }

  async getGateBlocks(limit?: number): Promise<GateBlockItem[]> {
    return this.getGateModel().getGateBlocks(limit);
  }

  dispose(): void {
    if (this.gateModel) {
      this.gateModel.dispose();
    }
    if (this.stateManager) {
      this.stateManager.close().catch(() => {});
    }
  }

  private getGateModel(): GateConsoleModel {
    if (!this.gateModel) {
      this.gateModel = new GateConsoleModel(this.workspaceDir);
    }
    return this.gateModel;
  }

  private getStateManager(): RuntimeStateManager {
    if (!this.stateManager) {
      this.stateManager = new RuntimeStateManager({ workspaceDir: this.workspaceDir });
    }
    return this.stateManager;
  }
}
