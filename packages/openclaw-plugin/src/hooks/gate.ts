import * as fs from 'fs';
import * as path from 'path';
import { isRisky, normalizePath, planStatus as getPlanStatus } from '../utils/io.js';
import { matchesAnyPattern } from '../utils/glob-match.js';
import { normalizeProfile } from '../core/profile.js';
import { trackBlock, hasRecentThinking, getSession } from '../core/session-tracker.js';
import { assessRiskLevel, estimateLineChanges } from '../core/risk-calculator.js';
import { WorkspaceContext } from '../core/workspace-context.js';
import { checkEvolutionGate } from '../core/evolution-engine.js';
import type { PluginHookBeforeToolCallEvent, PluginHookToolContext, PluginHookBeforeToolCallResult } from '../openclaw-sdk.js';

// ═══ GFI Gate Tool Tiers ═══
// TIER 0: 只读工具 - 永不拦截
const READ_ONLY_TOOLS = new Set([
  'read', 'read_file', 'read_many_files', 'image_read',
  'search_file_content', 'grep', 'grep_search', 'list_directory', 'ls', 'glob',
  'lsp_hover', 'lsp_goto_definition', 'lsp_find_references',
  'web_fetch', 'web_search', 'ref_search_documentation', 'ref_read_url',
  'resolve-library-id', 'get-library-docs',
  'todo_read', 'save_memory',
  'deep_reflect',
]);

// TIER 1: 低风险修改 - GFI >= low_risk_block 时拦截
// 注意：pd_spawn_agent、sessions_spawn、task 是 Agent 派生工具，不应被 GFI Gate 拦截
// 它们属于 AGENT_TOOLS，在早期过滤后直接放行
const LOW_RISK_WRITE_TOOLS = new Set([
  'write', 'write_file',
  'edit', 'edit_file', 'replace', 'apply_patch', 'insert', 'patch',
]);

// TIER 2: 高风险操作 - GFI >= high_risk_block 时拦截
const HIGH_RISK_TOOLS = new Set([
  'delete_file', 'move_file',
]);

// TIER 3: Bash 命令 - 根据内容判断
const BASH_TOOLS_SET = new Set([
  'bash', 'run_shell_command', 'exec', 'execute', 'shell', 'cmd',
]);

/**
 * 分析 Bash 命令风险等级
 */
function analyzeBashCommand(
  command: string,
  safePatterns: string[],
  dangerousPatterns: string[]
): 'safe' | 'dangerous' | 'normal' {
  const normalizedCmd = command.trim().toLowerCase();
  
  // 1. 优先检查危险命令
  for (const pattern of dangerousPatterns) {
    try {
      if (new RegExp(pattern, 'i').test(normalizedCmd)) {
        return 'dangerous';
      }
    } catch {
      // 忽略无效正则
    }
  }
  
  // 2. 检查安全命令
  for (const pattern of safePatterns) {
    try {
      if (new RegExp(pattern, 'i').test(normalizedCmd)) {
        return 'safe';
      }
    } catch {
      // 忽略无效正则
    }
  }
  
  // 3. 默认为普通命令
  return 'normal';
}

/**
 * 计算动态 GFI 阈值
 */
function calculateDynamicThreshold(
  baseThreshold: number,
  trustStage: number,
  lineChanges: number,
  config: {
    large_change_lines: number;
    trust_stage_multipliers: Record<string, number>;
  }
): number {
  // 1. Trust Stage 乘数
  const stageMultiplier = config.trust_stage_multipliers[trustStage.toString()] || 1.0;
  let threshold = baseThreshold * stageMultiplier;
  
  // 2. 大规模修改降低阈值
  if (lineChanges > config.large_change_lines) {
    const ratio = Math.min(lineChanges / 200, 0.5); // 最多降低 50%
    threshold = threshold * (1 - ratio);
  }
  
  return Math.round(Math.max(threshold, 0));
}

