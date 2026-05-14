import type { GateBlockItem, EmpathyEvent } from '../types/index.js';
import { GateConsoleModel } from './GateConsoleModel.js';

export interface FeedbackGfiOutput {
  current: number;
  peakToday: number;
  threshold: number;
  trend: { hour: string; value: number }[];
  sources: Record<string, number>;
}

export class FeedbackConsoleModel {
  private readonly workspaceDir: string;
  private gateModel: GateConsoleModel | null = null;

  constructor(workspaceDir: string) {
    this.workspaceDir = workspaceDir;
  }

  async getGfi(): Promise<FeedbackGfiOutput> {
    const stats = await this.getGateModel().getGateStats();
    return {
      current: stats.gfi.current,
      peakToday: stats.gfi.peakToday,
      threshold: stats.gfi.threshold,
      trend: stats.gfi.trend,
      sources: stats.gfi.sources,
    };
  }

  async getEmpathyEvents(_limit?: number): Promise<EmpathyEvent[]> {
    void this.workspaceDir;
    return [];
  }

  async getGateBlocks(limit?: number): Promise<GateBlockItem[]> {
    return this.getGateModel().getGateBlocks(limit);
  }

  dispose(): void {
    if (this.gateModel) {
      this.gateModel.dispose();
    }
  }

  private getGateModel(): GateConsoleModel {
    if (!this.gateModel) {
      this.gateModel = new GateConsoleModel(this.workspaceDir);
    }
    return this.gateModel;
  }
}
