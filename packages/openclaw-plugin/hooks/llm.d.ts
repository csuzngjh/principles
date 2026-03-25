import { PluginHookLlmOutputEvent, PluginHookAgentContext } from '../openclaw-sdk.js';
export interface EmpathySignal {
    detected: boolean;
    severity: 'mild' | 'moderate' | 'severe';
    confidence: number;
    reason?: string;
    mode?: 'structured' | 'legacy_tag';
}
export declare function extractEmpathySignal(text: string): EmpathySignal;
export declare function handleLlmOutput(event: PluginHookLlmOutputEvent, ctx: PluginHookAgentContext & {
    workspaceDir?: string;
}): void;
