import * as fs from 'fs';
import * as path from 'path';
import type { PluginHookBeforePromptBuildEvent, PluginHookAgentContext, PluginHookBeforePromptBuildResult } from '../openclaw-sdk.js';

export function handleBeforePromptBuild(
  _event: PluginHookBeforePromptBuildEvent,
  ctx: PluginHookAgentContext
): PluginHookBeforePromptBuildResult | void {
  if (!ctx.workspaceDir) {
    return;
  }

  const { workspaceDir, trigger } = ctx;
  const userContextPath = path.join(workspaceDir, 'docs', 'USER_CONTEXT.md');
  const focusPath = path.join(workspaceDir, 'docs', 'okr', 'CURRENT_FOCUS.md');
  const painFlagPath = path.join(workspaceDir, 'docs', '.pain_flag');
  const capsPath = path.join(workspaceDir, 'docs', 'SYSTEM_CAPABILITIES.json');

  let prependContext = '';

  // 1. User profile context
  if (fs.existsSync(userContextPath)) {
    try {
      const userContext = fs.readFileSync(userContextPath, 'utf8');
      if (userContext.trim()) {
        prependContext += `\n<global_context>\n--- Context from: docs/USER_CONTEXT.md ---\n${userContext}\n--- End of Context ---\n</global_context>\n`;
      }
    } catch (e) {
      // Non-critical — skip silently
    }
  }

  // 2. Strategic focus
  if (fs.existsSync(focusPath)) {
    try {
      const currentFocus = fs.readFileSync(focusPath, 'utf8');
      if (currentFocus.trim()) {
        prependContext += `\n<project_context>\n--- Context from: docs/okr/CURRENT_FOCUS.md ---\n${currentFocus}\n--- End of Context ---\n</project_context>\n`;
      }
    } catch (e) {
      // Non-critical — skip silently
    }
  }

  // 3. Proactive Evolution — pain flag (heightened urgency during heartbeat)
  if (fs.existsSync(painFlagPath)) {
    try {
      const painData = fs.readFileSync(painFlagPath, 'utf8');
      if (painData.trim()) {
        const isHeartbeat = trigger === 'heartbeat';
        const warning =
          `\n⚠️ CRITICAL PAIN SIGNAL DETECTED:\n${painData}\n` +
          (isHeartbeat
            ? 'You are currently in a HEARTBEAT turn. You MUST assess if an immediate /reflection or /evolve-task is required based on this pain.'
            : '');
        prependContext += `\n<evolution_context>${warning}</evolution_context>\n`;
      }
    } catch (e) {
      // Non-critical — skip silently
    }
  }

  // 4. Heartbeat-specific active checklist
  if (trigger === 'heartbeat') {
    const heartbeatPath = path.join(workspaceDir, 'docs', 'HEARTBEAT.md');
    if (fs.existsSync(heartbeatPath)) {
      try {
        const heartbeatChecklist = fs.readFileSync(heartbeatPath, 'utf8');
        prependContext += `\n<heartbeat_checklist>\n${heartbeatChecklist}\n\nDIRECTIVE: Perform a system-wide self-audit now. If everything is stable, strictly reply with "HEARTBEAT_OK" to minimize token usage.\n</heartbeat_checklist>\n`;
      } catch (e) {
        // Non-critical
      }
    }
  }

  // 5. Environment capabilities
  if (fs.existsSync(capsPath)) {
    try {
      const capsData = fs.readFileSync(capsPath, 'utf8');
      prependContext += `\n<system_capabilities>\n${capsData}\n</system_capabilities>\n`;
    } catch (e) {
      // Non-critical — skip silently
    }
  }

  const trimmed = prependContext.trim();
  if (!trimmed) return;
  return { prependContext: trimmed };
}
