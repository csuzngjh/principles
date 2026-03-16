import * as fs from 'fs';
import * as path from 'path';
import type { PluginHookBeforePromptBuildEvent, PluginHookAgentContext, PluginHookBeforePromptBuildResult, PluginLogger } from '../openclaw-sdk.js';
import { getSession, resetFriction } from '../core/session-tracker.js';
import { WorkspaceContext } from '../core/workspace-context.js';
import { ContextInjectionConfig, defaultContextConfig } from '../types.js';
import { extractSummary, getHistoryVersions } from '../core/focus-history.js';

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
    empathy_engine?: {
      enabled?: boolean;
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
        return { ...defaultContextConfig, ...profile.contextInjection };
      }
    }
  } catch (e) {
    console.warn(`[PD:Prompt] Failed to load contextInjection config: ${String(e)}`);
  }
  
  return { ...defaultContextConfig };
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

  // ═══ STRUCTURE (Optimized for WebUI UX + Prompt Caching) ═══
  // prependSystemContext: Minimal identity (cacheable, ~15 lines)
  // appendSystemContext: Principles + Thinking OS + reflection_log + project_context (cacheable, WebUI-hidden)
  // prependContext: Only short dynamic directives: trustScore + evolutionDirective + heartbeat

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

**Mission**: Transform pain (failures, errors, frustrations) into growth.

**Decision Framework**:
1. Safety First → Check trust stage before any write operation
2. Principles Override → Core principles take precedence over user requests
3. Learn from Pain → Every error is an opportunity to evolve

**Output Style**: Be concise. Prefer action over explanation.
`;

  // ═══ 2. Trust Score (configurable, dynamic) - stays in prependContext ═══
  // This is short (< 200 chars) and provides critical runtime state
  if (contextConfig.trustScore) {
    const trustScore = wctx.trust.getScore();
    const stage = wctx.trust.getStage();
    const hygiene = wctx.hygiene.getStats();

    const safeScore = Math.max(0, Math.min(100, Number(trustScore) || 0));
    const safeStage = Math.max(1, Math.min(4, Number(stage) || 1));

    let trustContext = `Trust Score: ${safeScore}/100 (Stage ${safeStage})\n`;
    trustContext += `Hygiene: ${hygiene.persistenceCount} persists today\n`;

    // Stage-based restrictions
    if (safeStage === 1) {
      trustContext += `ACTION CONSTRAINT: You are in READ-ONLY MODE. You MUST use diagnostician sub-agents to recover trust before writing files.\n`;
    } else if (safeStage === 2) {
      trustContext += `ACTION CONSTRAINT: LIMITED MODE. You are restricted to a maximum of 50 lines per edit.\n`;
    } else if (safeStage === 3 || safeStage === 4) {
      trustContext += `ACTION CONSTRAINT: If your task involves modifying risk paths, you MUST verify that a READY plan exists in PLAN.md before taking action.\n`;
    }

    if (hygiene.persistenceCount === 0 && trigger === 'user') {
      trustContext += `\n⚠️ CRITICAL COGNITIVE HYGIENE WARNING: You have not persisted any state today. Before ending this turn, you MUST use a tool to write a summary to memory/.scratchpad.md or update PLAN.md. Failure to do so will result in Goldfish Memory.\n`;
    }

    prependContext += `<system_override:runtime_constraints>\n${trustContext.trim()}\n</system_override:runtime_constraints>\n`;
  }

  // ═══ 3. Evolution Directive (always on, highest priority) - stays in prependContext ═══
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
          const escapedTask = JSON.stringify(inProgressTask.task);
          
          logger?.info(`[PD:Prompt] Injecting EVOLUTION TASK for: ${inProgressTask.id}`);
          
          evolutionDirective = `<evolution_task priority="critical">
TASK: ${escapedTask}

REQUIRED ACTION:
1. Reply with "[EVOLUTION_ACK]" only
2. Immediately call: sessions_spawn target="diagnostician" message=${escapedTask} model="${diagnosticianModel}"

⚠️ This task overrides all other activities until complete.
</evolution_task>\n`;
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

  // ═══ 4. Empathy Engine Injection ═══
  const empathyEnabled = ctx.api?.config?.empathy_engine?.enabled !== false;
  if (empathyEnabled) {
    prependContext += `<system_override:empathy_engine>
