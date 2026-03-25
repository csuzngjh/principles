import { PD_FILES } from './paths.js';
import { PainConfig } from './config.js';
import { EventLog } from './event-log.js';
import { PainDictionary } from './dictionary.js';
import { TrustEngine } from './trust-engine.js';
import { HygieneTracker } from './hygiene/tracker.js';
import { EvolutionReducerImpl } from './evolution-reducer.js';
import { TrajectoryDatabase } from './trajectory.js';
/**
 * WorkspaceContext - Centralized management of workspace-specific paths and services.
 * Implements a cached singleton pattern per workspace directory.
 */
export declare class WorkspaceContext {
    private static instances;
    private static pathResolver;
    readonly workspaceDir: string;
    readonly stateDir: string;
    private _config?;
    private _eventLog?;
    private _dictionary?;
    private _trust?;
    private _hygiene?;
    private _evolutionReducer?;
    private _trajectory?;
    private constructor();
    /**
     * Governance configuration for this workspace.
     */
    get config(): PainConfig;
    /**
     * Event logging service for this workspace.
     */
    get eventLog(): EventLog;
    /**
     * Pain dictionary service for this workspace.
     */
    get dictionary(): PainDictionary;
    /**
     * Trust engine service bound to this workspace.
     */
    get trust(): TrustEngine;
    /**
     * Hygiene tracking service for this workspace.
     */
    get hygiene(): HygieneTracker;
    /**
     * Evolution reducer singleton for this workspace.
     */
    get evolutionReducer(): EvolutionReducerImpl;
    /**
     * Trajectory database for analytics and sample curation.
     */
    get trajectory(): TrajectoryDatabase;
    private getTrajectoryOptions;
    /**
     * Creates or retrieves a WorkspaceContext instance from an OpenClaw hook context.
     * Uses PathResolver to handle path normalization and fallback logic.
     * @throws Error if workspaceDir is missing and no fallback available.
     */
    static fromHookContext(ctx: any): WorkspaceContext;
    /**
     * Resolves a PD file path within the workspace.
     */
    resolve(fileKey: keyof typeof PD_FILES): string;
    /**
     * Resets internal caches for services and paths.
     */
    invalidate(): void;
    /**
     * Removes a workspace from the cache.
     */
    static dispose(workspaceDir: string): void;
    /**
     * Clears the instance cache (primarily for testing).
     */
    static clearCache(): void;
}
