export declare function handleAfterToolCall(event: {
    toolName: string;
    params: Record<string, unknown>;
    error?: string;
    result?: any;
}, ctx: {
    workspaceDir?: string;
}): void;