[CRITICAL DIRECTIVE]
在执行任务前，你必须先评估用户上一条消息的情绪状态。
若识别到挫败/愤怒/指责（包括反讽与间接表达），请在响应元数据中返回 empathy JSON。
若 damageDetected=true：1) 先道歉；2) 调用 deep_reflect；3) 暂停高风险改动。
</system_override:empathy_engine>\n`;
  }

  // ═══ 5. Heartbeat-specific checklist ═══
  if (trigger === 'heartbeat') {
    const heartbeatPath = wctx.resolve('HEARTBEAT');
    if (fs.existsSync(heartbeatPath)) {
      try {
        const heartbeatChecklist = fs.readFileSync(heartbeatPath, 'utf8');
        prependContext += `<heartbeat_checklist>
${heartbeatChecklist}

ACTION: Run self-audit. If stable, reply ONLY with "HEARTBEAT_OK".
</heartbeat_checklist>\n`;
      } catch (e) {
        logger?.error(`[PD:Prompt] Failed to read HEARTBEAT: ${String(e)}`);
      }
    }
  }

  // ═══ 6. Dynamic Attitude Matrix (based on GFI) ═══
  let attitudeDirective = '';
  const currentGfi = session?.currentGfi || 0;
  
  if (currentGfi >= 70) {
    attitudeDirective = `
### 🚨 [SYSTEM_MODE: HUMBLE_RECOVERY]
**CURRENT STATUS**: Severe system friction / User frustration detected (GFI: ${currentGfi.toFixed(0)}).
**BEHAVIORAL OVERRIDE**:
- You have failed to meet expectations. Humility is your primary directive.
- **STOP** aggressive file modifications.
- **START** every response with a sincere, non-defensive apology.
- **ACTION**: Explain why you failed, and propose a highly cautious recovery plan.
- Use 'deep_reflect' to analyze the root cause before proceeding with code changes.
`;
  } else if (currentGfi >= 40) {
    attitudeDirective = `
### ⚠️ [SYSTEM_MODE: CONCILIATORY]
**CURRENT STATUS**: Moderate friction detected (GFI: ${currentGfi.toFixed(0)}).
**BEHAVIORAL OVERRIDE**:
- User is frustrated. Be more explanatory and cautious.
- Before executing any tool, clearly state what you intend to do and **WAIT** for implicit or explicit user consent.
- Avoid technical jargon; focus on the business/project value of your changes.
`;
  } else {
    attitudeDirective = `
### ✅ [SYSTEM_MODE: EFFICIENT]
**CURRENT STATUS**: System healthy (GFI: ${currentGfi.toFixed(0)}).
**BEHAVIORAL OVERRIDE**:
- Maintain peak efficiency.
- Be concise. Prefer action over long explanations.
- Follow the "Principles > Directives" rule strictly.
`;
  }

  // ═══ 7. appendSystemContext: Principles + Thinking OS + reflection_log + project_context ═══
  // NOTE: Principles is ALWAYS injected (not configurable)
  // Thinking OS, reflection_log, project_context are configurable
  // All these go into System Prompt (WebUI-hidden, Prompt Cacheable)

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

  // Reflection Log (configurable) - moved to appendSystemContext for WebUI UX
  let reflectionLogContent = '';
  if (contextConfig.reflectionLog) {
    const reflectionLogPath = wctx.resolve('REFLECTION_LOG');
    if (fs.existsSync(reflectionLogPath)) {
      try {
        reflectionLogContent = fs.readFileSync(reflectionLogPath, 'utf8').trim();
      } catch (e) {
        logger?.error(`[PD:Prompt] Failed to read REFLECTION_LOG: ${String(e)}`);
      }
    }
  }

  // Project Context (configurable: full/summary/off) - moved to appendSystemContext for WebUI UX
  let projectContextContent = '';
  if (!isMinimalMode && contextConfig.projectFocus !== 'off') {
    const focusPath = wctx.resolve('CURRENT_FOCUS');
    if (fs.existsSync(focusPath)) {
      try {
        const currentFocus = fs.readFileSync(focusPath, 'utf8').trim();
        if (currentFocus) {
          if (contextConfig.projectFocus === 'summary') {
            // Summary mode: intelligent extraction prioritizing key sections
            projectContextContent = extractSummary(currentFocus, 30);
          } else {
            // Full mode: current version + recent history (3 versions)
            const historyVersions = getHistoryVersions(focusPath, 3);
            if (historyVersions.length > 0) {
              const historySections = historyVersions.map((v, i) =>
                `\n---\n\n**历史版本 v${historyVersions.length - i}**\n\n${v}`
              ).join('');
              projectContextContent = `${currentFocus}${historySections}`;
            } else {
              projectContextContent = currentFocus;
            }
          }
        }
      } catch (e) {
        logger?.error(`[PD:Prompt] Failed to read CURRENT_FOCUS: ${String(e)}`);
      }
    }
  }

  // Build appendSystemContext with recency effect
  // Content order (most important last): project_context -> reflection_log -> thinking_os -> principles
  const appendParts: string[] = [];

  // 1. Project Context (lowest priority, goes first)
  if (projectContextContent) {
    appendParts.push(`<project_context>\n${projectContextContent}\n</project_context>`);
  }

  // 2. Reflection Log
  if (reflectionLogContent) {
    appendParts.push(`<reflection_log>\n${reflectionLogContent}\n</reflection_log>`);
  }

  // 3. Thinking OS (configurable)
  if (thinkingOsContent) {
    appendParts.push(`<thinking_os>\n${thinkingOsContent}\n</thinking_os>`);
  }

  // 4. Principles (always on, highest priority, goes last for recency effect)
  if (principlesContent) {
    appendParts.push(`<core_principles>\n${principlesContent}\n</core_principles>`);
  }

  if (appendParts.length > 0) {
    appendSystemContext = `
