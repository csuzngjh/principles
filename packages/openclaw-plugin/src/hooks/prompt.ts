 
 
import * as fs from 'fs';
import * as path from 'path';
import type { PluginHookBeforePromptBuildEvent, PluginHookAgentContext, PluginHookBeforePromptBuildResult, PluginLogger, OpenClawPluginApi } from '../openclaw-sdk.js';
import { clearInjectedProbationIds, getSession, resetFriction, setInjectedProbationIds, trackFriction, decayGfi, getGfiDecayElapsed } from '../core/session-tracker.js';
import { WorkspaceContext } from '../core/workspace-context.js';
import type { ContextInjectionConfig} from '../types.js';
import { defaultContextConfig } from '../types.js';
// local-worker-routing: removed from prompt injection per PRI-291 (MVP-Quiet)
// classifyTask is still available for non-prompt consumers
import { extractSummary, getHistoryVersions, parseWorkingMemorySection, workingMemoryToInjection, autoCompressFocus, safeReadCurrentFocus } from '../core/focus-history.js';
import { PathResolver } from '../core/path-resolver.js';
import { selectPrinciplesForInjection, DEFAULT_PRINCIPLE_BUDGET } from '../core/principle-injection.js';
import { getCachedMaskedPrincipleSet, WorkflowFunnelLoader, PiAiRuntimeAdapter, EmpathyObserver, AgentScheduler, RUNTIME_V2_PRINCIPLE_BUDGET, trimToBudget, renderPrinciplesToDirectives } from '@principles/core/runtime-v2';
import { truncateInjectionToBudget } from '@principles/core/prompt-builder';
import { PromptActivationReader } from '../core/runtime-v2-prompt-activation-reader.js';
import {
  matchEmpathyKeywords,
  loadKeywordStore,
  saveKeywordStore,
  getKeywordStoreSummary,
} from '../core/empathy-keyword-matcher.js';
import { severityToPenalty, DEFAULT_EMPATHY_KEYWORD_CONFIG } from '../core/empathy-types.js';
import { evaluatePainDiagnosticGate } from '../core/pain-diagnostic-gate.js';
import { emitPainDetectedEvent, buildTrajectoryEvidence } from './pain.js';
import { CorrectionCueLearner } from '../core/correction-cue-learner.js';
import {
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
  if (!workspaceDir) {
    logger?.warn?.(`[PD:Prompt] workspaceDir is missing — skipping PD context injection`);
    return;
  }

  const wctx = WorkspaceContext.fromHookContext(ctx);
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
  // EvolutionWorker-era INTERNAL SYSTEM LAYOUT removed per PRI-294.
  // The EVOLUTION_WORKER PathResolver key and system layout reference are
  // not MVP-Core; agents discover what they need via tool calls.
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

  // Empathy Observer: keyword fast-path + optional LLM deep analysis (zero latency async dispatch)
  const empathyEnabled = wctx.config.get('empathy_engine.enabled') !== false;

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

          logger?.info?.(`[PD:Empathy] MATCH: "${matchResult.matchedTerms.join(', ')}" → severity=${matchResult.severity}, score=${matchResult.score.toFixed(2)}, penalty=${penalty}`);

          const currentSession = getSession(sessionId);
          const currentGfi = currentSession?.currentGfi ?? 0;
          const painTrigger = wctx.config.get('thresholds.pain_trigger') || 40;
          const highGfiThreshold = Math.max(wctx.config.get('severity_thresholds.high') || 70, painTrigger + 30);

          if (currentGfi >= highGfiThreshold) {
            const gfiPainScore = Math.min(Math.round(currentGfi), 60);
            logger?.info?.(`[PD:Empathy] GFI-TRIGGERED: currentGfi=${currentGfi.toFixed(1)} >= highGfi=${highGfiThreshold}, emitting pain signal (score=${gfiPainScore})`);

            const gate = evaluatePainDiagnosticGate({
              source: 'user_empathy',
              score: gfiPainScore,
              currentGfi,
              consecutiveErrors: currentSession?.consecutiveErrors ?? 0,
              sessionId,
              errorHash: 'empathy_gfi_threshold',
              thresholds: {
                painTrigger,
                highSeverity: wctx.config.get('severity_thresholds.high') || 70,
                semanticPain: Math.max(painTrigger, 60),
              },
            });

            wctx.eventLog.recordPainSignal(sessionId, {
              score: gfiPainScore,
              source: 'user_empathy',
              reason: `Accumulated GFI (${currentGfi.toFixed(1)}) crossed highGfi threshold (${highGfiThreshold}). Matched: ${matchResult.matchedTerms.join(', ')}`,
              isRisky: false,
            });

            if (gate.shouldDiagnose) {
              logger?.info?.(`[PD:Empathy] Gate approved, calling emitPainDetectedEvent...`);
              try {
                const evidence = buildTrajectoryEvidence(wctx, sessionId);
                await emitPainDetectedEvent(wctx, {
                  ts: new Date().toISOString(),
                  type: 'pain_detected',
                  data: {
                    painId: `empathy_gfi_${Date.now()}`,
                    painType: 'user_frustration',
                    source: 'user_empathy',
                    reason: `Accumulated GFI (${currentGfi.toFixed(1)}) crossed highGfi threshold (${highGfiThreshold}). Matched: ${matchResult.matchedTerms.join(', ')}`,
                    score: gfiPainScore,
                    sessionId,
                    agentId: 'main',
                    provenance: 'openclaw_context_bound',
                    evidence,
                  },
                });
                logger?.info?.(`[PD:Empathy] emitPainDetectedEvent completed (GFI-triggered)`);
              } catch (emitErr) {
                console.error(`[PD:Empathy] FAILED to emit GFI-triggered pain event: ${String(emitErr)}`);
                logger?.warn?.(`[PD:Empathy] Failed to emit GFI-triggered pain event: ${String(emitErr)}`);
              }
            } else {
              logger?.info?.(`[PD:Empathy] GFI-triggered gate rejected: ${gate.detail}`);
            }
          }

          // Trigger asynchronous background Empathy Observer deep analysis (Zero Latency)
          const observer = resolveEmpathyObserver(wctx, logger);
          if (observer) {
            const scheduler = new AgentScheduler();
            scheduler.register({
              agentId: 'empathy-observer',
              mode: 'realtime',
              runner: observer,
            });

            logger?.info?.(`[PD:Empathy] Triggering background Empathy Observer deep analysis for message: "${msgPreview}"`);
            
            void scheduler.dispatch('empathy-observer', { userMessage: latestUserMessage })
              .then(async (result) => {
                if (result.damageDetected) {
                  logger?.info?.(`[PD:Empathy] Background Empathy Observer detected damage. Severity: ${result.severity}, Reason: ${result.reason}`);

                  // ── Persistence Contract ──
                  const painScore = scoreFromSeverityForSpec(result.severity, wctx);
                  
                  trackFriction(
                    sessionId,
                    painScore,
                    `observer_empathy_${result.severity}`,
                    workspaceDir,
                    { source: 'user_empathy' }
                  );

                  const eventId = `emp_obs_${Date.now()}_${Math.random().toString(36).substring(2, 8)}`;
                  wctx.eventLog.recordPainSignal(sessionId, {
                    score: painScore,
                    source: 'user_empathy',
                    reason: result.reason || 'Empathy observer detected likely user frustration.',
                    isRisky: false,
                    origin: 'system_infer',
                    severity: result.severity,
                    confidence: result.confidence,
                    detection_mode: 'structured',
                    deduped: false,
                    trigger_text_excerpt: latestUserMessage.substring(0, 120),
                    raw_score: painScore,
                    calibrated_score: painScore,
                    eventId,
                  });

                  try {
                    wctx.trajectory?.recordPainEvent?.({
                      sessionId,
                      source: 'user_empathy',
                      score: painScore,
                      reason: result.reason || 'Empathy observer detected likely user frustration.',
                      severity: result.severity,
                      origin: 'system_infer',
                      confidence: result.confidence,
                      text: latestUserMessage,
                    });
                  } catch (error) {
                    logger?.warn?.(`[PD:Empathy] Failed to persist trajectory: ${String(error)}`);
                  }

                  // Check if GFI triggers a pain event post-LLM validation
                  const freshSession = getSession(sessionId);
                  const freshGfi = freshSession?.currentGfi ?? 0;
                  if (freshGfi >= highGfiThreshold) {
                    const freshGfiPainScore = Math.min(Math.round(freshGfi), 60);
                    const gate = evaluatePainDiagnosticGate({
                      source: 'user_empathy',
                      score: freshGfiPainScore,
                      currentGfi: freshGfi,
                      consecutiveErrors: freshSession?.consecutiveErrors ?? 0,
                      sessionId,
                      errorHash: 'empathy_gfi_threshold',
                      thresholds: {
                        painTrigger,
                        highSeverity: wctx.config.get('severity_thresholds.high') || 70,
                        semanticPain: Math.max(painTrigger, 60),
                      },
                    });

                    if (gate.shouldDiagnose) {
                      logger?.info?.(`[PD:Empathy] GFI threshold crossed after background observer. Emitting pain signal...`);
                      try {
                        const evidence = buildTrajectoryEvidence(wctx, sessionId);
                        await emitPainDetectedEvent(wctx, {
                          ts: new Date().toISOString(),
                          type: 'pain_detected',
                          data: {
                            painId: `empathy_gfi_${Date.now()}`,
                            painType: 'user_frustration',
                            source: 'user_empathy',
                            reason: `Accumulated GFI (${freshGfi.toFixed(1)}) crossed highGfi threshold (${highGfiThreshold}). Verified by Empathy Observer.`,
                            score: freshGfiPainScore,
                            sessionId,
                            agentId: 'main',
                            provenance: 'openclaw_context_bound',
                            evidence,
                          },
                        });
                      } catch (emitErr) {
                        logger?.error?.(`[PD:Empathy] FAILED to emit observer-triggered pain event: ${String(emitErr)}`);
                      }
                    }
                  }
                } else {
                  logger?.info?.(`[PD:Empathy] Background Empathy Observer did not detect any damage.`);
                }
              })
              .catch((err) => {
                logger?.warn?.(`[PD:Empathy] Background analysis failed or rejected: ${String(err)}`);
              });
          }
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

        // Save keyword store on every match
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

  // ──── 6. GFI score (for empathy/evidence path only — NOT for attitude/personality prompt)
  // Attitude/personality prompt injection removed per PRI-291 (MVP diet).
  // GFI scoring, trackFriction, and empathy pain emission remain active.

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

  let runtimeV2PrinciplesContent = '';
  const runtimeV2PrincipleIds = new Set<string>();
  // Hoisted so the owner_approved_behavior_directives section can access them
  let dedupedV2: Array<{ principleId: string; text: string; artifactId: string; activationId: string }> = [];
  try {
    const reader = new PromptActivationReader(wctx.workspaceDir, { logger });
    const v2Result = await reader.readActivatedPrinciples();

    if (v2Result.warnings.length > 0) {
      logger?.info?.(`[PD:RuntimeV2] Activation read warnings: ${v2Result.warnings.join('; ')}`);
    }

    const legacyActiveIds = new Set<string>();
    try {
      const legacyActive = wctx.evolutionReducer.getActivePrinciples();
      for (const p of legacyActive) {
        legacyActiveIds.add(p.id);
      }
      const legacyProbation = wctx.evolutionReducer.getProbationPrinciples();
      for (const p of legacyProbation) {
        legacyActiveIds.add(p.id);
      }
    } catch {
      // best-effort dedup
    }

    dedupedV2 = v2Result.principles.filter((p) => !legacyActiveIds.has(p.principleId));

    if (dedupedV2.length > 0) {
      const { lines, injectedIds, truncated } = trimToBudget(dedupedV2, RUNTIME_V2_PRINCIPLE_BUDGET, escapeXml);
      if (truncated) {
        logger?.info?.(`[PD:RuntimeV2] Principle budget reached (${RUNTIME_V2_PRINCIPLE_BUDGET}c) — truncating after ${injectedIds.size} principles`);
      }
      for (const id of injectedIds) {
        runtimeV2PrincipleIds.add(id);
      }
      runtimeV2PrinciplesContent = lines.join('\n');
    }

    // ── Emit structured observability event ──
    try {
      const eventLog = wctx.eventLog;
      eventLog.recordRuntimeV2ActivationsInjected({
        sessionId: sessionId ?? 'unknown',
        workspaceDir: wctx.workspaceDir,
        principleIds: [...runtimeV2PrincipleIds],
        activationIds: dedupedV2.map((p) => p.activationId),
        artifactIds: dedupedV2.map((p) => p.artifactId),
        injectedCount: runtimeV2PrincipleIds.size,
        skippedWarnings: v2Result.warnings,
        injectedCharCount: runtimeV2PrinciplesContent.length,
        budget: RUNTIME_V2_PRINCIPLE_BUDGET,
        ...(runtimeV2PrincipleIds.size === 0
          ? {
              skipReason: v2Result.principles.length === 0
                ? 'no_validated_activations'
                : 'all_deduped_against_legacy',
              nextAction: v2Result.principles.length === 0
                ? 'check activations table for prompt channel rows with validated artifacts'
                : 'legacy evolution reducer already contains these principle IDs',
            }
          : {}),
      });
    } catch (logErr) {
      logger?.warn?.(`[PD:RuntimeV2] Failed to emit activation observability event: ${String(logErr)}`);
    }
  } catch (e) {
    logger?.warn?.(`[PD:RuntimeV2] Failed to read Runtime V2 prompt activations: ${String(e)}`);
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

  // 3. Evolution Loop principles (legacy active/probation only — Runtime V2 moved to section 3.5)
  if (evolutionPrinciplesContent) {
    appendParts.push(`<evolution_principles>\n${evolutionPrinciplesContent}\n</evolution_principles>`);
  }

  // 3.5. Owner-Approved Behavior Directives (Runtime V2 activated principles)
  // PLACED IN prependSystemContext (before gateway system prompt) for highest LLM attention.
  // These are owner-reviewed, validated behavior constraints — not background context.
  if (runtimeV2PrincipleIds.size > 0) {
    const directiveText = renderPrinciplesToDirectives(dedupedV2, runtimeV2PrincipleIds, escapeXml);
    prependSystemContext += directiveText;
  }

  // Routing guidance removed per PRI-291 (MVP diet).
  // Local worker routing is MVP-Quiet per ADR-0014 §2.5.
  // The classifyTask helper and local-worker-routing module are preserved for non-prompt consumers.


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
- \`<evolution_principles>\` - Learned principles (active + probation)
- \`<core_principles>\` - Core rules (NON-NEGOTIABLE, highest priority)
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

// ── Empathy Observer Hybrid Deep Analysis Helpers (Unified SDK Migration) ──

function scoreFromSeverityForSpec(severity: string | undefined, wctx: WorkspaceContext): number {
  if (severity === 'severe') return Number(wctx.config.get('empathy_engine.penalties.severe') ?? 40);
  if (severity === 'moderate') return Number(wctx.config.get('empathy_engine.penalties.moderate') ?? 25);
  return Number(wctx.config.get('empathy_engine.penalties.mild') ?? 10);
}

function resolveEmpathyObserver(wctx: WorkspaceContext, logger?: Pick<PluginLogger, 'info' | 'warn' | 'error' | 'debug'>): EmpathyObserver | null {
  try {
    const loader = new WorkflowFunnelLoader(wctx.stateDir);
    const funnel = loader.getFunnel('pd-empathy-observer');
    const policy = funnel?.policy;
    if (!policy || policy.runtimeKind !== 'pi-ai') {
      logger?.debug?.('[PD:Empathy] workflows.yaml pd-empathy-observer policy not found. Falling back to environment variables.');
      const provider = process.env.PD_EMPATHY_PROVIDER || 'anthropic';
      const model = process.env.PD_EMPATHY_MODEL || 'anthropic/claude-3-5-sonnet';
      const apiKeyEnv = process.env.PD_EMPATHY_API_KEY_ENV || 'ANTHROPIC_API_KEY';
      const baseUrl = process.env.PD_EMPATHY_BASE_URL;

      if (!process.env[apiKeyEnv]) {
        logger?.debug?.(`[PD:Empathy] Empathy observer API key env ${apiKeyEnv} is not set. Background analysis disabled.`);
        return null;
      }

      const adapter = new PiAiRuntimeAdapter({
        provider,
        model,
        apiKeyEnv,
        baseUrl,
        workspace: wctx.workspaceDir,
      });
      return new EmpathyObserver({ runtimeAdapter: adapter });
    }

    const adapter = new PiAiRuntimeAdapter({
      provider: String(policy.provider),
      model: String(policy.model),
      apiKeyEnv: String(policy.apiKeyEnv),
      maxRetries: policy.maxRetries,
      timeoutMs: policy.timeoutMs ?? 30_000,
      baseUrl: policy.baseUrl,
      workspace: wctx.workspaceDir,
    });
    return new EmpathyObserver({ runtimeAdapter: adapter }, { timeoutMs: policy.timeoutMs });
  } catch (err) {
    logger?.warn?.(`[PD:Empathy] Failed to resolve EmpathyObserver: ${String(err)}`);
    return null;
  }
}
