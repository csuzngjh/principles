import { resolvePdPath, PD_FILES } from './paths.js';
import { PathResolver } from './path-resolver.js';
import { ConfigService } from './config-service.js';
import { PainConfig } from './config.js';
import { EventLogService, EventLog } from './event-log.js';
import { DictionaryService } from './dictionary-service.js';
import { PainDictionary } from './dictionary.js';
import { HygieneTracker } from './hygiene/tracker.js';
import { EvolutionReducerImpl } from './evolution-reducer.js';
import { TrajectoryDatabase, TrajectoryRegistry, TrajectoryDatabaseOptions } from './trajectory.js';
import { PrincipleLifecycleService } from './principle-internalization/principle-lifecycle-service.js';
import {
    getPrincipleSubtree,
    updatePrinciple,
    updatePrincipleValueMetrics,
    type PrincipleSubtree,
} from './principle-tree-ledger.js';
import type { Principle, PrincipleValueMetrics } from '../types/principle-tree-schema.js';
import type { Principle as ActivePrinciple } from './evolution-types.js';

interface PrincipleTreeLedgerAccessor {
    getPrincipleSubtree(principleId: string): PrincipleSubtree | undefined;
    updatePrinciple(principleId: string, updates: Partial<Principle>): Principle;
    updatePrincipleValueMetrics(principleId: string, metrics: PrincipleValueMetrics): PrincipleValueMetrics;
}

/**
 * WorkspaceContext - Centralized management of workspace-specific paths and services.
 * Implements a cached singleton pattern per workspace directory.
 */
export class WorkspaceContext {
    private static instances = new Map<string, WorkspaceContext>();
    private static pathResolver = new PathResolver();

    public readonly workspaceDir: string;
    public readonly stateDir: string;

    private _config?: PainConfig;
    private _eventLog?: EventLog;
    private _dictionary?: PainDictionary;
    private _hygiene?: HygieneTracker;
    private _evolutionReducer?: EvolutionReducerImpl;
    private _trajectory?: TrajectoryDatabase;
    private _principleTreeLedger?: PrincipleTreeLedgerAccessor;
    private _principleLifecycle?: PrincipleLifecycleService;

    private constructor(workspaceDir: string, stateDir: string) {
        this.workspaceDir = workspaceDir;
        this.stateDir = stateDir;
    }

    /**
     * Governance configuration for this workspace.
     */
    get config(): PainConfig {
        if (!this._config) {
            this._config = ConfigService.get(this.stateDir);
        }
        return this._config;
    }

    /**
     * Event logging service for this workspace.
     */
    get eventLog(): EventLog {
        if (!this._eventLog) {
            this._eventLog = EventLogService.get(this.stateDir);
        }
        return this._eventLog;
    }

    /**
     * Pain dictionary service for this workspace.
     */
    get dictionary(): PainDictionary {
        if (!this._dictionary) {
            this._dictionary = DictionaryService.get(this.stateDir);
        }
        return this._dictionary;
    }

    /**
     * Hygiene tracking service for this workspace.
     */
    get hygiene(): HygieneTracker {
        if (!this._hygiene) {
            this._hygiene = new HygieneTracker(this.stateDir);
        }
        return this._hygiene;
    }


    /**
     * Evolution reducer singleton for this workspace.
     */
    get evolutionReducer(): EvolutionReducerImpl {
        if (!this._evolutionReducer) {
            this._evolutionReducer = new EvolutionReducerImpl({ workspaceDir: this.workspaceDir, stateDir: this.stateDir });
        }
        return this._evolutionReducer;
    }

    /**
     * Trajectory database for analytics and sample curation.
     */
    get trajectory(): TrajectoryDatabase {
        if (!this._trajectory) {
            this._trajectory = TrajectoryRegistry.get(this.workspaceDir, this.getTrajectoryOptions());
        }
        return this._trajectory;
    }

    /**
     * Locked ledger access for principle tree reads and metric writes in this workspace.
     */
    get principleTreeLedger(): PrincipleTreeLedgerAccessor {
        if (!this._principleTreeLedger) {
            this._principleTreeLedger = {
                getPrincipleSubtree: (principleId: string) => getPrincipleSubtree(this.stateDir, principleId),
                updatePrinciple: (principleId: string, updates: Partial<Principle>) =>
                    updatePrinciple(this.stateDir, principleId, updates),
                updatePrincipleValueMetrics: (principleId: string, metrics: PrincipleValueMetrics) =>
                    updatePrincipleValueMetrics(this.stateDir, principleId, metrics),
            };
        }
        return this._principleTreeLedger;
    }

