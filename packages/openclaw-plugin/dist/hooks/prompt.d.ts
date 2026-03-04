export declare function handleBeforePromptBuild(event: {
    prompt: string;
    messages?: unknown[];
}, ctx: {
    workspaceDir?: string;
    agentId?: string;
}): {
    prependContext?: string;
} | void;
