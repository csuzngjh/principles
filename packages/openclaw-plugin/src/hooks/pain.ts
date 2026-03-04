import * as fs from 'fs';
import * as path from 'path';
import { isRisky, normalizePath } from '../utils/io.js';
import { normalizeProfile } from '../core/profile.js';
import { computePainScore, writePainFlag } from '../core/pain.js';
import type { PluginHookAfterToolCallEvent, PluginHookToolContext } from '../openclaw-sdk.js';

export function handleAfterToolCall(
  event: PluginHookAfterToolCallEvent,
  ctx: PluginHookToolContext & { workspaceDir?: string; pluginConfig?: Record<string, unknown> }
): void {
  // OpenClaw core tool names for file mutations (from tool-catalog.ts)
  const WRITE_TOOLS = ['write', 'edit', 'apply_patch'];
  if (!ctx.workspaceDir || !WRITE_TOOLS.includes(event.toolName)) {
    return;
  }

  // Only record pain on failure
  if (!event.error && !(event.result && typeof event.result === 'object' && (event.result as Record<string, unknown>).exitCode !== 0)) {
    return;
  }

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
