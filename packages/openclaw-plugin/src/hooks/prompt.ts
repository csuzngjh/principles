 
 
import * as fs from 'fs';
import type { PluginHookBeforePromptBuildEvent, PluginHookAgentContext, PluginHookBeforePromptBuildResult, PluginLogger } from '../openclaw-sdk.js';
import { clearInjectedProbationIds, getSession, resetFriction, setInjectedProbationIds, decayGfi, getGfiDecayElapsed } from '../core/session-tracker.js';
import { WorkspaceContext } from '../core/workspace-context.js';
import type { ContextInjectionConfig } from '../types.js';
// local-worker-routing module and its routing helpers removed entirely per PRI-448.
// Routing guidance is no longer injected into prompts.
import { extractSummary, getHistoryVersions, parseWorkingMemorySection, workingMemoryToInjection, autoCompressFocus, safeReadCurrentFocus } from '../core/focus-history.js';
import { PathResolver } from '../core/path-resolver.js';
import { selectPrinciplesForInjection, DEFAULT_PRINCIPLE_BUDGET } from '../core/principle-injection.js';
import { getCachedMaskedPrincipleSet, RUNTIME_V2_PRINCIPLE_BUDGET, trimToBudget, renderPrinciplesToDirectives, formatCorePrinciplesList, resolveOutputLanguage, DEFAULT_OUTPUT_LANGUAGE } from '@principles/core/runtime-v2';
import type { ResolvedOutputLanguage } from '@principles/core/runtime-v2';
import { truncateInjectionToBudget } from '@principles/core/prompt-builder';
import { PromptActivationReader } from '../core/runtime-v2-prompt-activation-reader.js';
import type { ActivePrinciplePromptResult } from '@principles/host-runtime';
import { loadPdConfigForPlugin, loadFeatureFlagFromConfig } from '../core/pd-config-loader.js';
import { recordInjectionPresence, alignActivationIds, alignInjectedPrinciples } from '../core/principle-application-ledger.js';
import { setInjectedPrincipleIds } from '../core/session-tracker.js';
import { safeReadIntentDoc, resetIntentDocCacheForTest } from '../core/intent-doc-reader.js';
import { resolveIntentLang } from '../core/intent-doc-reader-adapter.js';
import { buildIntentFrictionBlock } from '@principles/core/runtime-v2';
import {
  escapeXml,
  isMinimalTrigger,
} from '@principles/core/prompt-builder';
import {
  buildGovernanceContext,
  buildEmpathySilenceConstraint,
  extractUserMessageFromPrompt,
  assembleHeartbeatChecklist,
  formatEvolutionPrinciples,
  assembleAppendSystemContext,
} from './prompt-helpers.js';
import { SignalCollectorHost, createSignalLlmClassifierFromConfig, isUserInteractionTrigger } from '../core/signal-collector-host.js';
import { createLiveSignalKeywordStore } from '../core/signal-keyword-store.js';
import type { CachedFile, PromptHookApi } from './prompt-types.js';
import type { InjectablePrinciple } from '../core/principle-injection.js';

export interface LegacyPrinciplePromptSelection {
  active: InjectablePrinciple[];
  probation: InjectablePrinciple[];
  content: string;
  selectedIds: ReadonlySet<string>;
  /** PRI-562 Phase 0: either budget-bounded selection dropped candidates. */
  wasTruncated: boolean;
}

export function selectLegacyPrinciplesForPrompt(
  workspaceDir: string,
  reducer: Pick<WorkspaceContext['evolutionReducer'], 'getActivePrinciples' | 'getProbationPrinciples'>,
  logger?: PluginLogger,
): LegacyPrinciplePromptSelection {
  const allActive = reducer.getActivePrinciples();
  const allProbation = reducer.getProbationPrinciples();
  let maskedIds = new Set<string>();
  try {
    maskedIds = getCachedMaskedPrincipleSet(workspaceDir);
  } catch (error) {
    const message = `[PD:Pruning] Failed to read review log — all principles injected: ${error instanceof Error ? error.message : String(error)}`;
    if (logger?.info) logger.info(message);
    else console.error(message);
  }
  const activeSelection = selectPrinciplesForInjection(allActive.filter((principle) => !maskedIds.has(principle.id)), DEFAULT_PRINCIPLE_BUDGET);
  const probationSelection = selectPrinciplesForInjection(allProbation.filter((principle) => !maskedIds.has(principle.id)), 1000);
  if (activeSelection.wasTruncated || probationSelection.wasTruncated) {
    logger?.info?.(`[PD:Prompt] Principles truncated: active=${activeSelection.selected.length}/${allActive.length} (${activeSelection.totalChars}c), probation=${probationSelection.selected.length}/${allProbation.length} (${probationSelection.totalChars}c)`);
  }
  const active = activeSelection.selected;
  const probation = probationSelection.selected;
  return {
    active,
    probation,
    content: active.length > 0 || probation.length > 0 ? formatEvolutionPrinciples(active, probation) : '',
    selectedIds: new Set([...active, ...probation].map((principle) => principle.id)),
    wasTruncated: activeSelection.wasTruncated || probationSelection.wasTruncated,
  };
}

