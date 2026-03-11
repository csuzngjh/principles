import * as fs from 'fs';
import * as path from 'path';
import { isRisky, normalizePath } from '../utils/io.js';
import { normalizeProfile } from '../core/profile.js';
import { computePainScore, writePainFlag } from '../core/pain.js';
import { trackFriction, resetFriction, getSession } from '../core/session-tracker.js';
import { denoiseError, computeHash } from '../utils/hashing.js';
import { SystemLogger } from '../core/system-logger.js';
import { WorkspaceContext } from '../core/workspace-context.js';
import type { PluginHookAfterToolCallEvent, PluginHookToolContext, OpenClawPluginApi } from '../openclaw-sdk.js';

export function handleAfterToolCall(
  event: PluginHookAfterToolCallEvent,
  ctx: PluginHookToolContext & { workspaceDir?: string; pluginConfig?: Record<string, unknown> },
  api?: OpenClawPluginApi // 👈 核心修复：接受 api 参数
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

  // ── Track A: Empirical Friction (GFI) ──
  
  // 0. Special Case: Manual Pain Intervention (from Skill)
  if (event.toolName === 'pain' || event.toolName === 'skill:pain') {
    const reason = (event.params as any).input || (event.params as any).arguments || 'Manual intervention';
    trackFriction(sessionId, 100, 'manual_pain', effectiveWorkspaceDir);
    SystemLogger.log(effectiveWorkspaceDir, 'MANUAL_PAIN', `User manually triggered pain: ${reason}`);
    eventLog.recordPainSignal(sessionId, {
      score: 100,
      source: 'manual',
      reason: `User intervention: ${reason}`,
      isRisky: true
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
    const filePath = (event.params as any).file_path || (event.params as any).path || (event.params as any).file;
    const relPath = typeof filePath === 'string' ? normalizePath(filePath, effectiveWorkspaceDir) : 'unknown';
    
    // Load profile for risk_paths check
    const profilePath = wctx.resolve('PROFILE');
    let profile = normalizeProfile({});
    if (fs.existsSync(profilePath)) {
      try {
        profile = normalizeProfile(JSON.parse(fs.readFileSync(profilePath, 'utf8')));
      } catch (_e) {}
    }
    
    const isRisk = isRisky(relPath, profile.risk_paths);
    
    trust.recordFailure(isRisk ? 'risky' : 'tool', {
        sessionId,
        api
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
  } else {
    resetFriction(sessionId, effectiveWorkspaceDir);
    
    const WRITE_TOOLS = ['write', 'edit', 'apply_patch'];
    if (WRITE_TOOLS.includes(event.toolName)) {
      const filePath = (event.params as any).file_path || (event.params as any).path || (event.params as any).file;
      eventLog.recordToolCall(sessionId, {
        toolName: event.toolName,
        filePath: typeof filePath === 'string' ? filePath : undefined,
        gfi: 0,
      });
    }
  }

  // ── Legacy/Risky Write Pain Logic ──
  const WRITE_TOOLS = ['write', 'edit', 'apply_patch'];
  if (!WRITE_TOOLS.includes(event.toolName)) {
    return;
  }

  if (!isFailure) return;

  const filePath = (event.params as any).file_path || (event.params as any).path || (event.params as any).file;
  const relPath = typeof filePath === 'string' ? normalizePath(filePath, effectiveWorkspaceDir) : 'unknown';

  const profilePath = wctx.resolve('PROFILE');
  let profile = normalizeProfile({});
  if (fs.existsSync(profilePath)) {
    try {
      profile = normalizeProfile(JSON.parse(fs.readFileSync(profilePath, 'utf8')));
    } catch (_e) {}
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