    /**
     * Phase 15 lifecycle/read-model surface for metrics, assessments, and route recommendations.
     */
    get principleLifecycle(): PrincipleLifecycleService {
        if (!this._principleLifecycle) {
            this._principleLifecycle = new PrincipleLifecycleService(this.workspaceDir, this.stateDir);
        }
        return this._principleLifecycle;
    }

    /**
     * Retrieve active Principle -> Rule -> Implementation subtrees without bypassing reducer authority.
     */
    getActivePrincipleSubtrees(): Array<{ principle: ActivePrinciple; subtree: PrincipleSubtree }> {
        return this.evolutionReducer
            .getActivePrinciples()
            .map((principle) => {
                const subtree = this.principleTreeLedger.getPrincipleSubtree(principle.id);
                return subtree ? { principle, subtree } : null;
            })
            .filter(
                (entry): entry is { principle: ActivePrinciple; subtree: PrincipleSubtree } => entry !== null,
            );
    }

    private getTrajectoryOptions(): Omit<TrajectoryDatabaseOptions, 'workspaceDir'> {
        const inlineThreshold = Number(this.config.get('trajectory.blob_inline_threshold_bytes'));
        const busyTimeoutMs = Number(this.config.get('trajectory.busy_timeout_ms'));
        const orphanBlobGraceDays = Number(this.config.get('trajectory.orphan_blob_grace_days'));

        return {
            blobInlineThresholdBytes: Number.isFinite(inlineThreshold) && inlineThreshold > 0 ? inlineThreshold : undefined,
            busyTimeoutMs: Number.isFinite(busyTimeoutMs) && busyTimeoutMs >= 0 ? busyTimeoutMs : undefined,
            orphanBlobGraceDays: Number.isFinite(orphanBlobGraceDays) && orphanBlobGraceDays >= 0 ? orphanBlobGraceDays : undefined,
        };
    }

    /**
     * Creates or retrieves a WorkspaceContext instance from an OpenClaw hook context.
     * Uses PathResolver to handle path normalization and fallback logic.
     * @throws Error if workspaceDir is missing and no fallback available.
     */
    static fromHookContext(ctx: any): WorkspaceContext {
        const logger = ctx.logger;
        const log = (msg: string) => logger?.info?.(msg);
        const logWarn = (msg: string) => logger?.warn?.(msg);

        let workspaceDir = ctx.workspaceDir;
        
        if (!workspaceDir) {
            logWarn('[PD:WorkspaceContext] workspaceDir not provided in context, using PathResolver fallback');
            workspaceDir = this.pathResolver.getWorkspaceDir();
            log(`[PD:WorkspaceContext] Resolved workspaceDir to: ${workspaceDir}`);
        } else {
            const normalized = this.pathResolver.normalizeWorkspacePath(workspaceDir);
            if (normalized !== workspaceDir) {
                log(`[PD:WorkspaceContext] Normalized workspaceDir: ${workspaceDir} -> ${normalized}`);
                workspaceDir = normalized;
            }
        }

        const existing = this.instances.get(workspaceDir);
        if (existing) return existing;

        let stateDir = ctx.stateDir;
        if (!stateDir) {
            stateDir = resolvePdPath(workspaceDir, 'STATE_DIR');
            log(`[PD:WorkspaceContext] Computed stateDir: ${stateDir}`);
        }

        const instance = new WorkspaceContext(workspaceDir, stateDir);
        this.instances.set(workspaceDir, instance);
        
        log(`[PD:WorkspaceContext] Created new context for workspace: ${workspaceDir}`);
        
        return instance;
    }

    /**
     * Resolves a PD file path within the workspace.
     */
    resolve(fileKey: keyof typeof PD_FILES): string {
        return resolvePdPath(this.workspaceDir, fileKey);
    }

    /**
     * Resets internal caches for services and paths.
     */
    invalidate(): void {
        this._config = undefined;
        this._eventLog = undefined;
        this._dictionary = undefined;
        this._evolutionReducer = undefined;
        this._trajectory = undefined;
        this._principleTreeLedger = undefined;
        this._principleLifecycle = undefined;
    }

    /**
     * Removes a workspace from the cache.
     */
    static dispose(workspaceDir: string): void {
        const normalized = this.pathResolver.normalizeWorkspacePath(workspaceDir);
        const instance = this.instances.get(normalized);
        if (instance) {
            instance.invalidate();
            this.instances.delete(normalized);
        }
        TrajectoryRegistry.dispose(normalized);
    }

    /**
     * Clears the instance cache (primarily for testing).
     */
    static clearCache(): void {
        for (const instance of this.instances.values()) {
            instance.invalidate();
        }
        this.instances.clear();
        TrajectoryRegistry.clear();
    }
}
