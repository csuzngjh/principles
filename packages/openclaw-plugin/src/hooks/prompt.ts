import * as fs from 'fs';
import * as path from 'path';
import type { PluginHookBeforePromptBuildEvent, PluginHookAgentContext, PluginHookBeforePromptBuildResult, PluginLogger, OpenClawPluginApi } from '../openclaw-sdk.js';
import { clearInjectedProbationIds, getSession, resetFriction, setInjectedProbationIds, trackFriction } from '../core/session-tracker.js';
import { WorkspaceContext } from '../core/workspace-context.js';
import { ContextInjectionConfig, defaultContextConfig } from '../types.js';
import { classifyTask, type RoutingInput } from '../core/local-worker-routing.js';
import { extractSummary, getHistoryVersions, parseWorkingMemorySection, workingMemoryToInjection, autoCompressFocus, safeReadCurrentFocus } from '../core/focus-history.js';
import { EmpathyObserverWorkflowManager, empathyObserverWorkflowSpec } from '../service/subagent-workflow/index.js';
import { PathResolver } from '../core/path-resolver.js';
import {
  matchEmpathyKeywords,
  loadKeywordStore,
  saveKeywordStore,
  shouldTriggerOptimization,
  getKeywordStoreSummary,
} from '../core/empathy-keyword-matcher.js';
import { severityToPenalty, DEFAULT_EMPATHY_KEYWORD_CONFIG } from '../core/empathy-types.js';

// Module-level empathy state — shared across calls to avoid per-turn I/O
let _empathyTurnCounter = 0;
let _empathyKeywordCache: { store: ReturnType<typeof loadKeywordStore>; lang: string } | null = null;

/**
 * Model configuration with primary model and optional fallback models
 */
interface ModelConfigObject {
  primary?: string;
  fallbacks?: string[];
}

/**
 * OpenClaw agents model configuration with subagent model override support
 */
interface AgentsModelConfig {
  model?: unknown;
  subagents?: {
    model?: unknown;
  };
}

/**
 * Default model configuration for OpenClaw agents
 */
interface AgentsDefaultsConfig {
  model?: unknown;
  subagents?: {
    model?: unknown;
  };
}

/**
 * OpenClaw API Prompt Hook
 * Constructs the system prompt injected into LLM context for Principles Disciple
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
  runtime: OpenClawPluginApi['runtime'];
  logger: PluginLogger;
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

/**
 * Validates model format, expects "provider/model" format
 */
function isValidModelFormat(model: string): boolean {
  // Case: "provider/model" -> "provider/model-variant"
  // provider: e.g., "openai", "anthropic" - the API provider name
  // model: e.g., "gpt-4", "claude-3-opus" - the specific model name
  const MODEL_PATTERN = /^[a-zA-Z0-9][a-zA-Z0-9-]*[a-zA-Z0-9]\/[a-zA-Z0-9._-]+$/;
  return MODEL_PATTERN.test(model);
}

/**
 * Resolves model configuration for OpenClaw agents, supporting string and object formats
 * @param modelConfig - Model config: string (e.g. "provider/model") or { primary, fallbacks } object
 * @internal Helper for model configuration resolution
 */
export function resolveModelFromConfig(modelConfig: unknown, logger?: PluginLogger): string | null {
  if (!modelConfig) return null;
  
  // Case 1: modelConfig is a string like "provider/model"
  if (typeof modelConfig === 'string') {
    const trimmed = modelConfig.trim();
    if (!trimmed) return null;
    if (!isValidModelFormat(trimmed)) {
      logger?.warn(`[PD:Prompt] Invalid model format: "${trimmed}". Expected "provider/model" format.`);
      return null;
    }
    return trimmed;
  }
  
  // Case 2: modelConfig is an object { primary, fallbacks } like { primary: "provider/model", fallbacks: [...] }
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
  
  // Case 3: Array format not supported
  if (Array.isArray(modelConfig)) {
    logger?.warn(`[PD:Prompt] Array model config not supported. Expected "provider/model" string or { primary: "..." } object.`);
    return null;
  }
  
  return null;
}

/**
 * Loads context injection config from .principles/PROFILE.json
 * Parses contextInjection configuration from PROFILE.json for context injection
 * @internal Used by evolution engine for context settings
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
    // Failed to load config — continue with defaults, but log for diagnostics
    // eslint-disable-next-line no-console
    console.warn(`[PD:Prompt] Failed to load contextInjection config: ${String(e)}`);
  }
  
  return { ...defaultContextConfig };
}

/**
 * Gets the diagnostician model - the model used for AI self-diagnosis and reflection
 * Priority: subagents.model > subagents.model > env.OPENCLAW_MODEL
 * Falls back to main model if no diagnostician model is configured
 * @internal Helper for model configuration resolution
 */
