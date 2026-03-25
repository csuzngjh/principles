import { resolvePdPath } from './paths.js';
import { PathResolver } from './path-resolver.js';
import { ConfigService } from './config-service.js';
import { EventLogService } from './event-log.js';
import { DictionaryService } from './dictionary-service.js';
import { TrustEngine } from './trust-engine.js';
import { HygieneTracker } from './hygiene/tracker.js';
import { EvolutionReducerImpl } from './evolution-reducer.js';
import { TrajectoryRegistry } from './trajectory.js';
/**
 * WorkspaceContext - Centralized management of workspace-specific paths and services.
 * Implements a cached singleton pattern per workspace directory.
 */
export class WorkspaceContext {
    static instances = new Map();
    static pathResolver = new PathResolver();
    workspaceDir;
    stateDir;
    _config;
    _eventLog;
    _dictionary;
    _trust;
    _hygiene;
    _evolutionReducer;
    _trajectory;
    constructor(workspaceDir, stateDir) {
        this.workspaceDir = workspaceDir;
        this.stateDir = stateDir;
    }
    /**
     * Governance configuration for this workspace.
     */
    get config() {
        if (!this._config) {
            this._config = ConfigService.get(this.stateDir);
        }
        return this._config;
    }
    /**
     * Event logging service for this workspace.
     */
    get eventLog() {
        if (!this._eventLog) {
            this._eventLog = EventLogService.get(this.stateDir);
        }
        return this._eventLog;
    }
    /**
     * Pain dictionary service for this workspace.
     */
    get dictionary() {
        if (!this._dictionary) {
            this._dictionary = DictionaryService.get(this.stateDir);
        }
        return this._dictionary;
    }
    /**
     * Trust engine service bound to this workspace.
     */
    get trust() {
        if (!this._trust) {
            this._trust = new TrustEngine(this.workspaceDir);
        }
        return this._trust;
    }
    /**
     * Hygiene tracking service for this workspace.
     */
    get hygiene() {
        if (!this._hygiene) {
            this._hygiene = new HygieneTracker(this.stateDir);
        }
        return this._hygiene;
    }
    /**
     * Evolution reducer singleton for this workspace.
     */
    get evolutionReducer() {
        if (!this._evolutionReducer) {
            this._evolutionReducer = new EvolutionReducerImpl({ workspaceDir: this.workspaceDir });
        }
        return this._evolutionReducer;
    }
    /**
     * Trajectory database for analytics and sample curation.
     */
    get trajectory() {
        if (!this._trajectory) {
            this._trajectory = TrajectoryRegistry.get(this.workspaceDir, this.getTrajectoryOptions());
        }
        return this._trajectory;
    }
    getTrajectoryOptions() {
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
    static fromHookContext(ctx) {
        const logger = ctx.logger;
        const log = (msg) => logger?.info?.(msg) ?? console.log(msg);
        const logWarn = (msg) => logger?.warn?.(msg) ?? console.warn(msg);
        let workspaceDir = ctx.workspaceDir;
        if (!workspaceDir) {
            logWarn('[PD:WorkspaceContext] workspaceDir not provided in context, using PathResolver fallback');
            workspaceDir = this.pathResolver.getWorkspaceDir();
            log(`[PD:WorkspaceContext] Resolved workspaceDir to: ${workspaceDir}`);
        }
        else {
            const normalized = this.pathResolver.normalizeWorkspacePath(workspaceDir);
            if (normalized !== workspaceDir) {
                log(`[PD:WorkspaceContext] Normalized workspaceDir: ${workspaceDir} -> ${normalized}`);
                workspaceDir = normalized;
            }
        }
        const existing = this.instances.get(workspaceDir);
        if (existing)
            return existing;
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
    resolve(fileKey) {
        return resolvePdPath(this.workspaceDir, fileKey);
    }
    /**
     * Resets internal caches for services and paths.
     */
    invalidate() {
        this._config = undefined;
        this._eventLog = undefined;
        this._dictionary = undefined;
        this._trust = undefined;
        this._evolutionReducer = undefined;
        this._trajectory = undefined;
    }
    /**
     * Removes a workspace from the cache.
     */
    static dispose(workspaceDir) {
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
    static clearCache() {
        for (const instance of this.instances.values()) {
            instance.invalidate();
        }
        this.instances.clear();
        TrajectoryRegistry.clear();
    }
}
