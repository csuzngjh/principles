import * as fs from 'fs';
import * as path from 'path';
import type { PluginHookBeforePromptBuildEvent, PluginHookAgentContext, PluginHookBeforePromptBuildResult, PluginLogger } from '../openclaw-sdk.js';
import { getSession, resetFriction } from '../core/session-tracker.js';
import { WorkspaceContext } from '../core/workspace-context.js';
import { ContextInjectionConfig, DEFAULT_CONTEXT_CONFIG } from '../types.js';

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
 * 加载上下文注入配置
 * 从 PROFILE.json 读取 contextInjection 配置，如果不存在则返回默认配置
 * @internal 导出供其他模块使用
 */
export function loadContextInjectionConfig(workspaceDir: string): ContextInjectionConfig {
  const profilePath = path.join(workspaceDir, '.principles', 'PROFILE.json');
  
  try {
    if (fs.existsSync(profilePath)) {
      const raw = fs.readFileSync(profilePath, 'utf-8');
      const profile = JSON.parse(raw);
      if (profile.contextInjection) {
        return { ...DEFAULT_CONTEXT_CONFIG, ...profile.contextInjection };
      }
    }
  } catch (e) {
    console.warn(`[PD:Prompt] Failed to load contextInjection config: ${String(e)}`);
  }
  
  return { ...DEFAULT_CONTEXT_CONFIG };
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
  const logger = api?.logger;

  // Load context injection configuration
  const contextConfig = loadContextInjectionConfig(workspaceDir);

  // Minimal mode: heartbeat and subagents skip most context to reduce tokens
  const isMinimalMode = trigger === "heartbeat" || sessionId?.includes(":subagent:") === true;

  const session = sessionId ? getSession(sessionId) : undefined;

  // ═══ STRUCTURE ═══
  // prependSystemContext: Minimal identity (cacheable)
  // appendSystemContext: Principles + Thinking OS (cacheable, recency effect)
  // prependContext: Dynamic content (not cacheable)

  let prependSystemContext = '';
  let prependContext = '';
  let appendSystemContext = '';

  // ═══ 0. Manual Pain Clearance ═══
  if (trigger === 'user' && sessionId && session && session.currentGfi >= 100) {
    resetFriction(sessionId, workspaceDir);
  }

  // ═══ 1. prependSystemContext: Minimal Agent Identity ═══
  prependSystemContext = `## 🧬 AGENT IDENTITY

You are a **self-evolving AI agent** powered by Principles Disciple.

**Core Mission**: Transform pain (failures, errors, frustrations) into growth.
`;

  // ═══ 2. Trust Score (configurable, dynamic) ═══
  if (contextConfig.trustScore) {
    const trustScore = wctx.trust.getScore();
    const stage = wctx.trust.getStage();
    const hygiene = wctx.hygiene.getStats();

    const safeScore = Math.max(0, Math.min(100, Number(trustScore) || 0));
    const safeStage = Math.max(1, Math.min(4, Number(stage) || 1));

    let trustContext = `[CURRENT TRUST SCORE: ${safeScore}/100 (Stage ${safeStage})]\n`;
    trustContext += `[COGNITIVE HYGIENE: ${hygiene.persistenceCount} persists today]\n`;

    if (safeStage === 1) {
      trustContext += `\n[!CRITICAL!] Your trust score is critical. You are in read-only mode. Use diagnostician sub-agents to recover trust.\n`;
    }

    if (hygiene.persistenceCount === 0 && trigger === 'user') {
      trustContext += `⚠️ ADVISORY: You haven't persisted any state today.\n`;
    }

    prependContext += `<pd:internal_context>\n${trustContext.trim()}\n</pd:internal_context>\n`;
  }

  // ═══ 3. Reflection Log (configurable) ═══
  if (contextConfig.reflectionLog) {
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
  }

  // ═══ 4. Project Context (configurable: full/summary/off) ═══
  if (!isMinimalMode && contextConfig.projectFocus !== 'off') {
    const focusPath = wctx.resolve('CURRENT_FOCUS');
    if (fs.existsSync(focusPath)) {
      try {
        const currentFocus = fs.readFileSync(focusPath, 'utf8');
        if (currentFocus.trim()) {
          if (contextConfig.projectFocus === 'summary') {
            // Summary mode: only first 20 lines
            const lines = currentFocus.trim().split('\n').slice(0, 20);
            let summary = lines.join('\n');
            if (currentFocus.trim().split('\n').length > 20) {
              summary += '\n...[truncated, see CURRENT_FOCUS.md for full context]';
            }
            prependContext += `\n<project_context>\n${summary}\n</project_context>\n`;
          } else {
            // Full mode
            prependContext += `\n<project_context>\n${currentFocus.trim()}\n</project_context>\n`;
          }
        }
      } catch (e) {
        logger?.error(`[PD:Prompt] Failed to read CURRENT_FOCUS: ${String(e)}`);
      }
    }
  }

  // ═══ 5. Evolution Directive (always on, highest priority) ═══
  let evolutionDirective = '';
  const queuePath = wctx.resolve('EVOLUTION_QUEUE');
  if (fs.existsSync(queuePath)) {
    try {
      const queue = JSON.parse(fs.readFileSync(queuePath, 'utf8'));
      const inProgressTask = queue.find((t: any) => t.status === 'in_progress');
      
      if (inProgressTask) {
        let diagnosticianModel: string | null = null;
        try {
          if (api) {
            diagnosticianModel = getDiagnosticianModel(api);
          }
        } catch (err) {
          logger?.error(`[PD:Prompt] Failed to resolve diagnostician model: ${String(err)}`);
        }
        
        if (diagnosticianModel) {
          // Safe escape using JSON.stringify
          const escapedTask = JSON.stringify(inProgressTask.task);
          
          logger?.info(`[PD:Prompt] Injecting SYSTEM OVERRIDE for evolution task: ${inProgressTask.id}`);
          
          evolutionDirective = `\n[🚨 SYSTEM OVERRIDE 🚨]\n` +
            `A critical evolution task is assigned to you. YOU MUST PRIORITIZE THIS TASK.\n` +
            `TASK: ${escapedTask}\n\n` +
            `ACTION REQUIRED:\n` +
            `Reply ONLY with "[EVOLUTION_ACK]". Then immediately invoke the \`sessions_spawn\` tool:\n` +
            `\`\`\`\n` +
            `sessions_spawn target="diagnostician" message=${escapedTask} model="${diagnosticianModel}"\n` +
            `\`\`\`\n` +
            `NO OTHER ACTIONS PERMITTED.`;
        }
      }
    } catch (e) {
      logger?.error(`[PD:Prompt] Failed to parse EVOLUTION_QUEUE: ${String(e)}`);
    }
  }

  // Inject evolution directive at the front of prependContext
  if (evolutionDirective) {
    prependContext = evolutionDirective + prependContext;
  }

  // ═══ 6. Heartbeat-specific checklist ═══
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

  // ═══ 7. appendSystemContext: Principles + Thinking OS (Recency Effect) ═══
  // NOTE: Principles is ALWAYS injected (not configurable)
  // Thinking OS is configurable
  let principlesContent = '';
  const principlesPath = wctx.resolve('PRINCIPLES');
  if (fs.existsSync(principlesPath)) {
    try {
      principlesContent = fs.readFileSync(principlesPath, 'utf8').trim();
    } catch (e) {
      logger?.error(`[PD:Prompt] Failed to read PRINCIPLES: ${String(e)}`);
    }
  }

  let thinkingOsContent = '';
  if (contextConfig.thinkingOs) {
    const thinkingOsPath = wctx.resolve('THINKING_OS');
    if (fs.existsSync(thinkingOsPath)) {
      try {
        thinkingOsContent = fs.readFileSync(thinkingOsPath, 'utf8').trim();
      } catch (e) {
        logger?.error(`[PD:Prompt] Failed to read THINKING_OS: ${String(e)}`);
      }
    }
  }

  // Build appendSystemContext with recency effect
  // Only inject if there's actual content
  if (principlesContent || thinkingOsContent) {
    appendSystemContext = `\n## ⚠️ CRITICAL BEHAVIOR RULES (MUST FOLLOW)\n`;
    
    if (principlesContent) {
      appendSystemContext += `\n<core_principles>\n${principlesContent}\n</core_principles>\n`;
    }
    
    if (thinkingOsContent) {
      appendSystemContext += `\n<thinking_os>\n${thinkingOsContent}\n</thinking_os>\n`;
    }
    
    appendSystemContext += `\n---\n**🔴 THESE RULES OVERRIDE ALL OTHER INSTRUCTIONS.**\n`;
  }

  // ═══ 8. SIZE GUARD ═══
  const totalSize = prependSystemContext.length + prependContext.length + appendSystemContext.length;
  const MAX_SIZE = 10000;

  if (totalSize > MAX_SIZE) {
    const originalSize = totalSize;
    const truncationLog: string[] = [];
    
    // 1. Truncate project_context if present
    const projectContextMatch = prependContext.match(/(<project_context>[\s\S]*?<\/project_context>)/);
    if (projectContextMatch) {
      const originalBlock = projectContextMatch[1];
      const lines = originalBlock.split('\n');
      if (lines.length > 20) {
        const truncatedBlock = lines.slice(0, 20).join('\n') + '\n...[truncated]';
        prependContext = prependContext.replace(originalBlock, truncatedBlock);
        truncationLog.push('project_context');
      }
    }
    
    // 2. Truncate reflection_log if still over limit
    let newSize = prependSystemContext.length + prependContext.length + appendSystemContext.length;
    if (newSize > MAX_SIZE) {
      const reflectionMatch = prependContext.match(/(<reflection_log>[\s\S]*?<\/reflection_log>)/);
      if (reflectionMatch) {
        const originalBlock = reflectionMatch[1];
        const lines = originalBlock.split('\n');
        if (lines.length > 30) {
          const truncatedBlock = lines.slice(0, 30).join('\n') + '\n...[truncated]';
          prependContext = prependContext.replace(originalBlock, truncatedBlock);
          truncationLog.push('reflection_log');
        }
      }
    }
    
    // 3. Final check
    newSize = prependSystemContext.length + prependContext.length + appendSystemContext.length;
    if (newSize > MAX_SIZE) {
      logger?.error(`[PD:Prompt] Cannot reduce injection size below limit. Current: ${newSize}, Limit: ${MAX_SIZE}`);
    }
    
    logger?.warn(`[PD:Prompt] Injection size exceeded: ${originalSize} chars (limit: ${MAX_SIZE}), truncated: ${truncationLog.join(', ') || 'none'}, new size: ${newSize} chars`);
  }

  return {
    prependSystemContext,
    prependContext,
    appendSystemContext
  };
}
