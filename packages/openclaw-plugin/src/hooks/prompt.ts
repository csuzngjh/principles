 
 
import * as fs from 'fs';
import { randomUUID, createHash } from 'node:crypto';
import type { PluginHookBeforePromptBuildEvent, PluginHookAgentContext, PluginHookBeforePromptBuildResult, PluginLogger } from '../openclaw-sdk.js';
import { setInjectedPrincipleIds } from '../core/session-tracker.js';
import { WorkspaceContext } from '../core/workspace-context.js';
import type { ContextInjectionConfig } from '../types.js';
// local-worker-routing module and its routing helpers removed entirely per PRI-448.
// Routing guidance is no longer injected into prompts.
import { extractSummary, getHistoryVersions, parseWorkingMemorySection, workingMemoryToInjection, autoCompressFocus, safeReadCurrentFocus } from '../core/focus-history.js';
import { PathResolver } from '../core/path-resolver.js';
import { RUNTIME_PRINCIPLE_BUDGET, getPromptModelCatalog, operatorDeclaredContextWindow, resolvePromptBudget, resolveTotalInjectionBudgetChars, trimToBudget, renderPrinciplesToDirectives, formatCorePrinciplesList, resolveOutputLanguage, DEFAULT_OUTPUT_LANGUAGE } from '@principles/core/runtime';
import type { PromptBudgetResolution, ResolvedOutputLanguage, PromptSelectionPolicy } from '@principles/core/runtime';
import { prepareAdaptiveIntervention, type ActivatedPrinciple, type AdaptiveInterventionResult, type AdaptiveDeliveryRecord } from '@principles/core/runtime';
import { nextSessionTurnOrdinal } from '@principles/core/trajectory-store';
import { truncateInjectionToBudget } from '@principles/core/prompt-builder';
import { buildInjectedExpectations } from './prompt-presence-expectations.js';
import { PromptActivationReader } from '../core/runtime-prompt-activation-reader.js';
import { revalidateAdaptivePrinciple, type ActivePrinciplePromptResult } from '@principles/host-runtime';
import { readAdaptiveActivationConfig } from './adaptive-activation-config.js';
import {
  claimControlledAdmission,
  isControlledAdmissionConfigured,
  releaseControlledAdmissionClaim,
  takeControlledAdmissionHandoff,
  type ControlledAdmissionClaim,
} from './controlled-admission.js';
import {
  buildAdaptiveConfigIdentitySnapshot,
  buildUnavailableAdaptiveConfigIdentity,
  forgetAdaptiveConfigIdentity,
  getRememberedAdaptiveConfigIdentity,
  rememberAdaptiveConfigIdentity,
  type AdaptiveConfigIdentitySnapshot,
} from '../core/adaptive-config-identity.js';
import { loadPdConfigForPlugin, loadFeatureFlagFromConfig } from '../core/pd-config-loader.js';
import { recordInjectionPresence, alignActivationIds, alignInjectedPrinciples } from '../core/principle-application-ledger.js';
import { recordPromptDeliveryEvidence } from '../core/intervention-evidence-recorder.js';
import { safeReadIntentDoc, resetIntentDocCacheForTest } from '../core/intent-doc-reader.js';
import { resolveIntentLang } from '../core/intent-doc-reader-adapter.js';
import { buildIntentFrictionBlock } from '@principles/core/runtime';
import {
  escapeXml,
  isMinimalTrigger,
} from '@principles/core/prompt-builder';
import {
  buildGovernanceContext,
  buildEmpathySilenceConstraint,
  resolveCurrentUserMessage,
  assembleHeartbeatChecklist,
  assembleAppendSystemContext,
} from './prompt-helpers.js';
import { SignalCollectorHost, createSignalLlmClassifierFromConfig, isUserInteractionTrigger } from '../core/signal-collector-host.js';
import { createLiveSignalKeywordStore } from '../core/signal-keyword-store.js';
import { CorrectionCueLearner } from '../core/correction-cue-learner.js';
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
    // mtime check and read share one handle: `statSync` + `readFileSync` on the
    // path can observe two different files (TOCTOU on a cached read).
    const fd = fs.openSync(filePath, 'r');
    try {
      const stat = fs.fstatSync(fd);
      const mtime = stat.mtimeMs;

      if (cached && (now - cached.loadedAt) < STATIC_FILE_TTL_MS && cached.mtime === mtime) {
        return cached.content;
      }

      const content = fs.readFileSync(fd, 'utf8');
      cache.set(filePath, { content, mtime, loadedAt: now });
      return content;
    } finally {
      fs.closeSync(fd);
    }
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
 * PRI-1065: the Runtime principle budget ACTUALLY applied to this build —
 * the shared route's own resolution or the plugin-local one, otherwise the
 * legacy constant. Both the injection event and the size guard read this one
 * derivation, so the recorded budget and the enforced ceiling cannot drift.
 */