export function handleBeforeToolCall(
  event: PluginHookBeforeToolCallEvent,
  ctx: PluginHookToolContext & { workspaceDir?: string; pluginConfig?: Record<string, unknown>; logger?: any }
): PluginHookBeforeToolCallResult | void {
  const logger = ctx.logger || console;

  // 1. Identify tool type
  const WRITE_TOOLS = ['write', 'edit', 'apply_patch', 'write_file', 'replace', 'insert', 'patch', 'edit_file', 'delete_file', 'move_file'];
  const BASH_TOOLS = ['bash', 'run_shell_command', 'exec', 'execute', 'shell', 'cmd'];
  const AGENT_TOOLS = ['pd_spawn_agent', 'sessions_spawn'];
  
  const isBash = BASH_TOOLS.includes(event.toolName);
  const isWriteTool = WRITE_TOOLS.includes(event.toolName);
  const isAgentTool = AGENT_TOOLS.includes(event.toolName);
  // Profile loaded first for config-driven behavior (see below)
  
  if (!ctx.workspaceDir || (!isWriteTool && !isBash && !isAgentTool)) {
    return;
  }

  const wctx = WorkspaceContext.fromHookContext(ctx);

  // 2. Load Profile
  const profilePath = wctx.resolve('PROFILE');
  let profile = {
    risk_paths: [] as string[],
    gate: { require_plan_for_risk_paths: true },
    progressive_gate: {
      enabled: true,
      plan_approvals: {
        enabled: false,
        max_lines_override: -1,
        allowed_patterns: [] as string[],
        allowed_operations: [] as string[],
      }
    },
    edit_verification: {
      enabled: true,
      max_file_size_bytes: 10 * 1024 * 1024,
      fuzzy_match_enabled: true,
      fuzzy_match_threshold: 0.8,
      skip_large_file_action: 'warn' as 'warn' | 'block',
    },
    thinking_checkpoint: {
      enabled: false,  // Default OFF
      window_ms: 5 * 60 * 1000,
      high_risk_tools: ['run_shell_command', 'delete_file', 'move_file', 'pd_spawn_agent'],
    }
  };

  if (fs.existsSync(profilePath)) {
    try {
      const rawProfile = JSON.parse(fs.readFileSync(profilePath, 'utf8'));
      profile = normalizeProfile(rawProfile);
    } catch (e) {
      logger?.error?.(`[PD_GATE] Failed to parse PROFILE.json: ${String(e)}`);
    }
  }

  // ═══ THINKING OS CHECKPOINT (P-10) — Config-gated ═══
  // Only enforced when thinking_checkpoint.enabled = true in PROFILE.json
  const isHighRisk = profile.thinking_checkpoint?.high_risk_tools?.includes(event.toolName) ?? false;
  if (profile.thinking_checkpoint?.enabled && isHighRisk && ctx.sessionId) {
    const windowMs = profile.thinking_checkpoint.window_ms ?? 5 * 60 * 1000;
    const hasThinking = hasRecentThinking(ctx.sessionId, windowMs);
    if (!hasThinking) {
      logger?.info?.(`[PD:THINKING_GATE] High-risk tool "${event.toolName}" called without recent deep thinking`);
      return {
        block: true,
        blockReason: `[Thinking OS Checkpoint] 高风险操作 "${event.toolName}" 需要先进行深度思考。\n\n请先使用 deep_reflect 工具分析当前情况，然后再尝试此操作。\n\n这是强制性检查点，目的是确保决策质量。\n\n提示：调用 deep_reflect 后，${Math.round(windowMs/60000)}分钟内的操作将自动放行。\n\n可在PROFILE.json中设置 thinking_checkpoint.enabled: false 来禁用此检查。`,
      };
    }
  }

  // ═══ GFI GATE - Hard Intercept ═══
  // 根据 GFI (疲劳指数) 精细化拦截工具调用
  // 注意：TIER 0 (只读工具) 已在早期过滤中放行，此处不检查
  const gfiGateConfig = wctx.config.get('gfi_gate');
  if (gfiGateConfig?.enabled !== false && ctx.sessionId) {
    const session = getSession(ctx.sessionId);
    const currentGfi = session?.currentGfi || 0;
    
    // TIER 3: Bash 命令 - 根据内容判断
    if (BASH_TOOLS_SET.has(event.toolName)) {
      const command = String(event.params.command || event.params.args || '');
      const bashRisk = analyzeBashCommand(
        command,
        gfiGateConfig?.bash_safe_patterns || [],
        gfiGateConfig?.bash_dangerous_patterns || []
      );
      
      if (bashRisk === 'dangerous') {
        // 危险命令 - 直接拦截
        logger?.warn?.(`[PD:GFI_GATE] Dangerous bash command blocked: ${command.substring(0, 50)}...`);
        return {
          block: true,
          blockReason: `[GFI Gate] 危险命令被拦截。

命令: ${command.substring(0, 100)}${command.length > 100 ? '...' : ''}

原因: 检测到危险命令模式，需要确认执行意图。

解决方案:
1. 如果确实需要执行，请确认操作意图后重试
2. 使用更安全的方式（如手动操作）
3. 咨询用户确认是否继续

注意: 危险命令需要更严格的审批流程。`,
        };
      }
      // safe 命令 - 放行
      else if (bashRisk === 'safe') {
        // 继续执行
      }
      // normal 命令 - 按 GFI 阈值判断
      else {
        const trustEngine = wctx.trust;
        const stage = trustEngine.getStage();
        const baseThreshold = gfiGateConfig?.thresholds?.low_risk_block || 70;
        const dynamicThreshold = calculateDynamicThreshold(
          baseThreshold,
          stage,
          0, // bash 命令没有行数概念
          {
            large_change_lines: gfiGateConfig?.large_change_lines || 50,
            trust_stage_multipliers: gfiGateConfig?.trust_stage_multipliers || { '1': 0.5, '2': 0.75, '3': 1.0, '4': 1.5 },
          }
        );
        
        if (currentGfi >= dynamicThreshold) {
          logger?.warn?.(`[PD:GFI_GATE] Bash blocked by GFI: ${currentGfi} >= ${dynamicThreshold}`);
          return {
            block: true,
            blockReason: `[GFI Gate] 疲劳指数过高，操作被拦截。

命令: ${command.substring(0, 100)}${command.length > 100 ? '...' : ''}
GFI: ${currentGfi}/100
动态阈值: ${dynamicThreshold} (Stage ${stage})

原因: 当前疲劳指数超过阈值，系统进入保护模式。

解决方案:
1. 执行 /pd-status reset 清零疲劳值
2. 检查是否存在理解偏差或死循环
3. 等待问题自然解决后再尝试

注意: 这是系统级硬性拦截，AI 无法绕过。`,
          };
        }
      }
    }
    // TIER 2: 高风险操作 - GFI >= high_risk_block 时拦截
    else if (HIGH_RISK_TOOLS.has(event.toolName)) {
      const trustEngine = wctx.trust;
      const stage = trustEngine.getStage();
      const baseThreshold = gfiGateConfig?.thresholds?.high_risk_block || 40;
      const dynamicThreshold = calculateDynamicThreshold(
        baseThreshold,
        stage,
        0,
        {
          large_change_lines: gfiGateConfig?.large_change_lines || 50,
          trust_stage_multipliers: gfiGateConfig?.trust_stage_multipliers || { '1': 0.5, '2': 0.75, '3': 1.0, '4': 1.5 },
        }
      );
      
      if (currentGfi >= dynamicThreshold) {
        const filePath = event.params.file_path || event.params.path || event.params.file || event.params.target || 'unknown';
        logger?.warn?.(`[PD:GFI_GATE] High-risk tool "${event.toolName}" blocked by GFI: ${currentGfi} >= ${dynamicThreshold}`);
        return {
          block: true,
          blockReason: `[GFI Gate] 高风险操作被拦截。

工具: ${event.toolName}
文件: ${filePath}
GFI: ${currentGfi}/100
动态阈值: ${dynamicThreshold} (Stage ${stage})

原因: 高风险工具需要更低的 GFI 阈值才能执行。

解决方案:
1. 执行 /pd-status reset 清零疲劳值
2. 检查是否存在理解偏差或死循环
3. 等待 GFI 自然衰减后重试

注意: 这是系统级硬性拦截，AI 无法绕过。`,
        };
      }
    }
    // TIER 1: 低风险修改 - GFI >= low_risk_block 时拦截
    else if (LOW_RISK_WRITE_TOOLS.has(event.toolName)) {
      const trustEngine = wctx.trust;
      const stage = trustEngine.getStage();
      const lineChanges = estimateLineChanges({ toolName: event.toolName, params: event.params });
      const baseThreshold = gfiGateConfig?.thresholds?.low_risk_block || 70;
      const dynamicThreshold = calculateDynamicThreshold(
        baseThreshold,
        stage,
        lineChanges,
        {
          large_change_lines: gfiGateConfig?.large_change_lines || 50,
          trust_stage_multipliers: gfiGateConfig?.trust_stage_multipliers || { '1': 0.5, '2': 0.75, '3': 1.0, '4': 1.5 },
        }
      );
      
      if (currentGfi >= dynamicThreshold) {
        const filePath = event.params.file_path || event.params.path || event.params.file || event.params.target || 'unknown';
        logger?.warn?.(`[PD:GFI_GATE] Low-risk tool "${event.toolName}" blocked by GFI: ${currentGfi} >= ${dynamicThreshold}`);
        return {
          block: true,
          blockReason: `[GFI Gate] 疲劳指数过高，操作被拦截。

工具: ${event.toolName}
文件: ${filePath}
GFI: ${currentGfi}/100
动态阈值: ${dynamicThreshold} (Stage ${stage}${lineChanges > 50 ? `, ${lineChanges}行修改` : ''})

原因: 当前疲劳指数超过阈值，系统进入保护模式。

解决方案:
1. 执行 /pd-status reset 清零疲劳值
2. 检查是否存在理解偏差或死循环
3. 等待问题自然解决后再尝试

注意: 这是系统级硬性拦截，AI 无法绕过。`,
        };
      }
    }
  }

  // Merge pluginConfig (OpenClaw UI settings)
  const configRiskPaths = (ctx.pluginConfig?.riskPaths as string[] | undefined) ?? [];
  if (configRiskPaths.length > 0) {
    profile.risk_paths = [...new Set([...profile.risk_paths, ...configRiskPaths])];
  }

  // 3. Resolve the target file path
  let filePath = event.params.file_path || event.params.path || event.params.file || event.params.target;
  
  // Heuristic for bash mutation detection
  if (isBash && !filePath) {
    const command = String(event.params.command || event.params.args || "");
    const mutationMatch = command.match(/(?:>|>>|sed\s+-i|rm|mv|mkdir|touch|cp)\s+(?:-[a-zA-Z]+\s+)*([^\s;&|<>]+)/);
    
    if (mutationMatch) {
      filePath = mutationMatch[1];
    } else {
      const hasRiskPath = profile.risk_paths.some(rp => command.includes(rp));
      const isMutation = /(?:>|>>|sed|rm|mv|mkdir|touch|cp|npm|yarn|pnpm|pip|cargo)/.test(command);
      
      if (hasRiskPath && isMutation) {
        filePath = command; 
      } else {
        return;
      }
    }
  }

  if (typeof filePath !== 'string') return;

  const relPath = normalizePath(filePath, ctx.workspaceDir);
  const risky = (isBash && filePath.includes(' ')) 
    ? profile.risk_paths.some(rp => filePath.includes(rp))
    : isRisky(relPath, profile.risk_paths);

  // ── PROGRESSIVE GATE LOGIC ──
  if (profile.progressive_gate?.enabled) {
    const trustEngine = wctx.trust;
    const trustScore = trustEngine.getScore();
    const stage = trustEngine.getStage();
    const trustSettings = wctx.config.get('trust') || {
        limits: { stage_2_max_lines: 50, stage_3_max_lines: 300 }
    };

    const riskLevel = assessRiskLevel(relPath, { toolName: event.toolName, params: event.params }, profile.risk_paths);
    const lineChanges = estimateLineChanges({ toolName: event.toolName, params: event.params });

    logger.info(`[PD_GATE] Trust: ${trustScore} (Stage ${stage}), Risk: ${riskLevel}, Path: ${relPath}`);

    // Stage 1 (Bankruptcy): Block ALL writes to risk paths, and all medium+ writes
    if (stage === 1) {
        if (risky || riskLevel !== 'LOW') {
            // Check if PLAN whitelist is enabled
            if (profile.progressive_gate?.plan_approvals?.enabled) {
                const planApprovals = profile.progressive_gate.plan_approvals;
                const planStatus = getPlanStatus(ctx.workspaceDir);

                // Must have READY plan
                if (planStatus === 'READY') {
                    // Check operation type
                    if (planApprovals.allowed_operations?.includes(event.toolName)) {
                        // Check path pattern
                        if (matchesAnyPattern(relPath, planApprovals.allowed_patterns || [])) {
                            // Check line limit (if configured)
                            const maxLines = planApprovals.max_lines_override ?? -1;
                            if (maxLines === -1 || lineChanges <= maxLines) {
                                // Record PLAN approval event
                                wctx.eventLog.recordPlanApproval(ctx.sessionId, {
                                    toolName: event.toolName,
                                    filePath: relPath,
                                    pattern: relPath,
                                    planStatus
                                });
                                logger.info(`[PD_GATE] Stage 1 PLAN approval: ${relPath}`);
                                return; // Allow the operation
                            }
                        }
                    }
                }
            }

            // Block if not approved by whitelist
            return block(relPath, `Trust score too low (${trustScore}). Stage 1 agents cannot modify risk paths or perform non-trivial edits.`, wctx, event.toolName);
        }
    }

    // Stage 2 (Editor): Block writes to risk paths. Block large changes.
    if (stage === 2) {
        if (risky) {
            return block(relPath, `Stage 2 agents are not authorized to modify risk paths.`, wctx, event.toolName);
        }
        const stage2Limit = trustSettings.limits?.stage_2_max_lines ?? 50;
        if (lineChanges > stage2Limit) {
            return block(relPath, `Modification too large (${lineChanges} lines) for Stage 2. Max allowed is ${stage2Limit}.`, wctx, event.toolName);
        }
    }

    // Stage 3 (Developer): Allow normal writes. Require READY plan for risk paths.
    if (stage === 3) {
        if (risky) {
            const planStatus = getPlanStatus(ctx.workspaceDir);
            if (planStatus !== 'READY') {
                return block(relPath, `No READY plan found. Stage 3 requires a plan for risk path modifications.`, wctx, event.toolName);
            }
        }
        const stage3Limit = trustSettings.limits?.stage_3_max_lines ?? 300;
        if (lineChanges > stage3Limit) {
            return block(relPath, `Modification too large (${lineChanges} lines) for Stage 3. Max allowed is ${stage3Limit}.`, wctx, event.toolName);
        }
    }

    // Stage 4 (Architect): Full bypass
    if (stage === 4) {
        logger.info(`[PD_GATE] Trusted Architect bypass for ${relPath}`);
        return;
    }

    // ── EP SIMULATION MODE (M6验证) ──
    // 记录EP系统的模拟决策，但不生效（仅用于对比分析）
    try {
        const epDecision = checkEvolutionGate(ctx.workspaceDir!, {
            toolName: event.toolName,
            content: event.params?.content,
            lineCount: lineChanges,
            isRiskPath: risky,
        });
        
        const epLogEntry = {
            timestamp: new Date().toISOString(),
            toolName: event.toolName,
            filePath: relPath,
            trustEngine: { score: trustScore, stage, decision: 'allow' },
            epSystem: { tier: epDecision.currentTier ?? 'UNKNOWN', allowed: epDecision.allowed, reason: epDecision.reason },
            conflict: epDecision.allowed === false, // Trust允许但EP拒绝（任何阶段）
        };
        
        const epLogPath = path.join(ctx.workspaceDir!, '.state', 'ep_simulation.jsonl');
        
        // 安全创建目录（如果失败则跳过日志写入，但不影响 Trust Engine 决策）
        let canWriteEpLog = true;
        try {
            fs.mkdirSync(path.dirname(epLogPath), { recursive: true });
        } catch (mkdirErr: any) {
            if (!mkdirErr || mkdirErr.code !== 'EEXIST') {
                logger.warn(`[PD_EP_SIM] Failed to create log dir: ${mkdirErr?.message ?? String(mkdirErr)}, skipping log`);
                canWriteEpLog = false;
            }
        }
        
        if (canWriteEpLog) {
            fs.appendFileSync(epLogPath, JSON.stringify(epLogEntry) + '\n');
        }
        
        logger.info(`[PD_EP_SIM] Tier: ${epDecision.currentTier}, Allowed: ${epDecision.allowed}, Trust: ${trustScore} (Stage ${stage})`);
    } catch (err) {
        // EP 模拟失败不应该影响 Trust Engine 决策
        const errMsg = err instanceof Error ? err.message : String(err);
        logger.warn(`[PD_EP_SIM] Simulation failed: ${errMsg}, continuing with Trust Engine`);
    }
  } else {
    // FALLBACK: Legacy Gate Logic
    if (risky && profile.gate?.require_plan_for_risk_paths) {
      const planStatus = getPlanStatus(ctx.workspaceDir);
      if (planStatus !== 'READY') {
        return block(relPath, `No READY plan found in PLAN.md.`, wctx, event.toolName);
      }
    }
  }

  // ═══════════════════════════════════════════════════════════════
  // P-03: Edit Tool Force Verification
  // ═══════════════════════════════════════════════════════════════

  // After all gate checks, verify edit operations (enforces P-03)
  if (event.toolName === 'edit' && profile.edit_verification?.enabled !== false) {
    const verifyResult = handleEditVerification(event, wctx, ctx, {
      enabled: profile.edit_verification.enabled,
      max_file_size_bytes: profile.edit_verification.max_file_size_bytes,
      fuzzy_match_enabled: profile.edit_verification.fuzzy_match_enabled,
      fuzzy_match_threshold: profile.edit_verification.fuzzy_match_threshold,
      skip_large_file_action: profile.edit_verification.skip_large_file_action as 'warn' | 'block' | undefined,
    });
    if (verifyResult) {
      return verifyResult; // Block or modify params
    }
  }
}

