import { HygieneStats, PersistenceAction } from '../../types/hygiene-types.js';
import { PluginLogger } from '../../openclaw-sdk.js';
/**
 * HygieneTracker - Tracks agent behavior regarding workspace organization and persistence.
 */
export declare class HygieneTracker {
    private readonly statsFile;
    private currentStats;
    private readonly logger?;
    constructor(stateDir: string, logger?: PluginLogger);
    private loadStats;
    private saveStats;
    /**
     * Records a persistence action (writing to memory or plan).
     */
    recordPersistence(action: PersistenceAction): void;
    /**
     * Records a grooming action (cleaning up the workspace).
     */
    recordGrooming(): void;
    getStats(): HygieneStats;
}
