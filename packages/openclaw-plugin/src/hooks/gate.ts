import * as fs from 'fs';
import * as path from 'path';
import { isRisky, normalizePath } from '../utils/io.js';
import { normalizeProfile } from '../core/profile.js';
import type { PluginHookBeforeToolCallEvent, PluginHookToolContext, PluginHookBeforeToolCallResult } from '../openclaw-sdk.js';

export function handleBeforeToolCall(
  event: PluginHookBeforeToolCallEvent,
  ctx: PluginHookToolContext & { workspaceDir?: string; pluginConfig?: Record<string, unknown> }
): PluginHookBeforeToolCallResult | void {
  // OpenClaw tool names for file writes
  if (!ctx.workspaceDir || !['fs_write', 'fs_replace', 'fs_delete'].includes(event.toolName)) {
    return;
  }

  const filePath = event.params.file_path || event.params.path;
  if (typeof filePath !== 'string') {
    return;
  }

  const profilePath = path.join(ctx.workspaceDir, 'docs', 'PROFILE.json');
  let profile = { risk_paths: [] as string[], gate: { require_plan_for_risk_paths: true } };

  if (fs.existsSync(profilePath)) {
    try {
      const rawProfile = JSON.parse(fs.readFileSync(profilePath, 'utf8'));
      profile = normalizeProfile(rawProfile);
    } catch (_e) {
      // Use defaults if parse fails
    }
  }

  // Merge config-level riskPaths if set
  const configRiskPaths = (ctx.pluginConfig?.riskPaths as string[] | undefined) ?? [];
  if (configRiskPaths.length > 0) {
    profile.risk_paths = [...new Set([...profile.risk_paths, ...configRiskPaths])];
  }

  const relPath = normalizePath(filePath, ctx.workspaceDir);
  const risky = isRisky(relPath, profile.risk_paths);

  if (risky && profile.gate.require_plan_for_risk_paths) {
    const planPath = path.join(ctx.workspaceDir, 'docs', 'PLAN.md');
    let planReady = false;

    if (fs.existsSync(planPath)) {
      try {
        const planContent = fs.readFileSync(planPath, 'utf8');
        for (const line of planContent.split('\n')) {
          if (line.startsWith('STATUS:')) {
            const status = line.split(':')[1].trim().split(/\s+/)[0];
            if (status === 'READY') planReady = true;
            break;
          }
        }
      } catch (_e) {
        // Ignore read errors
      }
    }

    if (!planReady) {
      return {
        block: true,
        blockReason:
          `[PRINCIPLES_GATE] Write blocked for risk path '${relPath}'.\n` +
          `REASON: No READY plan found in docs/PLAN.md.\n` +
          `ACTION: You MUST update docs/PLAN.md to STATUS: READY and describe the intended changes before you can modify this file.`,
      };
    }
  }
}