function block(filePath: string, reason: string, wctx: WorkspaceContext, toolName: string): PluginHookBeforeToolCallResult {
  const logger = console;
  logger.error(`[PD_GATE] BLOCKED: ${filePath}. Reason: ${reason}`);

  trackBlock(wctx.workspaceDir);

  return {
    block: true,
    blockReason: `[Principles Disciple] Security Gate Blocked this action.\nFile: ${filePath}\nReason: ${reason}\n\nHint: You may need a READY plan or a higher trust score to perform this action.`,
  };
}

// ═══════════════════════════════════════════════════════════════
// P-03: Edit Tool Force Verification
// ═══════════════════════════════════════════════════════════════

/**
 * Normalize a line for fuzzy matching by collapsing whitespace
 */
function normalizeLine(line: string): string {
  return line.replace(/\s+/g, ' ').trim();
}

/**
 * Find fuzzy match between oldText and current file content
 * @param lines - File content split into lines
 * @param oldLines - oldText split into lines
 * @param threshold - Match threshold (0-1)
 * @returns Match index or -1 if not found
 */
function findFuzzyMatch(lines: string[], oldLines: string[], threshold: number = 0.8): number {
  if (oldLines.length === 0) return -1;  // P2 fix: empty array boundary check

  const normalizedLines = lines.map(normalizeLine);
  const normalizedOldLines = oldLines.map(normalizeLine);

  // Try to find matching sequence
  for (let i = 0; i <= lines.length - oldLines.length; i++) {
    let matchCount = 0;
    for (let j = 0; j < oldLines.length; j++) {
      if (normalizedLines[i + j] === normalizedOldLines[j]) {
        matchCount++;
      }
    }

    // Use threshold from config
    if (matchCount >= oldLines.length * threshold) {
      return i;
    }
  }

  return -1;
}

