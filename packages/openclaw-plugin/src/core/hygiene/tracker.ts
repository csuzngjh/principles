import * as fs from 'fs';
import * as path from 'path';
import { HygieneStats, createEmptyHygieneStats, PersistenceAction } from '../../types/hygiene-types.js';
import { PluginLogger } from '../../openclaw-sdk.js';

/**
 * HygieneTracker - Tracks agent behavior regarding workspace organization and persistence.
 */
export class HygieneTracker {
  private readonly statsFile: string;
  private currentStats: HygieneStats;
  private readonly logger?: PluginLogger;

  constructor(stateDir: string, logger?: PluginLogger) {
    this.statsFile = path.join(stateDir, 'hygiene-stats.json');
    this.logger = logger;
    this.currentStats = this.loadStats();
  }

  private loadStats(): HygieneStats {
    const today = new Date().toISOString().split('T')[0];
    if (fs.existsSync(this.statsFile)) {
      try {
        const allStats = JSON.parse(fs.readFileSync(this.statsFile, 'utf-8'));
        if (allStats[today]) {
          return allStats[today];
        }
      } catch (e) {
        this.logger?.error(`[PD] Failed to load hygiene-stats.json: ${String(e)}`);
      }
    }
    return createEmptyHygieneStats(today);
  }

  private saveStats(): void {
    let allStats: Record<string, HygieneStats> = {};
    if (fs.existsSync(this.statsFile)) {
      try {
        allStats = JSON.parse(fs.readFileSync(this.statsFile, 'utf-8'));
      } catch (e) {
        this.logger?.error(`[PD] Failed to parse hygiene-stats.json for saving: ${String(e)}`);
      }
    }
    allStats[this.currentStats.date] = this.currentStats;
    try {
      fs.writeFileSync(this.statsFile, JSON.stringify(allStats, null, 2), 'utf-8');
    } catch (e) {
      this.logger?.error(`[PD] Failed to write hygiene-stats.json: ${String(e)}`);
    }
  }

  /**
   * Records a persistence action (writing to memory or plan).
   */
  recordPersistence(action: PersistenceAction): void {
    this.currentStats.persistenceCount++;
    this.currentStats.lastPersistenceTime = action.ts;
    this.currentStats.totalCharsPersisted += action.contentLength;
    
    const fileName = path.basename(action.path);
    this.currentStats.persistenceByFile[fileName] = (this.currentStats.persistenceByFile[fileName] || 0) + 1;
    
    this.saveStats();
    this.logger?.info(`[PD] Hygiene: Persisted state to ${fileName} (${action.contentLength} chars)`);
  }

  /**
   * Records a grooming action (cleaning up the workspace).
   */
  recordGrooming(): void {
    this.currentStats.groomingExecutedCount++;
    this.currentStats.lastGroomingTime = new Date().toISOString();
    this.saveStats();
    this.logger?.info(`[PD] Hygiene: Workspace grooming executed.`);
  }

  getStats(): HygieneStats {
    return this.currentStats;
  }
}
