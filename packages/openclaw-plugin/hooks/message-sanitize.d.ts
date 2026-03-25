import type { PluginHookBeforeMessageWriteEvent, PluginHookBeforeMessageWriteResult } from '../openclaw-sdk.js';
export declare function sanitizeAssistantText(text: string): string;
export declare function handleBeforeMessageWrite(event: PluginHookBeforeMessageWriteEvent): PluginHookBeforeMessageWriteResult | void;