/**
 * Try to find a fuzzy match for oldText in the current content
 * @param currentContent - Current file content
 * @param oldText - Text to match
 * @param threshold - Match threshold (0-1)
 * @returns Object with found status and corrected text if found
 */
function tryFuzzyMatch(currentContent: string, oldText: string, threshold: number = 0.8): { found: boolean; correctedText?: string } {
  const lines = currentContent.split('\n');
  const oldLines = oldText.split('\n');

  const matchIndex = findFuzzyMatch(lines, oldLines, threshold);

  if (matchIndex !== -1) {
    // Found fuzzy match, extract actual text from file
    const correctedText = lines.slice(matchIndex, matchIndex + oldLines.length).join('\n');
    return { found: true, correctedText };
  }

  return { found: false };
}

/**
 * Generate a helpful error message for edit verification failure
 */
function generateEditError(filePath: string, oldText: string, currentContent: string): string {
  const expectedSnippet = oldText.split('\n').slice(0, 3).join('\n').substring(0, 200);
  const actualSnippet = currentContent.substring(0, 200);

  return `[P-03 Violation] Edit verification failed

File: ${filePath}

The text you're trying to replace does not match the current file content.

Expected to find:
${expectedSnippet}${oldText.length > 200 ? '...' : ''}

Actual file contains:
${actualSnippet}${currentContent.length > 200 ? '...' : ''}

Possible reasons:
  - File has been modified by another process
  - Whitespace characters do not match (spaces, tabs, newlines)
  - Context compression caused outdated information

Solution:
  1. Use the 'read' tool to get the current file content
  2. Update your edit command with the exact text from the file
  3. Retry the edit operation

This is enforced by P-03 (精确匹配前验证原则).`;
}