// ---------------------------------------------------------------------------
// Static file cache — avoids re-reading rarely-changing files every message
// ---------------------------------------------------------------------------
const STATIC_FILE_TTL_MS = 60_000; // 1 minute

/**
 * Per-workspace file cache. Keyed by workspaceDir to avoid cross-workspace
 * cache pollution. Previously a module-level Map keyed by filePath only.
 */
const _staticFileCache = new Map<string, Map<string, CachedFile>>();
// Match OpenClaw's bounded per-run prompt cache. The session identity is part of
// the key because protocol run IDs may be reused after a run terminates.
const MAX_PROCESSED_SIGNAL_RUNS_PER_WORKSPACE = 256;
const _processedSignalRunKeys = new Map<string, Set<string>>();

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

function hasMessageRole(message: unknown, role: string): boolean {
  if (typeof message !== 'object' || message === null || !Object.hasOwn(message, 'role')) {
    return false;
  }
  return Object.getOwnPropertyDescriptor(message, 'role')?.value === role;
}

function nextUserTurnIndex(wctx: WorkspaceContext, sessionId: string, messages: readonly unknown[]): number {
  const recordedTurns = wctx.trajectory?.listUserTurnsForSession?.(sessionId) ?? [];
  if (recordedTurns.length > 0) {
    return recordedTurns.reduce((max, turn) => Math.max(max, turn.turnIndex), 0) + 1;
  }
  return messages.filter((message) => hasMessageRole(message, 'user')).length + 1;
}

function claimSignalRun(workspaceDir: string, sessionIdentity: string, runId: string): boolean {
  let runKeys = _processedSignalRunKeys.get(workspaceDir);
  if (!runKeys) {
    runKeys = new Set<string>();
    _processedSignalRunKeys.set(workspaceDir, runKeys);
  }
  const runKey = `${sessionIdentity}\u0000${runId}`;
  if (runKeys.has(runKey)) return false;

  runKeys.add(runKey);
  if (runKeys.size > MAX_PROCESSED_SIGNAL_RUNS_PER_WORKSPACE) {
    const oldestRunKey = runKeys.values().next().value;
    if (typeof oldestRunKey === 'string') runKeys.delete(oldestRunKey);
  }
  return true;
}

