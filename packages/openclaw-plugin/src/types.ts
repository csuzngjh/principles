// Re-export from local OpenClaw SDK shims.
// These types mirror openclaw/src/plugins/types.ts exactly.
// When openclaw is available as a peer dependency, you can switch to:
//   export type { PluginCommandContext, PluginCommandResult } from 'openclaw/plugin-sdk/core';
export type { PluginCommandContext, PluginCommandResult } from './openclaw-sdk.js';