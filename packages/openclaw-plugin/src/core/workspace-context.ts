import * as path from 'path';
import { resolvePdPath, PD_FILES } from './paths.js';
import { ConfigService } from './config-service.js';
import { PainConfig } from './config.js';
import { EventLogService, EventLog } from './event-log.js';
import { DictionaryService } from './dictionary-service.js';
import { PainDictionary } from './dictionary.js';
import { TrustEngine } from './trust-engine.js';
import { HygieneTracker } from './hygiene/tracker.js';

/**
 * WorkspaceContext - Centralized management of workspace-specific paths and services.
 * Implements a cached singleton pattern per workspace directory.
 */
export class WorkspaceContext {
    private static instances = new Map<string, WorkspaceContext>();

    public readonly workspaceDir: string;
    public readonly stateDir: string;

    private _config?: PainConfig;
    private _eventLog?: EventLog;
    private _dictionary?: PainDictionary;
    private _trust?: TrustEngine;
    private _hygiene?: HygieneTracker;

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
     * Trust engine service bound to this workspace.
     */
    get trust(): TrustEngine {
        if (!this._trust) {
            this._trust = new TrustEngine(this.workspaceDir);
        }
        return this._trust;
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
     * Creates or retrieves a WorkspaceContext instance from an OpenClaw hook context.
     * @throws Error if workspaceDir is missing.
     */
    static fromHookContext(ctx: any): WorkspaceContext {
        const workspaceDir = ctx.workspaceDir;
        if (!workspaceDir) {
            throw new Error('workspaceDir is required to create a WorkspaceContext.');
        }

        const existing = this.instances.get(workspaceDir);
        if (existing) return existing;

        const stateDir = ctx.stateDir || resolvePdPath(workspaceDir, 'STATE_DIR');
        const instance = new WorkspaceContext(workspaceDir, stateDir);
        this.instances.set(workspaceDir, instance);
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
        this._trust = undefined;
    }

    /**
     * Removes a workspace from the cache.
     */
    static dispose(workspaceDir: string): void {
        const instance = this.instances.get(workspaceDir);
        if (instance) {
            instance.invalidate();
            this.instances.delete(workspaceDir);
        }
    }

    /**
     * Clears the instance cache (primarily for testing).
     */
    static clearCache(): void {
        this.instances.clear();
    }
}
