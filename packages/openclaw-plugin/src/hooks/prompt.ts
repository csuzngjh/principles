 
 
import * as fs from 'fs';
import * as path from 'path';
import type { PluginHookBeforePromptBuildEvent, PluginHookAgentContext, PluginHookBeforePromptBuildResult, PluginLogger } from '../openclaw-sdk.js';
import { clearInjectedProbationIds, getSession, resetFriction, setInjectedProbationIds, trackFriction, decayGfi, getGfiDecayElapsed } from '../core/session-tracker.js';
import { WorkspaceContext } from '../core/workspace-context.js';
import type { ContextInjectionConfig} from '../types.js';
import { defaultContextConfig } from '../types.js';
// local-worker-routing module and its routing helpers removed entirely per PRI-448.
// Routing guidance is no longer injected into prompts.
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
  applyKeywordUpdates,
  getKeywordStoreSummary,
} from '../core/empathy-keyword-matcher.js';
import { severityToPenalty, DEFAULT_EMPATHY_KEYWORD_CONFIG } from '../core/empathy-types.js';
import { evaluatePainDiagnosticGate } from '../core/pain-diagnostic-gate.js';
import { emitPainDetectedEvent, buildTrajectoryEvidence } from './pain.js';
import { evaluateTriggerController } from '@principles/core/runtime-v2';
import { isSharedCooldownActive, markSharedEpisodeAsDiagnosed } from './trigger-cooldown-tracker.js';
import { buildEmpathyObservation, resolveSourceKind } from './raw-observation-adapter.js';
import { evaluateEvidenceTriage } from './triage-adapter.js';
import { loadFeatureFlagFromConfig } from '../core/pd-config-loader.js';
import { safeReadIntentDoc, resetIntentDocCacheForTest } from '../core/intent-doc-reader.js';
import { resolveIntentLang } from '../core/intent-doc-reader-adapter.js';
import { buildIntentFrictionBlock } from '@principles/core/runtime-v2';
import { CorrectionCueLearner } from '../core/correction-cue-learner.js';
import {
  detectCorrectionCue as coreDetectCorrectionCue,
  escapeXml,
  extractMessageContent,
  isMinimalTrigger,
} from '@principles/core/prompt-builder';
import { sanitizeForEvidence } from './message-sanitize.js';
import {
  buildAgentIdentity,
  buildEmpathySilenceConstraint,
  extractUserMessageFromPrompt,
  assembleHeartbeatChecklist,
  formatCorePrinciples,
  formatEvolutionPrinciples,
  assembleAppendSystemContext,
  extractPhrasesFromReason,
} from './prompt-helpers.js';
import type { CachedFile, PromptHookApi } from './prompt-types.js';

// ---------------------------------------------------------------------------
// Static file cache — avoids re-reading rarely-changing files every message
// ---------------------------------------------------------------------------
const STATIC_FILE_TTL_MS = 60_000; // 1 minute

/**
 * Per-workspace file cache. Keyed by workspaceDir to avoid cross-workspace
 * cache pollution. Previously a module-level Map keyed by filePath only.
 */
const _staticFileCache = new Map<string, Map<string, CachedFile>>();

function getOwnValue(value: object, key: string): unknown {
  if (!Object.hasOwn(value, key)) return undefined;
  return Object.getOwnPropertyDescriptor(value, key)?.value;
}

function readErrorCode(error: unknown): string | undefined {
  if (typeof error !== 'object' || error === null) return undefined;
  const code = getOwnValue(error, 'code');
  return typeof code === 'string' ? code : undefined;
}

function getFileCache(workspaceDir: string): Map<string, CachedFile> {
  let cache = _staticFileCache.get(workspaceDir);
  if (!cache) {
    cache = new Map();
    _staticFileCache.set(workspaceDir, cache);
  }
  return cache;
}

/**
 * Reads a file with TTL-based caching.
 * Returns cached content if:
 *   1. Cache entry exists and was loaded < TTL_MS ago, AND
 *   2. File mtime hasn't changed (detects external edits)
 * Otherwise re-reads from disk.
 */
