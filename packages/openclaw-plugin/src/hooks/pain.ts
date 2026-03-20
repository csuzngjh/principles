import * as fs from 'fs';
import * as path from 'path';
import { isRisky, normalizePath } from '../utils/io.js';
import { normalizeProfile } from '../core/profile.js';
import { computePainScore, writePainFlag } from '../core/pain.js';
import { getSession, trackFriction, resetFriction, getInjectedProbationIds, clearInjectedProbationIds } from '../core/session-tracker.js';
import { denoiseError, computeHash } from '../utils/hashing.js';
import { SystemLogger } from '../core/system-logger.js';
import { WorkspaceContext } from '../core/workspace-context.js';
import type { EvolutionLoopEvent } from '../core/evolution-types.js';
import type { PluginHookAfterToolCallEvent, PluginHookToolContext, OpenClawPluginApi } from '../openclaw-sdk.js';

/**
 * Interface for tool parameters to avoid 'any'
 */
interface ToolParams {
  file_path?: string;
  path?: string;
  file?: string;
  content?: string;
  new_string?: string;
  text?: string;
  query?: string;
  input?: string;
  arguments?: string;
}

const WRITE_TOOLS = ['write', 'edit', 'apply_patch', 'write_file', 'edit_file', 'replace'];

function shouldAttributePrincipleToTool(principle: { contextTags: string[]; trigger: string; }, toolName: string): boolean {
  return principle.contextTags.includes(toolName) || principle.trigger.includes(toolName);
}

function emitPainDetectedEvent(wctx: WorkspaceContext, event: EvolutionLoopEvent): void {
  try {
    wctx.evolutionReducer.emitSync(event);
  } catch (e) {
    SystemLogger.log(wctx.workspaceDir, 'EVOLUTION_EMIT_WARN', `Failed to emit evolution event: ${String(e)}`);
  }
}

function createPainId(sessionId: string): string {
  return `pain_${Date.now()}_${computeHash(sessionId).slice(0, 8)}`;
}

