import type { PD_FILES } from './paths.js';
import { resolvePdPath } from './paths.js';
import { PathResolver } from './path-resolver.js';
import { validateWorkspaceDir } from './workspace-dir-validation.js';
import { ConfigService } from './config-service.js';
import type { PainConfig } from './config.js';
import type { EventLog } from './event-log.js';
import { EventLogService } from './event-log.js';
import { DictionaryService } from './dictionary-service.js';
import type { PainDictionary } from './dictionary.js';
import { HygieneTracker } from './hygiene/tracker.js';
import { EvolutionReducerImpl } from './evolution-reducer.js';
import type { TrajectoryDatabase, TrajectoryDatabaseOptions } from './trajectory.js';
import { TrajectoryRegistry } from './trajectory.js';
import { PrincipleLifecycleService } from './principle-internalization/principle-lifecycle-service.js';
import {
    getPrincipleSubtree,
    updatePrinciple,
    updatePrincipleValueMetrics,
    type PrincipleSubtree,
    type LedgerPrinciple,
    type PrincipleValueMetrics,
} from './principle-tree-ledger.js';
import type { Principle as ActivePrinciple } from './evolution-types.js';
import { RuleHost } from './rule-host.js';
import type { RuleHostLogger } from './rule-host.js';


interface PrincipleTreeLedgerAccessor {
    getPrincipleSubtree(_principleId: string): PrincipleSubtree | undefined;
    updatePrinciple(_principleId: string, updates: Partial<LedgerPrinciple>): LedgerPrinciple;
    updatePrincipleValueMetrics(principleId: string, _metrics: PrincipleValueMetrics): PrincipleValueMetrics;
}
 

/**
 * WorkspaceContext - Centralized management of workspace-specific paths and services.
 * Implements a cached singleton pattern per workspace directory.
 */
export class WorkspaceContext {
    private static readonly instances = new Map<string, WorkspaceContext>();
    private static readonly pathResolver = new PathResolver();

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
    private _ruleHost?: RuleHost;

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
     *
     * PRI-647: TrajectoryService.stop() calls TrajectoryRegistry.dispose()
     * directly (closing the SQLite connection) without invalidating this
     * cached handle. If the cached database was closed underneath us, reacquire
     * a fresh instance instead of returning the dead connection (previously
     * threw TypeError: The database connection is not open and dropped every
     * injected principle on prompt build).
     */
    get trajectory(): TrajectoryDatabase {
        if (!this._trajectory || this._trajectory.isOpen === false) {
            this._trajectory = TrajectoryRegistry.get(this.workspaceDir, this.getTrajectoryOptions());
        }
        return this._trajectory;
    }

    getRuleHost(logger: RuleHostLogger): RuleHost {
        if (!this._ruleHost) {
            this._ruleHost = new RuleHost(this.stateDir, logger, { workspaceDir: this.workspaceDir });
        } else {
            this._ruleHost.updateLogger(logger);
        }
        return this._ruleHost;
    }

    /**
     * Locked ledger access for principle tree reads and metric writes in this workspace.
     */
    get principleTreeLedger(): PrincipleTreeLedgerAccessor {
        if (!this._principleTreeLedger) {
            this._principleTreeLedger = {
                getPrincipleSubtree: (principleId: string) => getPrincipleSubtree(this.stateDir, principleId),
                updatePrinciple: (principleId: string, updates: Partial<LedgerPrinciple>) =>
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
    getActivePrincipleSubtrees(): { principle: ActivePrinciple; subtree: PrincipleSubtree }[] {
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
        const {logger} = ctx;
        const log = (msg: string) => logger?.info?.(msg);
        const logWarn = (msg: string) => logger?.warn?.(msg);

        let {workspaceDir} = ctx;
        
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

        const validationIssue = validateWorkspaceDir(workspaceDir);
        if (validationIssue !== null) {
            logWarn(
                `[PD:WorkspaceContext] LEGACY_PATH_RESOLVER_FALLBACK: ${validationIssue}. ` +
                'This is a legacy discovery path; explicit workspaceDir should be provided in the hook context.',
            );
        }

        const existing = this.instances.get(workspaceDir);
        if (existing) return existing;

        let {stateDir} = ctx;
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
     * Creates a WorkspaceContext requiring explicit workspaceDir.
     * For Runtime V2 entrypoints where implicit PathResolver fallback is unacceptable.
     * @throws Error if workspaceDir is not provided in the context.
     */
    static fromHookContextExplicit(ctx: { workspaceDir?: string; logger?: { error?: (...args: unknown[]) => void; warn?: (...args: unknown[]) => void; info?: (...args: unknown[]) => void } }): WorkspaceContext {
        const { logger } = ctx;
        let { workspaceDir } = ctx;
        if (!workspaceDir || !workspaceDir.trim()) {
            const error = {
                ok: false as const,
                reason: 'workspace_dir_missing',
                message: 'workspaceDir is required for Runtime V2 entrypoints. Provide it explicitly in the hook context.',
                nextAction: 'Ensure the OpenClaw hook context includes workspaceDir, or use PD_WORKSPACE_DIR env var.',
            };
            logger?.error?.(`[PD:WorkspaceContext] ${error.message}`);
            throw new Error(`[PD:WorkspaceContext] ${error.reason}: ${error.message}`);
        }
        const normalized = this.pathResolver.normalizeWorkspacePath(workspaceDir);
        if (normalized !== workspaceDir) {
            logger?.info?.(`[PD:WorkspaceContext] Normalized workspaceDir before validation: ${workspaceDir} -> ${normalized}`);
            workspaceDir = normalized;
        }
        const validationIssue = validateWorkspaceDir(workspaceDir);
        if (validationIssue !== null) {
            const error = {
                ok: false as const,
                reason: 'workspace_dir_invalid',
                message: `workspaceDir validation failed for Runtime V2 entrypoint: ${validationIssue}`,
                nextAction: 'Provide a valid workspaceDir that is not the home directory, root, or empty.',
            };
            logger?.error?.(`[PD:WorkspaceContext] ${error.message}`);
            throw new Error(`[PD:WorkspaceContext] ${error.reason}: ${error.message}`);
        }
        return this.fromHookContext({ ...ctx, workspaceDir });
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
        this._ruleHost?.dispose();
        this._ruleHost = undefined;
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
