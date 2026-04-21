 
 
import * as fs from 'fs';
import * as path from 'path';
import type { PluginHookBeforePromptBuildEvent, PluginHookAgentContext, PluginHookBeforePromptBuildResult, PluginLogger, OpenClawPluginApi } from '../openclaw-sdk.js';
import { clearInjectedProbationIds, getSession, resetFriction, setInjectedProbationIds, trackFriction, decayGfi, getGfiDecayElapsed } from '../core/session-tracker.js';
import { WorkspaceContext } from '../core/workspace-context.js';
import type { ContextInjectionConfig} from '../types.js';
import { defaultContextConfig } from '../types.js';
import { classifyTask, type RoutingInput } from '../core/local-worker-routing.js';
import { extractSummary, getHistoryVersions, parseWorkingMemorySection, workingMemoryToInjection, autoCompressFocus, safeReadCurrentFocus } from '../core/focus-history.js';
import { EmpathyObserverWorkflowManager, empathyObserverWorkflowSpec, isExpectedSubagentError } from '../service/subagent-workflow/index.js';
import { PathResolver } from '../core/path-resolver.js';
import { selectPrinciplesForInjection, DEFAULT_PRINCIPLE_BUDGET } from '../core/principle-injection.js';
import { isSubagentRuntimeAvailable } from '../utils/subagent-probe.js';
import { getPendingDiagnosticianTasks } from '../core/diagnostician-task-store.js';
import {
  matchEmpathyKeywords,
  loadKeywordStore,
  saveKeywordStore,
  shouldTriggerOptimization,
  getKeywordStoreSummary,
} from '../core/empathy-keyword-matcher.js';
import { severityToPenalty, DEFAULT_EMPATHY_KEYWORD_CONFIG } from '../core/empathy-types.js';
import { CorrectionCueLearner } from '../core/correction-cue-learner.js';
import { EventLogService } from '../core/event-log.js';
import type { PluginRuntimeSubagent } from '../service/subagent-workflow/runtime-direct-driver.js';

/**
 * Type assertion: OpenClaw SDK subagent -> workflow manager subagent type.
 * Both types are structurally identical but come from different import paths.
 */
function toWorkflowSubagent(
  subagent: NonNullable<OpenClawPluginApi['runtime']>['subagent']
): PluginRuntimeSubagent {
  return subagent as unknown as PluginRuntimeSubagent;
}

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
function extractRecentMessages(messages: unknown[] | undefined, limit: number): string[] {
  if (!Array.isArray(messages)) return [];
  const userMessages: string[] = [];
  
  for (let i = messages.length - 1; i >= 0 && userMessages.length < limit; i--) {
    const msg = messages[i] as { role?: string; content?: unknown };
    if (msg?.role !== 'user') continue;
    
    let text = '';
    if (typeof msg.content === 'string') {
      text = msg.content;
    } else if (Array.isArray(msg.content)) {
      text = msg.content
        .filter((part: unknown) => part && typeof part === 'object' && (part as { type?: string }).type === 'text' && typeof (part as { text?: unknown }).text === 'string')
        .map((part: unknown) => (part as { text: string }).text)
        .join('\n')
        .trim();
    }
    if (text) userMessages.unshift(text.substring(0, 500));
  }
  
  return userMessages;
}

/**
 * Build prompt for keyword optimization subagent.
 */
function buildOptimizationPrompt(
  keywordStore: ReturnType<typeof loadKeywordStore>,
  recentMessages: string[],
): string {
  const currentTerms = Object.entries(keywordStore.terms)
    .map(([term, entry]) => `  - "${term}": weight=${entry.weight}, hits=${entry.hitCount || 0}, fp_rate=${entry.falsePositiveRate?.toFixed(2) || '0.10'}`)
    .join('\n');

  return `You are an empathy keyword optimizer.

## TASK
Analyze recent user messages and the current empathy keyword store.
Return STRICT JSON (no markdown):

{"updates": {"TERM": {"action": "add|update|remove", "weight": number, "falsePositiveRate": number, "reasoning": "string"}}}

## Current Keyword Store (${Object.keys(keywordStore.terms).length} terms):
${currentTerms}

## Recent User Messages (${recentMessages.length} messages):
${recentMessages.map((m, i) => `${i + 1}. "${m}"`).join('\n')}

## Rules:
- ADD: If a message contains frustration/empathy signals not in current terms
- UPDATE: If a term's weight should change (high hits → increase weight, low hits → decrease)
- REMOVE: If a term has 0 hits after many turns AND high false positive rate (>0.3)
- Keep reasoning concise (max 100 chars)
- Weight range: 0.1-0.9
- falsePositiveRate range: 0.05-0.5
`;
}

