 
 
import * as fs from 'fs';
import * as path from 'path';
import type { PluginHookBeforePromptBuildEvent, PluginHookAgentContext, PluginHookBeforePromptBuildResult, PluginLogger, OpenClawPluginApi } from '../openclaw-sdk.js';
import { clearInjectedProbationIds, getSession, resetFriction, setInjectedProbationIds, trackFriction, decayGfi, getGfiDecayElapsed } from '../core/session-tracker.js';
import { WorkspaceContext } from '../core/workspace-context.js';
import type { ContextInjectionConfig} from '../types.js';
import { defaultContextConfig } from '../types.js';
import { classifyTask, type RoutingInput } from '../core/local-worker-routing.js';
import { extractSummary, getHistoryVersions, parseWorkingMemorySection, workingMemoryToInjection, autoCompressFocus, safeReadCurrentFocus } from '../core/focus-history.js';
import { PathResolver } from '../core/path-resolver.js';
import { selectPrinciplesForInjection, DEFAULT_PRINCIPLE_BUDGET } from '../core/principle-injection.js';
import { getCachedMaskedPrincipleSet } from '@principles/core/runtime-v2';
import { truncateInjectionToBudget } from '@principles/core/prompt-builder';
import {
  matchEmpathyKeywords,
  loadKeywordStore,
  saveKeywordStore,
  getKeywordStoreSummary,
} from '../core/empathy-keyword-matcher.js';
import { severityToPenalty, DEFAULT_EMPATHY_KEYWORD_CONFIG } from '../core/empathy-types.js';
import { CorrectionCueLearner } from '../core/correction-cue-learner.js';
import {
  buildAttitudeDirective,
  detectCorrectionCue as coreDetectCorrectionCue,
  extractMessageContent,
  isMinimalTrigger,
} from '@principles/core/prompt-builder';

// ---------------------------------------------------------------------------
// Static file cache — avoids re-reading rarely-changing files every message
// ---------------------------------------------------------------------------
const STATIC_FILE_TTL_MS = 60_000; // 1 minute

interface CachedFile {
  content: string;
  mtime: number;   // file modification time at read
  loadedAt: number; // when we cached it
}

const _staticFileCache = new Map<string, CachedFile>();

/**
 * Reads a file with TTL-based caching.
 * Returns cached content if:
 *   1. Cache entry exists and was loaded < TTL_MS ago, AND
 *   2. File mtime hasn't changed (detects external edits)
 * Otherwise re-reads from disk.
 */