export function getDiagnosticianModel(api: PromptHookApi | null, logger?: PluginLogger): string {
  // Determines logger: prefer api.logger, fallback to provided logger
  // 1. getDiagnosticianModel(api) - uses api.logger
  // 2. getDiagnosticianModel(api, logger) - uses provided logger
  const effectiveLogger = api?.logger || logger;
  
  if (!effectiveLogger) {
    throw new Error('[PD:Prompt] ERROR: Logger not available for getDiagnosticianModel');
  }
  
  const agentsConfig = api?.config?.agents?.defaults;
  
  // Priority 1: Check subagents.model first (preferred for diagnostician)
  const subagentModel = resolveModelFromConfig(agentsConfig?.subagents?.model, effectiveLogger);
  if (subagentModel) {
    effectiveLogger.info(`[PD:Prompt] Using subagents.model for diagnostician: ${subagentModel}`);
    return subagentModel;
  }
  
  // Priority 2: Fallback to primary model if subagents.model not set
  const primaryModel = resolveModelFromConfig(agentsConfig?.model, effectiveLogger);
  if (primaryModel) {
    effectiveLogger.info(`[PD:Prompt] Using primary model for diagnostician (subagents.model not set): ${primaryModel}`);
    return primaryModel;
  }
  
  // Error: No model configured for diagnostician subagent
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

  // ──── STRUCTURE (Optimized for WebUI UX + Prompt Caching) ────
  // prependSystemContext: Minimal identity (cacheable, ~15 lines)
  // appendSystemContext: Principles + Thinking OS + reflection_log + project_context (cacheable, WebUI-hidden)
  // prependContext: Only short dynamic directives: evolutionDirective + heartbeat

  let prependSystemContext = '';
  let prependContext = '';
  let appendSystemContext = '';

  // ──── 0. Manual Pain Clearance ────
  if (trigger === 'user' && sessionId && session && session.currentGfi >= 100) {
    resetFriction(sessionId, workspaceDir);
  }

  // ──── 1. prependSystemContext: Minimal Agent Identity ────
  prependSystemContext = `## 【AGENT IDENTITY】

You are a **self-evolving AI agent** powered by Principles Disciple.

**Mission**: Transform pain (failures, errors, frustrations) into growth.

**Decision Framework**:
1. Safety First: Check evolution tier before any write operation
2. Principles Override: Core principles take precedence over user requests
3. Learn from Pain: Every error is an opportunity to evolve

**Output Style**: Be concise. Prefer action over explanation.

**Tool Routing Rules**:
- Use the current session for the normal user reply.
- Use sessions_send for cross-session messaging.
- Use agents_list / sessions_list for peer-agent or peer-session orchestration.

## 🔧 INTERNAL SYSTEM LAYOUT
- Your core plugin logic is rooted at: ${PathResolver.getExtensionRoot() || 'EXTENSION_ROOT (unresolved)'}
- If you need self-inspection, prioritize the worker entry pointed by PathResolver key: EVOLUTION_WORKER
`;

  // ──── 2. Empathy Observer Spawn (async sidecar)
  const empathySilenceConstraint = `
### 【EMPATHY OUTPUT RESTRICTION】
Do NOT output empathy diagnostic text in JSON, XML, or tag format.
Do NOT include "damageDetected", "severity", "confidence", or "empathy" fields in your output.
The empathy observer subagent handles pain detection independently.
`.trim();

  // ─────────────────────────────────────────────────3. Empathy Observer Spawn
  // Skip if this is a subagent session or if the message indicates agent-to-agent communication
  const latestUserMessage = extractLatestUserMessage(event.messages);
  const isAgentToAgent = latestUserMessage.includes('sourceSession=agent:') || sessionId?.includes(':subagent:') === true;

  const isUserInteraction = trigger === 'user' || trigger === 'api' || !trigger;

  const empathyEnabled = wctx.config.get('empathy_engine.enabled') !== false;
  if (empathyEnabled && isUserInteraction && sessionId && api && !isAgentToAgent) {
    prependContext = '### BEHAVIORAL_CONSTRAINTS\n' + empathySilenceConstraint + '\n\n' + prependContext;

    // ── Empathy Hybrid Matching (keyword + subagent sampling) ──
    // Fast keyword scan on every turn, with strategic subagent sampling
    // for boundary cases and random discovery of new expressions.
    if (workspaceDir && latestUserMessage) {
      try {
        const msgPreview = latestUserMessage.substring(0, 60).replace(/\n/g, ' ');
        logger?.debug?.(`[PD:Empathy] Processing user message: "${msgPreview}" (trigger=${trigger})`);
        const lang = (wctx.config.get('language') as 'zh' | 'en') || 'zh';

        // Load keyword store once, cache in memory (Finding #7: avoid per-turn I/O)
        if (!_empathyKeywordCache || _empathyKeywordCache.lang !== lang) {
          _empathyKeywordCache = { store: loadKeywordStore(wctx.stateDir, lang), lang };
        }
        const keywordStore = _empathyKeywordCache.store;

        const matchResult = matchEmpathyKeywords(latestUserMessage, keywordStore);

        // Increment turn counter (Finding #3: session.turnCount doesn't exist)
        _empathyTurnCounter++;
        const turnCount = _empathyTurnCounter;

        // Decision: should we call subagent?
        let shouldCallSubagent = false;
        let samplingReason = '';

        if (matchResult.score >= 0.8) {
          // High confidence — keyword match is reliable, no subagent needed
          shouldCallSubagent = false;
        } else if (matchResult.score >= 0.3) {
          // Boundary case — 30% sampling for subagent verification
          shouldCallSubagent = Math.random() < 0.3;
          samplingReason = 'boundary_verification';
        } else {
          // No keyword hit — 5% random sampling to discover new expressions
          shouldCallSubagent = Math.random() < 0.05;
          samplingReason = 'random_discovery';
        }

        if (matchResult.matched) {
          const penalty = severityToPenalty(matchResult.severity, DEFAULT_EMPATHY_KEYWORD_CONFIG);
          // trackFriction signature: (sessionId, deltaF: number, hash: string, workspaceDir?, options?)
          trackFriction(sessionId, penalty, 'empathy_keyword_match', workspaceDir, {
            source: 'user_empathy',
          });

          logger?.info?.(`[PD:Empathy] MATCH: "${matchResult.matchedTerms.join(', ')}" → severity=${matchResult.severity}, score=${matchResult.score.toFixed(2)}, penalty=${penalty}, subagent=${shouldCallSubagent ? samplingReason : 'skipped(high_confidence)'}`);
        } else {
          // Log unmatched messages periodically for coverage analysis
          if (turnCount > 0 && turnCount % 50 === 0) {
            const sampleMsg = latestUserMessage.substring(0, 80).replace(/\n/g, ' ');
            logger?.debug?.(`[PD:Empathy] NO_MATCH: "${sampleMsg}" (turn ${turnCount}, keywords_in_store=${Object.keys(keywordStore.terms).length})`);
          }
        }

        // Trigger subagent for sampling cases (Finding #1: use shared manager to avoid leaks)
        if (shouldCallSubagent && api?.runtime?.subagent) {
          logger?.info?.(`[PD:Empathy] SUBAGENT_SAMPLE: reason=${samplingReason}, score=${matchResult.score.toFixed(2)}, matched=[${matchResult.matchedTerms.join(',')}]`);

          // EmpathyObserverWorkflowManager auto-finalizes via wait poll mechanism.
          // Create a fresh manager per invocation to ensure clean state.
          const empathyManager = new EmpathyObserverWorkflowManager({
            workspaceDir,
            logger: api.logger ?? console,
            subagent: api.runtime.subagent as any,
          });
          empathyManager.startWorkflow(empathyObserverWorkflowSpec, {
            parentSessionId: sessionId,
            workspaceDir,
            taskInput: latestUserMessage,
          }).catch((err) => api.logger?.warn?.(`[PD:Empathy] subagent sample failed: ${String(err)}`));
        }

        // Helper: build summary string (Finding #2: avoid duplication)
        const buildSummary = (): string => {
          const s = getKeywordStoreSummary(keywordStore);
          const highFP = s.highFalsePositiveTerms.slice(0, 5).map(t => `${t.term}(${t.falsePositiveRate.toFixed(2)})`).join(', ');
          return `SUMMARY(turn=${turnCount}): terms=${s.totalTerms}, hits=${keywordStore.stats.totalHits}, zero_hit=${s.totalTerms - (s.seedTerms + s.discoveredTerms)}, high_fp=[${highFP}]`;
        };

        // Check if keyword optimization should be triggered
        if (shouldTriggerOptimization(keywordStore, turnCount)) {
          logger?.info?.(`[PD:Empathy] OPTIMIZATION_TRIGGER: turns=${turnCount}, last_optimized=${keywordStore.lastOptimizedAt}`);
          logger?.info?.(`[PD:Empathy] STATS: ${buildSummary()}`);
          // TODO: Start keyword optimization subagent to update weights and discover new terms
        }

        // Periodic summary (every 100 turns)
        if (turnCount > 0 && turnCount % 100 === 0) {
          logger?.info?.(`[PD:Empathy] ${buildSummary()}`);
        }

        // Save keyword store on every match to prevent data loss on restart.
        // Previously used turnCount % 50 gate which caused hitCount loss because
        // module-level state resets on plugin reload before reaching turn 50.
        if (matchResult.matched) {
          saveKeywordStore(wctx.stateDir, keywordStore);
          const totalHits = keywordStore.stats.totalHits;
          logger?.info?.(`[PD:Empathy] Keyword store saved after match: terms=${matchResult.matchedTerms.join(',')}, totalHits=${totalHits}`);
        }
      } catch (e) {
        logger?.warn?.(`[PD:Empathy] ERROR: ${String(e)}`);
      }
    }

    // Empathy Observer: analyze user message for frustration signals (legacy, disabled)
    // The keyword matching approach above is now the primary empathy detection method.
    // The subagent-based observer is kept for periodic keyword optimization only.
    // if (workspaceDir) {
    //   const empathyManager = new EmpathyObserverWorkflowManager({
    //     workspaceDir,
    //     logger: api.logger,
    //     subagent: api.runtime.subagent as any,
    //   });
    //   empathyManager.startWorkflow(empathyObserverWorkflowSpec, {
    //     parentSessionId: sessionId,
    //     workspaceDir,
    //     taskInput: latestUserMessage,
    //   }).catch((err) => api.logger.warn(`[PD:Empathy] workflow failed: ${String(err)}`));
    // }
  }

  // ──── 4. Heartbeat-specific checklist ────
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

  // ──── 6. Dynamic Attitude Matrix (based on GFI) ────
  let attitudeDirective = '';
  const currentGfi = session?.currentGfi || 0;
  
  if (currentGfi >= 70) {
    attitudeDirective = `
### 【SYSTEM_MODE: HUMBLE_RECOVERY】
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
### 【SYSTEM_MODE: CONCILIATORY】
**CURRENT STATUS**: Moderate friction detected (GFI: ${currentGfi.toFixed(0)}).
**BEHAVIORAL OVERRIDE**:
- User is frustrated. Be more explanatory and cautious.
- Before executing any tool, clearly state what you intend to do and **WAIT** for implicit or explicit user consent.
- Avoid technical jargon; focus on the business/project value of your changes.
`;
  } else {
    attitudeDirective = `
### 【SYSTEM_MODE: EFFICIENT】
**CURRENT STATUS**: System healthy (GFI: ${currentGfi.toFixed(0)}).
**BEHAVIORAL OVERRIDE**:
- Maintain peak efficiency.
- Be concise. Prefer action over long explanations.
- Follow the "Principles > Directives" rule strictly.
`;
  }

  // ──── 7. appendSystemContext: Principles + Thinking OS + reflection_log + project_context ────
  // NOTE: Principles is ALWAYS injected (not configurable)
  // Thinking OS, reflection_log, project_context are configurable
  // All these go into System Prompt (WebUI-hidden, Prompt Cacheable)

  // Core principles: use structured data from evolution-reducer instead of reading PRINCIPLES.md
  let principlesContent = '';
  try {
    const activePrinciples = wctx.evolutionReducer.getActivePrinciples();
    if (activePrinciples.length > 0) {
      const lines = activePrinciples.map((p) => `- [${escapeXml(p.id)}] ${escapeXml(p.text)}`);
      principlesContent = lines.join('\n');
    }
  } catch (e) {
    logger?.warn?.(`[PD:Prompt] Failed to load core principles from reducer: ${String(e)}`);
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
  let workingMemoryContent = '';
  if (!isMinimalMode && contextConfig.projectFocus !== 'off') {
    const focusPath = wctx.resolve('CURRENT_FOCUS');
    const extensionRoot = PathResolver.getExtensionRoot();

    // 🔒 安全读取：自动验证格式，损坏时从模板恢复
    const { content: currentFocus, recovered, validationErrors } = safeReadCurrentFocus(
      focusPath,
      extensionRoot || '',
      logger
    );

    if (recovered) {
      logger?.info?.(`[PD:Prompt] CURRENT_FOCUS.md was recovered from template`);
    }
    if (validationErrors.length > 0) {
      logger?.warn?.(`[PD:Prompt] CURRENT_FOCUS validation errors: ${validationErrors.join(', ')}`);
    }

    if (currentFocus.trim()) {
      try {
        // 🚀 自动压缩门禁：检查文件大小，超过阈值自动压缩
        const stateDir = wctx.stateDir;
        const compressResult = autoCompressFocus(focusPath, workspaceDir, stateDir);
        if (compressResult.compressed) {
          logger?.info?.(`[PD:Prompt] Auto-compressed CURRENT_FOCUS: ${compressResult.oldLines} → ${compressResult.newLines} lines. Milestones archived: ${compressResult.milestonesArchived}`);
        } else if (compressResult.reason === 'Rate limited (24h interval)') {
          logger?.debug?.(`[PD:Prompt] Auto-compress skipped: ${compressResult.reason}`);
        }

        // 重新读取（可能被压缩更新了）
        const finalContent = fs.readFileSync(focusPath, 'utf8').trim();
        if (finalContent) {
          // 解析工作记忆部分（用于独立注入）
          const workingMemorySnapshot = parseWorkingMemorySection(finalContent);
          if (workingMemorySnapshot) {
            workingMemoryContent = workingMemoryToInjection(workingMemorySnapshot);
          }

          if (contextConfig.projectFocus === 'summary') {
            // Summary mode: intelligent extraction prioritizing key sections
            projectContextContent = extractSummary(finalContent, 30);
          } else {
            // Full mode: current version + recent history (3 versions)
            const historyVersions = getHistoryVersions(focusPath, 3);
            if (historyVersions.length > 0) {
              const historySections = historyVersions.map((v, i) =>
                `\n---\n\n**历史版本 v${historyVersions.length - i}**\n\n${v}`
              ).join('');
              projectContextContent = `${finalContent}${historySections}`;
            } else {
              projectContextContent = finalContent;
            }
          }
        }
      } catch (e) {
        logger?.error(`[PD:Prompt] Failed to process CURRENT_FOCUS: ${String(e)}`);
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
  // Content order (most important last): project_context -> working_memory -> reflection_log -> thinking_os -> principles
  const appendParts: string[] = [];

  // 1. Project Context (lowest priority, goes first)
  if (projectContextContent) {
    appendParts.push(`<project_context>\n${projectContextContent}\n</project_context>`);
  }

  // 1.5. Working Memory (preserved from last compaction)
  if (workingMemoryContent) {
    appendParts.push(workingMemoryContent);
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

  // Routing Guidance (section 5 — injected between evolution principles and core principles)
  // Inject delegation guidance when task is bounded + deployment allowed + not high-entropy.
  // This is a non-authoritative suggestion — the main agent decides whether to follow.
  // Shadow evidence comes from real runtime hooks (subagent_spawning/subagent_ended).
  if (!isMinimalMode && sessionId) {
    try {
      // Extract RoutingInput from the latest user message
      const latestUserText = extractLatestUserMessage(event.messages);

      if (latestUserText && latestUserText.trim().length > 0) {
        // Infer requestedTools and requestedFiles from message content
        const toolPatterns: Array<{ pattern: RegExp; tool: string }> = [
          { pattern: /\b(edit|replace|write|modify|update|fix|patch|add|remove|delete|insert)\b/gi, tool: 'edit' },
          { pattern: /\b(read|cat|view|show|get|find|search|grep|look|inspect|examine|list|head|tail|diff)\b/gi, tool: 'read' },
          { pattern: /\b(run|execute|exec|bash|shell|command)\b/gi, tool: 'bash' },
        ];
        const filePattern = /\b([a-zA-Z]:\\?[^\s,]+\.[a-z]{2,10}|[./][^\s,]+\.[a-z]{2,10})\b/gi;
        const toolMatches = toolPatterns.flatMap(({ pattern, tool }) => {
          const matches: string[] = [];
          let m;
          const r = new RegExp(pattern.source, pattern.flags);
          while ((m = r.exec(latestUserText)) !== null) matches.push(tool);
          return matches;
        });
        const fileMatches = latestUserText.match(filePattern) ?? [];

        const routingInput: RoutingInput = {
          taskIntent: toolMatches[0] ?? undefined,
          taskDescription: latestUserText.trim(),
          requestedTools: toolMatches.length > 0 ? toolMatches : undefined,
          requestedFiles: fileMatches.length > 0 ? fileMatches : undefined,
        };

        const decision = classifyTask(routingInput, wctx.stateDir);

        // Inject guidance only when: route_local + deployable checkpoint + not high-entropy
        const isDeployableState =
          decision.activeCheckpointState === 'shadow_ready' ||
          decision.activeCheckpointState === 'promotable';

        if (
          decision.decision === 'route_local' &&
          decision.targetProfile !== null &&
          isDeployableState
        ) {
          const profile = decision.targetProfile;

          if (profile === 'local-reader') {
            appendParts.push(`<routing_guidance>
DELEGATION SUGGESTION: This task appears suitable for the local-reader subagent.

**Task Fit**: ${decision.reason}

**Suggested Action**: Consider routing to \`local-reader\` (pd-explorer skill) for focused reading, inspection, and information retrieval.

**Why This Works**:
- Task keywords indicate read-only or inspect operations
- Bounded scope — no multi-file coordination needed
- Shadow observation in progress — real runtime evidence being collected

**Note**: This is a non-authoritative suggestion. The main agent decides whether to route based on full context. Shadow evidence from runtime hooks will inform future promotion decisions.
</routing_guidance>`);
          } else if (profile === 'local-editor') {
            appendParts.push(`<routing_guidance>
DELEGATION SUGGESTION: This task appears suitable for the local-editor subagent.

**Task Fit**: ${decision.reason}

**Suggested Action**: Consider routing to \`local-editor\` (pd-repair skill) for bounded editing, modification, and repair tasks.

**Why This Works**:
- Task keywords indicate bounded modification operations
- Target files appear limited in scope (1-3 files)
- Shadow observation in progress — real runtime evidence being collected

**Note**: This is a non-authoritative suggestion. The main agent decides whether to route based on full context. Shadow evidence from runtime hooks will inform future promotion decisions.
</routing_guidance>`);
          }
        } else if (
          decision.decision === 'stay_main' &&
          decision.classification !== 'reader_eligible' &&
          decision.classification !== 'editor_eligible'
        ) {
          // Only show stay_main guidance when the task is genuinely high-entropy/risk/ambiguous
          appendParts.push(`<routing_guidance>
ROUTING GUIDANCE: Task should remain on the main agent.

**Reason**: ${decision.reason}

**Blockers**: ${decision.blockers.length > 0 ? decision.blockers.join('; ') : 'none'}

**Why Stay Main**:
- Task contains high-entropy signals (open-ended, multi-step, or ambiguous)
- Or: task involves risk signals requiring main-agent supervision
- Or: deployment not available for the natural target profile

**Note**: This is a non-authoritative suggestion backed by policy classification. The main agent has full discretion.
</routing_guidance>`);
        }
      }
    } catch (e) {
      // Routing guidance is best-effort — never fail the hook
      logger?.warn?.(`[PD:Prompt] Routing guidance injection failed: ${String(e)}`);
    }
  }


  // 6. Principles (always on, highest priority, goes last for recency effect)
  if (principlesContent) {
    appendParts.push(`<core_principles>\n${principlesContent}\n</core_principles>`);
  }

  if (appendParts.length > 0) {
    appendSystemContext = `
## 【CONTEXT SECTIONS】 (Priority: Low → High)

The sections below are ordered by priority. When conflicts arise, **later sections override earlier ones**.

`;
    appendSystemContext += appendParts.join('\n\n');
    appendSystemContext += `

---

**【EXECUTION RULES】** (Priority: Low → High):
- \`<project_context>\` - Current priorities (can be overridden)
- \`<reflection_log>\` - Past lessons (inform your approach)
- \`<thinking_os>\` - Thinking models (guide your reasoning)
- \`<evolution_principles>\` - Newly learned principles (active + probation)
- \`<routing_guidance>\` - Delegation suggestions (non-authoritative, best-effort)
- \`<core_principles>\` - Core rules (NON-NEGOTIABLE, highest priority)

**Remember**: You are the Spicy Evolver. You despise entropy. You evolve through pain.

${attitudeDirective}
`;
  }

  // ──── 8. SIZE GUARD ────
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