export async function handleBeforePromptBuild(
  event: PluginHookBeforePromptBuildEvent,
  ctx: PluginHookAgentContext & { api?: PromptHookApi }
): Promise<PluginHookBeforePromptBuildResult | void> {
  const {workspaceDir} = ctx;
  const logger = ctx.api?.logger;
  logger?.info?.(`[PD:Prompt] handleBeforePromptBuild called: workspaceDir=${!!workspaceDir}, trigger=${ctx.trigger}, sessionId=${ctx.sessionId?.substring(0, 20)}`);
  if (!workspaceDir) {
    logger?.warn?.(`[PD:Prompt] workspaceDir is missing — skipping empathy processing`);
    return;
  }

  // ──── DEBUG: Verify subagent availability in this context ────
  const subagent = ctx.api?.runtime?.subagent;
  logger?.info?.(`[PD:DEBUG:SubagentCheck] trigger=${ctx.trigger}, subagent_exists=${!!subagent}, subagent.run_exists=${!!subagent?.run}`);
  if (subagent?.run) {
    logger?.info?.('[PD:DEBUG:SubagentCheck] run entrypoint is callable');
  }

  const wctx = WorkspaceContext.fromHookContext(ctx);
  const { trigger, sessionId, api } = ctx;
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
        correctionCue = detectCorrectionCue(userText);
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
  const contextConfig = loadContextInjectionConfig(workspaceDir);

  // Minimal mode: heartbeat and subagents skip most context to reduce tokens
  const isMinimalMode = trigger === "heartbeat" || trigger === "cron" || sessionId?.includes(":subagent:") === true;

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

          logger?.info?.(`[PD:Empathy] MATCH: "${matchResult.matchedTerms.join(', ')}" → severity=${matchResult.severity}, score=${matchResult.score.toFixed(2)}, penalty=${penalty}, subagent=${shouldCallSubagent ? samplingReason : 'skipped(' + (matchResult.score >= 0.3 ? 'boundary_sampling' : 'random_discovery') + ')'}`);
        } else {
          // Log unmatched messages periodically for coverage analysis
          if (turnCount > 0 && turnCount % 50 === 0) {
            const sampleMsg = latestUserMessage.substring(0, 80).replace(/\n/g, ' ');
            logger?.debug?.(`[PD:Empathy] NO_MATCH: "${sampleMsg}" (turn ${turnCount}, keywords_in_store=${Object.keys(keywordStore.terms).length})`);
          }
        }

        // Trigger subagent for sampling cases (Finding #1: use shared manager to avoid leaks)
        const runtimeSubagent =
          isSubagentRuntimeAvailable(api?.runtime?.subagent)
            ? api.runtime.subagent
            : undefined;

        if (shouldCallSubagent && runtimeSubagent) {
          logger?.info?.(`[PD:Empathy] SUBAGENT_SAMPLE: reason=${samplingReason}, score=${matchResult.score.toFixed(2)}, matched=[${matchResult.matchedTerms.join(',')}]`);

          // EmpathyObserverWorkflowManager auto-finalizes via wait poll mechanism.
          // Create a fresh manager per invocation to ensure clean state.
          const empathyManager = new EmpathyObserverWorkflowManager({
            workspaceDir,
            logger: api.logger ?? console,
             
            subagent: toWorkflowSubagent(runtimeSubagent),
          });
          empathyManager.startWorkflow(empathyObserverWorkflowSpec, {
            parentSessionId: sessionId,
            workspaceDir,
            taskInput: latestUserMessage,
          }).catch((err) => {
            if (!isExpectedSubagentError(err)) {
              api.logger?.warn?.(`[PD:Empathy] subagent sample failed: ${String(err)}`);
            }
          });
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

          // Start keyword optimization subagent to update weights and discover new terms
          try {
            const recentMessages = extractRecentMessages(event.messages, 10);
            const optimizationPrompt = buildOptimizationPrompt(keywordStore, recentMessages);
            
            logger?.info?.(`[PD:Empathy] Starting optimization subagent with ${recentMessages.length} recent messages`);
            
            const empathyManager = new EmpathyObserverWorkflowManager({
              workspaceDir,
              logger: api.logger ?? console,
               
              subagent: toWorkflowSubagent(api.runtime.subagent),
            });
            
            empathyManager.startWorkflow(empathyObserverWorkflowSpec, {
              parentSessionId: sessionId,
              workspaceDir,
              taskInput: { prompt: optimizationPrompt },
            }).catch((err) => {
              if (!isExpectedSubagentError(err)) {
                api.logger?.warn?.(`[PD:Empathy] optimization subagent failed: ${String(err)}`);
              }
            });
          } catch (optErr) {
            if (!isExpectedSubagentError(optErr)) {
              logger?.warn?.(`[PD:Empathy] Failed to start optimization subagent: ${String(optErr)}`);
            }
          }
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
          const {totalHits} = keywordStore.stats;
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

// HEARTBEAT_OK removed - tasks must always be processed
</heartbeat_checklist>\n`;
      } catch (e) {
        logger?.error(`[PD:Prompt] Failed to read HEARTBEAT: ${String(e)}`);
      }
    }

    // ──── 4b. Inject pending diagnostician tasks (compact summary) ────
    // FIX (#283/#380): The evolution worker writes pain diagnosis tasks to
    // diagnostician_tasks.json. The heartbeat prompt hook must read and inject
    // them so the LLM (acting as diagnostician) can process them.
    //
    // INJECTION FORMAT: Compact summary (not full prompt) to stay well within
    // OpenClaw's ~10 000 char platform limit.  Full task.prompt can be 2–4 KB;
    // the compact block is < 400 chars.  The agent is instructed to read the
    // original from diagnostician_tasks.json if it needs the full context.
    try {
      const pendingTasks = getPendingDiagnosticianTasks(wctx.stateDir);
      if (pendingTasks.length > 0) {
        pendingDiagTaskCount = pendingTasks.length;

        // Build compact summary blocks — one per task (only first is processed per heartbeat)
        const taskBlocks = pendingTasks
          .slice(0, 1)
          .map(({ id, task }) => {
            // Extract summary fields; reason is truncated to 200 chars to keep
            // the injected block small and stable.
            const reason = (task.prompt
              .match(/reason["\s:]+([^\n]{0,240})/i)?.[1]
              ?? task.prompt.slice(0, 200)
            ).slice(0, 200);

            const markerFile = `.evolution_complete_${id}`;
            const reportFile = `.diagnostician_report_${id}.json`;

            return `<diagnostician_task id="${id}">
task_id: ${id}
reason: ${reason}
marker: ${markerFile}
report: ${reportFile}
queued_at: ${task.createdAt}
action: Analyze pain signal → identify violated principles → write ${markerFile} + ${reportFile}
</diagnostician_task>`;
          })
          .join('\n\n');

        const processingNote = pendingDiagTaskCount > 1
          ? `\n\nNOTE: ${pendingDiagTaskCount - 1} more task(s) are queued. ` +
            `Process one at a time; remaining tasks are handled on subsequent heartbeats.`
          : '';

        prependContext += `<diagnostician_tasks pending="${pendingDiagTaskCount}">
You are acting as a **Pain Diagnostician**. For each task:
1. Read the full prompt from: ${wctx.stateDir}/diagnostician_tasks.json [task_id=${pendingTasks[0]?.id}]
2. Analyze the pain signal and its context
3. Identify the root cause and violated principles
4. Write a completion marker: .evolution_complete_<TASK_ID>
5. Write a diagnostic report: .diagnostician_report_<TASK_ID>.json

${taskBlocks}${processingNote}
</diagnostician_tasks>\n`;

        logger?.info?.(
          `[PD:Prompt] Injected compact diagnostician task block ` +
          `(task=${pendingTasks[0]?.id}, total_pending=${pendingDiagTaskCount})`
        );

        // C: Record heartbeat_diagnosis event for observability
        try {
          const eventLog = EventLogService.get(wctx.stateDir, logger);
          eventLog.recordHeartbeatDiagnosis({
            taskCount: pendingDiagTaskCount,
            taskIds: pendingTasks.slice(0, 1).map(t => t.id),
            trigger: 'heartbeat',
          });
        } catch (evErr) {
          logger?.warn?.(`[PD:Prompt] Failed to record heartbeat_diagnosis event: ${String(evErr)}`);
        }
      }
    } catch (e) {
      logger?.warn?.(`[PD:Prompt] Failed to read diagnostician tasks: ${String(e)}`);
    }
  }

  // ──── 6. Dynamic Attitude Matrix (based on GFI) ────
   
   
  let attitudeDirective: string;
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


  // Evolution principles injection — budget-aware selection (SDK-QUAL-04)
  let evolutionPrinciplesContent = '';
  try {
    const reducer = wctx.evolutionReducer;
    const allActive = reducer.getActivePrinciples();
    const allProbation = reducer.getProbationPrinciples();

    // Budget-aware selection: prioritize P0>P1>P2 and recency
    const activeSelection = selectPrinciplesForInjection(allActive, DEFAULT_PRINCIPLE_BUDGET);
    const active = activeSelection.selected;

    // Probation principles get a smaller sub-budget (1000 chars)
    const probationBudget = 1000;
    const probationSelection = selectPrinciplesForInjection(allProbation, probationBudget);
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
  // See: https://github.com/csuzngjh/principles/issues/XXX
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
  // Hard cap for OpenClaw prompt injection. OpenClaw's actual platform limit is
  // approximately 10 000 characters. We use 9 000 here to leave ~1 000 chars of
  // headroom for the user's message, tool call delimiters, and encoding overhead.
  // IMPORTANT: PD must never treat the platform's upper bound as its own safe
  // working limit. Always keep a margin.
  const totalSize = prependSystemContext.length + prependContext.length + appendSystemContext.length;
  const MAX_INJECTION_SIZE = 9000;

  if (totalSize > MAX_INJECTION_SIZE) {
    const originalSize = totalSize;
    const truncationLog: string[] = [];

    // Deterministically remove low-priority context blocks in priority order.
    // In diagnostician-priority mode we aggressively strip everything except
    // the task block and minimum behavioral constraints.
    const inDiagMode = pendingDiagTaskCount > 0;

    // Step 1 — strip project_context (largest, lowest priority)
    if (projectContextContent && appendSystemContext.includes('<project_context>')) {
      appendSystemContext = appendSystemContext.replace(
        `<project_context>\n${projectContextContent}\n</project_context>`,
        '<project_context>\n[stripped: project_context]\n</project_context>'
      );
      truncationLog.push('project_context');
    }

    // Step 2 — strip thinking_os
    if (thinkingOsContent && appendSystemContext.includes('<thinking_os>')) {
      appendSystemContext = appendSystemContext.replace(
        `<thinking_os>\n${thinkingOsContent}\n</thinking_os>`,
        '<thinking_os>\n[stripped: thinking_os]\n</thinking_os>'
      );
      truncationLog.push('thinking_os');
    }

    // Step 3 — strip evolution_principles (keep core_principles only)
    if (evolutionPrinciplesContent && appendSystemContext.includes('<evolution_principles>')) {
      appendSystemContext = appendSystemContext.replace(
        `<evolution_principles>\n${evolutionPrinciplesContent}\n</evolution_principles>`,
        '<evolution_principles>\n[stripped: evolution_principles]\n</evolution_principles>'
      );
      truncationLog.push('evolution_principles');
    }

    // Step 4 — strip reflection_log if present
    if (appendSystemContext.includes('<reflection_log>')) {
      appendSystemContext = appendSystemContext.replace(
        /<reflection_log>[\s\S]*?<\/reflection_log>/,
        '<reflection_log>\n[stripped: reflection_log]\n</reflection_log>'
      );
      truncationLog.push('reflection_log');
    }

    // Step 5 — re-evaluate: check if still over limit
    let newSize = prependSystemContext.length + prependContext.length + appendSystemContext.length;
    if (newSize > MAX_INJECTION_SIZE) {
      // In diagnostician-priority mode also truncate the task reason as a last resort.
      // This is safe because the full prompt is still available in
      // diagnostician_tasks.json for the agent to read if needed.
      prependContext = prependContext.replace(
        /(reason["\s\S]{0,10})([^<]{200,})/,
        (_, prefix, rest) => prefix + rest.slice(0, 120) + '...[truncated]'
      );
      newSize = prependSystemContext.length + prependContext.length + appendSystemContext.length;
      truncationLog.push('diagnostician_reason');
    }

    // FAIL-CLOSED: if we are still over the limit after all deterministic
    // removals, do NOT return a prompt that exceeds MAX_INJECTION_SIZE.
    // Drop the entire appendSystemContext (keep only prependContext +
    // prependSystemContext) and log a hard error.
    if (newSize > MAX_INJECTION_SIZE) {
      const fallbackContext = `
## 【CONTEXT SECTIONS】

[WARNING: Context sections stripped due to prompt size constraints.
This is a diagnostician-priority session — see diagnostician_tasks.json for full task context.]

${attitudeDirective}
`.trim();

      appendSystemContext = fallbackContext;
      newSize = prependSystemContext.length + prependContext.length + appendSystemContext.length;

      logger?.error(
        `[PD:Prompt] PROMPT OVER LIMIT AFTER ALL REDUCTIONS — using fallback. ` +
        `Original: ${originalSize}, Current: ${newSize}, Limit: ${MAX_INJECTION_SIZE}. ` +
        `Stripped: ${truncationLog.join(', ')}. Diagnostician mode: ${inDiagMode}.`
      );
    } else {
      logger?.warn(
        `[PD:Prompt] Injection size exceeded: ${originalSize} chars (limit: ${MAX_INJECTION_SIZE}), ` +
        `truncated: ${truncationLog.join(', ') || 'none'}, new size: ${newSize} chars, ` +
        `diagnostician mode: ${inDiagMode}`
      );
    }
  }

  return {
    prependSystemContext,
    prependContext,
    appendSystemContext
  };
}
