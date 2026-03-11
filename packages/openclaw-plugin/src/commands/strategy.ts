import type { PluginCommandContext, PluginCommandResult } from '../openclaw-sdk.js';

export function handleInitStrategy(_ctx: PluginCommandContext): PluginCommandResult {
  return {
    text:
      `🎯 **Strategy Initialization**\n\n` +
      `The Agent will now conduct a deep interview to establish your project's vision and strategic OKRs.\n\n` +
      `**Instructions for Agent:** Read \`memory/okr/\` for existing context. ` +
      `Generate \`memory/okr/CURRENT_FOCUS.md\` with the top 1-3 strategic focus areas based on the user interview. ` +
      `Then update \`memory/USER_CONTEXT.md\` with key user preferences discovered.`,
  };
}

export function handleManageOkr(_ctx: PluginCommandContext): PluginCommandResult {
  return {
    text:
      `📊 **OKR Management**\n\n` +
      `The Agent will analyze recent work and align sub-agent objectives.\n\n` +
      `**Instructions for Agent:** Read \`memory/okr/CURRENT_FOCUS.md\` and \`memory/okr/WEEK_STATE.json\`. ` +
      `Compare them against recent session history. ` +
      `Update OKRs as needed and output a brief alignment report. ` +
      `If OKRs are stale (>7 days), prompt the user for a re-alignment conversation.`,
  };
}
