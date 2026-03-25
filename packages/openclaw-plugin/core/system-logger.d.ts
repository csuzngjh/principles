/**
 * System Logger for Principles Disciple
 * Writes critical evolutionary events to the project's memory/logs/SYSTEM.log
 * Uses asynchronous writing to avoid blocking the Node.js event loop.
 */
export declare const SystemLogger: {
    log(workspaceDir: string | undefined, eventType: string, message: string): void;
};