function appliedPrincipleBudgetChars(
  shared: ActivePrinciplePromptResult | undefined,
  local: PromptBudgetResolution | undefined,
): number {
  return shared?.budget ?? local?.budgetChars ?? RUNTIME_PRINCIPLE_BUDGET;
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

export function getSignalCollectorHost(wctx: WorkspaceContext, logger?: PluginLogger): SignalCollectorHost {
  let host = _signalCollectorHosts.get(wctx.workspaceDir);
  if (!host) {
    // 从 .pd/config.yaml 的 signalCollector runtimeProfile 构造 LLM classifier(配置单轨化)。
    // 未配置/降级时返回 null,host 走纯关键词模式(spec §3.3 决策3)。
    const llmClassifier = createSignalLlmClassifierFromConfig(wctx, logger);
    // P0-B: 检测词库走 live provider(learned correction cues 无需重启即生效,
    // optimizer 写 correction_keywords.json 后下一次 detectSync 消费)。
    const liveStore = createLiveSignalKeywordStore(wctx, logger);
    host = new SignalCollectorHost(wctx, {
      llmClassifier,
      keywordStoreProvider: () => liveStore.resolve(),
      // PRI-788 G3: LLM 确认 verdict → 关键词 TP/FP 反馈(earned precision 证据源)。
      // correction_keywords.json 全部为 correction 类词,命中词直接记入 learner。
      cueFeedbackRecorder: (terms, wasCorrection) => {
        const learner = CorrectionCueLearner.get(wctx.stateDir);
        for (const term of terms) {
          const recorded = wasCorrection
            ? learner.recordTruePositive(term)
            : learner.recordFalsePositive(term);
          if (!recorded) {
            // The term left the store between Stage1 detection and Stage2
            // confirmation (cap eviction opened this window), so this piece of
            // earned-precision evidence is lost — report it, don't drop it.
            logger?.warn?.(
              `[PD:SignalCollector] ${wasCorrection ? 'TP' : 'FP'} dropped: term="${term}" is no longer in the keyword store`,
            );
          }
        }
      },
    });
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

function adaptiveJournalFacts(
  ctx: PluginHookAgentContext,
  target: { artifactId: string; activationId: string } | undefined,
  identity: AdaptiveConfigIdentitySnapshot,
) {
  return target ? {
    host: identity.host, hostVersion: identity.hostVersion, runtimeMode: identity.runtimeMode,
    pluginVersion: identity.pluginVersion, effectiveHookSetFingerprint: identity.effectiveHookSetFingerprint,
    evidenceCoverage: identity.evidenceCoverage, configIdentityCoverage: identity.configIdentityCoverage,
    workspaceDir: ctx.workspaceDir,
    ...(ctx.sessionId ? { sessionId: ctx.sessionId } : {}), ...(ctx.runId ? { runId: ctx.runId } : {}),
    artifactId: target.artifactId, activationId: target.activationId,
  } : {};
}

function collectAdaptiveConfigIdentity(
  ctx: PluginHookAgentContext & { api?: PromptHookApi },
  runtimeMode: string,
): AdaptiveConfigIdentitySnapshot {
  try {
    return buildAdaptiveConfigIdentitySnapshot({ runtimeMode, pluginRootDir: ctx.api?.rootDir });
  } catch (error) {
    // Identity collection must never block or alter prompt assembly.
    ctx.api?.logger?.warn?.(`[PD:AA] Config identity unavailable: ${String(error)}`);
    return buildUnavailableAdaptiveConfigIdentity(runtimeMode, 'identity_collection_failed');
  }
}

/** Called before shared priority packing, or at the local entry before its work begins. */
export function beginAdaptivePromptInvocation(ctx: PluginHookAgentContext & { api?: PromptHookApi }, target: { artifactId: string; activationId: string }, runtimeMode: string, hookInvocationId: string = randomUUID()): string {
  // One frozen snapshot per invocation: the terminal record must reuse it even
  // if the environment changes while this invocation is in flight.
  const identity = collectAdaptiveConfigIdentity(ctx, runtimeMode);
  rememberAdaptiveConfigIdentity(hookInvocationId, identity);
  try {
    WorkspaceContext.fromHookContext(ctx).eventLog.recordAdaptiveDelivery(ctx.sessionId, {
      ...adaptiveJournalFacts(ctx, target, identity), hookInvocationId,
      receiptState: 'open', execution: 'unknown', payload: 'unknown', selection: 'unavailable', selectionPending: true, submission: 'unknown',
    });
  } catch (error) { ctx.api?.logger?.warn?.(`[PD:AA] Invocation journal unavailable: ${String(error)}`); }
  return hookInvocationId;
}

export async function handleBeforePromptBuild(
  event: PluginHookBeforePromptBuildEvent,
  ctx: PluginHookAgentContext & { api?: PromptHookApi },
  sharedActivePrinciplePrompt?: ActivePrinciplePromptResult,
): Promise<PluginHookBeforePromptBuildResult | void> {
  const {workspaceDir} = ctx;
  const adaptiveStartedAt = Date.now();
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
  const adaptiveMapping = readAdaptiveActivationConfig(api?.pluginConfig, workspaceDir, adaptiveStartedAt);
  // A mapping can expire or be disabled while the shared packer is running.
  // In that case discard its additional contribution before assembling anything.
  const preparedPacking = sharedActivePrinciplePrompt?.adaptivePacking;
  if (preparedPacking?.nativeBaseline && (!adaptiveMapping
    || preparedPacking.targetActivationId !== adaptiveMapping.activationId
    || preparedPacking.targetSnapshot?.artifactId !== adaptiveMapping.artifactId)) {
    sharedActivePrinciplePrompt = preparedPacking.nativeBaseline;
  }
  const adaptiveInvocationId = preparedPacking?.hookInvocationId
    ?? (adaptiveMapping ? beginAdaptivePromptInvocation(ctx, adaptiveMapping, sharedActivePrinciplePrompt ? 'shared' : 'plugin_local') : undefined);
  const recordAdaptive = (record: AdaptiveDeliveryRecord) => {
    try { wctx.eventLog.recordAdaptiveDelivery(sessionId, record); } catch (error) {
      logger?.warn?.(`[PD:AA] Invocation journal unavailable: ${String(error)}`);
    }
  };
  // A config reload may replace the mapping after packing. The terminal record
  // still belongs to the invocation's original target, never the replacement.
  const journalTarget = preparedPacking?.hookInvocationId && preparedPacking.targetArtifactId
    ? { artifactId: preparedPacking.targetArtifactId, activationId: preparedPacking.targetActivationId } : adaptiveMapping ?? undefined;
  // Reuse the snapshot taken when this invocation opened. A runtime/config
  // change after that point must not rewrite the invocation's own evidence.
  const journalRuntimeMode = sharedActivePrinciplePrompt ? 'shared' : 'plugin_local';
  const journalIdentity = adaptiveInvocationId
    ? getRememberedAdaptiveConfigIdentity(adaptiveInvocationId)
      ?? buildUnavailableAdaptiveConfigIdentity(journalRuntimeMode, 'invocation_snapshot_unavailable')
    : buildUnavailableAdaptiveConfigIdentity(journalRuntimeMode, 'no_invocation');
  const adaptiveJournalContext = adaptiveJournalFacts(ctx, journalTarget, journalIdentity);
  // PRI-647: trajectory session recording and assistant-turn anchoring are
  // observability side-effects only. A closed/disposed trajectory connection
  // (plugin service stop during config hot-reload) must never abort the prompt
  // build and drop every injected principle - fail open like the other side
  // channels (evolution, Runtime, INTENT). OpenClaw sends the current
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

  // ──── STRUCTURE (Optimized for WebUI UX + Prompt Caching) ────
  // prependSystemContext: Minimal identity (cacheable, ~15 lines)
  // appendSystemContext: Principles + Thinking OS + reflection_log + project_context (cacheable, WebUI-hidden)
  // prependContext: Only short dynamic directives: evolutionDirective + heartbeat

   
   
  let prependSystemContext: string;
  let prependContext = '';
  let appendSystemContext = '';

  // ──── 1. prependSystemContext: Minimal Agent Identity ────
  // EvolutionWorker-era INTERNAL SYSTEM LAYOUT removed per PRI-294.
  // The EVOLUTION_WORKER PathResolver key and system layout reference are
  // not MVP-Core; agents discover what they need via tool calls.
  prependSystemContext = buildGovernanceContext();

  // ──── 2. Behavioral constraints (structured-signal channel hygiene)
  const empathySilenceConstraint = buildEmpathySilenceConstraint();

  // ─────────────────────────────────────────────────3. User message extraction
  // Extract actual user message from prompt (handles boot checks + Feishu wrappers)
  // and detect agent-to-agent messages.
  const { message: currentUserMessage, isAgentToAgent } =
    resolveCurrentUserMessage(event, sessionId);

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

  // ──── 6. Attitude/personality prompt injection removed per PRI-291 (MVP diet).
  // GFI scoring and its prompt surface were removed in GFI-COMPLETE-REMOVAL-001.

  // ──── 7. appendSystemContext: Principles + Thinking OS + reflection_log + project_context ────
  // NOTE: Principles is ALWAYS injected (not configurable)
  // Thinking OS, reflection_log, project_context are configurable
  // All these go into System Prompt (WebUI-hidden, Prompt Cacheable)

  // Core principles: ALWAYS inject the canonical foundational axioms directly
  // from the @principles/core registry (PRI-606). Learned principles reach the
  // agent through Runtime activations (prependSystemContext), not here.
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


  let runtimePrinciplesContent = '';
  let adaptiveDirectiveText: string | undefined;
  let adaptiveOutcome: AdaptiveInterventionResult | undefined;
  let adaptiveAdmissionId: string | undefined;
  let adaptiveOperatorAdmission: (ControlledAdmissionClaim['identity'] & { claimId: string; status: 'claimed' }) | undefined;
  let admissionHandoffMissing = false;
  let adaptiveExpectedTarget: ActivatedPrinciple | undefined;
  let adaptiveTargetBody: string | undefined;
  let adaptiveDeadlineAt = 0;
  let adaptiveBaseline: { text: string; ids: string[] } | undefined;
  let adaptiveSafeFallback: { text: string; ids: string[] } | undefined;
  let adaptivePrefix = '';
  let commitRuntimeEvidence: (() => void) | undefined;
  const runtimePrincipleIds = new Set<string>();
  let v2Truncated: boolean | undefined;
  // PRI-904: fair-rotation selection diagnostics, hoisted for the event below.
  let v2SelectionPolicy: PromptSelectionPolicy | undefined;
  let v2EligibleCount: number | undefined;
  let v2RotationStartIndex: number | undefined;
  // Round provenance: a fair_rotation_v1 selection is only emitted together
  // with the session-turn ordinal that produced it, so every rotating
  // selection is traceable to the round fact that caused it.
  let v2RoundOrdinal: number | undefined;
  let v2DroppedActivationIds: string[] | undefined;
  let v2OversizedActivationIds: string[] | undefined;
  // Owner-approved Runtime principles are the single prompt-injection
  // authority. Hoisted so the owner_approved_behavior_directives section can
  // access them.
  let dedupedV2: Array<{ principleId: string; text: string; artifactId: string; activationId: string }> = [];
  // SPEC-PD-MODEL-AWARE-PROMPT-BUDGET-001: the plugin-local route's budget
  // resolution (resolved lazily below from THIS hook's model facts). The
  // shared route carries its own resolution in sharedActivePrinciplePrompt —
  // resolved by host-runtime from the same facts — so exactly one resolution
  // feeds each injection.
  let v2PromptBudget: PromptBudgetResolution | undefined;
  try {
    const reader = sharedActivePrinciplePrompt ? undefined : new PromptActivationReader(wctx.workspaceDir, { logger });
    const v2Result = sharedActivePrinciplePrompt
      ? { principles: [], warnings: sharedActivePrinciplePrompt.warnings, source: 'runtime_v2' as const }
      : await reader!.readActivatedPrinciples();

    if (v2Result.warnings.length > 0) {
      logger?.info?.(`[PD:Runtime] Activation read warnings: ${v2Result.warnings.join('; ')}`);
    }

    dedupedV2 = v2Result.principles;

    if (sharedActivePrinciplePrompt) {
      const packing = sharedActivePrinciplePrompt.adaptivePacking;
      if (adaptiveMapping && packing?.targetSnapshot && packing.targetBody && packing.nativeBaseline
        && packing.targetActivationId === adaptiveMapping.activationId
        && packing.targetSnapshot.artifactId === adaptiveMapping.artifactId) {
        const baseline = packing.nativeBaseline;
        adaptiveDeadlineAt = Math.min(packing.deadlineAt ?? adaptiveStartedAt + adaptiveMapping.softTimeoutMs, adaptiveMapping.expiresAtMs);
        const handedOff = takeControlledAdmissionHandoff(event, packing.hookInvocationId);
        if (handedOff) {
          adaptiveOperatorAdmission = { ...handedOff.identity, claimId: handedOff.claimId, status: 'claimed' };
        } else {
          const admitted = getOwnValue(event, 'currentUserMessageId');
          if (typeof admitted === 'string') adaptiveAdmissionId = admitted;
          // A replay, a duplicate callback or a lost handoff can never re-apply
          // the priority target; the Native baseline is preserved instead.
          else admissionHandoffMissing = isControlledAdmissionConfigured();
        }
        adaptiveSafeFallback = { text: baseline.principleIds.filter(id => id !== packing.targetSnapshot?.principleId).length
          ? baseline.additionalContext.replace(packing.targetBody, '') : '', ids: baseline.principleIds.filter(id => id !== packing.targetSnapshot?.principleId) };
        if (!admissionHandoffMissing) {
          adaptiveExpectedTarget = packing.targetSnapshot;
          adaptiveTargetBody = packing.targetBody;
          if (packing.status === 'prioritized') adaptiveBaseline = { text: baseline.additionalContext, ids: baseline.principleIds };
          adaptiveDirectiveText = sharedActivePrinciplePrompt.additionalContext;
          adaptiveOutcome = { text: adaptiveDirectiveText, reason: packing.status === 'prioritized' ? 'target_prioritized' : 'native_already_contains_target',
            addedTarget: packing.status === 'prioritized', displacedActivationIds: packing.displacedActivationIds,
            selectedPrincipleIds: sharedActivePrinciplePrompt.principleIds,
            targetBodySha256: createHash('sha256').update(packing.targetBody, 'utf8').digest('hex') };
        } else {
          adaptiveDirectiveText = baseline.additionalContext;
          adaptiveOutcome = { text: baseline.additionalContext, reason: 'admission_handoff_missing',
            addedTarget: false, displacedActivationIds: [], selectedPrincipleIds: baseline.principleIds };
        }
      } else if (adaptiveMapping && packing) {
        adaptiveOutcome = { text: sharedActivePrinciplePrompt.additionalContext, reason: packing.reason ?? 'target_unavailable', addedTarget: false, displacedActivationIds: [], selectedPrincipleIds: sharedActivePrinciplePrompt.principleIds };
      } else if (adaptiveMapping && isUserInteraction && !isAgentToAgent && !isMinimalMode) {
        const text = getOwnValue(event, 'currentUserMessage');
        const id = getOwnValue(event, 'currentUserMessageId');
        if (typeof text === 'string' && typeof id === 'string' && id.trim() && sessionId) {
          adaptiveAdmissionId = id;
          adaptiveOutcome = { text: sharedActivePrinciplePrompt.additionalContext,
            reason: text.split(/\r?\n/, 1)[0] === '[PD-AA:delivery-review:v1]' ? 'shared_priority_unavailable' : 'scene_not_matched',
            addedTarget: false, displacedActivationIds: [], selectedPrincipleIds: sharedActivePrinciplePrompt.principleIds };
        }
      }
      if (admissionHandoffMissing && sharedActivePrinciplePrompt.adaptivePacking?.nativeBaseline) {
        runtimePrinciplesContent = sharedActivePrinciplePrompt.adaptivePacking.nativeBaseline.additionalContext;
        for (const id of sharedActivePrinciplePrompt.adaptivePacking.nativeBaseline.principleIds) runtimePrincipleIds.add(id);
      } else {
        runtimePrinciplesContent = sharedActivePrinciplePrompt.additionalContext;
        for (const id of sharedActivePrinciplePrompt.principleIds) runtimePrincipleIds.add(id);
      }
      v2Truncated = sharedActivePrinciplePrompt.truncated;
      v2SelectionPolicy = sharedActivePrinciplePrompt.selectionPolicy;
      v2EligibleCount = sharedActivePrinciplePrompt.eligibleCount;
      v2RotationStartIndex = sharedActivePrinciplePrompt.rotationStartIndex;
      v2DroppedActivationIds = sharedActivePrinciplePrompt.droppedActivationIds;
      v2OversizedActivationIds = sharedActivePrinciplePrompt.oversizedActivationIds;
    } else if (dedupedV2.length > 0) {
      // PRI-904 Phase-1 (Option 3) fair rotation round = the session-local
      // user-turn ordinal already persisted in trajectory.db (same fact the
      // correction pipeline anchors on). Timing, verified on this route:
      // SignalCollectorHost.detectSync writes user_turns synchronously at the
      // top of this hook, so at selection time THIS turn is already recorded
      // and the helper returns MAX(turn_index)+1 — the NEXT turn's ordinal,
      // not the current one. That off-by-one is harmless for fairness (only
      // the strict +1 progression matters); it is documented rather than
      // papered over. Consecutive user turns therefore advance the rotation
      // start by exactly one, and N such turns cover all N eligible ring
      // positions. A missing sessionId or unreadable trajectory db degrades to
      // the legacy FIFO policy, observable via selectionPolicy.
      //
      // Scope: this guarantee is per CONTINUOUSLY ADVANCING SESSION on the
      // currently live plugin-local route. It is NOT cross-session, and it is
      // NOT claimed for the host-shared/Codex route (which passes no round key).
      let v2RoundKey: number | undefined;
      if (sessionId) {
        try {
          v2RoundKey = nextSessionTurnOrdinal(wctx.workspaceDir, sessionId);
        } catch (ordinalErr) {
          logger?.warn?.(`[PD:Runtime] Fair-rotation round ordinal unavailable (${String(ordinalErr)}); falling back to legacy FIFO selection for this build`);
        }
      }
      // SPEC-PD-MODEL-AWARE-PROMPT-BUDGET-001: resolve the injection budget
      // ONCE for this build from the host hook's own model facts (effective
      // context window first, installed Pi AI catalog as metadata fallback,
      // legacy 2000 with an observable reason when nothing is confirmable).
      // The shared route resolves the same facts inside host-runtime — same
      // resolver, same catalog, deterministic same result.
      // PRI-1020: the Owner's declared window (.pd/config.yaml promptBudget)
      // outranks all of these (tier 0); plugin-local route hostKind is always
      // openclaw. Loader never throws; malformed config degrades to no
      // declaration and is warned about by the other config readers here.
      const declaredWindow = operatorDeclaredContextWindow(
        loadPdConfigForPlugin(workspaceDir).effective.config.promptBudget,
        'openclaw',
      );
      v2PromptBudget = resolvePromptBudget({
        ...(declaredWindow !== undefined ? { operatorDeclared: { contextWindowTokens: declaredWindow } } : {}),
        hostCapacity: {
          contextTokenBudget: ctx.contextTokenBudget,
          contextWindowSource: ctx.contextWindowSource,
        },
        modelIdentity: {
          providerId: ctx.modelProviderId,
          modelId: ctx.modelId,
        },
        catalog: getPromptModelCatalog(),
      });
      if (v2PromptBudget.capacityStatus === 'unknown' && v2PromptBudget.fallbackReason) {
        // Per-turn debug noise control: the injection EVENT already records
        // capacityStatus=legacy_fallback + the bounded reason code (SPEC §7);
        // the log adds the non-sensitive detail for local diagnosis only.
        logger?.debug?.(`[PD:Runtime] Model-aware budget fell back to ${v2PromptBudget.budgetChars}c (reason: ${v2PromptBudget.fallbackReason}; detail: ${v2PromptBudget.fallbackDetail ?? 'n/a'})`);
      } else {
        logger?.info?.(`[PD:Runtime] Model-aware budget ${v2PromptBudget.budgetChars}c (source: ${v2PromptBudget.capacitySource}, window: ${v2PromptBudget.contextWindowTokens} tokens)`);
      }
      const selection = trimToBudget(dedupedV2, v2PromptBudget.budgetChars, escapeXml, v2RoundKey);
      const { lines, injectedIds, truncated } = selection;
      v2Truncated = truncated;
      v2SelectionPolicy = selection.selectionPolicy;
      v2EligibleCount = selection.eligibleCount;
      v2RotationStartIndex = selection.rotationStartIndex;
      v2RoundOrdinal = v2RoundKey;
      v2DroppedActivationIds = selection.droppedActivationIds;
      v2OversizedActivationIds = selection.oversizedActivationIds;
      if (truncated) {
        logger?.info?.(`[PD:Runtime] Principle budget reached (${v2PromptBudget.budgetChars}c) — ${injectedIds.size} principles injected under ${selection.selectionPolicy} (round=${v2RoundKey ?? 'n/a'}, start=${selection.rotationStartIndex ?? 0}, dropped=${selection.droppedActivationIds.length}, oversized=${selection.oversizedActivationIds.length})`);
      }
      for (const id of injectedIds) {
        runtimePrincipleIds.add(id);
      }
      runtimePrinciplesContent = lines.join('\n');
      const mapping = adaptiveMapping;
      const admittedText = getOwnValue(event, 'currentUserMessage');
      const admittedId = getOwnValue(event, 'currentUserMessageId');
      const nativeIdentity = typeof admittedId === 'string' && admittedId.trim().length > 0;
      let admissionClaim: ControlledAdmissionClaim | undefined;
      if (mapping && isUserInteraction && !isAgentToAgent && !isMinimalMode && sessionId
        && adaptiveInvocationId && isControlledAdmissionConfigured() && !nativeIdentity) {
        adaptiveDeadlineAt = Math.min(adaptiveStartedAt + mapping.softTimeoutMs, mapping.expiresAtMs);
        const admission = claimControlledAdmission({
          event, workspaceDir, sessionId, runId: runId ?? null, mapping,
          hookInvocationId: adaptiveInvocationId, now: adaptiveStartedAt,
        });
        if (admission.status === 'claimed') admissionClaim = admission.claim;
        else if (admission.status === 'rejected') {
          logger?.warn?.(`[PD:AA] controlled admission refused: ${JSON.stringify({ reason: admission.reason, detail: admission.detail })}`);
        }
      }
      if (mapping && isUserInteraction && !isAgentToAgent && !isMinimalMode && sessionId
        && (admissionClaim || (typeof admittedText === 'string' && nativeIdentity))) {
        const selfReport = loadFeatureFlagFromConfig(workspaceDir, 'principle_receipt_self_report', logger).enabled;
        const render = (ids: Set<string>) => renderPrinciplesToDirectives(dedupedV2, ids, { escapeFn: escapeXml, selfReportInstruction: selfReport });
        const target = dedupedV2.find(p => p.artifactId === mapping.artifactId && p.activationId === mapping.activationId);
        const withoutTarget = new Set(injectedIds);
        if (target) withoutTarget.delete(target.principleId);
        adaptiveDeadlineAt = Math.min(adaptiveStartedAt + mapping.softTimeoutMs, mapping.expiresAtMs);
        const intervention = await prepareAdaptiveIntervention({
          nativeText: render(injectedIds), nativeWithoutTargetText: render(withoutTarget),
          nativePrincipleIds: [...injectedIds], principles: dedupedV2, target: mapping,
          currentUserMessage: admissionClaim ? admissionClaim.admittedText : admittedText as string,
          ...(admissionClaim
            ? { controlledAdmission: {
                admissionId: admissionClaim.identity.admissionId,
                inputSha256: admissionClaim.identity.inputSha256,
                manifestSha256: admissionClaim.identity.manifestSha256,
              } }
            : { currentUserMessageId: admittedId as string }),
          sessionId,
          selectionBudget: v2PromptBudget.budgetChars, roundKey: v2RoundKey,
          mandatoryPrincipleIds: [], selfReportInstruction: selfReport,
          deadlineAt: adaptiveDeadlineAt,
        }, {
          now: Date.now,
          revalidate: (expected, signal) => revalidateAdaptivePrinciple(workspaceDir, expected, signal),
          renderAndGuard: ids => {
            const text = render(ids);
            return text.length <= resolveTotalInjectionBudgetChars(v2PromptBudget?.budgetChars ?? RUNTIME_PRINCIPLE_BUDGET) ? text : '';
          },
        });
        adaptiveDirectiveText = intervention.text;
        adaptiveOutcome = intervention;
        if (admissionClaim) {
          adaptiveOperatorAdmission = { ...admissionClaim.identity, claimId: admissionClaim.claimId, status: 'claimed' };
          releaseControlledAdmissionClaim(admissionClaim);
        } else {
          adaptiveAdmissionId = admittedId as string;
        }
        adaptiveExpectedTarget = target;
        adaptiveSafeFallback = { text: render(withoutTarget), ids: [...withoutTarget] };
        if (intervention.addedTarget) adaptiveBaseline = { text: render(injectedIds), ids: [...injectedIds] };
        if (intervention.selectedPrincipleIds) {
          const changed = intervention.selectedPrincipleIds.length !== runtimePrincipleIds.size
            || intervention.selectedPrincipleIds.some(id => !runtimePrincipleIds.has(id));
          runtimePrincipleIds.clear();
          for (const id of intervention.selectedPrincipleIds) runtimePrincipleIds.add(id);
          if (changed) {
            // The original rotation diagnostics describe the baseline, not the intervened selection.
            v2SelectionPolicy = undefined;
            v2RotationStartIndex = undefined;
            v2RoundOrdinal = undefined;
            v2DroppedActivationIds = undefined;
            v2OversizedActivationIds = undefined;
            v2Truncated = runtimePrincipleIds.size < dedupedV2.length;
          }
        }
        runtimePrinciplesContent = intervention.text;
      } else if (mapping) {
        logger?.info?.('[PD:AA] Native preserved: trusted current admission or supported user entry unavailable');
      }
    }

    commitRuntimeEvidence = () => {
    const sharedPrompt = sharedActivePrinciplePrompt;
    // ── Emit structured observability event ──
    try {
      const eventLog = wctx.eventLog;
      // PRI-537: pair the source arrays with the INJECTED subset — dedupedV2
      // is the full candidate list, so raw .map() mispairs under budget
      // truncation (rc-6-adjacent). All three arrays derive from the same
      // aligned list so index alignment cannot drift between them.
      const alignedPrinciples = alignInjectedPrinciples(dedupedV2, runtimePrincipleIds);
      // SPEC-PD-MODEL-AWARE-PROMPT-BUDGET-001: the budget THIS injection ran
      // under — the shared route's own resolution (host-runtime resolved from
      // the same hook facts), or the plugin-local resolution. Never a
      // restated constant: a recorded budget that differs from the executed
      // one is a silent lie.
      const v2EventBudget = appliedPrincipleBudgetChars(sharedActivePrinciplePrompt, v2PromptBudget);
      eventLog.recordRuntimeActivationsInjected({
        hostKind: 'openclaw',
        eventId: randomUUID(),
        ...(adaptiveInvocationId ? { hookInvocationId: adaptiveInvocationId } : {}),
        sessionId: sessionId ?? 'unknown',
        workspaceDir: wctx.workspaceDir,
        // PRI-750: host run/turn id from the OpenClaw hook context — DIRECT
        // turn binding to assistant_turns.run_id. Absent when the host
        // supplies none (event stays compatible; signal collection already
        // warns on missing runId at prompt build).
        ...(runId ? { runId } : {}),
        principleIds: sharedActivePrinciplePrompt?.principleIds ?? alignedPrinciples.map((p) => p.principleId),
        activationIds: sharedActivePrinciplePrompt?.activationIds ?? alignedPrinciples.map((p) => p.activationId),
        artifactIds: sharedActivePrinciplePrompt?.artifactIds ?? alignedPrinciples.map((p) => p.artifactId),
        injectedCount: runtimePrincipleIds.size,
        skippedWarnings: v2Result.warnings,
        injectedCharCount: runtimePrinciplesContent.length,
        budget: v2EventBudget,
        ...(v2Truncated !== undefined ? { v2Truncated } : {}),
        // PRI-904: fair-rotation observability (bounded, optional — old
        // readers ignore; SPEC §10/§INV-O01 make truncation explainable).
        ...(v2SelectionPolicy !== undefined ? { selectionPolicy: v2SelectionPolicy } : {}),
        ...(v2EligibleCount !== undefined ? { eligibleCount: v2EligibleCount } : {}),
        ...(v2RotationStartIndex !== undefined ? { rotationStartIndex: v2RotationStartIndex } : {}),
        ...(v2RoundOrdinal !== undefined ? { selectionRoundOrdinal: v2RoundOrdinal, selectionRoundSource: 'session_user_turn_ordinal' as const } : {}),
        ...(v2DroppedActivationIds !== undefined && v2DroppedActivationIds.length > 0 ? { droppedActivationIds: v2DroppedActivationIds } : {}),
        ...(v2OversizedActivationIds !== undefined && v2OversizedActivationIds.length > 0 ? { oversizedActivationIds: v2OversizedActivationIds } : {}),
        // SPEC-PD-MODEL-AWARE-PROMPT-BUDGET-001: budget provenance travels
        // with the event — shared route carries its own resolution, local
        // route the one resolved above; absent resolution (aborted build)
        // means policy unknown, which readers must treat as fixed-budget.
        ...(sharedActivePrinciplePrompt?.budgetPolicyVersion !== undefined ? { budgetPolicyVersion: sharedActivePrinciplePrompt.budgetPolicyVersion } : v2PromptBudget !== undefined ? { budgetPolicyVersion: v2PromptBudget.policyVersion } : {}),
        ...(sharedActivePrinciplePrompt?.budgetCapacitySource !== undefined ? { budgetCapacitySource: sharedActivePrinciplePrompt.budgetCapacitySource } : v2PromptBudget !== undefined ? { budgetCapacitySource: v2PromptBudget.capacitySource } : {}),
        ...(sharedActivePrinciplePrompt?.budgetCapacityStatus !== undefined ? { budgetCapacityStatus: sharedActivePrinciplePrompt.budgetCapacityStatus } : v2PromptBudget !== undefined ? { budgetCapacityStatus: v2PromptBudget.capacityStatus } : {}),
        ...(sharedActivePrinciplePrompt != null && sharedActivePrinciplePrompt.budgetContextWindowTokens != null ? { budgetContextWindowTokens: sharedActivePrinciplePrompt.budgetContextWindowTokens } : v2PromptBudget != null && v2PromptBudget.contextWindowTokens != null ? { budgetContextWindowTokens: v2PromptBudget.contextWindowTokens } : {}),
        // SPEC §7 v0.2: bounded fallback reason code — same facts, same code
        // on both routes (shared carries its own resolution's code).
        ...(sharedActivePrinciplePrompt?.budgetFallbackReason !== undefined ? { budgetFallbackReason: sharedActivePrinciplePrompt.budgetFallbackReason } : v2PromptBudget?.fallbackReason !== undefined ? { budgetFallbackReason: v2PromptBudget.fallbackReason } : {}),
        ...(runtimePrincipleIds.size === 0
          ? {
              skipReason: 'no_validated_activations',
              nextAction: 'check activations table for prompt channel rows with validated artifacts',
            }
          : {}),
      });
    } catch (logErr) {
      logger?.warn?.(`[PD:Runtime] Failed to emit activation observability event: ${String(logErr)}`);
    }

    // PRI-534: track injected principle ids for the /pd-context session
    // receipt (independent of the ledger flag — the injection itself happened).
    // PRI-755 (review fix): record the CURRENT set on EVERY build, empty
    // included — the self-report capture validates against this set, so a
    // stale non-empty set from an earlier turn would re-admit markers for
    // principles no longer injected this turn.
    // Review fix (rc-6-adjacent pairing): activation ids must align with the
    // INJECTED subset — the full dedupedV2 list mispairs when budget
    // truncation drops principles. The shared-runtime path keeps its own
    // parallel arrays.
    // PRI-899: the SAME aligned array now feeds BOTH the session tracker (the
    // pairing the self_report effect row is written from) and the presence
    // writer below, so the two receipt levels pair principles to activations
    // identically — one pairing derivation, not two.
    const alignedActivationIds = sharedActivePrinciplePrompt
      ? sharedActivePrinciplePrompt.activationIds
      : alignActivationIds(dedupedV2, runtimePrincipleIds);
    try {
      if (sessionId) {
        setInjectedPrincipleIds(sessionId, [...runtimePrincipleIds], workspaceDir, alignedActivationIds);
      }
    } catch (sessionErr) {
      logger?.warn?.(`[PD:Runtime] Session receipt tracking failed: ${String(sessionErr)}`);
    }

    // PRI-531: receipt ledger presence rows — one per injected principle,
    // deduped per session×principle (partial unique index). Flag-gated and
    // failure-degrading; never affects the injection itself (rc-9).
    try {
      if (runtimePrincipleIds.size > 0
          && loadFeatureFlagFromConfig(workspaceDir, 'principle_receipt_ledger', logger).enabled) {
        const written = recordInjectionPresence(
          workspaceDir,
          [...runtimePrincipleIds],
          sessionId,
          alignedActivationIds,
          logger,
        );
        if (written === 0) {
          logger?.info?.('[PD:Runtime] Receipt ledger presence rows: all already recorded for this session');
        }
      }
    } catch (ledgerErr) {
      logger?.warn?.(`[PD:Runtime] Receipt ledger presence write failed: ${String(ledgerErr)}`);
    }

    // PD v2 Phase 1: normalized delivery evidence for this injection (one
    // agent-context attempt per principle, confirmation 'submitted' — the
    // host's consumption is NOT claimed). Best-effort: never affects the
    // prompt being returned (ADR-0027 §2.4).
    try {
      const evidenceInjected = sharedPrompt
        ? sharedPrompt.principleIds
            .map((principleId, index) => ({
              principleId,
              activationId: sharedPrompt.activationIds[index] ?? '',
              artifactId: sharedPrompt.artifactIds[index],
            }))
            .filter((entry) => entry.activationId.length > 0)
        : alignInjectedPrinciples(dedupedV2, runtimePrincipleIds)
            .filter((entry) => entry.activationId.length > 0)
            .map((entry) => ({ principleId: entry.principleId, activationId: entry.activationId, artifactId: entry.artifactId }));
      if (evidenceInjected.length > 0) {
        recordPromptDeliveryEvidence({
          workspaceDir,
          sessionId,
          ...(runId ? { runId } : {}),
          injected: evidenceInjected,
          logger,
        });
      }
    } catch (evidenceErr) {
      logger?.warn?.(`[PD:Runtime] Evidence delivery recording failed: ${String(evidenceErr)}`);
    }
    };
  } catch (e) {
    logger?.warn?.(`[PD:Runtime] Failed to read Runtime V2 prompt activations: ${String(e)}`);
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
    corePrinciples: principlesContent || undefined,
  });

  // 3.5. Owner-Approved Behavior Directives (Runtime V2 activated principles)
  // PLACED IN prependSystemContext (before gateway system prompt) for highest LLM attention.
  // These are owner-reviewed, validated behavior constraints — not background context.
  if (runtimePrincipleIds.size > 0) {
    if (adaptiveOutcome) adaptivePrefix = prependSystemContext;
    const directiveText = adaptiveDirectiveText ?? sharedActivePrinciplePrompt?.additionalContext
      ?? renderPrinciplesToDirectives(dedupedV2, runtimePrincipleIds, {
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
  // thinking_os → reflection_log → reason: truncation → fallback.
  // PRI-467: intentBlockContent is passed so the guard can strip INTENT by
  // exact match before falling back to the nuclear option.
  // PRI-1065: the total ceiling is the SAME model-aware principle budget the
  // directives were rendered under plus a fixed background allowance — a
  // large-window model must not have its background blocks squeezed out by a
  // constant total (the former hard-coded 9000 did exactly that).
  const beforeSizeGuard = { prependContext, appendSystemContext };
  const result = truncateInjectionToBudget(
    prependSystemContext,
    prependContext,
    appendSystemContext,
    {
      totalBudgetChars: resolveTotalInjectionBudgetChars(
        appliedPrincipleBudgetChars(sharedActivePrinciplePrompt, v2PromptBudget),
      ),
      blocks: { projectContextContent, intentBlockContent, thinkingOsContent },
    }
  );

  // Pre-guard snapshot for truncated-fragment classification (presence forensics).
  const preGuardPrependSystemContext = prependSystemContext;
  let presenceFallbackApplied = false;

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

  if (adaptiveOutcome?.targetBodySha256 && adaptiveExpectedTarget && adaptiveSafeFallback) {
    const restore = (fallback: { text: string; ids: string[] }, reason: string) => {
      const guarded = truncateInjectionToBudget(adaptivePrefix + fallback.text, beforeSizeGuard.prependContext, beforeSizeGuard.appendSystemContext, {
        totalBudgetChars: resolveTotalInjectionBudgetChars(appliedPrincipleBudgetChars(sharedActivePrinciplePrompt, v2PromptBudget)),
        blocks: { projectContextContent, intentBlockContent, thinkingOsContent },
      });
      prependSystemContext = guarded.prependSystemContext;
      prependContext = guarded.prependContext;
      appendSystemContext = guarded.appendSystemContext;
      // Presence forensics: a fallback REPLACED the assembly — the pre-guard
      // snapshot no longer describes what was returned, so truncated-fragment
      // classification must not apply.
      presenceFallbackApplied = true;
      runtimePrincipleIds.clear();
      for (const id of fallback.ids) runtimePrincipleIds.add(id);
      runtimePrinciplesContent = fallback.text;
      if (sharedActivePrinciplePrompt) {
        const baseline = sharedActivePrinciplePrompt.adaptivePacking?.nativeBaseline;
        const sources = [sharedActivePrinciplePrompt, ...(baseline ? [baseline] : [])];
        const refs = new Map(sources.flatMap(source => source.principleIds.map((id, i) =>
          [id, { activationId: source.activationIds[i]!, artifactId: source.artifactIds[i]! }] as const)));
        sharedActivePrinciplePrompt = { ...sharedActivePrinciplePrompt, additionalContext: fallback.text,
          principleIds: fallback.ids, activationIds: fallback.ids.map(id => refs.get(id)!.activationId), artifactIds: fallback.ids.map(id => refs.get(id)!.artifactId) };
      }
      v2SelectionPolicy = undefined;
      v2RotationStartIndex = undefined;
      v2RoundOrdinal = undefined;
      v2DroppedActivationIds = undefined;
      v2OversizedActivationIds = undefined;
      adaptiveOutcome = { text: fallback.text, reason, addedTarget: false, displacedActivationIds: [], selectedPrincipleIds: fallback.ids };
    };
    const expected = renderPrinciplesToDirectives([adaptiveExpectedTarget], new Set([adaptiveExpectedTarget.principleId]), { escapeFn: escapeXml });
    const body = adaptiveTargetBody ?? expected.slice(expected.indexOf('<directive '), expected.indexOf('</directive>') + '</directive>'.length);
    if (!prependSystemContext.includes(body)) {
      restore(adaptiveSafeFallback, 'final_target_incomplete');
    } else if (Date.now() >= adaptiveDeadlineAt) {
      restore(adaptiveSafeFallback, 'deadline');
    } else {
      const signal = AbortSignal.timeout(Math.max(1, Math.min(adaptiveDeadlineAt - Date.now(), 15000)));
      const valid = await revalidateAdaptivePrinciple(workspaceDir, adaptiveExpectedTarget, signal);
      if (!valid || Date.now() >= adaptiveDeadlineAt) {
        restore(adaptiveSafeFallback, signal.aborted || Date.now() >= adaptiveDeadlineAt ? 'deadline' : 'target_changed');
      } else if (adaptiveOutcome?.addedTarget && adaptiveBaseline
        && prependSystemContext.length + prependContext.length + appendSystemContext.length
          > resolveTotalInjectionBudgetChars(appliedPrincipleBudgetChars(sharedActivePrinciplePrompt, v2PromptBudget))) {
        restore(adaptiveBaseline, 'final_budget_exceeded');
      }
    }
  }

  // ──── 8.6 PRESENCE EXPECTATIONS (prompt presence forensics, design v1.2) ────
  // Frozen AFTER all body, authorization, timeout and budget fallbacks: the
  // classification runs against the FINAL text this hook returns. Candidates no
  // longer present after a fallback are excluded entirely; pre-guard fragments
  // (truncation without fallback) are marked bodyComplete=false and can never
  // yield a full_hit. Fail-open, memory-only; see prompt-presence-expectations.ts.
  const presenceExpectations = buildInjectedExpectations({
    finalAssembly: prependSystemContext,
    preGuardAssembly: presenceFallbackApplied ? undefined : preGuardPrependSystemContext,
    target: adaptiveTargetBody && adaptiveExpectedTarget?.activationId
      ? { activationId: adaptiveExpectedTarget.activationId, body: adaptiveTargetBody }
      : undefined,
    rendered: dedupedV2
      .filter((p) => runtimePrincipleIds.has(p.principleId))
      .map((p) => ({ activationId: p.activationId, body: p.text })),
    escape: escapeXml,
  });

  // Commit only the final selection, including a late deadline/revision/budget fallback.
  try { commitRuntimeEvidence?.(); } catch (error) {
    logger?.warn?.(`[PD:Runtime] Final prompt evidence unavailable: ${String(error)}`);
  }
  if (adaptiveOutcome) {
    logger?.info?.(`[PD:AA] ${JSON.stringify({
      hookInvocationId: adaptiveInvocationId, sessionId, nativeAdmissionId: adaptiveAdmissionId,
      operatorAdmissionId: adaptiveOperatorAdmission?.admissionId, claimId: adaptiveOperatorAdmission?.claimId,
      reason: adaptiveOutcome.reason, addedTarget: adaptiveOutcome.addedTarget,
      payload: adaptiveOutcome.targetBodySha256 ? 'prepared' : 'none',
      targetBodySha256: adaptiveOutcome.targetBodySha256, submission: 'unknown',
    })}`);
  }

  if (adaptiveInvocationId) {
    const selected = !!adaptiveOutcome?.targetBodySha256;
    const notApplicable = adaptiveOutcome?.reason === 'scene_not_matched';
    recordAdaptive({ ...adaptiveJournalContext, hookInvocationId: adaptiveInvocationId, receiptState: 'closed',
      execution: !adaptiveOutcome || selected || notApplicable ? 'completed' : 'degraded',
      payload: selected ? 'prepared' : 'none', selection: selected ? 'selected' : notApplicable ? 'none_applicable' : adaptiveOutcome ? 'unavailable' : 'skipped',
      submission: 'unknown', reason: adaptiveOutcome?.reason ?? 'native_entry_preserved',
      addedTarget: adaptiveOutcome?.addedTarget ?? false,
      ...(adaptiveAdmissionId ? { nativeAdmissionId: adaptiveAdmissionId } : {}),
      ...(adaptiveOperatorAdmission ? { operatorAdmission: adaptiveOperatorAdmission } : {}),
      ...(adaptiveOutcome?.targetBodySha256 ? { targetBodySha256: adaptiveOutcome.targetBodySha256 } : {}),
    });
    forgetAdaptiveConfigIdentity(adaptiveInvocationId);
  }

  return {
    prependSystemContext,
    prependContext,
    appendSystemContext,
    ...(presenceExpectations && presenceExpectations.expectations.length > 0
      ? {
          injectedExpectations: presenceExpectations.expectations,
          ...(presenceExpectations.overflowCount > 0
            ? { injectedExpectationsOverflow: presenceExpectations.overflowCount }
            : {}),
        }
      : {})
  };
}
