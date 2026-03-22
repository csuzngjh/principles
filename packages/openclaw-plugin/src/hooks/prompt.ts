import * as fs from 'fs';
import * as path from 'path';
import type { PluginHookBeforePromptBuildEvent, PluginHookAgentContext, PluginHookBeforePromptBuildResult, PluginLogger } from '../openclaw-sdk.js';
import { clearInjectedProbationIds, getSession, resetFriction, setInjectedProbationIds } from '../core/session-tracker.js';
import { WorkspaceContext } from '../core/workspace-context.js';
import { ContextInjectionConfig, defaultContextConfig } from '../types.js';
import { extractSummary, getHistoryVersions } from '../core/focus-history.js';
import { empathyObserverManager, type EmpathyObserverApi } from '../service/empathy-observer-manager.js';
import { PathResolver } from '../core/path-resolver.js';

/**
 * 婵☆垪鈧磭鈧兘鏌婂鍥╂瀭閻庣數顢婇挅鍕冀閻撳海纭€
 */
interface ModelConfigObject {
  primary?: string;
  fallbacks?: string[];
}

/**
 * 濞寸媴绲块幃濠囨煀瀹ュ洨鏋傚☉鎿冨幘濞堟垵螣閳ュ磭鈧兘鎯勭粙鍨綘闂佹澘绉堕悿?
 */
interface AgentsModelConfig {
  model?: unknown;
  subagents?: {
    model?: unknown;
  };
}

/**
 * 濞寸媴绲块幃濠冾渶濡鍚囬梺鏉跨Ф閻?
 */
interface AgentsDefaultsConfig {
  model?: unknown;
  subagents?: {
    model?: unknown;
  };
}

/**
 * OpenClaw API 闁规亽鍎辫ぐ娑氣偓瑙勭煯缁犵喖鏁嶉崷顧竜mpt Hook 闁圭鍋撻梻鍥ｅ亾闂侇喓鍔岄崹搴ㄦ晬?
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
    .replace(/[.,!?;:，。！？；：]/g, '');
  const cues = [
    '不是这个',
    '不对',
    '错了',
    '搞错了',
    '理解错了',
    '你理解错了',
    '重新来',
    '再试一次',
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

  if (typeof inProgressTask.id !== 'string' || !inProgressTask.id.trim()) return null;

  const source = typeof inProgressTask.source === 'string' ? inProgressTask.source.trim() : 'unknown';
  const reason = typeof inProgressTask.reason === 'string' ? inProgressTask.reason.trim() : 'Systemic pain detected';
  const preview = typeof inProgressTask.trigger_text_preview === 'string' && inProgressTask.trigger_text_preview.trim()
    ? inProgressTask.trigger_text_preview.trim()
    : 'N/A';

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
 * 濡ょ姴鐭侀惁澶娢熼垾宕団偓椋庘偓娑欘殘椤戜焦绋夐崣澶屽鐎殿喖绻戝Σ鎼佸触閿旇儻绀?"provider/model"
 */
function isValidModelFormat(model: string): boolean {
  // 闁哄秶鍘х槐? "provider/model" 闁?"provider/model-variant"
  // provider: 閻庢稒顨嗛惁婵嬪极閺夎法鎽熼柛婊冪焷缁绘稓鈧稒顨堥渚€鏁嶇仦鑲╃憹闁艰櫕鍨濇禍鎺撴交閻愯尙鎽熺紒妤嬬畱缁辨垶寰?缂備焦鎸搁悢?
  // model: 閻庢稒顨嗛惁婵嬪极閺夎法鎽熼柕鍡曟祰缁绘稓鈧稒顨堥渚€濡存担鍝勪化闁告瑦鐏氶埀顑挎缁楀懘宕氶幒鏂挎疇
  const MODEL_PATTERN = /^[a-zA-Z0-9][a-zA-Z0-9-]*[a-zA-Z0-9]\/[a-zA-Z0-9._-]+$/;
  return MODEL_PATTERN.test(model);
}

/**
 * 濞?OpenClaw 闂佹澘绉堕悿鍡樼▔椤撯寬鎺楀几閹邦劷渚€宕圭€ｎ喒鍋撴径瀣仴
 * 闁衡偓椤栨稑鐦?string 闁?{ primary, fallbacks } 闁哄秶鍘х槐?
 * @internal 閻庣數鍘ч崵顓熺閸涱剛杩旀繛鏉戭儓閻︻垱鎷呯捄銊︽殢
 */
