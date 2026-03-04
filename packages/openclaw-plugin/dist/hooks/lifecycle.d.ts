export declare function handleBeforeReset(event: {
    sessionFile?: string;
    messages?: any[];
    reason?: string;
}, ctx: {
    workspaceDir?: string;
}): Promise<void>;
export declare function handleBeforeCompaction(event: {
    messageCount: number;
    messages?: any[];
}, ctx: {
    workspaceDir?: string;
}): Promise<void>;
