export declare function handleBeforeToolCall(event: {
    toolName: string;
    params: Record<string, unknown>;
}, ctx: {
    workspaceDir?: string;
}): {
    block?: boolean;
    blockReason?: string;
} | void;
