import * as fs from 'fs';
import * as path from 'path';
import type { PluginHookBeforePromptBuildEvent, PluginHookAgentContext, PluginHookBeforePromptBuildResult } from '../openclaw-sdk.js';
import { getSession, resetFriction } from '../core/session-tracker.js';
import { WorkspaceContext } from '../core/workspace-context.js';

export async function handleBeforePromptBuild(
  event: PluginHookBeforePromptBuildEvent,
  ctx: PluginHookAgentContext & { api?: any }
): Promise<PluginHookBeforePromptBuildResult | void> {
  const workspaceDir = ctx.workspaceDir;
  if (!workspaceDir) return;

  const wctx = WorkspaceContext.fromHookContext(ctx);
  const { trigger, sessionId, api } = ctx;
  const focusPath = wctx.resolve('CURRENT_FOCUS');
  const painFlagPath = wctx.resolve('PAIN_FLAG');
  const capsPath = wctx.resolve('SYSTEM_CAPABILITIES');

  const config = wctx.config;
  const session = sessionId ? getSession(sessionId) : undefined;

  let prependSystemContext = '';
  let prependContext = '';
  let appendSystemContext = '';

  // 0. Manual Pain Clearance
  if (trigger === 'user' && sessionId && session && session.currentGfi >= 100) {
    resetFriction(sessionId, workspaceDir);
  }

  // ═══ LAYER 3 (道): Thinking OS + Reflection Checkpoint ═══
  // Both are static, cacheable content - put in prependSystemContext for provider caching
  const thinkingOsPath = wctx.resolve('THINKING_OS');
  if (fs.existsSync(thinkingOsPath)) {
    try {
      const thinkingOs = fs.readFileSync(thinkingOsPath, 'utf8');
      if (thinkingOs.trim()) {
        prependSystemContext = `<thinking_os>\n${thinkingOs.trim()}\n</thinking_os>`;
      }
    } catch (e) {}
  }

  // 1. Critical Reflection Logic (High Priority - Prompt Injection)
  const reflectionLogPath = path.join(workspaceDir, 'memory', 'reflection-log.md');
  if (fs.existsSync(reflectionLogPath)) {
    try {
      const reflectionLog = fs.readFileSync(reflectionLogPath, 'utf8');
      if (reflectionLog.trim()) {
        prependContext += `\n<reflection_log>\n${reflectionLog.trim()}\n</reflection_log>\n`;
      }
    } catch (e) {}
  }

  // 2. Strategic focus
  if (fs.existsSync(focusPath)) {
    try {
      const currentFocus = fs.readFileSync(focusPath, 'utf8');
      if (currentFocus.trim()) {
        prependContext += `\n<project_context>\n--- Strategic Focus ---\n${currentFocus.trim()}\n--- End of Strategic Focus ---\n</project_context>\n`;
      }
    } catch (e) {}
  }

  // 3. Background Evolution Directives
  const queuePath = wctx.resolve('EVOLUTION_QUEUE');
  if (fs.existsSync(queuePath)) {
    try {
      const queue = JSON.parse(fs.readFileSync(queuePath, 'utf8'));
      const inProgressTask = queue.find((t: any) => t.status === 'in_progress');
      
      if (inProgressTask) {
        // High-intensity directive to force the agent to work on the evolution task
        prependContext += `\n[🚨 SYSTEM OVERRIDE 🚨]\n` +
          `A critical evolution task is assigned to you. YOU MUST PRIORITIZE THIS TASK.\n` +
          `TASK: "${inProgressTask.task}"\n\n` +
          `ACTION REQUIRED:\n` +
          `Reply ONLY with "[EVOLUTION_ACK]". Then immediately invoke the \`sessions_spawn\` tool targeting \`diagnostician\` with the task above. NO OTHER ACTIONS PERMITTED.`;
      }
    } catch (e) {}
  }

  // 4. Perceptive awareness: System Capabilities
  if (fs.existsSync(capsPath)) {
    try {
      const caps = fs.readFileSync(capsPath, 'utf8');
      prependContext += `\n<system_capabilities>\n${caps}\n</system_capabilities>\n`;
    } catch (e) {}
  }

  // 5. Heartbeat-specific active checklist
  if (trigger === 'heartbeat') {
    const heartbeatPath = wctx.resolve('HEARTBEAT');
    if (fs.existsSync(heartbeatPath)) {
      try {
        const heartbeatChecklist = fs.readFileSync(heartbeatPath, 'utf8');
        prependContext += `\n<heartbeat_checklist>\n${heartbeatChecklist}\n\nDIRECTIVE: Perform a system-wide self-audit now. If everything is stable, strictly reply with "HEARTBEAT_OK" to minimize token usage.\n</heartbeat_checklist>\n`;
      } catch (e) {}
    }
  }

  // 6. Security Layer: Trust & Permission Awareness
  const scorecard = wctx.trust.getScorecard();
  const trustScore = scorecard.trust_score;
  const stage = wctx.trust.getStage();
  
  prependSystemContext += `\n[CURRENT TRUST SCORE: ${trustScore}/100 (Stage ${stage})]\n`;
  if (stage === 1) {
    prependSystemContext += `⚠️ WARNING: Your trust score is critical. You are in read-only mode. Use diagnostician sub-agents to recover trust.\n`;
  }

  return {
    prependSystemContext,
    prependContext,
    appendSystemContext
  };
}