function hasClaimedSignalRun(workspaceDir: string, sessionIdentity: string, runId: string): boolean {
  return _processedSignalRunKeys.get(workspaceDir)?.has(`${sessionIdentity}\u0000${runId}`) ?? false;
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
 * Reset all module-level prompt state for a workspace.
 * Intended for test isolation — call in beforeEach().
 */
export function resetPromptStateForTest(workspaceDir?: string): void {
  if (workspaceDir) {
    _staticFileCache.delete(workspaceDir);
    _processedSignalRunKeys.delete(workspaceDir);
    resetIntentDocCacheForTest(workspaceDir);
  } else {
    _staticFileCache.clear();
    _processedSignalRunKeys.clear();
    resetIntentDocCacheForTest();
  }
  // CodeRabbit #6: 清理 host 缓存,避免 rate-limit/classifier 状态跨测试泄漏
  _signalCollectorHosts.clear();
}

/**
 * SignalCollectorHost 实例缓存(per-workspace)。
 * 避免每条用户消息 new 一个 host;host 内部有 rate limit 状态需跨消息保留。
 */
const _signalCollectorHosts = new Map<string, SignalCollectorHost>();

function getSignalCollectorHost(wctx: WorkspaceContext, logger?: PluginLogger): SignalCollectorHost {
  let host = _signalCollectorHosts.get(wctx.workspaceDir);
  if (!host) {
    // 从 .pd/config.yaml 的 signalCollector runtimeProfile 构造 LLM classifier(配置单轨化)。
    // 未配置/降级时返回 null,host 走纯关键词模式(spec §3.3 决策3)。
    const llmClassifier = createSignalLlmClassifierFromConfig(wctx, logger);
    // P0-B: 检测词库走 live provider(learned correction cues 无需重启即生效,
    // optimizer 写 correction_keywords.json 后下一次 detectSync 消费)。
    const liveStore = createLiveSignalKeywordStore(wctx, logger);
    host = new SignalCollectorHost(wctx, { llmClassifier, keywordStoreProvider: () => liveStore.resolve() });
    _signalCollectorHosts.set(wctx.workspaceDir, host);
  }
  return host;
}

/**
 * OpenClaw API Prompt Hook
 * Constructs the system prompt injected into LLM context for Principles Disciple
 */


/**
 * Loads context injection config from .pd/config.yaml via loadPdConfigForPlugin.
 * The resolved config is computed by the core config layer (pd-config-effective.ts),
 * which merges user partial input with DEFAULT_CONTEXT_INJECTION defaults.
 * @internal Used by evolution engine for context settings
 */
export function loadContextInjectionConfig(workspaceDir: string): ContextInjectionConfig {
  const result = loadPdConfigForPlugin(workspaceDir);
  return { ...result.effective.resolvedContextInjection };
}

/**
 * Resolve the output language for the `<core_principles>` axioms.
 *
 * Canonical SSOT (PRI-606): `.pd/config.yaml` → `principles.outputLanguage`,
 * the same source principle generation reads. `loadPdConfigForPlugin` never
 * throws (malformed config returns structured errors with effective
 * defaults), and `resolveOutputLanguage` is pure validation logic — but the
 * belt-and-braces catch below keeps the contract explicit: a config failure
 * may only degrade the LANGUAGE, never remove the axioms.
 *
 * Missing config → canonical default (no warning).
 * Malformed value/config → structured warning + canonical default (rc-9).
 */
function resolveCoreAxiomLanguage(
  workspaceDir: string,
  logger?: PluginLogger,
): ResolvedOutputLanguage {
  try {
    const configResult = loadPdConfigForPlugin(workspaceDir);
    if (!configResult.ok) {
      const reasons = configResult.errors
        .map(error => `${error.path || '(root)'}: ${error.reason}`)
        .join('; ');
      logger?.warn?.(
        `[PD:Prompt] .pd/config.yaml malformed (${reasons}). ` +
        `Core axioms fall back to default language ${DEFAULT_OUTPUT_LANGUAGE}. ` +
        `nextAction: ${configResult.errors[0]?.nextAction ?? 'Fix .pd/config.yaml and retry'}`
      );
    }
    const resolved = resolveOutputLanguage(configResult.effective.config.principles?.outputLanguage);
    if (resolved.degradationWarning) {
      logger?.warn?.(`[PD:Prompt] ${resolved.degradationWarning}`);
    }
    return resolved;
  } catch (e) {
    // Loader contract is "never throws"; if it ever does, language degrades
    // with a structured reason — the axioms themselves stay injected.
    logger?.warn?.(
      `[PD:Prompt] Core axiom language resolution failed (${String(e)}); ` +
      `falling back to default language ${DEFAULT_OUTPUT_LANGUAGE}. ` +
      `nextAction: Check that .pd/config.yaml is readable YAML`
    );
    return { outputLanguage: DEFAULT_OUTPUT_LANGUAGE };
  }
}

export async function handleBeforePromptBuild(
  event: PluginHookBeforePromptBuildEvent,
  ctx: PluginHookAgentContext & { api?: PromptHookApi },
  sharedActivePrinciplePrompt?: ActivePrinciplePromptResult,
  preparedLegacyPrinciples?: LegacyPrinciplePromptSelection,
): Promise<PluginHookBeforePromptBuildResult | void> {
  const {workspaceDir} = ctx;
  const logger = ctx.api?.logger;
  logger?.info?.(`[PD:Prompt] handleBeforePromptBuild called: workspaceDir=${!!workspaceDir}, trigger=${ctx.trigger}, sessionId=${ctx.sessionId?.substring(0, 20)}`);
  if (!workspaceDir) {
    logger?.warn?.(`[PD:Prompt] workspaceDir is missing — skipping PD context injection`);
    return;
  }

  const wctx = WorkspaceContext.fromHookContext(ctx);
  const { runId, sessionKey, trigger, sessionId } = ctx;
  const isUserInteraction = isUserInteractionTrigger(trigger);
  const api = ctx.api;
  // PRI-647: trajectory session recording and assistant-turn anchoring are
  // observability side-effects only. A closed/disposed trajectory connection
  // (plugin service stop during config hot-reload) must never abort the prompt
  // build and drop every injected principle - fail open like the other side
  // channels (evolution, Runtime V2, INTENT). OpenClaw sends the current
  // model-visible user input in event.prompt; event.messages contains prepared
  // history and must only be used for lineage and turn indexing.
  let correctionReferencesAssistantTurnId: number | null = null;
  try {
    if (sessionId) {
      wctx.trajectory?.recordSession?.({ sessionId });
    }
    if (sessionId && isUserInteraction && event.messages.some((message) => hasMessageRole(message, 'assistant'))) {
      const turns = wctx.trajectory?.listAssistantTurns?.(sessionId) ?? [];
      const lastAssistant = turns[turns.length - 1];
      correctionReferencesAssistantTurnId = lastAssistant?.id ?? null;
    }
  } catch (trajectoryErr) {
    // PRI-647 observability: record the trajectory side-channel failure as a
    // structured event (never throws) so the state stays observable without
    // changing the fail-open behavior.
    wctx.eventLog.recordTrajectoryObservabilityFailure({
      sessionId,
      reason: String(trajectoryErr).slice(0, 200),
      nextAction: 'Restart the plugin services or repair the trajectory database connection; prompt injection continues without turn anchoring.',
    });
    logger?.warn?.(
      `[PD:Prompt] Trajectory observability unavailable, continuing without turn anchoring: ${String(trajectoryErr)}`
    );
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
  prependSystemContext = buildGovernanceContext();

  // ──── 2. Empathy Observer Spawn (async sidecar)
  const empathySilenceConstraint = buildEmpathySilenceConstraint();

  // ─────────────────────────────────────────────────3. Empathy Observer Spawn
  // Extract actual user message from prompt (handles boot checks + Feishu wrappers).
  // Also detects empathy observer output (prevent recursion) and agent-to-agent messages.
  const { message: currentUserMessage, isAgentToAgent } =
    extractUserMessageFromPrompt(event.prompt, sessionId);

  // Track if we should inject behavioral constraints (will be added to appendSystemContext later)
  // 注:原 empathy 检测门控(empathyEnabled)已移除,检测职责由 SignalCollectorHost 接管。
  // behavioral 约束注入是独立职责,保留门控。
  let shouldInjectBehavioralConstraints = false;
  if (isUserInteraction && sessionId && api && !isAgentToAgent) {
    shouldInjectBehavioralConstraints = true;
  }

  // SignalCollectorHost 统一接管 correction + empathy 检测(spec §3.3 决策1)。
  // 在 isAgentToAgent 解析之后调用,避免 agent-to-agent 流量被误当用户纠正(CodeRabbit #7)。
  if (currentUserMessage && sessionId && isUserInteraction && !isAgentToAgent) {
    if (runId && hasClaimedSignalRun(wctx.workspaceDir, sessionKey ?? sessionId, runId)) {
      logger?.info?.(`[PD:Prompt] duplicate signal run skipped: runId=${runId}, sessionId=${sessionId.substring(0, 20)}`);
    } else {
      if (!runId) {
        logger?.warn?.(`[PD:Prompt] runId missing; signal collection cannot be deduplicated: sessionId=${sessionId.substring(0, 20)}`);
      }
      // trigger ?? 'api':detectSync 的 trigger 参数必须为具体值(host 内部用
      // isUserInteractionTrigger 判定,undefined 会被接受但下游日志/标签需要具体值)。
      getSignalCollectorHost(wctx, logger).detectSync(
        currentUserMessage, sessionId, trigger ?? 'api',
        {
          referencesAssistantTurnId: correctionReferencesAssistantTurnId,
          turnIndex: nextUserTurnIndex(wctx, sessionId, event.messages),
        },
      );
      if (runId) claimSignalRun(wctx.workspaceDir, sessionKey ?? sessionId, runId);
    }
  }

  // 注:SignalCollectorHost.detectSync 已在上文 correction 段(:259)统一调用一次,
  // 覆盖 correction + empathy 全部检测职责(含 lineage + turnIndex)。
  // 此处不再重复调用,避免同一消息双重写入 user_turns 和重复触发 STRONG 分流。


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

  // Core principles: ALWAYS inject the canonical foundational axioms directly
  // from the @principles/core registry (PRI-606). These are built-in axioms,
  // NOT owner-approved learned principles — those flow via <evolution_principles>.
  // PRI-606/PRI-607: only the foundational layer is injected here (the
  // NON-NEGOTIABLE highest-priority block); operating principles reach the
  // agent via THINKING_OS directives.
  //
  // Language SSOT: .pd/config.yaml → principles.outputLanguage (the same
  // source principle generation uses). Config failure degrades the LANGUAGE
  // only — never the axioms themselves: the registry is static code data and
  // stays injected even when config is unreadable.
  let principlesContent = '';
  try {
    principlesContent = formatCorePrinciplesList(
      resolveCoreAxiomLanguage(workspaceDir, logger).outputLanguage,
      'foundational',
    );
  } catch (e) {
    // rc-9: degrade to no-injection with a structured reason; never break the hook.
    // Only a registry/format defect can land here — config errors are already
    // absorbed by resolveCoreAxiomLanguage as language degradation.
    logger?.warn?.(`[PD:Prompt] Failed to load core principles from registry: ${String(e)}`);
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


  // PRI-562 Phase 0: legacy-block observability, hoisted so the injection
  // event below can carry it. Populated best-effort inside the try; stays
  // zero/absent when legacy assembly fails (rc-9: absence is observable via
  // the block's own warn log).
  let legacyInjectedIds: string[] = [];
  let legacyTotalChars = 0;
  let legacyTruncated = false;

  // Evolution principles injection — budget-aware selection (SDK-QUAL-04)
  let evolutionPrinciplesContent = '';
  try {
    const reducer = wctx.evolutionReducer;
    const selection = preparedLegacyPrinciples ?? selectLegacyPrinciplesForPrompt(wctx.workspaceDir, reducer, logger);
    const { probation } = selection;
    legacyInjectedIds = [...selection.selectedIds];
    legacyTotalChars = selection.content.length;
    legacyTruncated = selection.wasTruncated;

    if (ctx.sessionId) {
      if (probation.length > 0) {
        setInjectedProbationIds(ctx.sessionId, probation.map((p) => p.id), workspaceDir);
      } else {
        clearInjectedProbationIds(ctx.sessionId, workspaceDir);
      }
    }
    evolutionPrinciplesContent = selection.content;
  } catch (e) {
    if (ctx.sessionId) {
      clearInjectedProbationIds(ctx.sessionId, workspaceDir);
    }
    logger?.warn?.(`[PD:Prompt] Failed to load evolution principles: ${String(e)}`);
  }

  let runtimeV2PrinciplesContent = '';
  const runtimeV2PrincipleIds = new Set<string>();
  let v2Truncated: boolean | undefined;
  // Hoisted so the owner_approved_behavior_directives section can access them
  let dedupedV2: Array<{ principleId: string; text: string; artifactId: string; activationId: string }> = [];
  try {
    const reader = sharedActivePrinciplePrompt ? undefined : new PromptActivationReader(wctx.workspaceDir, { logger });
    const v2Result = sharedActivePrinciplePrompt
      ? { principles: [], warnings: sharedActivePrinciplePrompt.warnings, source: 'runtime_v2' as const }
      : await reader!.readActivatedPrinciples();

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

    // PRI-562 Phase 0: cross-block duplication PRESSURE — v2 candidates
    // suppressed because the legacy evolution block already carries them.
    // Both injection paths exclude this overlap before injection (the dedup
    // below on the plugin-local path; promptExcludePrincipleIds inside the
    // host on the shared path), so these ids are NOT double-injected; they
    // measure how often both channels would have carried the same principle.
    // Always [] on the shared host-runtime path, where v2Result arrives empty
    // and exclusion happens inside the host.
    const crossBlockDuplicateIds = v2Result.principles
      .filter((p) => legacyActiveIds.has(p.principleId))
      .map((p) => p.principleId);
    dedupedV2 = v2Result.principles.filter((p) => !legacyActiveIds.has(p.principleId));

    if (sharedActivePrinciplePrompt) {
      runtimeV2PrinciplesContent = sharedActivePrinciplePrompt.additionalContext;
      for (const id of sharedActivePrinciplePrompt.principleIds) runtimeV2PrincipleIds.add(id);
      v2Truncated = sharedActivePrinciplePrompt.truncated;
    } else if (dedupedV2.length > 0) {
      const { lines, injectedIds, truncated } = trimToBudget(dedupedV2, RUNTIME_V2_PRINCIPLE_BUDGET, escapeXml);
      v2Truncated = truncated;
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
      const allSharedPrinciplesExcluded = sharedActivePrinciplePrompt !== undefined
        && sharedActivePrinciplePrompt.allValidatedPrinciplesExcluded;
      // PRI-537: pair the source arrays with the INJECTED subset — dedupedV2
      // is the full post-dedup candidate list, so raw .map() mispairs under
      // budget truncation (rc-6-adjacent). All three arrays derive from the
      // same aligned list so index alignment cannot drift between them.
      const alignedPrinciples = alignInjectedPrinciples(dedupedV2, runtimeV2PrincipleIds);
      eventLog.recordRuntimeV2ActivationsInjected({
        sessionId: sessionId ?? 'unknown',
        workspaceDir: wctx.workspaceDir,
        principleIds: sharedActivePrinciplePrompt?.principleIds ?? alignedPrinciples.map((p) => p.principleId),
        activationIds: sharedActivePrinciplePrompt?.activationIds ?? alignedPrinciples.map((p) => p.activationId),
        artifactIds: sharedActivePrinciplePrompt?.artifactIds ?? alignedPrinciples.map((p) => p.artifactId),
        injectedCount: runtimeV2PrincipleIds.size,
        skippedWarnings: v2Result.warnings,
        injectedCharCount: runtimeV2PrinciplesContent.length,
        budget: RUNTIME_V2_PRINCIPLE_BUDGET,
        legacySelectedCount: legacyInjectedIds.length,
        legacyTotalChars,
        legacyTruncated,
        ...(v2Truncated !== undefined ? { v2Truncated } : {}),
        crossBlockDuplicateIds,
        ...(runtimeV2PrincipleIds.size === 0
          ? {
              skipReason: sharedActivePrinciplePrompt
                ? allSharedPrinciplesExcluded
                  ? 'all_deduped_against_legacy'
                  : 'no_validated_activations'
                : v2Result.principles.length === 0
                ? 'no_validated_activations'
                : 'all_deduped_against_legacy',
              nextAction: allSharedPrinciplesExcluded
                ? 'legacy evolution reducer already contains these principle IDs'
                : v2Result.principles.length === 0
                  ? 'check activations table for prompt channel rows with validated artifacts'
                  : 'legacy evolution reducer already contains these principle IDs',
            }
          : {}),
      });
    } catch (logErr) {
      logger?.warn?.(`[PD:RuntimeV2] Failed to emit activation observability event: ${String(logErr)}`);
    }

    // PRI-534: track injected principle ids for the /pd-context session
    // receipt (independent of the ledger flag — the injection itself happened).
    try {
      if (runtimeV2PrincipleIds.size > 0 && sessionId) {
        setInjectedPrincipleIds(sessionId, [...runtimeV2PrincipleIds], workspaceDir);
      }
    } catch (sessionErr) {
      logger?.warn?.(`[PD:RuntimeV2] Session receipt tracking failed: ${String(sessionErr)}`);
    }

    // PRI-531: receipt ledger presence rows — one per injected principle,
    // deduped per session×principle (partial unique index). Flag-gated and
    // failure-degrading; never affects the injection itself (rc-9).
    try {
      if (runtimeV2PrincipleIds.size > 0
          && loadFeatureFlagFromConfig(workspaceDir, 'principle_receipt_ledger', logger).enabled) {
        // Review fix (rc-6-adjacent pairing): activation ids must align with
        // the INJECTED subset — the full dedupedV2 list mispairs when budget
        // truncation drops principles. The shared-runtime path keeps its own
        // parallel arrays.
        const alignedActivationIds = sharedActivePrinciplePrompt
          ? sharedActivePrinciplePrompt.activationIds
          : alignActivationIds(dedupedV2, runtimeV2PrincipleIds);
        const written = recordInjectionPresence(
          workspaceDir,
          [...runtimeV2PrincipleIds],
          sessionId,
          alignedActivationIds,
          logger,
        );
        if (written === 0) {
          logger?.info?.('[PD:RuntimeV2] Receipt ledger presence rows: all already recorded for this session');
        }
      }
    } catch (ledgerErr) {
      logger?.warn?.(`[PD:RuntimeV2] Receipt ledger presence write failed: ${String(ledgerErr)}`);
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
    const directiveText = sharedActivePrinciplePrompt?.additionalContext
      ?? renderPrinciplesToDirectives(dedupedV2, runtimeV2PrincipleIds, {
          escapeFn: escapeXml,
          // PRI-532: self-report instruction on the fallback render path (the
          // shared host-runtime path applies the same flag internally).
          selfReportInstruction: loadFeatureFlagFromConfig(workspaceDir, 'principle_receipt_self_report', logger).enabled,
        });
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
