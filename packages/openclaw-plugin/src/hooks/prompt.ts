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

  const { workspaceDir, trigger, stateDir } = ctx;
  const userContextPath = path.join(workspaceDir, 'docs', 'USER_CONTEXT.md');
  const focusPath = path.join(workspaceDir, 'docs', 'okr', 'CURRENT_FOCUS.md');
  const painFlagPath = path.join(workspaceDir, 'docs', '.pain_flag');
  const capsPath = path.join(workspaceDir, 'docs', 'SYSTEM_CAPABILITIES.json');

  // Use stateDir if available, fallback to workspaceDir/docs/.state
  const actualStateDir = stateDir || path.join(workspaceDir, 'docs', '.state');
  const directivePath = path.join(actualStateDir, 'evolution_directive.json');

  let prependContext = '';
  let appendSystemContext = '';

  // 1. User profile context (STATIC -> appendSystemContext)
  if (fs.existsSync(userContextPath)) {
    try {
      const userContext = fs.readFileSync(userContextPath, 'utf8');
      if (userContext.trim()) {
        appendSystemContext += `\n<global_context>\n--- Context from: docs/USER_CONTEXT.md ---\n${userContext}\n--- End of Context ---\n</global_context>\n`;
      }
    } catch (e) {
      // Non-critical — skip silently
    }
  }

  // 2. Strategic focus (DYNAMIC -> prependContext)
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

  // 3. Background Evolution Directives (DYNAMIC -> prependContext)
  let handledDirective = false;
  if (fs.existsSync(directivePath)) {
    try {
      const directive = JSON.parse(fs.readFileSync(directivePath, 'utf8'));
      if (directive.active) {
        handledDirective = true;
        const directiveMsg =
          `\n🚨 SYSTEM OVERRIDE: AUTONOMOUS EVOLUTION REQUIRED 🚨\n` +
          `Task: ${directive.task}\n\n` +
          `You MUST immediately invoke the \`sessions_spawn\` tool to delegate this diagnosis to the \`diagnostician\` subagent.\n` +
          `Do not attempt to fix it yourself yet. Ask the diagnostician to investigate and report back.`;

        prependContext += `\n<evolution_directive>${directiveMsg}</evolution_directive>\n`;

        directive.active = false;
        fs.writeFileSync(directivePath, JSON.stringify(directive, null, 2), 'utf8');
      }
    } catch (e) {
      // Ignore
    }
  }

  // 4. Proactive Evolution — pain flag (Heightened urgency during heartbeat)
  if (!handledDirective && fs.existsSync(painFlagPath)) {
    try {
      const painData = fs.readFileSync(painFlagPath, 'utf8');
      if (painData.trim() && !painData.includes('status: queued')) {
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

  // 5. Heartbeat-specific active checklist
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

  // 6. Environment capabilities (STATIC -> appendSystemContext)
  if (fs.existsSync(capsPath)) {
    try {
      const capsData = fs.readFileSync(capsPath, 'utf8');
      appendSystemContext += `\n<system_capabilities>\n${capsData}\n</system_capabilities>\n`;
    } catch (e) {
      // Non-critical — skip silently
    }
  }

  const result: PluginHookBeforePromptBuildResult = {};
  if (prependContext.trim()) result.prependContext = prependContext.trim();
  if (appendSystemContext.trim()) result.appendSystemContext = appendSystemContext.trim();

  if (Object.keys(result).length > 0) return result;
}
