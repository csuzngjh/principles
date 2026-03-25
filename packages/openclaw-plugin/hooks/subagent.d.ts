import type { PluginHookSubagentEndedEvent, PluginHookSubagentContext } from '../openclaw-sdk.js';
import { type EmpathyObserverApi } from '../service/empathy-observer-manager.js';
type SubagentEndedHookContext = PluginHookSubagentContext & {
    api?: EmpathyObserverApi;
    workspaceDir?: string;
    sessionId?: string;
    agentId?: string;
};
export declare function handleSubagentEnded(event: PluginHookSubagentEndedEvent, ctx: SubagentEndedHookContext): Promise<void>;
export {};
