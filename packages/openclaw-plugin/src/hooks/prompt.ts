import * as fs from 'fs';
import * as path from 'path';
import type { PluginHookBeforePromptBuildEvent, PluginHookAgentContext, PluginHookBeforePromptBuildResult, PluginLogger } from '../openclaw-sdk.js';
import { getSession, resetFriction } from '../core/session-tracker.js';
import { WorkspaceContext } from '../core/workspace-context.js';

/**
 * 模型配置对象格式
 */
interface ModelConfigObject {
  primary?: string;
  fallbacks?: string[];
}

/**
 * 代理配置中的模型相关配置
 */
interface AgentsModelConfig {
  model?: unknown;
  subagents?: {
    model?: unknown;
  };
}

/**
 * 代理默认配置
 */
interface AgentsDefaultsConfig {
  model?: unknown;
  subagents?: {
    model?: unknown;
  };
}

/**
 * OpenClaw API 接口定义（Prompt Hook 所需部分）
 */
interface PromptHookApi {
  config?: {
    agents?: {
      defaults?: AgentsDefaultsConfig;
    };
  };
  logger: PluginLogger;
}

/**
 * 验证模型字符串格式是否为 "provider/model"
 */
function isValidModelFormat(model: string): boolean {
  // 格式: "provider/model" 或 "provider/model-variant"
  // provider: 字母数字和连字符，不能以连字符开头/结尾
  // model: 字母数字、连字符、点号、下划线
  const MODEL_PATTERN = /^[a-zA-Z0-9][a-zA-Z0-9-]*[a-zA-Z0-9]\/[a-zA-Z0-9._-]+$/;
  return MODEL_PATTERN.test(model);
}

/**
 * 从 OpenClaw 配置中解析模型选择
 * 支持 string 或 { primary, fallbacks } 格式
 * @internal 导出仅供测试使用
 */
export function resolveModelFromConfig(modelConfig: unknown, logger?: PluginLogger): string | null {
  if (!modelConfig) return null;
  
  // 格式 1: "provider/model" 字符串
  if (typeof modelConfig === 'string') {
    const trimmed = modelConfig.trim();
    if (!trimmed) return null;
    if (!isValidModelFormat(trimmed)) {
      logger?.warn(`[PD:Prompt] Invalid model format: "${trimmed}". Expected "provider/model" format.`);
      return null;
    }
    return trimmed;
  }
  
  // 格式 2: { primary: "provider/model", fallbacks: [...] } 对象
  if (typeof modelConfig === 'object' && modelConfig !== null && !Array.isArray(modelConfig)) {
    const cfg = modelConfig as ModelConfigObject;
    if (cfg.primary && typeof cfg.primary === 'string') {
      const trimmed = cfg.primary.trim();
      if (!trimmed) return null;
      if (!isValidModelFormat(trimmed)) {
        logger?.warn(`[PD:Prompt] Invalid primary model format: "${trimmed}". Expected "provider/model" format.`);
        return null;
      }
      return trimmed;
    }
  }
  
  // 格式 3: 数组格式（不支持，发出警告）
  if (Array.isArray(modelConfig)) {
    console.warn(`[PD:Prompt] Array model config not supported. Expected "provider/model" string or { primary: "..." } object.`);
    logger?.warn(`[PD:Prompt] Array model config not supported. Expected "provider/model" string or { primary: "..." } object.`);
    return null;
  }
  
  return null;
}

/**
 * 获取诊断子智能体应使用的模型
 * 优先级：subagents.model > 主模型
 * 如果都没有配置，抛出错误
 * @internal 导出仅供测试使用
 */
