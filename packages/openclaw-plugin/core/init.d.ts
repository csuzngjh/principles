import type { OpenClawPluginApi, PluginLogger } from '../openclaw-sdk.js';
/**
 * Ensures that the workspace has the necessary template files for Principles Disciple.
 * This function flattens 'core' templates to the root so OpenClaw can find them.
 */
export declare function ensureWorkspaceTemplates(api: OpenClawPluginApi, workspaceDir: string, language?: string): void;
/**
 * Ensures that the state directory has the necessary files (like pain_dictionary.json).
 */
export declare function ensureStateTemplates(ctx: {
    logger: PluginLogger;
}, stateDir: string, language?: string): void;
