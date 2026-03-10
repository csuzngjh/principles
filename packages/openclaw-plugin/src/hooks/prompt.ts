import * as fs from 'fs';
import * as path from 'path';
import type { PluginHookBeforePromptBuildEvent, PluginHookAgentContext, PluginHookBeforePromptBuildResult } from '../openclaw-sdk.js';
import { ConfigService } from '../core/config-service.js';
import { getSession, resetFriction } from '../core/session-tracker.js';

export async function handleBeforePromptBuild(
  event: PluginHookBeforePromptBuildEvent,
  ctx: PluginHookAgentContext & { api?: any }
): Promise<PluginHookBeforePromptBuildResult | void> {
  if (!ctx.workspaceDir) {
    return;
  }

  const { workspaceDir, trigger, stateDir, sessionId, api } = ctx;
  const focusPath = path.join(workspaceDir, 'docs', 'okr', 'CURRENT_FOCUS.md');
  const painFlagPath = path.join(workspaceDir, 'docs', '.pain_flag');
  const capsPath = path.join(workspaceDir, 'docs', 'SYSTEM_CAPABILITIES.json');

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
    resetFriction(sessionId);
  }

  // ═══ LAYER 3 (道): Thinking OS ═══
  const thinkingOsPath = path.join(workspaceDir, 'docs', 'THINKING_OS.md');
  if (fs.existsSync(thinkingOsPath)) {
    try {
      const thinkingOs = fs.readFileSync(thinkingOsPath, 'utf8');
      if (thinkingOs.trim()) {
        prependSystemContext = `<thinking_os>\n${thinkingOs.trim()}\n</thinking_os>`;
      }
    } catch (_e) {}
  }

  // 2. Strategic focus
  if (fs.existsSync(focusPath)) {
    try {
      const currentFocus = fs.readFileSync(focusPath, 'utf8');
      if (currentFocus.trim()) {
        prependContext += `\n<project_context>\n--- Context from: docs/okr/CURRENT_FOCUS.md ---\n${currentFocus}\n--- End of Context ---\n</project_context>\n`;
      }
    } catch (e) {}
  }

  // 3. Background Evolution Directives
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
          `IMPORTANT: You MUST acknowledge this directive by responding with the exact text:\n` +
          `[EVOLUTION_ACKNOWLEDGED]\n\n` +
          `Then you MUST call the \`sessions_spawn\` tool with:\n` +
          `- agentId: "diagnostician"\n` +
          `- task: "${directive.task}"\n\n` +
          `Do not attempt to fix it yourself yet. Ask the diagnostician to investigate and report back.`;

        prependContext += `\n<evolution_directive>${directiveMsg}</evolution_directive>\n`;

        directive.active = false;
        fs.writeFileSync(directivePath, JSON.stringify(directive, null, 2), 'utf8');
      }
    } catch (e) {}
  }

  // 4. Proactive Evolution — pain flag
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
    } catch (e) {}
  }

  // 5. Heartbeat-specific active checklist
  if (trigger === 'heartbeat') {
    const heartbeatPath = path.join(workspaceDir, 'docs', 'HEARTBEAT.md');
    if (fs.existsSync(heartbeatPath)) {
      try {
        const heartbeatChecklist = fs.readFileSync(heartbeatPath, 'utf8');
        prependContext += `\n<heartbeat_checklist>\n${heartbeatChecklist}\n\nDIRECTIVE: Perform a system-wide self-audit now. If everything is stable, strictly reply with "HEARTBEAT_OK" to minimize token usage.\n</heartbeat_checklist>\n`;
      } catch (e) {}
    }
  }

  // 6. Environment capabilities
  if (fs.existsSync(capsPath)) {
    try {
      const capsData = fs.readFileSync(capsPath, 'utf8');
      appendSystemContext += `\n<system_capabilities>\n${capsData}\n</system_capabilities>\n`;
    } catch (e) {}
  }

  // 7. V1.3.0: Pre-emptive Semantic Warning
  if (api && event.prompt && trigger !== 'heartbeat') {
    try {
      const searchTool = api.runtime?.tools?.createMemorySearchTool?.({ config: api.config });
      if (searchTool) {
        const searchResult = await searchTool.execute('pre-emptive-pain-check', {
          query: event.prompt,
          minScore: 0.8,
          maxResults: 1
        });
        
        const results = (searchResult as any)?.results || [];
        if (results.length > 0) {
          const warning = `
[⚠️ ANTI-FRAGILITY WARNING ⚠️]
Your current intent matches historical failure patterns or expressions of confusion recorded in memory.
**Historical Context**: "${results[0].snippet.substring(0, 200).replace(/\n/g, ' ')}..."
**Advice**: Analyze why similar tasks failed in the past. PIVOT your approach if necessary to avoid repeating errors.
`;
          prependContext += `\n<semantic_warning>${warning.trim()}</semantic_warning>\n`;
        }
      }
    } catch (err) {}
  }

  const result: PluginHookBeforePromptBuildResult = {};
  if (prependSystemContext.trim()) result.prependSystemContext = prependSystemContext.trim();
  if (prependContext.trim()) result.prependContext = prependContext.trim();
  if (appendSystemContext.trim()) result.appendSystemContext = appendSystemContext.trim();

  if (Object.keys(result).length > 0) return result;
}