function cachedReadFile(filePath: string): string {
  const now = Date.now();
  const cached = _staticFileCache.get(filePath);

  try {
    const stat = fs.statSync(filePath);
    const mtime = stat.mtimeMs;

    if (cached && (now - cached.loadedAt) < STATIC_FILE_TTL_MS && cached.mtime === mtime) {
      return cached.content;
    }

    const content = fs.readFileSync(filePath, 'utf8');
    _staticFileCache.set(filePath, { content, mtime, loadedAt: now });
    return content;
  } catch {
    // File doesn't exist or unreadable — invalidate cache
    _staticFileCache.delete(filePath);
    return '';
  }
}

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
  return extractMessageContent(message);
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
    const raw = cachedReadFile(profilePath);
    if (raw) {
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

/**
 * Extract recent user messages for keyword optimization context.
 */


/**
 * Build prompt for keyword optimization subagent.
 */


export async function handleBeforePromptBuild(
  event: PluginHookBeforePromptBuildEvent,
  ctx: PluginHookAgentContext & { api?: PromptHookApi }
): Promise<PluginHookBeforePromptBuildResult | void> {
  const {workspaceDir} = ctx;
  const logger = ctx.api?.logger;
  logger?.info?.(`[PD:Prompt] handleBeforePromptBuild called: workspaceDir=${!!workspaceDir}, trigger=${ctx.trigger}, sessionId=${ctx.sessionId?.substring(0, 20)}`);
  // ──── DEBUG: Verify subagent availability in this context ────
  const subagent = ctx.api?.runtime?.subagent;
  logger?.info?.(`[PD:DEBUG:SubagentCheck] trigger=${ctx.trigger}, subagent_exists=${!!subagent}, subagent.run_exists=${!!subagent?.run}`);
  if (subagent?.run) {
    logger?.info?.('[PD:DEBUG:SubagentCheck] run entrypoint is callable');
  }

  const wctx = WorkspaceContext.fromHookContextExplicit(ctx);
  const { trigger, sessionId } = ctx as { trigger: string | undefined; sessionId: string | undefined };
  const api = ctx.api;
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
      // Use CorrectionCueLearner for detection — supports learned keywords, not just hardcoded list
      let correctionCue: string | null = null;
      try {
        const learner = CorrectionCueLearner.get(wctx.stateDir);
        const matchResult = learner.match(userText);
        if (matchResult.matched) {
          correctionCue = matchResult.matchedTerms[0] ?? null;
          learner.recordHits(matchResult.matchedTerms);
          // TP for high-confidence; flush hitCount for low-confidence
          if (correctionCue && matchResult.confidence >= 0.5) {
            learner.recordTruePositive(correctionCue);
          } else {
            learner.flush();
          }
        }
      } catch (learnerErr) {
        // Fallback to hardcoded detection if learner fails — log for observability
        correctionCue = coreDetectCorrectionCue(userText);
        logger?.warn?.(`[PD:Prompt] CorrectionCueLearner.match() failed (${String(learnerErr)}), fallback=${correctionCue ? `matched="${correctionCue}"` : 'no-match'}`);
      }
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
  const contextConfig = loadContextInjectionConfig(wctx.workspaceDir);

  // Minimal mode: heartbeat and subagents skip most context to reduce tokens
  const isMinimalMode = isMinimalTrigger(trigger as string | undefined, sessionId as string | undefined);

  const session = sessionId ? getSession(sessionId) : undefined;

  // ──── STRUCTURE (Optimized for WebUI UX + Prompt Caching) ────
  // prependSystemContext: Minimal identity (cacheable, ~15 lines)
  // appendSystemContext: Principles + Thinking OS + reflection_log + project_context (cacheable, WebUI-hidden)
  // prependContext: Only short dynamic directives: evolutionDirective + heartbeat

   
   
  let prependSystemContext: string;
  let prependContext = '';
  let appendSystemContext = '';
  // Tracks pending diagnostician task count for diagnostician-priority mode in size guard
  let pendingDiagTaskCount = 0;

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
  // event.prompt contains the full prompt text, which may include system/boot instructions
  // The actual user message from Feishu is embedded in the prompt with various formats:
  // Format 1: "Sender (untrusted metadata): ```json {...}```  user_message_text"
  // Format 2: "You are running a boot check. Follow BOOT.md..." (boot check, skip empathy)
  // Format 3: Clean user message text
  let latestUserMessage = event.prompt || '';

  // Skip boot check messages — these are system-generated, not real user messages.
  // buildBootPrompt() in OpenClaw src/gateway/boot.ts always starts with:
  // "You are running a boot check. Follow BOOT.md instructions exactly."
  // This exact phrase will never appear in a real user message.
  if (latestUserMessage.startsWith('You are running a boot check.') ||
      latestUserMessage.includes('You are running a boot check. Follow BOOT.md')) {
    latestUserMessage = '';
  }

  // Try to extract actual user message from Feishu wrapper formats
  if (latestUserMessage.length > 50) {
    // Format 1: "Sender (untrusted metadata): ```json {...}```  user_message_text"
    const senderMatch = /Sender \(untrusted metadata\):[\s\S]*?```json[\s\S]*?```\s*/.exec(latestUserMessage);
    if (senderMatch) {
      const afterSender = latestUserMessage.slice(senderMatch.index + senderMatch[0].length).trim();
      if (afterSender.length > 3) latestUserMessage = afterSender;
    }

    // Format 2: "Conversation info (untrusted metadata): ```json {...}```  user_message_text"
    if (latestUserMessage.length > 200 && latestUserMessage.includes('Conversation info')) {
      const convInfoMatch = /Conversation info[\s\S]*?```json[\s\S]*?```\s*/.exec(latestUserMessage);
      if (convInfoMatch) {
        const afterConvInfo = latestUserMessage.slice(convInfoMatch.index + convInfoMatch[0].length).trim();
        if (afterConvInfo.length > 3) latestUserMessage = afterConvInfo;
      }
    }
  }
  
  // #189: Detect empathy observer output to prevent recursive spawn.
  // The empathy observer runs with parentSessionId (not :subagent:), so its output
  // would be treated as a user message and re-trigger empathy evaluation.
  // Match distinctive patterns from the empathy observer prompt/output.
  const isEmpathyPrompt = /empathy\s*observer/i.test(latestUserMessage) &&
    /damageDetected|severity|confidence/i.test(latestUserMessage);
  const isAgentToAgent = latestUserMessage.includes('sourceSession=agent:') || sessionId?.includes(':subagent:') === true || isEmpathyPrompt;

  const isUserInteraction = trigger === 'user' || trigger === 'api' || !trigger;

  // LEGACY PATH GUARD: empathy subagent spawning is disabled by default.
  // Set PD_LEGACY_EMPATHY_SUBAGENT_ENABLED=true to re-enable.
  const legacyEmpathyEnabled = process.env.PD_LEGACY_EMPATHY_SUBAGENT_ENABLED === 'true';
  const empathyEnabled = legacyEmpathyEnabled && wctx.config.get('empathy_engine.enabled') !== false;
  if (!legacyEmpathyEnabled) {
    logger?.debug?.('[PD:Prompt] Legacy empathy subagent DISABLED (PD_LEGACY_EMPATHY_SUBAGENT_ENABLED != true)');
  }
  logger?.info?.(`[PD:Empathy] Conditions: enabled=${empathyEnabled}, isUser=${isUserInteraction}, sessionId=${!!sessionId}, api=${!!api}, !agentToAgent=${!isAgentToAgent}, workspaceDir=${!!workspaceDir}, hasMessage=${!!latestUserMessage}`);

  // Track if we should inject behavioral constraints (will be added to appendSystemContext later)
  let shouldInjectBehavioralConstraints = false;
  if (empathyEnabled && isUserInteraction && sessionId && api && !isAgentToAgent) {
    shouldInjectBehavioralConstraints = true;

    // ── Empathy Hybrid Matching (keyword + subagent sampling) ──
    // Fast keyword scan on every turn, with strategic subagent sampling
    // for boundary cases and random discovery of new expressions.
    if (workspaceDir && latestUserMessage) {
      try {
        const msgPreview = latestUserMessage.substring(0, 200).replace(/\n/g, ' ');
        logger?.info?.(`[PD:Empathy] Processing user message: "${msgPreview}" (trigger=${trigger}, promptLen=${latestUserMessage.length})`);
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


        if (matchResult.matched) {
          const penalty = severityToPenalty(matchResult.severity, DEFAULT_EMPATHY_KEYWORD_CONFIG);
          // trackFriction signature: (sessionId, deltaF: number, hash: string, workspaceDir?, options?)
          trackFriction(sessionId, penalty, 'empathy_keyword_match', workspaceDir, {
            source: 'user_empathy',
          });

          logger?.info?.(`[PD:Empathy] MATCH: "${matchResult.matchedTerms.join(', ')}" → severity=${matchResult.severity}, score=${matchResult.score.toFixed(2)}, penalty=${penalty}, ''`);
        } else {
          // Log unmatched messages periodically for coverage analysis
          if (turnCount > 0 && turnCount % 50 === 0) {
            const sampleMsg = latestUserMessage.substring(0, 80).replace(/\n/g, ' ');
            logger?.debug?.(`[PD:Empathy] NO_MATCH: "${sampleMsg}" (turn ${turnCount}, keywords_in_store=${Object.keys(keywordStore.terms).length})`);
          }
        }

        // Periodic summary (every 100 turns)
        if (turnCount > 0 && turnCount % 100 === 0) {
          const s = getKeywordStoreSummary(keywordStore);
          const highFP = s.highFalsePositiveTerms.slice(0, 5).map(t => `${t.term}(${t.falsePositiveRate.toFixed(2)})`).join(', ');
          logger?.info?.(`[PD:Empathy] SUMMARY(turn=${turnCount}): terms=${s.totalTerms}, hits=${keywordStore.stats.totalHits}, zero_hit=${s.totalTerms - (s.seedTerms + s.discoveredTerms)}, high_fp=[${highFP}]`);
        }

        // Save keyword store on every match to prevent data loss on restart.
        // Previously used turnCount % 50 gate which caused hitCount loss because
        // module-level state resets on plugin reload before reaching turn 50.
        if (matchResult.matched) {
          saveKeywordStore(wctx.stateDir, keywordStore);
          const {totalHits} = keywordStore.stats;
          logger?.info?.(`[PD:Empathy] Keyword store saved after match: terms=${matchResult.matchedTerms.join(',')}, totalHits=${totalHits}`);
        }
      } catch (e) {
        logger?.warn?.(`[PD:Empathy] ERROR: ${String(e)}`);
      }
    }

  }

  // ──── 4. Heartbeat-specific checklist (also fires for cron-triggered sessions) ────
  if (trigger === 'heartbeat' || trigger === 'cron') {
    // ──── 4a. GFI Time-based Decay ────
    // Apply segmented exponential decay to GFI on each heartbeat
    if (sessionId) {
      const elapsedMinutes = getGfiDecayElapsed(sessionId);
      if (elapsedMinutes >= 1) {
        const decayedState = decayGfi(sessionId, elapsedMinutes);
        if (decayedState) {
          logger?.info?.(`[PD:GFI] Heartbeat decay applied: ${elapsedMinutes}min elapsed, GFI now ${decayedState.currentGfi.toFixed(1)}`);
        }
      }
    }
    
    const heartbeatPath = wctx.resolve('HEARTBEAT');
    if (fs.existsSync(heartbeatPath)) {
      try {
        const heartbeatChecklist = fs.readFileSync(heartbeatPath, 'utf8');
        prependContext += `<heartbeat_checklist>
${heartbeatChecklist}
</heartbeat_checklist>\n`;
      } catch (e) {
        logger?.error(`[PD:Prompt] Failed to read HEARTBEAT: ${String(e)}`);
      }
    }

  }

  // ──── 6. Dynamic Attitude Matrix (based on GFI) ────

  const currentGfi = session?.currentGfi || 0;
  const attitudeDirective = buildAttitudeDirective(currentGfi);

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
    try {
      const cached = cachedReadFile(thinkingOsPath);
      if (cached) thinkingOsContent = cached.trim();
    } catch (e) {
      logger?.error(`[PD:Prompt] Failed to read THINKING_OS: ${String(e)}`);
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
        const {stateDir} = wctx;
        const compressResult = autoCompressFocus(focusPath, workspaceDir, stateDir);
        if (compressResult.compressed) {
          logger?.info?.(`[PD:Prompt] Auto-compressed CURRENT_FOCUS: ${compressResult.oldLines} → ${compressResult.newLines} lines. Milestones archived: ${compressResult.milestonesArchived}`);
        } else if (compressResult.reason === 'Rate limited (24h interval)') {
          logger?.debug?.(`[PD:Prompt] Auto-compress skipped: ${compressResult.reason}`);
        }

        // Use compressResult.newContent when available, else fall back to currentFocus
        const finalContent = compressResult.newContent?.trim() || currentFocus.trim();
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
            const historyVersions = await getHistoryVersions(focusPath, 3);
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


  // Evolution principles injection — budget-aware selection (SDK-QUAL-04)
  let evolutionPrinciplesContent = '';
  try {
    const reducer = wctx.evolutionReducer;
    const allActive = reducer.getActivePrinciples();
    const allProbation = reducer.getProbationPrinciples();

    // Pruning mask: exclude principles whose latest review is archive-candidate
    let maskedIds = new Set<string>();
    try {
      maskedIds = getCachedMaskedPrincipleSet(wctx.workspaceDir);
    } catch (err) {
      // Safe degradation: if review log unreadable, inject all principles
      const msg = err instanceof Error ? err.message : String(err);
      if (logger?.info) {
        logger.info(`[PD:Pruning] Failed to read review log — all principles injected: ${msg}`);
      } else {
        console.error(`[PD:Pruning] Failed to read review log — all principles injected: ${msg}`);
      }
    }

    // Budget-aware selection: prioritize P0>P1>P2 and recency
    const activeSelection = selectPrinciplesForInjection(
      allActive.filter(p => !maskedIds.has(p.id)),
      DEFAULT_PRINCIPLE_BUDGET,
    );
    const active = activeSelection.selected;

    // Probation principles get a smaller sub-budget (1000 chars)
    const probationBudget = 1000;
    const probationSelection = selectPrinciplesForInjection(
      allProbation.filter(p => !maskedIds.has(p.id)),
      probationBudget,
    );
    const probation = probationSelection.selected;

    if (activeSelection.wasTruncated || probationSelection.wasTruncated) {
      logger?.info?.(`[PD:Prompt] Principles truncated: active=${activeSelection.breakdown.p0 + activeSelection.breakdown.p1 + activeSelection.breakdown.p2}/${allActive.length} (${activeSelection.totalChars}c), probation=${probation.length}/${allProbation.length} (${probationSelection.totalChars}c)`);
    }

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
  // Content order (most important last): behavioral_constraints -> project_context -> working_memory -> reflection_log -> thinking_os -> principles
  const appendParts: string[] = [];

  // 0. Behavioral Constraints (empathy observer coordination)
  // Injected here (appendSystemContext) instead of prependContext to hide from WebUI users.
  // Behavioral constraints: empathy observer coordination
  if (shouldInjectBehavioralConstraints) {
    appendParts.push(`<behavioral_constraints>
${empathySilenceConstraint}
</behavioral_constraints>`);
  }

  // 1. Project Context (lowest priority, goes first)
  if (projectContextContent) {
    appendParts.push(`<project_context>\n${projectContextContent}\n</project_context>`);
  }

  // 1.5. Working Memory (preserved from last compaction)
  if (workingMemoryContent) {
    appendParts.push(workingMemoryContent);
  }

  // 2. Thinking OS (configurable)
  if (thinkingOsContent) {
    appendParts.push(`<thinking_os>\n${thinkingOsContent}\n</thinking_os>`);
  }

  // 3. Evolution Loop principles (active/probation)
  if (evolutionPrinciplesContent) {
    appendParts.push(`<evolution_principles>\n${evolutionPrinciplesContent}\n</evolution_principles>`);
  }

  // Routing Guidance (section 5 — injected between evolution principles and core principles)
  // Inject delegation guidance when task is bounded + deployment allowed + not high-entropy.
  // This is a non-authoritative suggestion — the main agent decides whether to follow.
  // Shadow evidence comes from real runtime hooks (subagent_spawning/subagent_ended).
  if (!isMinimalMode && sessionId) {
    try {
      // Use the already extracted and cleaned user message
      const latestUserText = latestUserMessage || '';

      if (latestUserText && latestUserText.trim().length > 0) {
        // Infer requestedTools and requestedFiles from message content
        const toolPatterns: { pattern: RegExp; tool: string }[] = [
          { pattern: /\b(edit|replace|write|modify|update|fix|patch|add|remove|delete|insert)\b/gi, tool: 'edit' },
          { pattern: /\b(read|cat|view|show|get|find|search|grep|look|inspect|examine|list|head|tail|diff)\b/gi, tool: 'read' },
          { pattern: /\b(run|execute|exec|bash|shell|command)\b/gi, tool: 'bash' },
        ];
        const filePattern = /\b([a-zA-Z]:\\?[^\s,]+\.[a-z]{2,10}|[./][^\s,]+\.[a-z]{2,10})\b/gi;
        const toolMatches = toolPatterns.flatMap(({ pattern, tool }) => {
          const matches: string[] = [];
          const r = new RegExp(pattern.source, pattern.flags);
          while (r.exec(latestUserText) !== null) matches.push(tool);
          return matches;
        });
        const fileMatches = latestUserText.match(filePattern) ?? [];

        const routingInput: RoutingInput = {
          taskIntent: toolMatches[0] ?? undefined,
          taskDescription: latestUserText.trim(),
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
- \`<behavioral_constraints>\` - Output format restrictions (hide diagnostic JSON)
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
  // Delegates to @principles/core/prompt-builder/truncateInjectionToBudget
  // which handles priority stripping: project_context → thinking_os →
  // evolution_principles → reflection_log → reason: truncation → fallback.
  const result = truncateInjectionToBudget(
    prependSystemContext,
    prependContext,
    appendSystemContext,
    {
      diagnosticianMode: pendingDiagTaskCount > 0,
      blocks: { projectContextContent, thinkingOsContent, evolutionPrinciplesContent },
    }
  );

  prependSystemContext = result.prependSystemContext;
  prependContext = result.prependContext;
  appendSystemContext = result.appendSystemContext;

  if (result.truncated) {
    const logEntry = result.truncationLog.join(', ');
    if (result.appendSystemContext.includes('[WARNING: Context sections stripped')) {
      logger?.error(
        `[PD:Prompt] PROMPT OVER LIMIT AFTER ALL REDUCTIONS — using fallback. ` +
        `Diagnostician mode: ${pendingDiagTaskCount > 0}. Stripped: ${logEntry}.`
      );
    } else {
      logger?.warn(
        `[PD:Prompt] Injection size exceeded budget, truncated: ${logEntry || 'none'}, ` +
        `diagnostician mode: ${pendingDiagTaskCount > 0}`
      );
    }
  }

  return {
    prependSystemContext,
    prependContext,
    appendSystemContext
  };
}