export function getDiagnosticianModel(api: PromptHookApi | null, logger?: PluginLogger): string {
  // 兼容两种调用方式：
  // 1. 新方式：getDiagnosticianModel(api) - api 包含 logger
  // 2. 旧方式：getDiagnosticianModel(api, logger) - 分离参数
  const effectiveLogger = api?.logger || logger;
  
  if (!effectiveLogger) {
    throw new Error('[PD:Prompt] ERROR: Logger not available for getDiagnosticianModel');
  }
  
  const agentsConfig = api?.config?.agents?.defaults;
  
  // 优先使用子智能体专用模型
  const subagentModel = resolveModelFromConfig(agentsConfig?.subagents?.model, effectiveLogger);
  if (subagentModel) {
    effectiveLogger.info(`[PD:Prompt] Using subagents.model for diagnostician: ${subagentModel}`);
    return subagentModel;
  }
  
  // 备选：使用主智能体模型
  const primaryModel = resolveModelFromConfig(agentsConfig?.model, effectiveLogger);
  if (primaryModel) {
    effectiveLogger.info(`[PD:Prompt] Using primary model for diagnostician (subagents.model not set): ${primaryModel}`);
    return primaryModel;
  }
  
  // 没有配置任何模型，报错
  const errorMsg = `[PD:Prompt] ERROR: No model configured for diagnostician subagent. ` +
    `Please set 'agents.defaults.subagents.model' or 'agents.defaults.model' in OpenClaw config.`;
  effectiveLogger.error(errorMsg);
  throw new Error(errorMsg);
}

