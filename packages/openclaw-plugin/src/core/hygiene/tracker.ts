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
    
    // Ensure state directory exists
    if (!fs.existsSync(stateDir)) {
      try {
        fs.mkdirSync(stateDir, { recursive: true });
      } catch (e) {
        this.logger?.error(`[PD] Failed to create state directory ${stateDir}: ${String(e)}`);
      }
    }
    
    this.currentStats = this.loadStats();
  }

  private loadStats(): HygieneStats {
    const today = new Date().toISOString().split('T')[0];
    if (fs.existsSync(this.statsFile)) {
      try {
        const content = fs.readFileSync(this.statsFile, 'utf-8');
        if (content.trim()) {
          const allStats = JSON.parse(content);
          if (allStats[today]) {
            return allStats[today];
          }
        }
      } catch (e) {
        this.logger?.error(`[PD] Failed to load/parse hygiene-stats.json: ${String(e)}`);
        // If file is corrupted, we might want to back it up and start fresh
        try {
          const backupPath = `${this.statsFile}.bak`;
          fs.renameSync(this.statsFile, backupPath);
          this.logger?.warn(`[PD] Corrupted hygiene stats backed up to ${backupPath}`);
        } catch (_renameErr) {}
      }
    }
    return createEmptyHygieneStats(today);
  }

  private saveStats(): void {
    let allStats: Record<string, HygieneStats> = {};
    
    // Check if we need to rotate date (reset currentStats if date changed)
    const today = new Date().toISOString().split('T')[0];
    if (this.currentStats.date !== today) {
      this.currentStats = createEmptyHygieneStats(today);
    }

    if (fs.existsSync(this.statsFile)) {
      try {
        const content = fs.readFileSync(this.statsFile, 'utf-8');
        if (content.trim()) {
          allStats = JSON.parse(content);
        }
      } catch (e) {
        this.logger?.error(`[PD] Failed to parse hygiene-stats.json for saving: ${String(e)}`);
      }
    }
    
    allStats[this.currentStats.date] = this.currentStats;
    
    try {
      // Use a temporary file for atomic write if possible, or simple write
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
    // Check for date change on every get
    const today = new Date().toISOString().split('T')[0];
    if (this.currentStats.date !== today) {
      this.currentStats = createEmptyHygieneStats(today);
    }
    return this.currentStats;
  }
}
