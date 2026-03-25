import { WorkspaceContext } from '../core/workspace-context.js';
import type { PluginCommandContext, PluginCommandResult } from '../openclaw-sdk.js';
/**
 * Handles the /pd-rollback command
 *
 * Usage:
 *   /pd-rollback <event-id>  - Rollback a specific empathy event by ID
 *   /pd-rollback last        - Rollback the last empathy event in current session
 */
export declare function handleRollbackCommand(ctx: PluginCommandContext): PluginCommandResult;
/**
 * Handle natural language rollback request
 * Called from prompt hook when user says things like "撤销刚才的惩罚"
 */
export declare function handleNaturalLanguageRollback(wctx: WorkspaceContext, sessionId: string | undefined, reason: string): {
    success: boolean;
    score: number;
    message: string;
};