export async function handleBeforePromptBuild(
  event: PluginHookBeforePromptBuildEvent,
  ctx: PluginHookAgentContext & { api?: PromptHookApi }
): Promise<PluginHookBeforePromptBuildResult | void> {
  const workspaceDir = ctx.workspaceDir;
  if (!workspaceDir) return;

  const wctx = WorkspaceContext.fromHookContext(ctx);
  const { trigger, sessionId, api } = ctx;
  const logger = api?.logger;  // 统一获取 logger

  // Minimal mode: heartbeat and subagents skip project context/system caps to reduce tokens
  // SessionId format: "agent:main:subagent:{type}-{id}" for subagents, "agent:main:..." for main
  const isMinimalMode = trigger === "heartbeat" || sessionId?.includes(":subagent:") === true;

  const focusPath = wctx.resolve('CURRENT_FOCUS');
  const painFlagPath = wctx.resolve('PAIN_FLAG');
  const capsPath = wctx.resolve('SYSTEM_CAPABILITIES');

  const config = wctx.config;
  const session = sessionId ? getSession(sessionId) : undefined;

  let prependSystemContext = '';
  let prependContext = '';
  let appendSystemContext = '';

  // ═══ LAYER 0 (道之源): Core Principles - Highest Priority ═══
  const principlesPath = wctx.resolve('PRINCIPLES');
  if (fs.existsSync(principlesPath)) {
    try {
      const principles = fs.readFileSync(principlesPath, 'utf8');
      if (principles.trim()) {
        prependSystemContext = `<core_principles>\n${principles.trim()}\n</core_principles>`;
      }
    } catch (e) {
      logger?.error(`[PD:Prompt] Failed to read PRINCIPLES: ${String(e)}`);
    }
  }

  // 0. Manual Pain Clearance
  if (trigger === 'user' && sessionId && session && session.currentGfi >= 100) {
    resetFriction(sessionId, workspaceDir);
  }

  // ═══ LAYER 3 (道): Thinking OS + Reflection Checkpoint ═══
  // Both are static, cacheable content - put in prependSystemContext for provider caching
  const thinkingOsPath = wctx.resolve('THINKING_OS');
  if (fs.existsSync(thinkingOsPath)) {
    try {
      const thinkingOs = fs.readFileSync(thinkingOsPath, 'utf8');
      if (thinkingOs.trim()) {
        prependSystemContext += `\n<thinking_os>\n${thinkingOs.trim()}\n</thinking_os>`;
      }
    } catch (e) {
      logger?.error(`[PD:Prompt] Failed to read THINKING_OS: ${String(e)}`);
    }
  }

  // 1. Critical Reflection Logic (High Priority - Prompt Injection)
  const reflectionLogPath = wctx.resolve('REFLECTION_LOG');
  if (fs.existsSync(reflectionLogPath)) {
    try {
      const reflectionLog = fs.readFileSync(reflectionLogPath, 'utf8');
      if (reflectionLog.trim()) {
        prependContext += `\n<reflection_log>\n${reflectionLog.trim()}\n</reflection_log>\n`;
      }
    } catch (e) {
      logger?.error(`[PD:Prompt] Failed to read REFLECTION_LOG: ${String(e)}`);
    }
  }

  // 2. Strategic focus (skip in minimal mode)
  if (!isMinimalMode) {
    if (fs.existsSync(focusPath)) {
      try {
        const currentFocus = fs.readFileSync(focusPath, 'utf8');
        if (currentFocus.trim()) {
          prependContext += `\n<project_context>\n--- Strategic Focus ---\n${currentFocus.trim()}\n--- End of Strategic Focus ---\n</project_context>\n`;
        }
      } catch (e) {
        logger?.error(`[PD:Prompt] Failed to read CURRENT_FOCUS: ${String(e)}`);
      }
    }
  }

  // 3. Background Evolution Directives
  let evolutionDirective = ''; // 用于存储进化指令，避免 return 导致上下文丢失
  const queuePath = wctx.resolve('EVOLUTION_QUEUE');
  if (fs.existsSync(queuePath)) {
    try {
      const queue = JSON.parse(fs.readFileSync(queuePath, 'utf8'));
      const inProgressTask = queue.find((t: any) => t.status === 'in_progress');
      
      if (inProgressTask) {
        // High-intensity directive to force the agent to work on the evolution task
        let diagnosticianModel: string | null = null;
        try {
          if (api) {
            diagnosticianModel = getDiagnosticianModel(api);
          }
        } catch (err) {
          // 模型配置缺失，记录错误但不 return，继续注入其他上下文
          logger?.error(`[PD:Prompt] Failed to resolve diagnostician model: ${String(err)}`);
        }
        
        if (diagnosticianModel) {
          // 转义任务内容，防止注入攻击
          // 需要转义：反引号、$、反斜杠、双引号、换行符
          const escapedTask = inProgressTask.task
            .replace(/\\/g, '\\\\')   // 先转义反斜杠
            .replace(/`/g, '\\`')     // 转义反引号（模板字符串）
            .replace(/\$/g, '\\$')    // 转义 $（模板字符串插值）
            .replace(/"/g, '\\"')     // 转义双引号
            .replace(/\n/g, '\\n');   // 转义换行符
          
          logger?.info(`[PD:Prompt] Injecting SYSTEM OVERRIDE for evolution task: ${inProgressTask.id}`);
          
          evolutionDirective = `\n[🚨 SYSTEM OVERRIDE 🚨]\n` +
            `A critical evolution task is assigned to you. YOU MUST PRIORITIZE THIS TASK.\n` +
            `TASK: "${escapedTask}"\n\n` +
            `ACTION REQUIRED:\n` +
            `Reply ONLY with "[EVOLUTION_ACK]". Then immediately invoke the \`sessions_spawn\` tool:\n` +
            `\`\`\`\n` +
            `sessions_spawn target="diagnostician" message="${escapedTask}" model="${diagnosticianModel}"\n` +
            `\`\`\`\n` +
            `NO OTHER ACTIONS PERMITTED.`;
        }
      }
    } catch (e) {
      logger?.error(`[PD:Prompt] Failed to parse EVOLUTION_QUEUE: ${String(e)}`);
    }
  }

  // 4. Perceptive awareness: System Capabilities (skip in minimal mode)
  if (!isMinimalMode) {
    if (fs.existsSync(capsPath)) {
      try {
        const caps = fs.readFileSync(capsPath, 'utf8');
        prependContext += `\n<system_capabilities>\n${caps}\n</system_capabilities>\n`;
      } catch (e) {
        logger?.error(`[PD:Prompt] Failed to read SYSTEM_CAPABILITIES: ${String(e)}`);
      }
    }
  }

  // 5. Heartbeat-specific active checklist
  if (trigger === 'heartbeat') {
    const heartbeatPath = wctx.resolve('HEARTBEAT');
    if (fs.existsSync(heartbeatPath)) {
      try {
        const heartbeatChecklist = fs.readFileSync(heartbeatPath, 'utf8');
        prependContext += `\n<heartbeat_checklist>\n${heartbeatChecklist}\n\nDIRECTIVE: Perform a system-wide self-audit now. If everything is stable, strictly reply with "HEARTBEAT_OK" to minimize token usage.\n</heartbeat_checklist>\n`;
      } catch (e) {
        logger?.error(`[PD:Prompt] Failed to read HEARTBEAT: ${String(e)}`);
      }
    }
  }

  // 6. Security Layer: Trust & Permission Awareness (Dynamic Content)
  // 这些是动态内容，放入 <pd:internal_context> 以便 prependSystemContext 保持纯静态
  const trustScore = wctx.trust.getScore();
  const stage = wctx.trust.getStage();
  const hygiene = wctx.hygiene.getStats();

  // 1. 数值安全校验：防止异常值
  // safeScore 范围: 0-100，safeStage 范围: 1-4（四个信任阶段）
  const safeScore = Math.max(0, Math.min(100, Number(trustScore) || 0));
  const safeStage = Math.max(1, Math.min(4, Number(stage) || 1));

  // 2. 构建动态内部上下文（重命名 internalContext → dynamicContext）
  let dynamicContext = '';
  dynamicContext += `[CURRENT TRUST SCORE: ${safeScore}/100 (Stage ${safeStage})]\n`;
  dynamicContext += `[COGNITIVE HYGIENE: ${hygiene.persistenceCount} persists today]\n`;

  // 3. 视觉层次改进：Stage 1 使用更醒目的格式
  if (safeStage === 1) {
    dynamicContext += `\n[!CRITICAL!] Your trust score is critical. You are in read-only mode. Use diagnostician sub-agents to recover trust.\n`;
  }

  if (hygiene.persistenceCount === 0 && trigger === 'user') {
    dynamicContext += `⚠️ ADVISORY: You haven't persisted any state today. To prevent "Goldfish Memory", consider updating PLAN.md or writing notes to memory/ if this session is becoming complex.\n`;
  }

  // 4. 使用命名空间前缀 (pd:internal_context)
  if (dynamicContext.trim()) {
    prependContext = `\n<pd:internal_context>\n${dynamicContext.trim()}\n</pd:internal_context>\n` + prependContext;
  }

  // 注入进化指令（如果有），放在 prependContext 最前面（高优先级）
  if (evolutionDirective) {
    prependContext = evolutionDirective + prependContext;
  }

  // ═══ SIZE GUARD: Prevent token explosion ═══
  const totalSize = prependSystemContext.length + prependContext.length + appendSystemContext.length;
  const MAX_SIZE = 10000;

  if (totalSize > MAX_SIZE) {
    const originalSize = totalSize;
    
    // Truncate <project_context> to first 50 lines
    const projectContextMatch = prependContext.match(/(<project_context>[\s\S]*?<\/project_context>)/);
    if (projectContextMatch) {
      const originalBlock = projectContextMatch[1];
      const lines = originalBlock.split('\n');
      if (lines.length > 50) {
        const truncatedBlock = lines.slice(0, 50).join('\n') + '\n...[truncated]';
        prependContext = prependContext.replace(originalBlock, truncatedBlock);
      }
    }
    
    const newSize = prependSystemContext.length + prependContext.length + appendSystemContext.length;
    logger?.warn(`[PD:Prompt] Injection size exceeded: ${originalSize} chars (limit: ${MAX_SIZE}), truncated to ${newSize} chars (${newSize - originalSize} saved)`);
  }

  return {
    prependSystemContext,
    prependContext,
    appendSystemContext
  };
}
