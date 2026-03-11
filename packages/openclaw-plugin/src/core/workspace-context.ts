import * as path from 'path';
import { resolvePdPath, PD_FILES } from './paths.js';

/**
 * WorkspaceContext - Centralized management of workspace-specific paths and services.
 * Implements a cached singleton pattern per workspace directory.
 */
export class WorkspaceContext {
    private static instances = new Map<string, WorkspaceContext>();

    public readonly workspaceDir: string;
    public readonly stateDir: string;

    private constructor(workspaceDir: string, stateDir: string) {
        this.workspaceDir = workspaceDir;
        this.stateDir = stateDir;
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
        // Future: Reset service caches (Config, EventLog, etc.)
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