/**
 * Handle edit tool verification before allowing the operation
 * This enforces P-03 at the tool layer
 */
function handleEditVerification(
  event: PluginHookBeforeToolCallEvent,
  wctx: WorkspaceContext,
  ctx: PluginHookToolContext & { logger?: any },
  config: {
    enabled?: boolean;
    max_file_size_bytes?: number;
    fuzzy_match_enabled?: boolean;
    fuzzy_match_threshold?: number;
    skip_large_file_action?: 'warn' | 'block';
  } = {}
): PluginHookBeforeToolCallResult | void {
  const logger = ctx.logger || console;
  const maxSizeBytes = config.max_file_size_bytes ?? 10 * 1024 * 1024; // Default 10MB
  const fuzzyMatchEnabled = config.fuzzy_match_enabled !== false;
  const fuzzyMatchThreshold = config.fuzzy_match_threshold ?? 0.8;
  const skipAction: 'warn' | 'block' = config.skip_large_file_action ?? 'warn';

  // 1. Extract parameters (handle both parameter naming conventions)
  const filePath = event.params.file_path || event.params.path || event.params.file;
  const oldText = event.params.oldText || event.params.old_string;

  if (!filePath || !oldText) {
    // Missing required parameters, let it fail naturally
    return;
  }

  // 2. Resolve and read file
  let absolutePath: string;
  try {
    absolutePath = wctx.resolve(filePath);
  } catch (error) {
    // Path resolution error, let it fail naturally
    return;
  }

  // 2.5. Skip verification for binary files
  const BINARY_EXTENSIONS = ['.png', '.jpg', '.jpeg', '.gif', '.webp', '.bmp', '.svg',
                           '.pdf', '.zip', '.tar', '.gz', '.7z', '.rar',
                           '.exe', '.dll', '.so', '.dylib', '.bin',
                           '.mp3', '.mp4', '.avi', '.mov', '.wav',
                           '.ttf', '.otf', '.woff', '.woff2',
                           '.doc', '.docx', '.xls', '.xlsx', '.ppt', '.pptx'];
  const ext = path.extname(absolutePath).toLowerCase();
  if (BINARY_EXTENSIONS.includes(ext)) {
    logger?.info?.(`[PD_GATE:EDIT_VERIFY] Skipping verification for binary file: ${path.basename(filePath)}`);
    return;
  }

  try {
    // 2.6. Check file size before reading (P-03 improvement)
    try {
      const stats = fs.statSync(absolutePath);
      const fileSizeBytes = stats.size;
      const fileSizeMB = fileSizeBytes / (1024 * 1024);

      if (fileSizeBytes > maxSizeBytes) {
        const message = `[PD_GATE:EDIT_VERIFY] File size check: ${path.basename(filePath)} is ${fileSizeMB.toFixed(2)}MB (threshold: ${(maxSizeBytes / (1024 * 1024)).toFixed(2)}MB)`;

        if (skipAction === 'block') {
          logger?.warn?.(message + ' - BLOCKED');
          return {
            block: true,
            blockReason: `${message}\n\nFile is too large for edit verification. Increase max_file_size_bytes in PROFILE.json or reduce file size.`
          };
        } else {
          logger?.warn?.(message + ' - SKIPPING verification');
          return; // Skip verification but allow operation
        }
      }

      logger?.info?.(`[PD_GATE:EDIT_VERIFY] File size check passed: ${path.basename(filePath)} (${fileSizeMB.toFixed(2)}MB)`);
    } catch (statError) {
      // File stat error (e.g., permission denied)
      const errStr = statError instanceof Error ? statError.message : String(statError);
      const errCode = (statError as any).code;

      if (errCode === 'EACCES' || errCode === 'EPERM') {
        logger?.error?.(`[PD_GATE:EDIT_VERIFY] Permission denied accessing file: ${path.basename(filePath)} (${errStr})`);
        return {
          block: true,
          blockReason: `[P-03 Error] Permission denied: Cannot access file ${absolutePath}\n\nError: ${errStr}\n\nSolution: Check file permissions or run with appropriate access rights.`
        };
      } else if (errCode === 'ENOENT') {
        logger?.warn?.(`[PD_GATE:EDIT_VERIFY] File not found: ${path.basename(filePath)} (${errStr})`);
        // File doesn't exist - let the edit operation proceed (it will create the file)
        return;
      } else {
        logger?.warn?.(`[PD_GATE:EDIT_VERIFY] Stat error: ${errStr}`);
        // Let it fail naturally on read attempt
      }
    }

    // 3. Read current file content with improved error handling
    let currentContent: string;
    try {
      currentContent = fs.readFileSync(absolutePath, 'utf-8');
    } catch (readError) {
      const errStr = readError instanceof Error ? readError.message : String(readError);
      const errCode = (readError as any).code;

      if (errCode === 'EACCES' || errCode === 'EPERM') {
        logger?.error?.(`[PD_GATE:EDIT_VERIFY] Permission denied reading file: ${path.basename(filePath)} (${errStr})`);
        return {
          block: true,
          blockReason: `[P-03 Error] Permission denied: Cannot read file ${absolutePath}\n\nError: ${errStr}\n\nSolution: Check file permissions or run with appropriate access rights.`
        };
      } else if (errCode === 'ENOENT') {
        logger?.warn?.(`[PD_GATE:EDIT_VERIFY] File not found: ${path.basename(filePath)} (${errStr})`);
        // File doesn't exist - let the edit operation proceed
        return;
      } else if (errStr.includes('UTF-8') || errStr.includes('encoding')) {
        logger?.error?.(`[PD_GATE:EDIT_VERIFY] Encoding error reading file: ${path.basename(filePath)} (${errStr})`);
        return {
          block: true,
          blockReason: `[P-03 Error] Encoding error: Cannot read file ${absolutePath}\n\nError: ${errStr}\n\nThe file appears to use an encoding other than UTF-8. Edit verification requires UTF-8 readable text files.\n\nSolution: Ensure the file is UTF-8 encoded text, or mark binary extensions to skip verification.`
        };
      } else {
        logger?.warn?.(`[PD_GATE:EDIT_VERIFY] Read error: ${errStr}`);
        // Let it fail naturally
        return;
      }
    }

    // 4. Verify oldText exists in current content
    if (!currentContent.includes(oldText)) {
      logger?.info?.(`[PD_GATE:EDIT_VERIFY] Exact match failed for ${path.basename(filePath)}, trying fuzzy match`);

      // 5. Try fuzzy matching (if enabled)
      if (fuzzyMatchEnabled) {
        const fuzzyResult = tryFuzzyMatch(currentContent, oldText, fuzzyMatchThreshold);

        if (fuzzyResult.found && fuzzyResult.correctedText) {
          logger?.info?.(`[PD_GATE:EDIT_VERIFY] Fuzzy match found for ${path.basename(filePath)}, auto-correcting oldText`);

          // Return corrected parameters
          return {
            params: {
              ...event.params,
              oldText: fuzzyResult.correctedText,
              old_string: fuzzyResult.correctedText
            }
          };
        }
      }

      // 6. No match found, block the operation with helpful error
      const errorMsg = generateEditError(absolutePath, oldText, currentContent);

      logger?.error?.(`[PD_GATE:EDIT_VERIFY] Block edit on ${path.basename(filePath)}: oldText not found`);

      return {
        block: true,
        blockReason: errorMsg
      };
    }

    // 7. Verification passed, allow edit to proceed
    logger?.info?.(`[PD_GATE:EDIT_VERIFY] Verified edit on ${path.basename(filePath)}`);
    return;

  } catch (error) {
    // Unexpected error - let it fail naturally
    const errorStr = error instanceof Error ? error.message : String(error);
    logger?.warn?.(`[PD_GATE:EDIT_VERIFY] Unexpected error: ${errorStr}`);
    return;
  }
}
