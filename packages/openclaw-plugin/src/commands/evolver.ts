import type { PluginCommandContext, PluginCommandResult } from '../openclaw-sdk.js';

/**
 * /evolve-task [task description]
 *
 * Returns instructions that tell the Agent to invoke the sessions_spawn tool
 * targeting the evolver agent. Plugin command handlers cannot directly call
 * Gateway tools — only the AI agent can do that via sessions_spawn.
 */
export function handleEvolveTask(ctx: PluginCommandContext): PluginCommandResult {
  const task = ctx.args?.trim() || "Diagnose and fix the latest pain signals in .state/.pain_flag.";

  return {
    text:
      `🔧 **Evolver Handoff Requested**\n\n` +
      `To spin up the Evolver sub-agent, the Agent should call the \`sessions_spawn\` tool with:\n\n` +
      `**spawnId**: \`evolver\`\n` +
      `**task**: "${task}"\n\n` +
      `**Instructions for Agent:**\n` +
      `1. Use \`sessions_spawn\` now.\n` +
      `2. Target \`evolver\`.\n` +
      `3. Pass the task above.\n` +
      `4. No other tools needed until the sub-agent returns.`,
  };
}