export function resolveModelFromConfig(modelConfig: unknown, logger?: PluginLogger): string | null {
  if (!modelConfig) return null;
  
  // 闁哄秶鍘х槐?1: "provider/model" 閻庢稒顨堥浣圭▔?
  if (typeof modelConfig === 'string') {
    const trimmed = modelConfig.trim();
    if (!trimmed) return null;
    if (!isValidModelFormat(trimmed)) {
      logger?.warn(`[PD:Prompt] Invalid model format: "${trimmed}". Expected "provider/model" format.`);
      return null;
    }
    return trimmed;
  }
  
  // 闁哄秶鍘х槐?2: { primary: "provider/model", fallbacks: [...] } 閻庣數顢婇挅?
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
  
  // 闁哄秶鍘х槐?3: 闁轰焦澹嗙划宥夊冀閻撳海纭€闁挎稑鐗呯粭澶愬绩椤栨稑鐦柨娑樿嫰瑜板倿宕欐ウ娆惧妳闁告稑顭槐?
  if (Array.isArray(modelConfig)) {
    console.warn(`[PD:Prompt] Array model config not supported. Expected "provider/model" string or { primary: "..." } object.`);
    logger?.warn(`[PD:Prompt] Array model config not supported. Expected "provider/model" string or { primary: "..." } object.`);
    return null;
  }
  
  return null;
}

/**
 * 闁告梻濮惧ù鍥ㄧ▔婵犱胶鐟撻柡鍌氭处閺佺偤宕楅妷鈺佸赋缂?
 * 濞?PROFILE.json 閻犲洩顕цぐ?contextInjection 闂佹澘绉堕悿鍡涙晬鐏炵瓔娲ら柡瀣矆缁楀鈧稒锚濠€顏堝礆濞嗘帞绠查柛銉у仱缁垳鎷嬮妶澶婂赋缂?
 * @internal 閻庣數鍘ч崵顓熺瑹濞戞ê寰撳ù鐘崇墬鑶╅柛褎銇炴繛鍥偨?
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
 * 闁兼儳鍢茶ぐ鍥╂嫚婵犲啯鐒介悗娑欏姈濞呫倝鎳楅幋鎺旂Ъ閹煎瓨鏌ф繛鍥偨閵娧勭暠婵☆垪鈧磭鈧?
 * 濞村吋锚閸樻稓鐥缁辩殜ubagents.model > 濞戞挾绮啯闁?
 * 濠碘€冲€归悘澶愭焾閼恒儳姊鹃柡鍫濐樀閸樸倗绱旈鍡欑闁硅埖绋戦崵顓㈡煥濞嗘帩鍤?
 * @internal 閻庣數鍘ч崵顓熺閸涱剛杩旀繛鏉戭儓閻︻垱鎷呯捄銊︽殢
 */