function cachedReadFile(filePath: string, workspaceDir: string): string {
  const cache = getFileCache(workspaceDir);
  const now = Date.now();
  const cached = cache.get(filePath);

  try {
    const stat = fs.statSync(filePath);
    const mtime = stat.mtimeMs;

    if (cached && (now - cached.loadedAt) < STATIC_FILE_TTL_MS && cached.mtime === mtime) {
      return cached.content;
    }

    const content = fs.readFileSync(filePath, 'utf8');
    cache.set(filePath, { content, mtime, loadedAt: now });
    return content;
  } catch (error) {
    // File doesn't exist or unreadable — invalidate cache
    cache.delete(filePath);
    if (readErrorCode(error) !== 'ENOENT') {
      console.warn(`[PD:Prompt] cachedReadFile failed: path=${filePath}, workspace=${workspaceDir}, error=${String(error)}`);
    }
    return '';
  }
}

/**
 * Per-workspace empathy state. Keyed by workspaceDir to avoid cross-workspace
 * state pollution. Previously module-level variables.
 */
const _empathyState = new Map<string, { turnCounter: number; keywordCache: { store: ReturnType<typeof loadKeywordStore>; lang: string } | null }>();

function getEmpathyState(workspaceDir: string): { turnCounter: number; keywordCache: { store: ReturnType<typeof loadKeywordStore>; lang: string } | null } {
  let state = _empathyState.get(workspaceDir);
  if (!state) {
    state = { turnCounter: 0, keywordCache: null };
    _empathyState.set(workspaceDir, state);
  }
  return state;
}

/**
 * Reset all module-level prompt state for a workspace.
 * Intended for test isolation — call in beforeEach().
 */
export function resetPromptStateForTest(workspaceDir?: string): void {
  if (workspaceDir) {
    _staticFileCache.delete(workspaceDir);
    _empathyState.delete(workspaceDir);
    resetIntentDocCacheForTest(workspaceDir);
  } else {
    _staticFileCache.clear();
    _empathyState.clear();
    resetIntentDocCacheForTest();
  }
}

function parseContextInjectionConfig(value: unknown): ContextInjectionConfig | null {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return null;

  const config: ContextInjectionConfig = { ...defaultContextConfig };
  const thinkingOs = getOwnValue(value, 'thinkingOs');
  const projectFocus = getOwnValue(value, 'projectFocus');
  const evolutionContext = getOwnValue(value, 'evolutionContext');

  if (thinkingOs !== undefined) {
    if (typeof thinkingOs !== 'boolean') return null;
    config.thinkingOs = thinkingOs;
  }

  if (projectFocus !== undefined) {
    if (projectFocus !== 'full' && projectFocus !== 'summary' && projectFocus !== 'off') return null;
    config.projectFocus = projectFocus;
  }

  if (evolutionContext !== undefined) {
    if (typeof evolutionContext !== 'object' || evolutionContext === null || Array.isArray(evolutionContext)) return null;

    config.evolutionContext = { ...defaultContextConfig.evolutionContext };
    const enabled = getOwnValue(evolutionContext, 'enabled');
    const maxMessages = getOwnValue(evolutionContext, 'maxMessages');
    const maxCharsPerMessage = getOwnValue(evolutionContext, 'maxCharsPerMessage');

    if (enabled !== undefined) {
      if (typeof enabled !== 'boolean') return null;
      config.evolutionContext.enabled = enabled;
    }
    if (maxMessages !== undefined) {
      if (typeof maxMessages !== 'number' || !Number.isFinite(maxMessages)) return null;
      config.evolutionContext.maxMessages = maxMessages;
    }
    if (maxCharsPerMessage !== undefined) {
      if (typeof maxCharsPerMessage !== 'number' || !Number.isFinite(maxCharsPerMessage)) return null;
      config.evolutionContext.maxCharsPerMessage = maxCharsPerMessage;
    }
  }

  return config;
}

/**
 * OpenClaw API Prompt Hook
 * Constructs the system prompt injected into LLM context for Principles Disciple
 */


