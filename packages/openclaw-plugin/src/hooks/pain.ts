import * as fs from 'fs';
import * as path from 'path';
import { isRisky, normalizePath } from '../utils/io.js';
import { normalizeProfile } from '../core/profile.js';
import { computePainScore, writePainFlag } from '../core/pain.js';
import { trackFriction, resetFriction } from '../core/session-tracker.js';
import { denoiseError, computeHash } from '../utils/hashing.js';
import { ConfigService } from '../core/config-service.js';
import type { PluginHookAfterToolCallEvent, PluginHookToolContext } from '../openclaw-sdk.js';

export function handleAfterToolCall(
  event: PluginHookAfterToolCallEvent,
  ctx: PluginHookToolContext & { workspaceDir?: string; pluginConfig?: Record<string, unknown> }
): void {
  if (!ctx.workspaceDir || !ctx.sessionId) {
    return;
  }

  const stateDir = ctx.stateDir || path.join(ctx.workspaceDir, 'memory', '.state');
  const config = ConfigService.get(stateDir);

  // ── Track A: Empirical Friction (GFI) ──
  
  // 1. Determine if this was a failure
  const exitCode = (event.result && typeof event.result === 'object') ? (event.result as any).exitCode : 0;
  const isFailure = !!event.error || (exitCode !== 0 && exitCode !== undefined);

  if (isFailure) {
    const errorText = event.error || (typeof event.result === 'string' ? event.result : JSON.stringify(event.result));
    const denoised = denoiseError(errorText);
    const hash = computeHash(denoised);
    
    // Default deltaF for tool errors from config
    const deltaF = config.get('scores.tool_failure_friction') || 30;
    trackFriction(ctx.sessionId, deltaF, hash);
  } else {
    // Success! Reset friction
    resetFriction(ctx.sessionId);
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
    time: new Date().toISOString(),
    reason: `Tool ${event.toolName} failed on ${relPath}. Error: ${event.error ?? 'Non-zero exit code'}`,
    is_risky: String(isRisk),
  };

  writePainFlag(ctx.workspaceDir, painData);
}