export function getDiagnosticianModel(api: PromptHookApi | null, logger?: PluginLogger): string {
  // 闁稿繒鍘ч鎰▔閵堝浂娼氶悹瀣暟閺併倝寮悷鎵闁?
  // 1. 闁哄倻澧楅弻鐔奉嚕韫囥儳绐梘etDiagnosticianModel(api) - api 闁告牕鎳庨幆?logger
  // 2. 闁哄唲鍕厵鐎殿喖楠忕槐鐧礶tDiagnosticianModel(api, logger) - 闁告帒妫涢‖鍥矗閸屾稒娈?
  const effectiveLogger = api?.logger || logger;
  
  if (!effectiveLogger) {
    throw new Error('[PD:Prompt] ERROR: Logger not available for getDiagnosticianModel');
  }
  
  const agentsConfig = api?.config?.agents?.defaults;
  
  // 濞村吋锚閸樻稒鎷呯捄銊︽殢閻庢稒鍔栧▍銈夋嚄閹存帞绉煎☉鎾存尵閺併倕螣閳ュ磭鈧?
  const subagentModel = resolveModelFromConfig(agentsConfig?.subagents?.model, effectiveLogger);
  if (subagentModel) {
    effectiveLogger.info(`[PD:Prompt] Using subagents.model for diagnostician: ${subagentModel}`);
    return subagentModel;
  }
  
  // 濠㈣泛娲埀顒€顧€缁辩増鎷呯捄銊︽殢濞戞挾绮▍銈夋嚄閹存帞绉兼俊顖椻偓宕団偓?
  const primaryModel = resolveModelFromConfig(agentsConfig?.model, effectiveLogger);
  if (primaryModel) {
    effectiveLogger.info(`[PD:Prompt] Using primary model for diagnostician (subagents.model not set): ${primaryModel}`);
    return primaryModel;
  }
  
  // 婵炲备鍓濆﹢渚€鏌婂鍥╂瀭濞寸姾顔婄紞宥呂熼垾宕団偓鐑芥晬鐏炴儳袚闂?
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

  // 闁崇儤鍔忛弲鏌ュ煛?STRUCTURE (Optimized for WebUI UX + Prompt Caching) 闁崇儤鍔忛弲鏌ュ煛?
  // prependSystemContext: Minimal identity (cacheable, ~15 lines)
  // appendSystemContext: Principles + Thinking OS + reflection_log + project_context (cacheable, WebUI-hidden)
  // prependContext: Only short dynamic directives: trustScore + evolutionDirective + heartbeat

  let prependSystemContext = '';
  let prependContext = '';
  let appendSystemContext = '';

  // 闁崇儤鍔忛弲鏌ュ煛?0. Manual Pain Clearance 闁崇儤鍔忛弲鏌ュ煛?
  if (trigger === 'user' && sessionId && session && session.currentGfi >= 100) {
    resetFriction(sessionId, workspaceDir);
  }

  // 闁崇儤鍔忛弲鏌ュ煛?1. prependSystemContext: Minimal Agent Identity 闁崇儤鍔忛弲鏌ュ煛?
  prependSystemContext = `## 妫ｅ唭?AGENT IDENTITY

You are a **self-evolving AI agent** powered by Principles Disciple.

**Mission**: Transform pain (failures, errors, frustrations) into growth.

**Decision Framework**:
1. Safety First 闁?Check trust stage before any write operation
2. Principles Override 闁?Core principles take precedence over user requests
3. Learn from Pain 闁?Every error is an opportunity to evolve

**Output Style**: Be concise. Prefer action over explanation.

**Tool Routing Rules**:
- Use the current session for the normal user reply.
- Use sessions_send for cross-session messaging.
- Use agents_list / sessions_list / sessions_spawn for peer-agent or session orchestration.
- Use pd_run_worker only for Principles Disciple internal workers such as diagnostician/explorer.

## 妫ｅ啯鎯?INTERNAL SYSTEM LAYOUT
- Your core plugin logic is rooted at: ${PathResolver.getExtensionRoot() || 'EXTENSION_ROOT (unresolved)'}
- If you need self-inspection, prioritize the worker entry pointed by PathResolver key: EVOLUTION_WORKER
`;

  // 闁崇儤鍔忛弲鏌ュ煛?2. Trust Score (configurable, dynamic) - stays in prependContext 闁崇儤鍔忛弲鏌ュ煛?
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
      trustContext += `ACTION CONSTRAINT: You are in READ-ONLY MODE. You MUST use the internal pd_run_worker diagnostician worker to recover trust before writing files. Do not use it for peer-session messaging.\n`;
    } else if (safeStage === 2) {
      trustContext += `ACTION CONSTRAINT: LIMITED MODE. You are restricted to a maximum of 50 lines per edit.\n`;
    } else if (safeStage === 3 || safeStage === 4) {
      trustContext += `ACTION CONSTRAINT: If your task involves modifying risk paths, you MUST verify that a READY plan exists in PLAN.md before taking action.\n`;
    }

    if (hygiene.persistenceCount === 0 && trigger === 'user') {
      trustContext += `\n闁宠法濯寸粭?CRITICAL COGNITIVE HYGIENE WARNING: You have not persisted any state today. Before ending this turn, you MUST use a tool to write a summary to memory/.scratchpad.md or update PLAN.md. Failure to do so will result in Goldfish Memory.\n`;
    }

    prependContext += `<system_override:runtime_constraints>\n${trustContext.trim()}\n</system_override:runtime_constraints>\n`;
  }

  // 闁崇儤鍔忛弲鏌ュ煛?3. Evolution Directive (always on, highest priority) - stays in prependContext 闁崇儤鍔忛弲鏌ュ煛?
  let evolutionDirective = '';
  const queuePath = wctx.resolve('EVOLUTION_QUEUE');
  if (fs.existsSync(queuePath)) {
    try {
      const queue = JSON.parse(fs.readFileSync(queuePath, 'utf8'));
      const inProgressTasks = [...queue]
        .filter((t: any) => t.status === 'in_progress')
        .sort((a: any, b: any) => {
          const scoreA = Number.isFinite(a?.score) ? Number(a.score) : 0;
          const scoreB = Number.isFinite(b?.score) ? Number(b.score) : 0;
          return scoreB - scoreA;
        });

      for (const inProgressTask of inProgressTasks) {
        const resolvedTask = resolveEvolutionTask(
          inProgressTask,
          event.messages,
          contextConfig.evolutionContext.maxMessages,
          contextConfig.evolutionContext.maxCharsPerMessage,
          contextConfig.evolutionContext.enabled
        );
        if (!resolvedTask) {
          continue;
        }

        const escapedTask = JSON.stringify(resolvedTask);

        logger?.info(`[PD:Prompt] Injecting EVOLUTION TASK for: ${inProgressTask.id}`);

        if (trigger === 'user') {
          evolutionDirective = `<evolution_task priority="high">
TASK: ${escapedTask}

REQUIRED ACTION:
- First respond to the user's current request normally.
- After finishing the user-facing response, call:
  pd_run_worker agentType="diagnostician" task=${escapedTask} runInBackground=true
- Treat pd_run_worker as an internal Principles Disciple worker, not a peer-session messaging tool.
- Do NOT reply with "[EVOLUTION_ACK]".
- Do NOT let this task interrupt the current user interaction.
</evolution_task>\n`;
        } else {
          evolutionDirective = `<evolution_task priority="critical">
TASK: ${escapedTask}

REQUIRED ACTION:
- Start diagnostics immediately by calling:
  pd_run_worker agentType="diagnostician" task=${escapedTask} runInBackground=true
- Treat pd_run_worker as an internal Principles Disciple worker, not a peer-session messaging tool.
- Do NOT reply with "[EVOLUTION_ACK]".
</evolution_task>\n`;
        }

        break;
      }

      if (!evolutionDirective && inProgressTasks.length > 0) {
        logger?.warn('[PD:Prompt] Skipping evolution task injection because task payload is invalid.');
      }
    } catch (e) {
      logger?.error(`[PD:Prompt] Failed to parse EVOLUTION_QUEUE: ${String(e)}`);
    }
  }

  // Inject queue-derived evolution task at the front of prependContext
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

  // 闁崇儤鍔忛弲鏌ュ煛?5. Heartbeat-specific checklist 闁崇儤鍔忛弲鏌ュ煛?
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

  // 闁崇儤鍔忛弲鏌ュ煛?6. Dynamic Attitude Matrix (based on GFI) 闁崇儤鍔忛弲鏌ュ煛?
  let attitudeDirective = '';
  const currentGfi = session?.currentGfi || 0;
  
  if (currentGfi >= 70) {
    attitudeDirective = `
### 妫ｅ啯鐦?[SYSTEM_MODE: HUMBLE_RECOVERY]
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
### 闁宠法濯寸粭?[SYSTEM_MODE: CONCILIATORY]
**CURRENT STATUS**: Moderate friction detected (GFI: ${currentGfi.toFixed(0)}).
**BEHAVIORAL OVERRIDE**:
- User is frustrated. Be more explanatory and cautious.
- Before executing any tool, clearly state what you intend to do and **WAIT** for implicit or explicit user consent.
- Avoid technical jargon; focus on the business/project value of your changes.
`;
  } else {
    attitudeDirective = `
### 闁?[SYSTEM_MODE: EFFICIENT]
**CURRENT STATUS**: System healthy (GFI: ${currentGfi.toFixed(0)}).
**BEHAVIORAL OVERRIDE**:
- Maintain peak efficiency.
- Be concise. Prefer action over long explanations.
- Follow the "Principles > Directives" rule strictly.
`;
  }

  // 闁崇儤鍔忛弲鏌ュ煛?7. appendSystemContext: Principles + Thinking OS + reflection_log + project_context 闁崇儤鍔忛弲鏌ュ煛?
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
                `\n---\n\n**闁告ê妫楄ぐ鍫曟偋閸喐鎷?v${historyVersions.length - i}**\n\n${v}`
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
    if (ctx.sessionId) {
      if (probation.length > 0) {
        setInjectedProbationIds(ctx.sessionId, probation.map((p) => p.id), workspaceDir);
      } else {
        clearInjectedProbationIds(ctx.sessionId, workspaceDir);
      }
    }
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
    if (ctx.sessionId) {
      clearInjectedProbationIds(ctx.sessionId, workspaceDir);
    }
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
## 妫ｅ啯鎯?CONTEXT SECTIONS (Priority: Low 闁?High)

The sections below are ordered by priority. When conflicts arise, **later sections override earlier ones**.

`;
    appendSystemContext += appendParts.join('\n\n');
    appendSystemContext += `

---

**闁宠法濯寸粭?EXECUTION RULES** (Priority: Low 闁?High):
- \`<project_context>\` - Current priorities (can be overridden)
- \`<reflection_log>\` - Past lessons (inform your approach)
- \`<thinking_os>\` - Thinking models (guide your reasoning)
- \`<evolution_principles>\` - Newly learned principles (active + probation)
- \`<core_principles>\` - Core rules (NON-NEGOTIABLE, highest priority)

**Remember**: You are the Spicy Evolver. You despise entropy. You evolve through pain.

${attitudeDirective}
`;
  }

  // 闁崇儤鍔忛弲鏌ュ煛?8. SIZE GUARD 闁崇儤鍔忛弲鏌ュ煛?
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

