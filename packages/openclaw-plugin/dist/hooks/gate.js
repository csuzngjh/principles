import * as fs from 'fs';
import * as path from 'path';
import { isRisky, normalizePath } from '../utils/io.js';
import { normalizeProfile } from '../core/profile.js';
export function handleBeforeToolCall(event, ctx) {
    const logger = ctx.logger;
    // 1. Identify if this is a file-mutation tool
    // Includes core file tools and common bash-based mutation patterns
    const WRITE_TOOLS = ['write', 'edit', 'apply_patch', 'write_file', 'replace', 'insert', 'patch', 'edit_file', 'delete_file', 'move_file'];
    const isBash = event.toolName === 'bash' || event.toolName === 'run_shell_command';
    const isWriteTool = WRITE_TOOLS.includes(event.toolName);
    if (!ctx.workspaceDir || (!isWriteTool && !isBash)) {
        return;
    }
    // 2. Resolve the target file path
    let filePath = event.params.file_path || event.params.path || event.params.file || event.params.target;
    // Special handling for bash: heuristic check for file mutations
    if (isBash && !filePath) {
        const command = String(event.params.command || event.params.args || "");
        // Regex to find potential file writes/deletes in shell commands
        // Matches: > file, >> file, sed -i, rm file
        const mutationMatch = command.match(/(?:>|>>|sed\s+-i|rm|mv)\s+([^\s;&|<>]+)/);
        if (mutationMatch) {
            filePath = mutationMatch[1];
            logger?.info?.(`[PD_GATE] Bash mutation detected. Extracted path: ${filePath}`);
        }
        else {
            // Not a clear mutation command, skip
            return;
        }
    }
    if (typeof filePath !== 'string') {
        return;
    }
    // 3. Load and Normalize Profile (ensuring camelCase compatibility)
    const profilePath = path.join(ctx.workspaceDir, 'docs', 'PROFILE.json');
    let profile = { risk_paths: [], gate: { require_plan_for_risk_paths: true } };
    if (fs.existsSync(profilePath)) {
        try {
            const rawProfile = JSON.parse(fs.readFileSync(profilePath, 'utf8'));
            profile = normalizeProfile(rawProfile);
        }
        catch (e) {
            logger?.error?.(`[PD_GATE] Failed to parse PROFILE.json: ${String(e)}`);
        }
    }
    // Merge pluginConfig (OpenClaw UI settings)
    const configRiskPaths = ctx.pluginConfig?.riskPaths ?? [];
    if (configRiskPaths.length > 0) {
        profile.risk_paths = [...new Set([...profile.risk_paths, ...configRiskPaths])];
    }
    // 4. Check Risk
    const relPath = normalizePath(filePath, ctx.workspaceDir);
    const risky = isRisky(relPath, profile.risk_paths);
    if (risky) {
        logger?.info?.(`[PD_GATE] Auditing write to risk path: ${relPath}`);
        if (profile.gate.require_plan_for_risk_paths) {
            const planPath = path.join(ctx.workspaceDir, 'docs', 'PLAN.md');
            let planReady = false;
            if (fs.existsSync(planPath)) {
                try {
                    const planContent = fs.readFileSync(planPath, 'utf8');
                    for (const line of planContent.split('\n')) {
                        if (line.trim().startsWith('STATUS:')) {
                            const status = line.split(':')[1].trim().split(/\s+/)[0];
                            if (status === 'READY') {
                                planReady = true;
                                break;
                            }
                        }
                    }
                }
                catch (e) {
                    logger?.error?.(`[PD_GATE] Failed to read PLAN.md: ${String(e)}`);
                }
            }
            if (!planReady) {
                logger?.warn?.(`[PD_GATE] BLOCKED: No READY plan for ${relPath}`);
                return {
                    block: true,
                    blockReason: `[PRINCIPLES_GATE] Write blocked for risk path '${relPath}'.\n` +
                        `REASON: No READY plan found in docs/PLAN.md.\n` +
                        `ACTION: You MUST update docs/PLAN.md to STATUS: READY and describe the intended changes before you can modify this file.`,
                };
            }
            else {
                logger?.info?.(`[PD_GATE] ALLOWED: Plan is READY for ${relPath}`);
            }
        }
    }
}
