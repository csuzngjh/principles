import type { PluginCommandContext, PluginCommandResult } from '../openclaw-sdk.js';

/**
 * /evolve-task [task description]
 *
 * Returns instructions that tell the Agent to invoke the sessions_spawn tool
 * targeting the evolver agent. Plugin command handlers cannot directly call
 * Gateway tools — only the AI agent can do that via sessions_spawn.
 */
export function handleEvolveTask(ctx: PluginCommandContext): PluginCommandResult {
  const task = ctx.args?.trim() || "Diagnose and fix the latest pain signals in docs/.pain_flag.";

  return {
    text:
      `🔧 **Evolver Handoff Requested**\n\n` +
      `To spin up the Evolver sub-agent, the Agent should call the \`sessions_spawn\` tool with:\n\n` +
      `\`\`\`json\n` +
      JSON.stringify(
        {
          agentId: "evolver",
          mode: "run",
          message: task,
          label: "Principles-Evolver-Synergy",
        },
        null,
        2
      ) +
      `\n\`\`\`\n\n` +
      `If you are the Agent reading this: please call \`sessions_spawn\` now with the parameters above ` +
      `to delegate this task to the Evolver agent. Ensure \`tools.allow\` includes \`sessions_spawn\` ` +
      `in the current agent config.`,
  };
}
