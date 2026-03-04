import type { PluginCommandContext, PluginCommandResult } from '../types';

export function handleEvolveTask(ctx: PluginCommandContext): PluginCommandResult {
  const task = ctx.args || "Diagnose and fix the latest pain signals.";
  const spawnPayload = triggerEvolverHandoff(ctx.workspaceDir || ".", task);

  return {
    text: `Evolver handoff initiated. The Evolver agent will run in the background to handle: "${task}".\nSpawn Payload: \`${spawnPayload}\``,
  };
}

export function triggerEvolverHandoff(workspaceDir: string, task: string): string {
  // Format matches evolver's bridge.js sessions_spawn expectation
  const payload = JSON.stringify({
    task: task,
    agentId: "evolver", // Targeting the evolver agent
    cleanup: true,
    label: "Principles-Evolver-Synergy"
  });

  // Emitting this string causes OpenClaw Gateway to intercept and spawn a new subagent
  return `sessions_spawn(${payload})`;
}
