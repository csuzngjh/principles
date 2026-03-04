export type PluginCommandContext = {
    senderId?: string;
    channel: string;
    channelId?: string;
    isAuthorizedSender: boolean;
    args?: string;
    commandBody: string;
    config: any;
    from?: string;
    to?: string;
    accountId?: string;
    messageThreadId?: number;
    workspaceDir?: string;
};

export type PluginCommandResult = {
    text: string;
};