import * as fs from 'fs';
import * as path from 'path';
import { isRisky, normalizePath } from '../utils/io.js';
import { normalizeProfile } from '../core/profile.js';
import { computePainScore, writePainFlag } from '../core/pain.js';
import { trackFriction, resetFriction, getSession } from '../core/session-tracker.js';
import { adjustTrustScore, TRUST_CONFIG } from '../core/trust-engine.js';
import { denoiseError, computeHash } from '../utils/hashing.js';
import { ConfigService } from '../core/config-service.js';
import { EventLogService } from '../core/event-log.js';
import { SystemLogger } from '../core/system-logger.js';
import type { PluginHookAfterToolCallEvent, PluginHookToolContext } from '../openclaw-sdk.js';

export function handleAfterToolCall(
  event: PluginHookAfterToolCallEvent,
  ctx: PluginHookToolContext & { workspaceDir?: string; pluginConfig?: Record<string, unknown> }
): void {
  if (!ctx.workspaceDir) {
    return;
  }

  const stateDir = (ctx as any).stateDir || path.join(ctx.workspaceDir, 'memory', '.state');
  const config = ConfigService.get(stateDir);
  const eventLog = EventLogService.get(stateDir);
  const sessionId = ctx.sessionId || 'unknown';

  // ── Track A: Empirical Friction (GFI) ──
  
  // 0. Special Case: Manual Pain Intervention (from Skill)
  if (event.toolName === 'pain' || event.toolName === 'skill:pain') {
    const reason = event.params.input || event.params.arguments || 'Manual intervention';
    trackFriction(sessionId, 100, 'manual_pain', ctx.workspaceDir);
    SystemLogger.log(ctx.workspaceDir, 'MANUAL_PAIN', `User manually triggered pain: ${reason}`);
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

  // Get current GFI before tracking
  let previousGfi = 0;
  const session = getSession(sessionId);
  if (session) {
    previousGfi = session.currentGfi;
  }

  if (isFailure) {
    const errorText = event.error || (typeof event.result === 'string' ? event.result : JSON.stringify(event.result));
    const denoised = denoiseError(errorText);
    const hash = computeHash(denoised);
    
    // Default deltaF for tool errors from config
    const deltaF = config.get('scores.tool_failure_friction') || 30;
    const updatedState = trackFriction(sessionId, deltaF, hash, ctx.workspaceDir);
    
    // ── Trust Engine: Decrement score on failure (Refined) ──
    const errorType = extractErrorType(event.error || errorText);
    const filePath = event.params.file_path || event.params.path || event.params.file;
    const relPath = typeof filePath === 'string' ? normalizePath(filePath, ctx.workspaceDir) : 'unknown';
    
    // Load profile for risk_paths check
    const profilePath = path.join(ctx.workspaceDir, 'docs', 'PROFILE.json');
    let profile = normalizeProfile({});
    if (fs.existsSync(profilePath)) {
      try {
        profile = normalizeProfile(JSON.parse(fs.readFileSync(profilePath, 'utf8')));
      } catch (_e) {}
    }
    
    const isRisk = isRisky(relPath, profile.risk_paths);
    const penalty = isRisk ? TRUST_CONFIG.PENALTIES.RISKY_FAILURE : TRUST_CONFIG.PENALTIES.TOOL_FAILURE;
    
    adjustTrustScore(ctx.workspaceDir, penalty, `pain:${errorType}`, {
        sessionId,
        stateDir,
        api: (ctx as any).api
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
    // Success! Reset friction
    resetFriction(sessionId, ctx.workspaceDir);
    
    // Record tool call success event (only for write tools to avoid noise)
    const WRITE_TOOLS = ['write', 'edit', 'apply_patch'];
    if (WRITE_TOOLS.includes(event.toolName)) {
      const filePath = event.params.file_path || event.params.path || event.params.file;
      eventLog.recordToolCall(sessionId, {
        toolName: event.toolName,
        filePath: typeof filePath === 'string' ? filePath : undefined,
        gfi: 0,
      });
    }
  }

  // ── Legacy/Risky Write Pain Logic ──
  // OpenClaw core tool names for file mutations (from tool-catalog.ts)
  const WRITE_TOOLS = ['write', 'edit', 'apply_patch'];
  if (!WRITE_TOOLS.includes(event.toolName)) {
    return;
  }

  // Only record explicit pain flag on failure for write tools
  if (!isFailure) return;

  const filePath = event.params.file_path || event.params.path || event.params.file;
  const relPath = typeof filePath === 'string' ? normalizePath(filePath, ctx.workspaceDir) : 'unknown';

  const profilePath = path.join(ctx.workspaceDir, 'docs', 'PROFILE.json');
  let profile = normalizeProfile({});
  if (fs.existsSync(profilePath)) {
    try {
      profile = normalizeProfile(JSON.parse(fs.readFileSync(profilePath, 'utf8')));
    } catch (_e) {
      // Use defaults
    }
  }

  const isRisk = isRisky(relPath, profile.risk_paths);
  const painScore = computePainScore(1, false, false, isRisk ? 20 : 0);

  const painData = {
    score: String(painScore),
    source: 'tool_failure',
    time: new Date().toISOString(),
    reason: `Tool ${event.toolName} failed on ${relPath}. Error: ${event.error ?? 'Non-zero exit code'}`,
    is_risky: String(isRisk),
  };

  writePainFlag(ctx.workspaceDir, painData);
  
  // Record pain signal event
  eventLog.recordPainSignal(sessionId, {
    score: painScore,
    source: 'tool_failure',
    reason: `Tool ${event.toolName} failed on ${relPath}`,
    isRisky: isRisk,
  });
}

/**
 * Extract error type from error message for categorization.
 */
function extractErrorType(error: unknown): string {
  if (!error) return 'Unknown';
  const msg = String(error);
  
  // Common error patterns
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
