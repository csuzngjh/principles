import * as fs from 'fs';
import * as path from 'path';
import type { PluginHookBeforePromptBuildEvent, PluginHookAgentContext, PluginHookBeforePromptBuildResult } from '../openclaw-sdk.js';
import { ConfigService } from '../core/config-service.js';
import { getSession, resetFriction } from '../core/session-tracker.js';

export function handleBeforePromptBuild(
  _event: PluginHookBeforePromptBuildEvent,
  ctx: PluginHookAgentContext
): PluginHookBeforePromptBuildResult | void {
  if (!ctx.workspaceDir) {
    return;
  }

  const { workspaceDir, trigger, stateDir, sessionId } = ctx;
  const focusPath = path.join(workspaceDir, 'docs', 'okr', 'CURRENT_FOCUS.md');
  const painFlagPath = path.join(workspaceDir, 'docs', '.pain_flag');
  const capsPath = path.join(workspaceDir, 'docs', 'SYSTEM_CAPABILITIES.json');

  // Use stateDir if available, fallback to workspaceDir/memory/.state (V1.1.0+ standard)
  const actualStateDir = stateDir || path.join(workspaceDir, 'memory', '.state');
  const directivePath = path.join(actualStateDir, 'evolution_directive.json');

  const config = ConfigService.get(actualStateDir);
  const session = sessionId ? getSession(sessionId) : undefined;

  let prependSystemContext = '';
  let prependContext = '';
  let appendSystemContext = '';

  // ── Track A: GFI Physical Override ──
  const gfiThreshold = config.get('thresholds.gfi_override') || 100;
  if (session && session.currentGfi >= gfiThreshold && sessionId) {
    const overrideMsg = `
[🚨 CRITICAL SYSTEM OVERRIDE 🚨]
Your Generalized Friction Index (GFI) has exceeded the safety threshold (**${session.currentGfi.toFixed(1)}**).
This indicates you are trapped in a failure loop or facing extreme environment resistance.

**Mandate**: 
1. STOP all current tool executions.
2. Enter a <reflection> state immediately.
3. Analyze the root cause of the last ${session.consecutiveErrors} failures.
4. PIVOT your strategy. Do not repeat the same failing command.
`;
    prependContext += `\n<system_override>\n${overrideMsg.trim()}\n</system_override>\n`;
    
    // Reset after injecting to allow progress if they actually pivot
    resetFriction(sessionId);
  }

  // ═══ LAYER 3 (道): Thinking OS → prependSystemContext (最高优先级认知注入) ═══
  // The Thinking OS is the agent's meta-cognitive framework.
  // Using prependSystemContext ensures:
  //  1. It is prepended to the system prompt (highest cognitive priority)
  //  2. Providers like Claude can CACHE it (prompt caching), so the ~450 tokens
  //     incur cost only on the first turn, then are essentially free thereafter.
  //  3. It does NOT override OpenClaw's native system prompt (unlike systemPrompt).
  const thinkingOsPath = path.join(workspaceDir, 'docs', 'THINKING_OS.md');
  if (fs.existsSync(thinkingOsPath)) {
    try {
      const thinkingOs = fs.readFileSync(thinkingOsPath, 'utf8');
      if (thinkingOs.trim()) {
        prependSystemContext = `<thinking_os>\n${thinkingOs.trim()}\n</thinking_os>`;
      }
    } catch (_e) {
      // Non-critical — Thinking OS not yet initialized
    }
  }

  // 1. User profile context (Now natively handled by OpenClaw via USER.md, skipping)

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
  if (prependSystemContext.trim()) result.prependSystemContext = prependSystemContext.trim();
  if (prependContext.trim()) result.prependContext = prependContext.trim();
  if (appendSystemContext.trim()) result.appendSystemContext = appendSystemContext.trim();

  if (Object.keys(result).length > 0) return result;
}