export function handleAfterToolCall(
  event: PluginHookAfterToolCallEvent,
  ctx: PluginHookToolContext & { workspaceDir?: string; pluginConfig?: Record<string, unknown> },
  api?: OpenClawPluginApi
): void {
  const effectiveWorkspaceDir = ctx.workspaceDir || (api as any)?.workspaceDir || api?.resolvePath?.('.');
  if (!effectiveWorkspaceDir) {
    return;
  }

  const wctx = WorkspaceContext.fromHookContext({ ...ctx, workspaceDir: effectiveWorkspaceDir });
  const config = wctx.config;
  const eventLog = wctx.eventLog;
  const trust = wctx.trust;
  const sessionId = ctx.sessionId || 'unknown';
  const sessionState = ctx.sessionId ? getSession(ctx.sessionId) : undefined;
  const gfiBefore = sessionState?.currentGfi ?? 0;
  const params = event.params as ToolParams;

  // ── Track A: Empirical Friction (GFI) ──
  
  // 0. Special Case: Manual Pain Intervention
  if (event.toolName === 'pain' || event.toolName === 'skill:pain') {
    const reason = params.input || params.arguments || 'Manual intervention';
    trackFriction(sessionId, 100, 'manual_pain', effectiveWorkspaceDir);
    SystemLogger.log(effectiveWorkspaceDir, 'MANUAL_PAIN', `User manually triggered pain: ${reason}`);
    eventLog.recordPainSignal(sessionId, {
      score: 100,
      source: 'manual',
      reason: `User intervention: ${reason}`,
      isRisky: true
    });
    wctx.trajectory?.recordPainEvent?.({
      sessionId,
      source: 'manual',
      score: 100,
      reason: `User intervention: ${reason}`,
      origin: 'user_manual',
    });
    emitPainDetectedEvent(wctx, {
      ts: new Date().toISOString(),
      type: 'pain_detected',
      data: {
        painId: createPainId(sessionId),
        painType: 'user_frustration',
        source: event.toolName,
        reason: `User intervention: ${reason}`,
        score: 100,
        sessionId,
      },
    });
    return;
  }

  // 1. Determine if this was a failure
  const exitCode = (event.result && typeof event.result === 'object') ? (event.result as any).exitCode : 0;
  const isFailure = !!event.error || (exitCode !== 0 && exitCode !== undefined);

  if (isFailure) {
    const errorText = event.error || (typeof event.result === 'string' ? event.result : JSON.stringify(event.result));
    const denoised = denoiseError(errorText);
    const hash = computeHash(denoised);
    
    const deltaF = config.get('scores.tool_failure_friction') || 30;
    const updatedState = trackFriction(sessionId, deltaF, hash, effectiveWorkspaceDir);
    
    // ── Trust Engine: Record failure ──
    const errorType = extractErrorType(event.error || errorText);
    const filePath = params.file_path || params.path || params.file;
    const relPath = typeof filePath === 'string' ? normalizePath(filePath, effectiveWorkspaceDir) : 'unknown';
    
    // Load profile for risk_paths check
    const profilePath = wctx.resolve('PROFILE');
    let profile = normalizeProfile({});
    if (fs.existsSync(profilePath)) {
      try {
        profile = normalizeProfile(JSON.parse(fs.readFileSync(profilePath, 'utf8')));
      } catch (e) {
        SystemLogger.log(effectiveWorkspaceDir, 'PROFILE_PARSE_WARN', `Failed to parse PROFILE.json: ${String(e)}`);
      }
    }
    
    const isRisk = isRisky(relPath, profile.risk_paths);
    
    trust.recordFailure(isRisk ? 'risky' : 'tool', {
        sessionId,
        api,
        toolName: event.toolName,
        error: event.error // Pass error for timeout detection
    });
    
    // Record tool call failure event
    eventLog.recordToolCall(sessionId, {
      toolName: event.toolName,
      filePath: typeof filePath === 'string' ? filePath : undefined,
      error: event.error ? String(event.error).substring(0, 200) : undefined,
      errorType,
      gfi: updatedState.currentGfi,
      consecutiveErrors: updatedState.consecutiveErrors,
      exitCode,
    });
    wctx.trajectory?.recordToolCall?.({
      sessionId,
      toolName: event.toolName,
      outcome: 'failure',
      durationMs: event.durationMs,
      exitCode,
      errorType,
      errorMessage: event.error ? String(event.error) : undefined,
      gfiBefore,
      gfiAfter: updatedState.currentGfi,
      paramsJson: event.params,
    });

    const injectedProbationIds = getInjectedProbationIds(sessionId, effectiveWorkspaceDir);
    for (const id of injectedProbationIds) {
      const principle = wctx.evolutionReducer.getPrincipleById(id);
      const shouldAttribute = !!principle && shouldAttributePrincipleToTool(principle, event.toolName);
      if (shouldAttribute) {
        wctx.evolutionReducer.recordProbationFeedback(id, false);
      }
    }
    clearInjectedProbationIds(sessionId, effectiveWorkspaceDir);
  } else {
    // ── SUCCESS BRANCH ──
    const resetState = resetFriction(sessionId, effectiveWorkspaceDir);
    
    // 👈 Record success to reset failure streak and earn minor trust (if constructive)
    trust.recordSuccess('tool_success', { 
        sessionId, 
        api,
        toolName: event.toolName // 👈 NEW: Pass toolName for classification
    });

    const injectedProbationIds = getInjectedProbationIds(sessionId, effectiveWorkspaceDir);
    for (const id of injectedProbationIds) {
      const principle = wctx.evolutionReducer.getPrincipleById(id);
      const shouldAttribute = !!principle && shouldAttributePrincipleToTool(principle, event.toolName);
      if (shouldAttribute) {
        wctx.evolutionReducer.recordProbationFeedback(id, true);
      }
    }
    clearInjectedProbationIds(sessionId, effectiveWorkspaceDir);
    wctx.trajectory?.recordToolCall?.({
      sessionId,
      toolName: event.toolName,
      outcome: 'success',
      durationMs: event.durationMs,
      exitCode,
      gfiBefore,
      gfiAfter: resetState.currentGfi,
      paramsJson: event.params,
    });
    
    if (WRITE_TOOLS.includes(event.toolName)) {
      const filePath = params.file_path || params.path || params.file;
      eventLog.recordToolCall(sessionId, {
        toolName: event.toolName,
        filePath: typeof filePath === 'string' ? filePath : undefined,
        gfi: 0,
      });

      // ── Hygiene Tracking: Record persistence actions ──
      if (typeof filePath === 'string') {
        const normalized = filePath.replace(/\\/g, '/');
        const isMemory = /(?:^|\/)memory\//.test(normalized) || normalized.endsWith('/MEMORY.md') || normalized === 'MEMORY.md';
        const isPlan = normalized === 'PLAN.md' || normalized.endsWith('/PLAN.md');
        
        if (isMemory || isPlan) {
          const content = params.content || params.new_string || '';
          wctx.hygiene.recordPersistence({
            ts: new Date().toISOString(),
            tool: event.toolName,
            path: filePath,
            type: isMemory ? 'memory' : 'plan',
            contentLength: content.length,
          });
        }
      }
    }

    // Special case for memory_store tool (Success only)
    if (event.toolName === 'memory_store') {
       const text = params.text || '';
       wctx.hygiene.recordPersistence({
         ts: new Date().toISOString(),
         tool: event.toolName,
         path: 'DATABASE',
         type: 'memory',
         contentLength: text.length,
       });
    }
  }

  // ── Legacy/Risky Write Pain Logic (Unified WRITE_TOOLS) ──
  if (!WRITE_TOOLS.includes(event.toolName) || !isFailure) {
    return;
  }

  const filePath = params.file_path || params.path || params.file;
  const relPath = typeof filePath === 'string' ? normalizePath(filePath, effectiveWorkspaceDir) : 'unknown';

  const profilePath = wctx.resolve('PROFILE');
  let profile = normalizeProfile({});
  if (fs.existsSync(profilePath)) {
    try {
      profile = normalizeProfile(JSON.parse(fs.readFileSync(profilePath, 'utf8')));
    } catch (e) {
      SystemLogger.log(effectiveWorkspaceDir, 'PROFILE_PARSE_WARN', `Failed to parse PROFILE.json: ${String(e)}`);
    }
  }

  const isRisk = isRisky(relPath, profile.risk_paths);
  const painScore = computePainScore(1, false, false, isRisk ? 20 : 0, effectiveWorkspaceDir);

  const painData = {
    score: String(painScore),
    source: 'tool_failure',
    time: new Date().toISOString(),
    reason: `Tool ${event.toolName} failed on ${relPath}. Error: ${event.error ?? 'Non-zero exit code'}`,
    is_risky: String(isRisk),
  };

  writePainFlag(effectiveWorkspaceDir, painData);
  
  eventLog.recordPainSignal(sessionId, {
    score: painScore,
    source: 'tool_failure',
    reason: `Tool ${event.toolName} failed on ${relPath}`,
    isRisky: isRisk,
  });
  wctx.trajectory?.recordPainEvent?.({
    sessionId,
    source: 'tool_failure',
    score: painScore,
    reason: `Tool ${event.toolName} failed on ${relPath}`,
    severity: painScore >= 70 ? 'severe' : painScore >= 40 ? 'moderate' : 'mild',
    origin: 'system_infer',
  });

  emitPainDetectedEvent(wctx, {
    ts: new Date().toISOString(),
    type: 'pain_detected',
    data: {
      painId: createPainId(sessionId),
      painType: 'tool_failure',
      source: event.toolName,
      reason: `Tool ${event.toolName} failed on ${relPath}`,
      score: painScore,
      sessionId,
    },
  });
}

function extractErrorType(error: unknown): string {
  if (!error) return 'Unknown';
  const msg = String(error);
  if (msg.includes('EACCES') || msg.includes('permission denied')) return 'EACCES';
  if (msg.includes('ENOENT') || msg.includes('no such file')) return 'ENOENT';
  if (msg.includes('EISDIR')) return 'EISDIR';
  if (msg.includes('ENOSPC')) return 'ENOSPC';
  if (msg.includes('SyntaxError')) return 'SyntaxError';
  if (msg.includes('TypeError')) return 'TypeError';
  if (msg.includes('ReferenceError')) return 'ReferenceError';
  if (msg.includes('timeout') || msg.includes('ETIMEDOUT')) return 'Timeout';
  if (msg.includes('network') || msg.includes('ECONNREFUSED')) return 'Network';
  return 'Other';
}
