import * as fs from 'fs';
import * as path from 'path';
import { isRisky, normalizePath } from '../utils/io';
import { normalizeProfile } from '../core/profile';

export function handleBeforeToolCall(
  event: { toolName: string; params: Record<string, unknown> },
  ctx: { workspaceDir?: string }
): { block?: boolean; blockReason?: string } | void {
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
    } catch (e) {
      // Use defaults if parse fails
    }
  }

  const relPath = normalizePath(filePath, ctx.workspaceDir);
  const risky = isRisky(relPath, profile.risk_paths);

  if (risky && profile.gate.require_plan_for_risk_paths) {
    const planPath = path.join(ctx.workspaceDir, 'docs', 'PLAN.md');
    let planReady = false;

    if (fs.existsSync(planPath)) {
      try {
        const planContent = fs.readFileSync(planPath, 'utf8');
        const lines = planContent.split('\n');
        for (const line of lines) {
          if (line.startsWith('STATUS:')) {
            const status = line.split(':')[1].trim().split(/\s+/)[0];
            if (status === 'READY') {
              planReady = true;
            }
            break;
          }
        }
      } catch (e) {
        // Ignore read errors
      }
    }

    if (!planReady) {
      return {
        block: true,
        blockReason: `[PRINCIPLES_GATE] Write blocked for risk path '${relPath}'. \nREASON: No READY plan found in docs/PLAN.md. \nACTION: You MUST update docs/PLAN.md to STATUS: READY and describe the intended changes before you can modify this file.`,
      };
    }
  }
}
