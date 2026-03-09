import * as fs from 'fs';
import * as path from 'path';
import { isRisky, normalizePath } from '../utils/io.js';
import { normalizeProfile } from '../core/profile.js';
import { EventLogService } from '../core/event-log.js';
import { trackBlock } from '../core/session-tracker.js';
import type { PluginHookBeforeToolCallEvent, PluginHookToolContext, PluginHookBeforeToolCallResult } from '../openclaw-sdk.js';

export function handleBeforeToolCall(
  event: PluginHookBeforeToolCallEvent,
  ctx: PluginHookToolContext & { workspaceDir?: string; pluginConfig?: Record<string, unknown>; logger?: any }
): PluginHookBeforeToolCallResult | void {
  const logger = ctx.logger || console;

  // 1. Identify tool type
  const WRITE_TOOLS = ['write', 'edit', 'apply_patch', 'write_file', 'replace', 'insert', 'patch', 'edit_file', 'delete_file', 'move_file'];
  const BASH_TOOLS = ['bash', 'run_shell_command', 'exec', 'execute', 'shell', 'cmd'];
  
  const isBash = BASH_TOOLS.includes(event.toolName);
  const isWriteTool = WRITE_TOOLS.includes(event.toolName);
  
  if (!ctx.workspaceDir || (!isWriteTool && !isBash)) {
    return;
  }

  // Debug logging only for relevant tools
  logger.info(`[PD_GATE_DEBUG] Received potential mutation tool: ${event.toolName}`);

  // 2. Load and Normalize Profile (Moved up to use risk_paths dynamically)
  const profilePath = path.join(ctx.workspaceDir, 'docs', 'PROFILE.json');
  let profile = { risk_paths: [] as string[], gate: { require_plan_for_risk_paths: true } };

  if (fs.existsSync(profilePath)) {
    try {
      const rawProfile = JSON.parse(fs.readFileSync(profilePath, 'utf8'));
      profile = normalizeProfile(rawProfile);
    } catch (e) {
      logger?.error?.(`[PD_GATE] Failed to parse PROFILE.json: ${String(e)}`);
    }
  }

  // Merge pluginConfig (OpenClaw UI settings)
  const configRiskPaths = (ctx.pluginConfig?.riskPaths as string[] | undefined) ?? [];
  if (configRiskPaths.length > 0) {
    profile.risk_paths = [...new Set([...profile.risk_paths, ...configRiskPaths])];
  }

  // 3. Resolve the target file path
  let filePath = event.params.file_path || event.params.path || event.params.file || event.params.target;
  
  // Special handling for bash: heuristic check for file mutations
  if (isBash && !filePath) {
    const command = String(event.params.command || event.params.args || "");
    
    // Improved Regex: Find potential file writes/deletes/creates in shell commands
    // We look for patterns like: > file, >> file, rm file, mkdir path, touch file, etc.
    // We try to skip common flags like -p, -rf, -v
    const mutationMatch = command.match(/(?:>|>>|sed\s+-i|rm|mv|mkdir|touch|cp)\s+(?:-[a-zA-Z]+\s+)*([^\s;&|<>]+)/);
    
    if (mutationMatch) {
      filePath = mutationMatch[1];
      logger?.info?.(`[PD_GATE] Bash mutation detected. Extracted path: ${filePath}`);
    } else {
      // Check if command contains any risk path and looks like a write operation
      const hasRiskPath = profile.risk_paths.some(rp => command.includes(rp));
      const isMutation = /(?:>|>>|sed|rm|mv|mkdir|touch|cp|npm|yarn|pnpm|pip|cargo)/.test(command);
      
      if (hasRiskPath && isMutation) {
        filePath = command; // Fallback to full command for risk auditing
        logger?.info?.(`[PD_GATE] Dynamic fallback risk detection for command: ${command}`);
      } else {
        // Not a clear mutation command or doesn't target risk paths, skip
        return;
      }
    }
  }

  if (typeof filePath !== 'string') {
    return;
  }

  // 4. Check Risk
  const relPath = normalizePath(filePath, ctx.workspaceDir);
  
  // If filePath is a full command (fallback case), we check if any risk path is contained in it
  let risky = false;
  if (isBash && filePath.includes(' ')) {
    risky = profile.risk_paths.some(rp => filePath.includes(rp));
  } else {
    risky = isRisky(relPath, profile.risk_paths);
  }

  if (risky) {
    logger?.info?.(`[PD_GATE] Auditing modification to risk path: ${relPath}`);
    
    if (profile.gate.require_plan_for_risk_paths) {
      const planPath = path.join(ctx.workspaceDir, 'docs', 'PLAN.md');
      let planReady = false;
      let planStatus = 'UNKNOWN';

      if (fs.existsSync(planPath)) {
        try {
          const planContent = fs.readFileSync(planPath, 'utf8');
          for (const line of planContent.split('\n')) {
            if (line.trim().startsWith('STATUS:')) {
              planStatus = line.split(':')[1].trim().split(/\s+/)[0];
              if (planStatus === 'READY') {
                planReady = true;
                break;
              }
            }
          }
        } catch (e) {
          logger?.error?.(`[PD_GATE] Failed to read PLAN.md: ${String(e)}`);
        }
      }

      if (!planReady) {
        logger?.warn?.(`[PD_GATE] BLOCKED: No READY plan for ${relPath}`);
        
        // Track block in session state
        if (ctx.sessionId) {
          trackBlock(ctx.sessionId);
        }
        
        // Record gate block event
        const stateDir = (ctx as any).stateDir || path.join(ctx.workspaceDir, 'memory', '.state');
        const eventLog = EventLogService.get(stateDir);
        eventLog.recordGateBlock(ctx.sessionId, {
          toolName: event.toolName,
          filePath: relPath,
          reason: 'No READY plan found',
          planStatus,
        });
        
        return {
          block: true,
          blockReason:
            `[PRINCIPLES_GATE] Modification blocked for risk path '${relPath}'.\n` +
            `REASON: No READY plan found in docs/PLAN.md.\n` +
            `ACTION: You MUST update docs/PLAN.md to STATUS: READY and describe the intended changes before you can modify this file.`,
        };
      } else {
        logger?.info?.(`[PD_GATE] ALLOWED: Plan is READY for ${relPath}`);
      }
    }
  }
}
