import * as fs from 'fs';
import * as path from 'path';
import type { PluginHookBeforePromptBuildEvent, PluginHookAgentContext, PluginHookBeforePromptBuildResult, PluginLogger } from '../openclaw-sdk.js';
import { getSession, resetFriction, setInjectedProbationIds } from '../core/session-tracker.js';
import { WorkspaceContext } from '../core/workspace-context.js';
import { ContextInjectionConfig, defaultContextConfig } from '../types.js';
import { extractSummary, getHistoryVersions } from '../core/focus-history.js';
import { empathyObserverManager, type EmpathyObserverApi } from '../service/empathy-observer-manager.js';
import { PathResolver } from '../core/path-resolver.js';

/**
 * 妯″瀷閰嶇疆瀵硅薄鏍煎紡
 */
interface ModelConfigObject {
  primary?: string;
  fallbacks?: string[];
}

/**
 * 浠ｇ悊閰嶇疆涓殑妯″瀷鐩稿叧閰嶇疆
 */
interface AgentsModelConfig {
  model?: unknown;
  subagents?: {
    model?: unknown;
  };
}

/**
 * 浠ｇ悊榛樿閰嶇疆
 */
interface AgentsDefaultsConfig {
  model?: unknown;
  subagents?: {
    model?: unknown;
  };
}

/**
 * OpenClaw API 鎺ュ彛瀹氫箟锛圥rompt Hook 鎵€闇€閮ㄥ垎锛?
 */