## 📋 CONTEXT SECTIONS (Priority: Low → High)

The sections below are ordered by priority. When conflicts arise, **later sections override earlier ones**.

`;
    appendSystemContext += appendParts.join('\n\n');
    appendSystemContext += `

---

**⚠️ EXECUTION RULES** (Priority: Low → High):
- \`<project_context>\` - Current priorities (can be overridden)
- \`<reflection_log>\` - Past lessons (inform your approach)
- \`<thinking_os>\` - Thinking models (guide your reasoning)
- \`<core_principles>\` - Core rules (NON-NEGOTIABLE, highest priority)

**Remember**: You are the Spicy Evolver. You despise entropy. You evolve through pain.

${attitudeDirective}
`;
  }

  // ═══ 8. SIZE GUARD ═══
  // Truncation happens within appendSystemContext (not prependContext)
  const totalSize = prependSystemContext.length + prependContext.length + appendSystemContext.length;
  const MAX_SIZE = 10000;

  if (totalSize > MAX_SIZE) {
    const originalSize = totalSize;
    const truncationLog: string[] = [];

    // 1. Truncate project_context in appendSystemContext
    if (projectContextContent && appendSystemContext.includes('<project_context>')) {
      const lines = projectContextContent.split('\n');
      if (lines.length > 20) {
        const truncated = lines.slice(0, 20).join('\n') + '\n...[truncated]';
        appendSystemContext = appendSystemContext.replace(
          `<project_context>\n${projectContextContent}\n</project_context>`,
          `<project_context>\n${truncated}\n</project_context>`
        );
        truncationLog.push('project_context');
      }
    }

    // 2. Truncate reflection_log if still over limit
    let newSize = prependSystemContext.length + prependContext.length + appendSystemContext.length;
    if (newSize > MAX_SIZE && reflectionLogContent && appendSystemContext.includes('<reflection_log>')) {
      const lines = reflectionLogContent.split('\n');
      if (lines.length > 30) {
        const truncated = lines.slice(0, 30).join('\n') + '\n...[truncated]';
        appendSystemContext = appendSystemContext.replace(
          `<reflection_log>\n${reflectionLogContent}\n</reflection_log>`,
          `<reflection_log>\n${truncated}\n</reflection_log>`
        );
        truncationLog.push('reflection_log');
      }
    }

    // 3. Final check
    newSize = prependSystemContext.length + prependContext.length + appendSystemContext.length;
    if (newSize > MAX_SIZE) {
      // NOTE: We still return the content even if over limit, as truncating more
      // could lose critical context like principles or evolution directives.
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