/**
 * Loads context injection config from .principles/PROFILE.json
 * Parses contextInjection configuration from PROFILE.json for context injection
 * @internal Used by evolution engine for context settings
 */
export function loadContextInjectionConfig(workspaceDir: string): ContextInjectionConfig {
  const profilePath = path.join(workspaceDir, '.principles', 'PROFILE.json');

  try {
    const raw = cachedReadFile(profilePath, workspaceDir);
    if (raw) {
      const profile = JSON.parse(raw);
      if (profile && typeof profile === 'object' && !Array.isArray(profile)) {
        const contextInjection = getOwnValue(profile, 'contextInjection');
        if (contextInjection !== undefined) {
          const parsed = parseContextInjectionConfig(contextInjection);
          if (!parsed) {
            console.warn(`[PD:Prompt] Invalid contextInjection config in ${profilePath}; using defaults.`);
            return { ...defaultContextConfig };
          }
          return parsed;
        }
      }
    }
  } catch (e) {
    // Failed to load config — continue with defaults, but log for diagnostics
     
    console.warn(`[PD:Prompt] Failed to load contextInjection config: ${String(e)}`);
  }
  
  return { ...defaultContextConfig };
}

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
      const userText = extractMessageContent(latestUserIndex.message);

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
  // ──── 0. Manual Pain Clearance ────
  if (trigger === 'user' && sessionId && session && session.currentGfi >= 100) {
    resetFriction(sessionId, workspaceDir);
  }

  // ──── 1. prependSystemContext: Minimal Agent Identity ────
  // EvolutionWorker-era INTERNAL SYSTEM LAYOUT removed per PRI-294.
  // The EVOLUTION_WORKER PathResolver key and system layout reference are
  // not MVP-Core; agents discover what they need via tool calls.
  prependSystemContext = buildAgentIdentity();

  // ──── 2. Empathy Observer Spawn (async sidecar)
  const empathySilenceConstraint = buildEmpathySilenceConstraint();

  // ─────────────────────────────────────────────────3. Empathy Observer Spawn
  // Extract actual user message from prompt (handles boot checks + Feishu wrappers).
  // Also detects empathy observer output (prevent recursion) and agent-to-agent messages.
  const { message: latestUserMessage, isAgentToAgent } =
    extractUserMessageFromPrompt(event.prompt || '', sessionId);

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

        // Load keyword store once, cache per-workspace (Finding #7: avoid per-turn I/O)
        const empathyState = getEmpathyState(workspaceDir);
        if (!empathyState.keywordCache || empathyState.keywordCache.lang !== lang) {
          empathyState.keywordCache = { store: loadKeywordStore(wctx.stateDir, lang), lang };
        }
        const keywordStore = empathyState.keywordCache.store;

        const matchResult = matchEmpathyKeywords(latestUserMessage, keywordStore);

        // Increment turn counter (Finding #3: session.turnCount doesn't exist)
        empathyState.turnCounter++;
        const turnCount = empathyState.turnCounter;
        const painTrigger = wctx.config.get('thresholds.pain_trigger') || 40;
        const highGfiThreshold = Math.max(wctx.config.get('severity_thresholds.high') || 70, painTrigger + 30);

        if (matchResult.matched) {
          const penalty = severityToPenalty(matchResult.severity, DEFAULT_EMPATHY_KEYWORD_CONFIG);
          // trackFriction signature: (sessionId, deltaF: number, hash: string, workspaceDir?, options?)
          trackFriction(sessionId, penalty, 'empathy_keyword_match', workspaceDir, {
            source: 'user_empathy',
          });

          logger?.info?.(`[PD:Empathy] MATCH: "${matchResult.matchedTerms.join(', ')}" → severity=${matchResult.severity}, score=${matchResult.score.toFixed(2)}, penalty=${penalty}`);

          const currentSession = getSession(sessionId);
          const currentGfi = currentSession?.currentGfi ?? 0;

          if (currentGfi >= highGfiThreshold) {
            const gfiPainScore = Math.min(Math.round(currentGfi), 60);
            logger?.info?.(`[PD:Empathy] GFI-TRIGGERED: currentGfi=${currentGfi.toFixed(1)} >= highGfi=${highGfiThreshold}, emitting pain signal (score=${gfiPainScore})`);

            // PRI-454: Dual-gate migration. When both flags ON → Gate B (TriggerController).
            // When either OFF → Gate A (PainDiagnosticGate, rollback).
            const triageFlag = loadFeatureFlagFromConfig(workspaceDir, 'painEvidenceAdmission');
            const defaultFlag = loadFeatureFlagFromConfig(workspaceDir, 'painEvidenceAdmissionDefault');
            const useGateB = triageFlag.enabled && defaultFlag.enabled;

            wctx.eventLog.recordPainSignal(sessionId, {
              score: gfiPainScore,
              source: 'user_empathy',
              reason: `Accumulated GFI (${currentGfi.toFixed(1)}) crossed highGfi threshold (${highGfiThreshold}). Matched: ${matchResult.matchedTerms.join(', ')}`,
              isRisky: false,
              origin: 'system_infer',
              severity: gfiPainScore >= 40 ? 'moderate' : 'mild',
              confidence: 0.5,
              detection_mode: 'structured',
              deduped: false,
              trigger_text_excerpt: sanitizeForEvidence(latestUserMessage, workspaceDir).substring(0, 120),
              raw_score: gfiPainScore,
              calibrated_score: gfiPainScore,
              eventId: `empathy_gfi_${Date.now()}`,
            });

            // PRI-453: Generate painId early and write to trajectory.db via legacy
            // recordPainEvent so that disabling SDK observability path does not lose
            // trajectory coverage. canonicalPainId enables dedup.
            const gfiPainId = `empathy_gfi_${Date.now()}`;
            wctx.trajectory?.recordPainEvent?.({
              sessionId,
              source: 'user_empathy',
              score: gfiPainScore,
              reason: `Accumulated GFI (${currentGfi.toFixed(1)}) crossed highGfi threshold (${highGfiThreshold}). Matched: ${matchResult.matchedTerms.join(', ')}`,
              origin: 'system_infer',
              canonicalPainId: gfiPainId,
            });

            if (useGateB) {
              // PRI-454: Gate B path — TriggerController owns admission
              const rawObs = buildEmpathyObservation({
                detectionSource: 'user_empathy',
                isGfiTriggered: true,
                sessionId,
              });
              const sourceKind = resolveSourceKind(rawObs);
              const triage = evaluateEvidenceTriage(sourceKind, gfiPainScore);
              if (triage.decision !== 'admit') {
                logger?.info?.(`[PD:Empathy] Triage ${triage.decision}: ${triage.reason}`);
              } else {
                const cooldownActive = isSharedCooldownActive(sourceKind, sessionId, 'empathy_gfi_threshold');
                const triggerDecision = evaluateTriggerController({
                  triageResult: triage,
                  isOwnerManual: false,
                  isCooldownActive: cooldownActive,
                  isValid: true,
                  score: gfiPainScore,
                  sessionId,
                });
                if (triggerDecision.shouldCreateDiagnosticTask) {
                  markSharedEpisodeAsDiagnosed(sourceKind, sessionId, 'empathy_gfi_threshold');
                  logger?.info?.(`[PD:Empathy] Gate B approved, calling emitPainDetectedEvent...`);
                  try {
                    const evidence = buildTrajectoryEvidence(wctx, sessionId);
                    await emitPainDetectedEvent(wctx, {
                      ts: new Date().toISOString(),
                      type: 'pain_detected',
                      data: {
                        painId: gfiPainId,
                        painType: 'user_frustration',
                        source: 'user_empathy',
                        reason: `Accumulated GFI (${currentGfi.toFixed(1)}) crossed highGfi threshold (${highGfiThreshold}). Matched: ${matchResult.matchedTerms.join(', ')}`,
                        score: gfiPainScore,
                        sessionId,
                        agentId: 'main',
                        provenance: 'openclaw_context_bound',
                        evidence,
                      },
                    }, { recordObservability: false });
                    logger?.info?.(`[PD:Empathy] emitPainDetectedEvent completed (GFI-triggered)`);
                  } catch (emitErr) {
                    console.error(`[PD:Empathy] FAILED to emit GFI-triggered pain event: ${String(emitErr)}`);
                    logger?.warn?.(`[PD:Empathy] Failed to emit GFI-triggered pain event: ${String(emitErr)}`);
                  }
                } else {
                  logger?.info?.(`[PD:Empathy] Gate B skipped: ${triggerDecision.reason}`);
                }
              }
            } else {
              // PRI-454: Gate A path (rollback when either flag is OFF)
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

              if (gate.shouldDiagnose) {
                logger?.info?.(`[PD:Empathy] Gate approved, calling emitPainDetectedEvent...`);
                try {
                  const evidence = buildTrajectoryEvidence(wctx, sessionId);
                  await emitPainDetectedEvent(wctx, {
                    ts: new Date().toISOString(),
                    type: 'pain_detected',
                    data: {
                      painId: gfiPainId,
                      painType: 'user_frustration',
                      source: 'user_empathy',
                      reason: `Accumulated GFI (${currentGfi.toFixed(1)}) crossed highGfi threshold (${highGfiThreshold}). Matched: ${matchResult.matchedTerms.join(', ')}`,
                      score: gfiPainScore,
                      sessionId,
                      agentId: 'main',
                      provenance: 'openclaw_context_bound',
                      evidence,
                    },
                  }, { recordObservability: false });
                  logger?.info?.(`[PD:Empathy] emitPainDetectedEvent completed (GFI-triggered)`);
                } catch (emitErr) {
                  console.error(`[PD:Empathy] FAILED to emit GFI-triggered pain event: ${String(emitErr)}`);
                  logger?.warn?.(`[PD:Empathy] Failed to emit GFI-triggered pain event: ${String(emitErr)}`);
                }
              } else {
                logger?.info?.(`[PD:Empathy] GFI-triggered gate rejected: ${gate.detail}`);
              }
            }
          }

        } else {
          // ── Pipeline: Observer only runs when keyword matcher misses ──
          const observer = resolveEmpathyObserver(wctx, logger);
          if (observer) {
            const scheduler = new AgentScheduler();
            scheduler.register({
              agentId: 'empathy-observer',
              mode: 'realtime',
              runner: observer,
            });

            logger?.info?.(`[PD:Empathy] Pipeline: Triggering background Empathy Observer for unmatched message: "${msgPreview}"`);

            void scheduler.dispatch('empathy-observer', { userMessage: latestUserMessage })
              .then(async (result) => {
                if (result.damageDetected) {
                  logger?.info?.(`[PD:Empathy] Pipeline: Background Empathy Observer detected damage. Severity: ${result.severity}, Reason: ${result.reason}`);

                  // ── Persistence Contract ──
                  const painScore = scoreFromSeverityForSpec(result.severity, wctx);

                  trackFriction(
                    sessionId,
                    painScore,
                    `observer_empathy_${result.severity}`,
                    workspaceDir,
                    { source: 'user_empathy' }
                  );

                  // ── Pipeline: feed back newly detected expressions into keyword store ──
                  if (result.reason) {
                    const rawLang = wctx.config.get('language');
                    const lang: 'zh' | 'en' = rawLang === 'en' ? 'en' : 'zh';
                    const phrases = extractPhrasesFromReason(result.reason, lang);
                    if (phrases.length > 0) {
                      const updates: Record<string, { action: 'add'; weight: number; falsePositiveRate: number; reasoning: string }> = {};
                      for (const phrase of phrases) {
                        if (!Object.hasOwn(keywordStore.terms, phrase)) {
                          updates[phrase] = {
                            action: 'add',
                            weight: 0.4,
                            falsePositiveRate: 0.3,
                            reasoning: `Discovered by empathy observer: ${result.reason.substring(0, 100)}`,
                          };
                        }
                      }
                      if (Object.keys(updates).length > 0) {
                        const { added } = applyKeywordUpdates(keywordStore, updates);
                        if (added > 0) {
                          saveKeywordStore(wctx.stateDir, keywordStore);
                          logger?.info?.(`[PD:Empathy] Pipeline: added ${added} new terms from observer feedback`);
                        }
                      }
                    }
                  }

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
                    trigger_text_excerpt: sanitizeForEvidence(latestUserMessage, workspaceDir).substring(0, 120),
                    raw_score: painScore,
                    calibrated_score: painScore,
                    eventId,
                  });

                  // PRI-453: Generate painId early to pass as canonicalPainId for dedup.
                  // Declared outside try block so it's accessible to emitPainDetectedEvent
                  // later (lineage consistency: same id for trajectory + emitted event).
                  const observerPainId = `empathy_gfi_${Date.now()}`;
                  try {
                    wctx.trajectory?.recordPainEvent?.({
                      sessionId,
                      source: 'user_empathy',
                      score: painScore,
                      reason: result.reason || 'Empathy observer detected likely user frustration.',
                      severity: result.severity,
                      origin: 'system_infer',
                      confidence: result.confidence,
                      text: sanitizeForEvidence(latestUserMessage, workspaceDir),
                      canonicalPainId: observerPainId,
                    });
                  } catch (error) {
                    logger?.warn?.(`[PD:Empathy] Failed to persist trajectory: ${String(error)}`);
                  }

                  // Check if GFI triggers a pain event post-LLM validation
                  const freshSession = getSession(sessionId);
                  const freshGfi = freshSession?.currentGfi ?? 0;
                  if (freshGfi >= highGfiThreshold) {
                    const freshGfiPainScore = Math.min(Math.round(freshGfi), 60);
                    // PRI-454: Dual-gate migration. When both flags ON → Gate B (TriggerController).
                    // When either OFF → Gate A (PainDiagnosticGate, rollback).
                    const triageFlag = loadFeatureFlagFromConfig(workspaceDir, 'painEvidenceAdmission');
                    const defaultFlag = loadFeatureFlagFromConfig(workspaceDir, 'painEvidenceAdmissionDefault');
                    const useGateB = triageFlag.enabled && defaultFlag.enabled;

                    if (useGateB) {
                      // PRI-454: Gate B path — TriggerController owns admission
                      const rawObs = buildEmpathyObservation({
                        detectionSource: 'user_empathy',
                        isGfiTriggered: true,
                        sessionId,
                      });
                      const sourceKind = resolveSourceKind(rawObs);
                      const triage = evaluateEvidenceTriage(sourceKind, freshGfiPainScore);
                      if (triage.decision !== 'admit') {
                        logger?.info?.(`[PD:Empathy] Pipeline observer triage ${triage.decision}: ${triage.reason}`);
                      } else {
                        const cooldownActive = isSharedCooldownActive(sourceKind, sessionId, 'empathy_gfi_observer');
                        const triggerDecision = evaluateTriggerController({
                          triageResult: triage,
                          isOwnerManual: false,
                          isCooldownActive: cooldownActive,
                          isValid: true,
                          score: freshGfiPainScore,
                          sessionId,
                        });
                        if (triggerDecision.shouldCreateDiagnosticTask) {
                          markSharedEpisodeAsDiagnosed(sourceKind, sessionId, 'empathy_gfi_observer');
                          logger?.info?.(`[PD:Empathy] Pipeline Gate B approved (observer), calling emitPainDetectedEvent...`);
                          try {
                            const evidence = buildTrajectoryEvidence(wctx, sessionId);
                            // PRI-453: Reuse observerPainId for lineage consistency —
                            // the same id is used as canonicalPainId in recordPainEvent
                            // and as painId in the emitted event, so EvidenceChainConsoleModel
                            // can JOIN pain_events.canonical_pain_id = tasks.input_ref.
                            await emitPainDetectedEvent(wctx, {
                              ts: new Date().toISOString(),
                              type: 'pain_detected',
                              data: {
                                painId: observerPainId,
                                painType: 'user_frustration',
                                source: 'user_empathy',
                                reason: `Accumulated GFI (${freshGfi.toFixed(1)}) crossed highGfi threshold (${highGfiThreshold}). Verified by Empathy Observer.`,
                                score: freshGfiPainScore,
                                sessionId,
                                agentId: 'main',
                                provenance: 'openclaw_context_bound',
                                evidence,
                              },
                            }, { recordObservability: false });
                          } catch (emitErr) {
                            logger?.error?.(`[PD:Empathy] Pipeline FAILED to emit observer-triggered pain event: ${String(emitErr)}`);
                          }
                        } else {
                          logger?.info?.(`[PD:Empathy] Pipeline Gate B skipped (observer): ${triggerDecision.reason}`);
                        }
                      }
                    } else {
                      // PRI-454: Gate A path (rollback when either flag is OFF)
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
                        logger?.info?.(`[PD:Empathy] Pipeline GFI threshold crossed after background observer. Emitting pain signal...`);
                        try {
                          const evidence = buildTrajectoryEvidence(wctx, sessionId);
                          // PRI-453: Reuse observerPainId for lineage consistency —
                          // the same id is used as canonicalPainId in recordPainEvent
                          // and as painId in the emitted event, so EvidenceChainConsoleModel
                          // can JOIN pain_events.canonical_pain_id = tasks.input_ref.
                          await emitPainDetectedEvent(wctx, {
                            ts: new Date().toISOString(),
                            type: 'pain_detected',
                            data: {
                              painId: observerPainId,
                              painType: 'user_frustration',
                              source: 'user_empathy',
                              reason: `Accumulated GFI (${freshGfi.toFixed(1)}) crossed highGfi threshold (${highGfiThreshold}). Verified by Empathy Observer.`,
                              score: freshGfiPainScore,
                              sessionId,
                              agentId: 'main',
                              provenance: 'openclaw_context_bound',
                              evidence,
                            },
                          }, { recordObservability: false });
                        } catch (emitErr) {
                          logger?.error?.(`[PD:Empathy] Pipeline FAILED to emit observer-triggered pain event: ${String(emitErr)}`);
                        }
                      }
                    }
                  }
                } else {
                  logger?.info?.(`[PD:Empathy] Pipeline: Background Empathy Observer did not detect any damage.`);
                }
              })
              .catch((err) => {
                logger?.warn?.(`[PD:Empathy] Pipeline: Background analysis failed or rejected: ${String(err)}`);
              });
          }

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
        prependContext += assembleHeartbeatChecklist(heartbeatChecklist);
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
      principlesContent = formatCorePrinciples(activePrinciples);
    }
  } catch (e) {
    logger?.warn?.(`[PD:Prompt] Failed to load core principles from reducer: ${String(e)}`);
  }

  let thinkingOsContent = '';
  if (contextConfig.thinkingOs) {
    const thinkingOsPath = wctx.resolve('THINKING_OS');
    try {
      const cached = cachedReadFile(thinkingOsPath, wctx.workspaceDir);
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
      evolutionPrinciplesContent = formatEvolutionPrinciples(active, probation);
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

  // ── PRI-467: Intent Engineering — INTENT.md friction block injection ──
  // SPEC §5: flag off → no fs access, no cache access, no injection, no telemetry.
  // SPEC §13.1: inject only when flag on + INTENT.md exists + safeReadIntentDoc ok=true.
  // SPEC §14.1 Mode A: prompt-only — no output-hook capture, no check_emitted counter.
  let intentBlockContent: string | undefined;
  try {
    const intentFlag = loadFeatureFlagFromConfig(workspaceDir, 'intent_engineering', logger);
    if (intentFlag.enabled) {
      const intentResult = safeReadIntentDoc(workspaceDir, resolveIntentLang(workspaceDir), { logger });
      if (intentResult.ok && intentResult.doc) {
        const block = buildIntentFrictionBlock({ rawIntentMd: intentResult.doc.raw });
        if (block.length > 0) {
          intentBlockContent = block;
        }
      } else if (!intentResult.ok && intentResult.reason !== 'not_found') {
        // SPEC §13.1: missing file is silent (no debug noise). Other degraded
        // paths (oversized, read_error, flag_disabled) log a debug reason.
        logger?.debug?.(
          `[PD:Intent] INTENT.md injection skipped: reason=${intentResult.reason ?? 'unknown'}, nextAction=${intentResult.nextAction ?? 'none'}`
        );
      }
    }
  } catch (intentErr) {
    // ERR-002 — fail-open: never let INTENT injection break the prompt hook.
    logger?.warn?.(`[PD:Intent] INTENT injection failed, skipping: ${String(intentErr)}`);
  }

  // Build appendSystemContext with recency effect
  // Content order (most important last): behavioral_constraints -> project_context -> intent_block -> working_memory -> reflection_log -> thinking_os -> principles
  appendSystemContext = assembleAppendSystemContext({
    behavioralConstraints: shouldInjectBehavioralConstraints ? empathySilenceConstraint : undefined,
    projectContext: projectContextContent || undefined,
    intentBlock: intentBlockContent,
    workingMemory: workingMemoryContent || undefined,
    thinkingOs: thinkingOsContent || undefined,
    evolutionPrinciples: evolutionPrinciplesContent || undefined,
    corePrinciples: principlesContent || undefined,
  });

  // 3.5. Owner-Approved Behavior Directives (Runtime V2 activated principles)
  // PLACED IN prependSystemContext (before gateway system prompt) for highest LLM attention.
  // These are owner-reviewed, validated behavior constraints — not background context.
  if (runtimeV2PrincipleIds.size > 0) {
    const directiveText = renderPrinciplesToDirectives(dedupedV2, runtimeV2PrincipleIds, escapeXml);
    prependSystemContext += directiveText;
  }

  // Routing guidance removed per PRI-291; local-worker-routing module and its
  // routing helpers deleted per PRI-448. No routing-related content is injected.

  // ──── 8. SIZE GUARD ────
  // Delegates to @principles/core/prompt-builder/truncateInjectionToBudget
  // which handles priority stripping: project_context → intent_block →
  // thinking_os → evolution_principles → reflection_log → reason: truncation → fallback.
  // PRI-467: intentBlockContent is passed so the guard can strip INTENT by
  // exact match before falling back to the nuclear option.
  const result = truncateInjectionToBudget(
    prependSystemContext,
    prependContext,
    appendSystemContext,
    {
      blocks: { projectContextContent, intentBlockContent, thinkingOsContent, evolutionPrinciplesContent },
    }
  );

  prependSystemContext = result.prependSystemContext;
  prependContext = result.prependContext;
  appendSystemContext = result.appendSystemContext;

  if (result.truncated) {
    const logEntry = result.truncationLog.join(', ');
    if (result.appendSystemContext.includes('[WARNING: Context sections stripped')) {
      logger?.error(
        `[PD:Prompt] PROMPT OVER LIMIT AFTER ALL REDUCTIONS — using fallback. Stripped: ${logEntry}.`
      );
    } else {
      logger?.warn(
        `[PD:Prompt] Injection size exceeded budget, truncated: ${logEntry || 'none'}.`
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
  // F15 (PRI-442): empathy_observer flag is registered as MVP-Quiet (default
  // off) per ADR-0014 §2.5. Previously this flag was a dead registration —
  // registered in feature-flag-contract.ts but never read anywhere, violating
  // the PRI-239 constraint "Only flags with real consumption paths are
  // registered". Now resolveEmpathyObserver consumes the flag: when disabled
  // (the default), the LLM observer pipeline is short-circuited and the
  // keyword-matcher path (gated by empathy_engine.enabled above) continues
  // to run independently. This mirrors the pattern used by
  // shouldStartEvolutionWorker / shouldStartCorrectionObserver.
  const empathyFlag = loadFeatureFlagFromConfig(wctx.workspaceDir, 'empathy_observer', logger);
  if (!empathyFlag.enabled) {
    logger?.debug?.(`[PD:Empathy] empathy_observer flag disabled (source=${empathyFlag.source}) — LLM observer pipeline skipped`);
    return null;
  }

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