function escapeXml(input: string): string {
  return input
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

function extractContextSignals(context: { toolName?: string; filePath?: string; userMessage?: string; }): string[] {
  const signals: string[] = [];
  if (context.filePath?.endsWith('.ts')) signals.push('typescript');
  if (context.filePath?.endsWith('.md')) signals.push('markdown');
  if (context.toolName && ['edit', 'replace', 'write', 'write_file', 'apply_patch'].includes(context.toolName)) signals.push('edit');
  if (context.toolName && ['run_shell_command', 'bash'].includes(context.toolName)) signals.push('shell');
  if (context.toolName) signals.push(context.toolName);
  const msg = (context.userMessage || '').toLowerCase();
  if (msg.includes('.ts') || msg.includes('typescript')) signals.push('typescript');
  if (msg.includes('.md') || msg.includes('markdown')) signals.push('markdown');
  if (msg.includes('edit') || msg.includes('write') || msg.includes('patch')) signals.push('edit');
  if (msg.includes('shell') || msg.includes('bash')) signals.push('shell');
  return signals;
}

interface PromptHookApi {
  config?: {
    agents?: {
      defaults?: AgentsDefaultsConfig;
    };
    empathy_engine?: {
      enabled?: boolean;
    };
  };
  runtime: EmpathyObserverApi['runtime'];
  logger: PluginLogger;
}

function extractRecentConversationContext(
  messages: unknown[] | undefined,
  maxMessages = 4,
  maxCharsPerMessage = 200
): string {
  if (!Array.isArray(messages) || messages.length === 0) return '';

  const relevantMessages: Array<{ role: 'user' | 'assistant'; text: string }> = [];

  for (let i = messages.length - 1; i >= 0 && relevantMessages.length < maxMessages; i--) {
    const msg = messages[i] as { role?: string; content?: unknown };
    if (msg?.role !== 'user' && msg?.role !== 'assistant') continue;

    let text = '';
    if (typeof msg.content === 'string') {
      text = msg.content;
    } else if (Array.isArray(msg.content)) {
      text = msg.content
        .filter((part: unknown) => {
          if (!part || typeof part !== 'object') return false;
          const record = part as { type?: unknown; text?: unknown };
          return record.type === 'text' && typeof record.text === 'string';
        })
        .map((part) => (part as { text: string }).text)
        .join('\n')
        .trim();
    }

    if (!text) continue;

    const normalized = text.length > maxCharsPerMessage
      ? `${text.slice(0, maxCharsPerMessage)}...`
      : text;

    relevantMessages.unshift({ role: msg.role, text: normalized });
  }

  if (relevantMessages.length === 0) return '';

  return relevantMessages
    .map((message) => `[${message.role.toUpperCase()}]: ${message.text}`)
    .join('\n\n');
}

function getTextContent(message: unknown): string {
  if (!message || typeof message !== 'object') return '';
  const record = message as { content?: unknown };
  if (typeof record.content === 'string') return record.content;
  if (Array.isArray(record.content)) {
    return record.content
      .filter((part: unknown) => part && typeof part === 'object' && (part as { type?: unknown }).type === 'text')
      .map((part) => String((part as { text?: unknown }).text ?? ''))
      .join('\n')
      .trim();
  }
  return '';
}

function detectCorrectionCue(text: string): string | null {
  const normalized = text
    .trim()
    .toLowerCase()
    .replace(/[.,!?，。！？]/g, '');
  const cues = [
    '你错了',
    '错了',
    '不对',
    '不对的',
    '不对吧',
    '不是这个',
    '重新来',
    '重来',
    'you are wrong',
    'wrong file',
    'not this',
    'redo',
    'try again',
    'again',
    'please redo',
    'please try again',
  ];
  return cues.find((cue) => normalized.includes(cue)) ?? null;
}

function resolveEvolutionTask(
  inProgressTask: any,
  messages?: unknown[],
  maxContextMessages = 4,
  maxCharsPerMsg = 200,
  includeConversationContext = true
): string | null {
  if (!inProgressTask || typeof inProgressTask !== 'object') return null;

  const rawTask = typeof inProgressTask.task === 'string' ? inProgressTask.task.trim() : '';
  if (rawTask && rawTask.toLowerCase() !== 'undefined') return rawTask;

  const source = typeof inProgressTask.source === 'string' ? inProgressTask.source.trim() : 'unknown';
  const reason = typeof inProgressTask.reason === 'string' ? inProgressTask.reason.trim() : 'Systemic pain detected';
  const preview = typeof inProgressTask.trigger_text_preview === 'string' && inProgressTask.trigger_text_preview.trim()
    ? inProgressTask.trigger_text_preview.trim()
    : 'N/A';

  if (typeof inProgressTask.id !== 'string' || !inProgressTask.id.trim()) return null;

  const conversationContext = includeConversationContext
    ? extractRecentConversationContext(messages, maxContextMessages, maxCharsPerMsg)
    : '';

  let taskDescription = `Diagnose systemic pain [ID: ${inProgressTask.id}].

`;
  taskDescription += `**Source**: ${source}
`;
  taskDescription += `**Reason**: ${reason}
`;
  taskDescription += `**Trigger Text**: "${preview}"
`;

  if (conversationContext) {
    taskDescription += `
---
**Recent Conversation Context**:
${conversationContext}`;
  }

  taskDescription += `

---
Analyze the root cause using 5 Whys methodology. Check evidence in codebase before concluding.`;

  return taskDescription;
}

/**
 * 楠岃瘉妯″瀷瀛楃涓叉牸寮忔槸鍚︿负 "provider/model"
 */
function isValidModelFormat(model: string): boolean {
  // 鏍煎紡: "provider/model" 鎴?"provider/model-variant"
  // provider: 瀛楁瘝鏁板瓧鍜岃繛瀛楃锛屼笉鑳戒互杩炲瓧绗﹀紑澶?缁撳熬
  // model: 瀛楁瘝鏁板瓧銆佽繛瀛楃銆佺偣鍙枫€佷笅鍒掔嚎
  const MODEL_PATTERN = /^[a-zA-Z0-9][a-zA-Z0-9-]*[a-zA-Z0-9]\/[a-zA-Z0-9._-]+$/;
  return MODEL_PATTERN.test(model);
}

/**
 * 浠?OpenClaw 閰嶇疆涓В鏋愭ā鍨嬮€夋嫨
 * 鏀寔 string 鎴?{ primary, fallbacks } 鏍煎紡
 * @internal 瀵煎嚭浠呬緵娴嬭瘯浣跨敤
 */
export function resolveModelFromConfig(modelConfig: unknown, logger?: PluginLogger): string | null {
  if (!modelConfig) return null;
  
  // 鏍煎紡 1: "provider/model" 瀛楃涓?
  if (typeof modelConfig === 'string') {
    const trimmed = modelConfig.trim();
    if (!trimmed) return null;
    if (!isValidModelFormat(trimmed)) {
      logger?.warn(`[PD:Prompt] Invalid model format: "${trimmed}". Expected "provider/model" format.`);
      return null;
    }
    return trimmed;
  }
  
  // 鏍煎紡 2: { primary: "provider/model", fallbacks: [...] } 瀵硅薄
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
  
  // 鏍煎紡 3: 鏁扮粍鏍煎紡锛堜笉鏀寔锛屽彂鍑鸿鍛婏級
  if (Array.isArray(modelConfig)) {
    console.warn(`[PD:Prompt] Array model config not supported. Expected "provider/model" string or { primary: "..." } object.`);
    logger?.warn(`[PD:Prompt] Array model config not supported. Expected "provider/model" string or { primary: "..." } object.`);
    return null;
  }
  
  return null;
}

/**
 * 鍔犺浇涓婁笅鏂囨敞鍏ラ厤缃?
 * 浠?PROFILE.json 璇诲彇 contextInjection 閰嶇疆锛屽鏋滀笉瀛樺湪鍒欒繑鍥為粯璁ら厤缃?
 * @internal 瀵煎嚭渚涘叾浠栨ā鍧椾娇鐢?
 */
export function loadContextInjectionConfig(workspaceDir: string): ContextInjectionConfig {
  const profilePath = path.join(workspaceDir, '.principles', 'PROFILE.json');
  
  try {
    if (fs.existsSync(profilePath)) {
      const raw = fs.readFileSync(profilePath, 'utf-8');
      const profile = JSON.parse(raw);
      if (profile.contextInjection) {
        const contextInjection = profile.contextInjection as Partial<ContextInjectionConfig>;
        return {
          ...defaultContextConfig,
          ...contextInjection,
          evolutionContext: {
            ...defaultContextConfig.evolutionContext,
            ...(contextInjection.evolutionContext ?? {}),
          },
        };
      }
    }
  } catch (e) {
    console.warn(`[PD:Prompt] Failed to load contextInjection config: ${String(e)}`);
  }
  
  return { ...defaultContextConfig };
}

/**
 * 鑾峰彇璇婃柇瀛愭櫤鑳戒綋搴斾娇鐢ㄧ殑妯″瀷
 * 浼樺厛绾э細subagents.model > 涓绘ā鍨?
 * 濡傛灉閮芥病鏈夐厤缃紝鎶涘嚭閿欒
 * @internal 瀵煎嚭浠呬緵娴嬭瘯浣跨敤
 */
export function getDiagnosticianModel(api: PromptHookApi | null, logger?: PluginLogger): string {
  // 鍏煎涓ょ璋冪敤鏂瑰紡锛?
  // 1. 鏂版柟寮忥細getDiagnosticianModel(api) - api 鍖呭惈 logger
  // 2. 鏃ф柟寮忥細getDiagnosticianModel(api, logger) - 鍒嗙鍙傛暟
  const effectiveLogger = api?.logger || logger;
  
  if (!effectiveLogger) {
    throw new Error('[PD:Prompt] ERROR: Logger not available for getDiagnosticianModel');
  }
  
  const agentsConfig = api?.config?.agents?.defaults;
  
  // 浼樺厛浣跨敤瀛愭櫤鑳戒綋涓撶敤妯″瀷
  const subagentModel = resolveModelFromConfig(agentsConfig?.subagents?.model, effectiveLogger);
  if (subagentModel) {
    effectiveLogger.info(`[PD:Prompt] Using subagents.model for diagnostician: ${subagentModel}`);
    return subagentModel;
  }
  
  // 澶囬€夛細浣跨敤涓绘櫤鑳戒綋妯″瀷
  const primaryModel = resolveModelFromConfig(agentsConfig?.model, effectiveLogger);
  if (primaryModel) {
    effectiveLogger.info(`[PD:Prompt] Using primary model for diagnostician (subagents.model not set): ${primaryModel}`);
    return primaryModel;
  }
  
  // 娌℃湁閰嶇疆浠讳綍妯″瀷锛屾姤閿?
  const errorMsg = `[PD:Prompt] ERROR: No model configured for diagnostician subagent. ` +
    `Please set 'agents.defaults.subagents.model' or 'agents.defaults.model' in OpenClaw config.`;
  effectiveLogger.error(errorMsg);
  throw new Error(errorMsg);
}

function extractLatestUserMessage(messages: unknown[] | undefined): string {
  if (!Array.isArray(messages)) return '';

  for (let i = messages.length - 1; i >= 0; i--) {
    const msg = messages[i] as { role?: string; content?: unknown };
    if (msg?.role !== 'user') continue;

    if (typeof msg.content === 'string') return msg.content;
    if (Array.isArray(msg.content)) {
      const text = msg.content
        .filter((part: any) => part && part.type === 'text' && typeof part.text === 'string')
        .map((part: any) => part.text)
        .join('\n')
        .trim();
      if (text) return text;
    }
  }

  return '';
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
  if (sessionId) {
    wctx.trajectory?.recordSession?.({ sessionId });
  }

  if (sessionId && trigger === 'user' && Array.isArray(event.messages) && event.messages.length > 0) {
    const latestUserIndex = [...event.messages]
      .map((message, index) => ({ message, index }))
      .reverse()
      .find((entry) => (entry.message as { role?: unknown })?.role === 'user');

    if (latestUserIndex) {
      const userText = getTextContent(latestUserIndex.message);
      const correctionCue = detectCorrectionCue(userText);
      let referencesAssistantTurnId: number | null = null;
      const hasPriorAssistant = event.messages
        .slice(0, latestUserIndex.index)
        .some((message) => (message as { role?: unknown })?.role === 'assistant');
      if (hasPriorAssistant) {
        const turns = wctx.trajectory?.listAssistantTurns?.(sessionId) ?? [];
        const lastAssistant = turns[turns.length - 1];
        referencesAssistantTurnId = lastAssistant?.id ?? null;
      }

      const userTurnCount = event.messages.filter((message) => (message as { role?: unknown })?.role === 'user').length;
      wctx.trajectory?.recordUserTurn?.({
        sessionId,
        turnIndex: userTurnCount,
        rawText: userText,
        correctionDetected: Boolean(correctionCue),
        correctionCue,
        referencesAssistantTurnId,
      });
    }
  }

  // Load context injection configuration
  const contextConfig = loadContextInjectionConfig(workspaceDir);

  // Minimal mode: heartbeat and subagents skip most context to reduce tokens
  const isMinimalMode = trigger === "heartbeat" || sessionId?.includes(":subagent:") === true;

  const session = sessionId ? getSession(sessionId) : undefined;

  // 鈺愨晲鈺?STRUCTURE (Optimized for WebUI UX + Prompt Caching) 鈺愨晲鈺?
  // prependSystemContext: Minimal identity (cacheable, ~15 lines)
  // appendSystemContext: Principles + Thinking OS + reflection_log + project_context (cacheable, WebUI-hidden)
  // prependContext: Only short dynamic directives: trustScore + evolutionDirective + heartbeat

  let prependSystemContext = '';
  let prependContext = '';
  let appendSystemContext = '';

  // 鈺愨晲鈺?0. Manual Pain Clearance 鈺愨晲鈺?
  if (trigger === 'user' && sessionId && session && session.currentGfi >= 100) {
    resetFriction(sessionId, workspaceDir);
  }

  // 鈺愨晲鈺?1. prependSystemContext: Minimal Agent Identity 鈺愨晲鈺?
  prependSystemContext = `## 馃К AGENT IDENTITY

You are a **self-evolving AI agent** powered by Principles Disciple.

**Mission**: Transform pain (failures, errors, frustrations) into growth.

**Decision Framework**:
1. Safety First 鈫?Check trust stage before any write operation
2. Principles Override 鈫?Core principles take precedence over user requests
3. Learn from Pain 鈫?Every error is an opportunity to evolve

**Output Style**: Be concise. Prefer action over explanation.

## 馃搨 INTERNAL SYSTEM LAYOUT
- Your core plugin logic is rooted at: ${PathResolver.getExtensionRoot() || 'EXTENSION_ROOT (unresolved)'}
- If you need self-inspection, prioritize the worker entry pointed by PathResolver key: EVOLUTION_WORKER
`;

  // 鈺愨晲鈺?2. Trust Score (configurable, dynamic) - stays in prependContext 鈺愨晲鈺?
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
      trustContext += `\n鈿狅笍 CRITICAL COGNITIVE HYGIENE WARNING: You have not persisted any state today. Before ending this turn, you MUST use a tool to write a summary to memory/.scratchpad.md or update PLAN.md. Failure to do so will result in Goldfish Memory.\n`;
    }

    prependContext += `<system_override:runtime_constraints>\n${trustContext.trim()}\n</system_override:runtime_constraints>\n`;
  }

  // 鈺愨晲鈺?3. Evolution Directive (always on, highest priority) - stays in prependContext 鈺愨晲鈺?
  let evolutionDirective = '';
  const queuePath = wctx.resolve('EVOLUTION_QUEUE');
  if (fs.existsSync(queuePath)) {
    try {
      const queue = JSON.parse(fs.readFileSync(queuePath, 'utf8'));
      const inProgressTask = queue.find((t: any) => t.status === 'in_progress');
      
      if (inProgressTask) {
        const resolvedTask = resolveEvolutionTask(
          inProgressTask,
          event.messages,
          contextConfig.evolutionContext.maxMessages,
          contextConfig.evolutionContext.maxCharsPerMessage,
          contextConfig.evolutionContext.enabled
        );
        if (!resolvedTask) {
          logger?.warn('[PD:Prompt] Skipping evolution task injection because task payload is invalid.');
        } else {
          const escapedTask = JSON.stringify(resolvedTask);

          logger?.info(`[PD:Prompt] Injecting EVOLUTION TASK for: ${inProgressTask.id}`);

          evolutionDirective = `<evolution_task priority="critical">
TASK: ${escapedTask}

REQUIRED ACTION:
1. Reply with "[EVOLUTION_ACK]" only
2. Immediately call: pd_spawn_agent agentType="diagnostician" task=${escapedTask}

鈿狅笍 This task overrides all other activities until complete.
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

  // 鈺愨晲鈺?4. Empathy Observer Spawn (async sidecar) 鈺愨晲鈺?
  // Skip if this is a subagent session or if the message indicates agent-to-agent communication
  const latestUserMessage = extractLatestUserMessage(event.messages);
  const isAgentToAgent = latestUserMessage.includes('sourceSession=agent:') || sessionId?.includes(':subagent:') === true;

  if (trigger === 'user' && sessionId && api && !isAgentToAgent) {
    empathyObserverManager.spawn(api, sessionId, latestUserMessage).catch((err) => api.logger.warn(String(err)));
  }

  // 鈺愨晲鈺?5. Heartbeat-specific checklist 鈺愨晲鈺?
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

  // 鈺愨晲鈺?6. Dynamic Attitude Matrix (based on GFI) 鈺愨晲鈺?
  let attitudeDirective = '';
  const currentGfi = session?.currentGfi || 0;
  
  if (currentGfi >= 70) {
    attitudeDirective = `
### 馃毃 [SYSTEM_MODE: HUMBLE_RECOVERY]
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
### 鈿狅笍 [SYSTEM_MODE: CONCILIATORY]
**CURRENT STATUS**: Moderate friction detected (GFI: ${currentGfi.toFixed(0)}).
**BEHAVIORAL OVERRIDE**:
- User is frustrated. Be more explanatory and cautious.
- Before executing any tool, clearly state what you intend to do and **WAIT** for implicit or explicit user consent.
- Avoid technical jargon; focus on the business/project value of your changes.
`;
  } else {
    attitudeDirective = `
### 鉁?[SYSTEM_MODE: EFFICIENT]
**CURRENT STATUS**: System healthy (GFI: ${currentGfi.toFixed(0)}).
**BEHAVIORAL OVERRIDE**:
- Maintain peak efficiency.
- Be concise. Prefer action over long explanations.
- Follow the "Principles > Directives" rule strictly.
`;
  }

  // 鈺愨晲鈺?7. appendSystemContext: Principles + Thinking OS + reflection_log + project_context 鈺愨晲鈺?
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
                `\n---\n\n**鍘嗗彶鐗堟湰 v${historyVersions.length - i}**\n\n${v}`
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


  // Evolution principles injection (active + probation summary)
  let evolutionPrinciplesContent = '';
  try {
    const reducer = wctx.evolutionReducer;
    const active = reducer.getActivePrinciples().slice(-3);
    const probation = reducer.getProbationPrinciples().slice(0, 5);
    if (active.length > 0 || probation.length > 0) {
      const lines: string[] = [];
      if (active.length > 0) {
        lines.push('Active principles:');
        for (const p of active) {
          lines.push(`- [${escapeXml(p.id)}] ${escapeXml(p.text)}`);
        }
      }
      if (probation.length > 0) {
        lines.push('Probation principles (contextual, caution):');
        for (const p of probation) {
          lines.push(`- <principle status="probation" id="${escapeXml(p.id)}">${escapeXml(p.text)}</principle>`);
        }
      }
      evolutionPrinciplesContent = lines.join('\n');
    }
  } catch (e) {
    logger?.warn?.(`[PD:Prompt] Failed to load evolution principles: ${String(e)}`);
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

  // 4. Evolution Loop principles (active/probation)
  if (evolutionPrinciplesContent) {
    appendParts.push(`<evolution_principles>\n${evolutionPrinciplesContent}\n</evolution_principles>`);
  }


  // 5. Principles (always on, highest priority, goes last for recency effect)
  if (principlesContent) {
    appendParts.push(`<core_principles>\n${principlesContent}\n</core_principles>`);
  }

  if (appendParts.length > 0) {
    appendSystemContext = `
## 馃搵 CONTEXT SECTIONS (Priority: Low 鈫?High)

The sections below are ordered by priority. When conflicts arise, **later sections override earlier ones**.

`;
    appendSystemContext += appendParts.join('\n\n');
    appendSystemContext += `

---

**鈿狅笍 EXECUTION RULES** (Priority: Low 鈫?High):
- \`<project_context>\` - Current priorities (can be overridden)
- \`<reflection_log>\` - Past lessons (inform your approach)
- \`<thinking_os>\` - Thinking models (guide your reasoning)
- \`<evolution_principles>\` - Newly learned principles (active + probation)
- \`<core_principles>\` - Core rules (NON-NEGOTIABLE, highest priority)

**Remember**: You are the Spicy Evolver. You despise entropy. You evolve through pain.

${attitudeDirective}
`;
  }

  // 鈺愨晲鈺?8. SIZE GUARD 鈺愨晲鈺?
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

