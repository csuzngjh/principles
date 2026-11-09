 
 
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
import { RUNTIME_PRINCIPLE_BUDGET, resolveTotalInjectionBudgetChars, renderPrinciplesToDirectives, formatCorePrinciplesList, resolveOutputLanguage, DEFAULT_OUTPUT_LANGUAGE } from '@principles/core/runtime';
// PRI-1137: the plugin-local injection route (activation list reader + budget
// trimmer + adaptive intervention) is retired; the shared runtime is the only
// ordinary Runtime principle authority.
import type { ResolvedOutputLanguage, PromptSelectionPolicy } from '@principles/core/runtime';
import type { ActivatedPrinciple, AdaptiveInterventionResult, AdaptiveDeliveryRecord } from '@principles/core/runtime';
import { nextSessionTurnOrdinal } from '@principles/core/trajectory-store';
import { truncateInjectionToBudget } from '@principles/core/prompt-builder';
// PRI-1137 retired the plugin-local activation reader; the shared runtime is
// the only ordinary Runtime principle authority (main's resolution, kept).
import { buildInjectedExpectations } from './prompt-presence-expectations.js';
import { getPromptPresenceRegistry } from './prompt-presence-registry.js';
import { revalidateAdaptivePrinciple, type ActivePrinciplePromptResult } from '@principles/host-runtime';
import { readAdaptiveActivationConfig, isPrincipleIdentityMapping } from './adaptive-activation-config.js';
import { takeAdaptivePrincipleResolution } from './adaptive-principle-resolution.js';
import {
  isControlledAdmissionConfigured,
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
import { recordInjectionPresence } from '../core/principle-application-ledger.js';
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
/**
 * PRI-1137 final review P1-3: run claims now carry the PERSISTED ordinal the
 * claimed write produced. A duplicate callback for the same run reuses THAT
 * ordinal instead of re-reading the global `max(turn_index)+1` — the global
 * value may have advanced because a DIFFERENT run wrote a turn in between, and
 * a retry selecting on a foreign round would mislabel the invocation's window.
 * In-process by design (both callbacks of one run arrive in this plugin
 * process); no new persisted state is introduced.
 */
const _processedSignalRunKeys = new Map<string, Map<string, number | undefined>>();

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

function claimSignalRun(workspaceDir: string, sessionIdentity: string, runId: string, ordinal?: number): boolean {
  let runKeys = _processedSignalRunKeys.get(workspaceDir);
  if (!runKeys) {
    runKeys = new Map<string, number | undefined>();
    _processedSignalRunKeys.set(workspaceDir, runKeys);
  }
  const runKey = `${sessionIdentity}\u0000${runId}`;
  if (runKeys.has(runKey)) return false;

  runKeys.set(runKey, ordinal);
  if (runKeys.size > MAX_PROCESSED_SIGNAL_RUNS_PER_WORKSPACE) {
    const oldestRunKey = runKeys.keys().next().value;
    if (typeof oldestRunKey === 'string') runKeys.delete(oldestRunKey);
  }
  return true;
}

function hasClaimedSignalRun(workspaceDir: string, sessionIdentity: string, runId: string): boolean {
  return _processedSignalRunKeys.get(workspaceDir)?.has(`${sessionIdentity}\u0000${runId}`) ?? false;
}

/**
 * PRI-1137 final review P1-3: the ordinal persisted by THIS run's own
 * `user_turns` write (undefined when the claim carries none — e.g. a claim
 * recorded by a code path that did not read the ordinal).
 */
function claimedSignalRunOrdinal(workspaceDir: string, sessionIdentity: string, runId: string): number | undefined {
  return _processedSignalRunKeys.get(workspaceDir)?.get(`${sessionIdentity}\u0000${runId}`);
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
 * the shared route's own resolution, otherwise the legacy constant. The
 * injection event and the size guard both read this one derivation, so the
 * recorded budget and the enforced ceiling cannot drift.
 */
function appliedPrincipleBudgetChars(shared: ActivePrinciplePromptResult | undefined): number {
  return shared?.budget ?? RUNTIME_PRINCIPLE_BUDGET;
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

/**
 * PRI-1137: native hook events whose PRE-SELECTION round preparation already
 * ran. Keyed on the native event object — the SAME object instance reaches
 * both `prepareOpenClawPromptRound` (through the shared `roundKeyProvider`)
 * and the post-selection `handleBeforePromptBuild` callback. It is the only
 * deduplication signal that also covers a host invocation WITHOUT a runId,
 * where the run-claim key cannot distinguish two hook calls.
 */
const _roundPreparedEvents = new WeakSet<object>();

/**
 * PRI-1137 PRE-SELECTION phase for the OpenClaw shared prompt route.
 *
 * The shared runtime must know the session round BEFORE it selects principles
 * (`buildActivePrinciplePromptContext` → roundKey), but OpenClaw's user-turn
 * record is written by `SignalCollectorHost.detectSync`, which the plugin
 * previously ran inside `handleBeforePromptBuild` — i.e. AFTER the shared
 * selection. Calling `nextSessionTurnOrdinal` before that write would read a
 * PREVIOUS round and shift the rotation by one turn.
 *
 * So the plugin preparation is split in two halves that share ONE write:
 *   - pre-selection (this function): signal collection + user_turns write,
 *     then read the trusted ordinal;
 *   - post-selection (`handleBeforePromptBuild`): skips signal collection for
 *     an event already claimed here and assembles the host context.
 *
 * The returned ordinal is exactly `max(turn_index) + 1` AFTER this turn is
 * persisted — the same derivation the former plugin-local route used, so the
 * two routes agreed turn-for-turn. No unconditional `+1` offset is applied
 * anywhere.
 *
 * PRI-1137 final review P1-3 — a round key is returned ONLY when this
 * invocation has a real, persisted round of its own:
 *   - a run already claimed here reuses ITS OWN persisted ordinal (never the
 *     global counter, which a concurrent run's write may have advanced);
 *   - a fresh user-interaction write that reports `user_turn_persisted`
 *     claims the ordinal it just produced;
 *   - EVERYTHING ELSE — no sessionId, no resolvable user message, a message
 *     resolution failure, a non-interactive trigger (heartbeat/cron), an
 *     agent-to-agent message, a write that did not persist, an unreadable
 *     trajectory DB, a non-integer ordinal — returns `undefined` and the
 *     selection degrades to `legacy_fifo_prefix_v1`. Previously a write-free
 *     invocation still read the global ordinal and claimed fair rotation on a
 *     round it never recorded (a heartbeat could re-present the last window
 *     as a fresh fair rotation, and an empty session yielded a fabricated
 *     round 1). A constant round is never fabricated.
 */
export function prepareOpenClawPromptRound(
  event: PluginHookBeforePromptBuildEvent,
  ctx: PluginHookAgentContext & { api?: PromptHookApi },
): number | undefined {
  const logger = ctx.api?.logger;
  const { workspaceDir, sessionId, trigger, runId, sessionKey } = ctx;
  if (!workspaceDir) return undefined;

  let wctx: WorkspaceContext;
  try {
    wctx = WorkspaceContext.fromHookContext(ctx);
  } catch (error) {
    logger?.warn?.(`[PD:Prompt] pre-selection workspace context unavailable: ${String(error)} → legacy_fifo_prefix_v1`);
    return undefined;
  }

  // ── idempotent replay: reuse THIS run's own persisted ordinal ──
  // P1-3: never re-read the global counter here — a concurrent run may have
  // recorded a further turn since, and the retry must select on the round its
  // own write produced, not on a foreign one.
  const sessionIdentity = sessionKey ?? sessionId;
  if (runId !== undefined && sessionIdentity !== undefined && hasClaimedSignalRun(wctx.workspaceDir, sessionIdentity, runId)) {
    const replayed = claimedSignalRunOrdinal(wctx.workspaceDir, sessionIdentity, runId);
    if (typeof replayed === 'number' && Number.isInteger(replayed) && replayed >= 1) {
      logger?.info?.(`[PD:Prompt] round key replayed for claimed run: round=${replayed}, sessionId=${sessionId?.substring(0, 20)}`);
      _roundPreparedEvents.add(event);
      return replayed;
    }
    logger?.warn?.('[PD:Prompt] claimed run carries no valid ordinal → legacy_fifo_prefix_v1');
    _roundPreparedEvents.add(event);
    return undefined;
  }

  // ── pre-selection half: the ONE signal-collection write for this invocation ──
  let currentUserMessage = '';
  let isAgentToAgent = false;
  let messageResolvable = true;
  try {
    const resolved = resolveCurrentUserMessage(event, sessionId);
    currentUserMessage = resolved.message;
    isAgentToAgent = resolved.isAgentToAgent;
  } catch (error) {
    // P1-3: an unresolvable message means the round fact for THIS invocation
    // cannot be established — degrade to FIFO instead of reading an ordinal
    // whose owning write never happened.
    messageResolvable = false;
    logger?.warn?.(`[PD:Prompt] pre-selection user message resolution failed: ${String(error)} → legacy_fifo_prefix_v1`);
  }
  const isUserInteraction = isUserInteractionTrigger(trigger);
  _roundPreparedEvents.add(event);

  if (!messageResolvable) return undefined;
  if (!(currentUserMessage && sessionId && isUserInteraction && !isAgentToAgent)) {
    // P1-3: no write will happen for this invocation (empty message,
    // heartbeat/cron trigger, agent-to-agent traffic, missing sessionId) — so
    // it has NO round of its own and must not claim fair rotation on one.
    if (isUserInteraction && !isAgentToAgent && !currentUserMessage) {
      logger?.info?.('[PD:Prompt] no resolvable user message this invocation → no round key (legacy_fifo_prefix_v1)');
    } else if (!isUserInteraction) {
      logger?.info?.(`[PD:Prompt] non-interactive trigger (${trigger ?? 'unknown'}) records no round → legacy_fifo_prefix_v1`);
    }
    return undefined;
  }
  if (!runId) {
    logger?.warn?.(`[PD:Prompt] runId missing; signal collection cannot be deduplicated: sessionId=${sessionId.substring(0, 20)}`);
  }
  let referencesAssistantTurnId: number | null = null;
  try {
    if (event.messages.some((message) => hasMessageRole(message, 'assistant'))) {
      const turns = wctx.trajectory?.listAssistantTurns?.(sessionId) ?? [];
      referencesAssistantTurnId = turns[turns.length - 1]?.id ?? null;
    }
  } catch (error) {
    logger?.warn?.(`[PD:Prompt] pre-selection assistant-turn anchor unavailable: ${String(error)}`);
  }
  try {
    const outcome = getSignalCollectorHost(wctx, logger).detectSync(
      currentUserMessage, sessionId, trigger ?? 'api',
      {
        referencesAssistantTurnId,
        turnIndex: nextUserTurnIndex(wctx, sessionId, event.messages),
        ...(runId ? { idempotencyKey: `${sessionKey ?? sessionId}\u0000${runId}` } : {}),
      },
    );
    if (outcome?.status !== 'user_turn_persisted') {
      // The write did not land (threw / no rowid / stub returned nothing):
      // no new round exists to key on, and the run must NOT be claimed so a
      // later retry can still collect.
      const reason = outcome?.status === 'user_turn_persist_failed'
        ? outcome.reason
        : `collector_status_${String(outcome?.status ?? 'missing')}`;
      logger?.warn?.(
        `[PD:Prompt] pre-selection user_turns not persisted (${reason}) → legacy_fifo_prefix_v1`,
      );
      return undefined;
    }
  } catch (error) {
    // Detection failure means "no confirmed persistence" — no round key.
    logger?.warn?.(`[PD:Prompt] pre-selection signal collection failed: ${String(error)} → legacy_fifo_prefix_v1`);
    return undefined;
  }

  // ── round authority: only the persisted OpenClaw user_turns counter ──
  try {
    const ordinal = nextSessionTurnOrdinal(wctx.workspaceDir, sessionId);
    if (typeof ordinal === 'number' && Number.isInteger(ordinal) && ordinal >= 1) {
      // Claim with the ordinal THIS write produced — retries of the same run
      // replay exactly this round (P1-3 race fix).
      if (runId) claimSignalRun(wctx.workspaceDir, sessionKey ?? sessionId, runId, ordinal);
      logger?.info?.(`[PD:Prompt] round key resolved: round=${ordinal}, sessionId=${sessionId.substring(0, 20)}`);
      return ordinal;
    }
    logger?.warn?.(`[PD:Prompt] round key invalid (${String(ordinal)}); falling back to legacy_fifo_prefix_v1`);
    return undefined;
  } catch (error) {
    logger?.warn?.(`[PD:Prompt] round key unavailable (trajectory DB unreadable): ${String(error)} → legacy_fifo_prefix_v1`);
    return undefined;
  }
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
  // PRI-1140: a {principleId} mapping carries no local target identity — the
  // provider resolved it against the CURRENT authorized set for THIS
  // invocation. Consume that resolution exactly once, whatever the re-read
  // mapping now says, so it never lingers; a replay or a duplicate callback
  // that finds it gone degrades to the native baseline (same safety shape as a
  // lost controlled-admission handoff).
  const principleResolution = takeAdaptivePrincipleResolution(sharedActivePrinciplePrompt?.adaptivePacking?.hookInvocationId);
  // PRI-1140 closeout: the mapping was just re-read. A principle mapping keeps
  // this invocation's priority only while it still names the principle the
  // provider resolved. Switched mid-flight to another principle → THIS round
  // falls back to Native (the terminal record stays with the original
  // invocation and target); the next request resolves the current mapping.
  const principleMappingChanged = adaptiveMapping !== null && isPrincipleIdentityMapping(adaptiveMapping)
    && principleResolution !== undefined && principleResolution.principleId !== adaptiveMapping.principleId;
  // The concrete target identity this invocation may use: the pinned mapping
  // itself, or the provider's principle resolution. Undefined = no verified
  // identity, so nothing downstream may fabricate one.
  const mappingTarget: { artifactId: string; activationId: string } | undefined = !adaptiveMapping
    ? undefined
    : isPrincipleIdentityMapping(adaptiveMapping)
      ? (principleResolution && !principleMappingChanged
        ? { artifactId: principleResolution.artifactId, activationId: principleResolution.activationId }
        : undefined)
      : adaptiveMapping;
  // A mapping can expire or be disabled while the shared packer is running.
  // In that case discard its additional contribution before assembling anything.
  const preparedPacking = sharedActivePrinciplePrompt?.adaptivePacking;
  if (preparedPacking?.nativeBaseline && (!mappingTarget
    || preparedPacking.targetActivationId !== mappingTarget.activationId
    || preparedPacking.targetSnapshot?.artifactId !== mappingTarget.artifactId)) {
    sharedActivePrinciplePrompt = preparedPacking.nativeBaseline;
  }
  const adaptiveInvocationId = preparedPacking?.hookInvocationId
    ?? (mappingTarget ? beginAdaptivePromptInvocation(ctx, mappingTarget, sharedActivePrinciplePrompt ? 'shared' : 'plugin_local') : undefined);
  const recordAdaptive = (record: AdaptiveDeliveryRecord) => {
    try { wctx.eventLog.recordAdaptiveDelivery(sessionId, record); } catch (error) {
      logger?.warn?.(`[PD:AA] Invocation journal unavailable: ${String(error)}`);
    }
  };
  // A config reload may replace the mapping after packing. The terminal record
  // still belongs to the invocation's original target, never the replacement.
  const journalTarget = preparedPacking?.hookInvocationId && preparedPacking.targetArtifactId
    ? { artifactId: preparedPacking.targetArtifactId, activationId: preparedPacking.targetActivationId } : mappingTarget ?? undefined;
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
  // PRI-1137 final review P1-3: a resolution failure must degrade THIS concern
  // (no message-scoped behavior) instead of failing the whole prompt build —
  // the shared selection already degraded to FIFO via the pre-selection phase.
  let currentUserMessage = '';
  let isAgentToAgent = false;
  try {
    ({ message: currentUserMessage, isAgentToAgent } = resolveCurrentUserMessage(event, sessionId));
  } catch (error) {
    logger?.warn?.(`[PD:Prompt] post-selection user message resolution failed: ${String(error)} — message-scoped injection skipped`);
  }

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
    if (_roundPreparedEvents.has(event)) {
      // PRI-1137: the shared route's pre-selection phase already ran
      // SignalCollectorHost for this invocation (it must, because the round
      // key is resolved before the shared prompt context is built). Repeating
      // it here would double-write user_turns and double-dispatch STRONG
      // signals — including when no runId exists, where the run-claim key
      // cannot deduplicate.
      _roundPreparedEvents.delete(event);
      logger?.info?.('[PD:Prompt] signal collection already performed by the pre-selection round phase');
    } else if (runId && hasClaimedSignalRun(wctx.workspaceDir, sessionKey ?? sessionId, runId)) {
      logger?.info?.(`[PD:Prompt] duplicate signal run skipped: runId=${runId}, sessionId=${sessionId.substring(0, 20)}`);
    } else {
      if (!runId) {
        logger?.warn?.(`[PD:Prompt] runId missing; signal collection cannot be deduplicated: sessionId=${sessionId.substring(0, 20)}`);
      }
      // trigger ?? 'api':detectSync 的 trigger 参数必须为具体值(host 内部用
      // isUserInteractionTrigger 判定,undefined 会被接受但下游日志/标签需要具体值)。
      const outcome = getSignalCollectorHost(wctx, logger).detectSync(
        currentUserMessage, sessionId, trigger ?? 'api',
        {
          referencesAssistantTurnId: correctionReferencesAssistantTurnId,
          turnIndex: nextUserTurnIndex(wctx, sessionId, event.messages),
        },
      );
      // PRI-1137: a run is claimed only when its user_turns row really landed,
      // so a failed write stays retryable instead of looking "already
      // collected". P1-3: the claim carries the ordinal this write produced,
      // so a retry of the same run replays THIS round.
      if (runId && outcome?.status === 'user_turn_persisted') {
        let claimedOrdinal: number | undefined;
        try {
          const ordinal = nextSessionTurnOrdinal(wctx.workspaceDir, sessionId);
          if (typeof ordinal === 'number' && Number.isInteger(ordinal) && ordinal >= 1) claimedOrdinal = ordinal;
        } catch {
          // Claim without an ordinal — a replay of this run then degrades to
          // FIFO rather than selecting on a foreign round (P1-3).
        }
        claimSignalRun(wctx.workspaceDir, sessionKey ?? sessionId, runId, claimedOrdinal);
      }
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
  // PRI-1137: the plugin-local injection route is retired — the shared runtime
  // is the ONLY source of ordinary Runtime principles; there is no local fallback.
  let v2ResultWarnings: string[] = [];
  try {
    if (sharedActivePrinciplePrompt) {
      v2ResultWarnings = sharedActivePrinciplePrompt.warnings;
      if (v2ResultWarnings.length > 0) {
        // Data-integrity warnings (unreadable artifacts, malformed content,
        // broken config) must stay at warn: they are degradations the Owner
        // must see, not routine info. Benign states (feature disabled, no
        // runtime DB yet) stay at info to avoid per-turn warn spam.
        const integrity = v2ResultWarnings.some((w) =>
          /^(config_invalid|artifact_|activation_db_unreadable|prompt_activation_authority_unavailable)/.test(w));
        const line = `[PD:Runtime] Activation read warnings: ${v2ResultWarnings.join('; ')}`;
        if (integrity) logger?.warn?.(line);
        else logger?.info?.(line);
      }
    } else {
      // Every production OpenClaw prompt arrives through the shared runtime.
      // An absent result is a wiring failure, not a reason to re-run the
      // retired plugin-local reader (rc-9: the absence stays observable).
      logger?.warn?.('[PD:Runtime] shared prompt result missing — no Runtime principles injected on this invocation');
    }

    if (sharedActivePrinciplePrompt) {
      const packing = sharedActivePrinciplePrompt.adaptivePacking;
      // PRI-1140: the identity comparison uses the invocation's resolved
      // target (pinned mapping or provider principle resolution) — never an
      // unresolved principleId.
      if (adaptiveMapping && mappingTarget && packing?.targetSnapshot && packing.targetBody && packing.nativeBaseline
        && packing.targetActivationId === mappingTarget.activationId
        && packing.targetSnapshot.artifactId === mappingTarget.artifactId) {
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
            // PRI-1140 closeout: a mid-flight principle switch is recorded as
            // such on the ORIGINAL invocation instead of a generic reason.
            reason: principleMappingChanged ? 'adaptive_mapping_changed'
              : text.split(/\r?\n/, 1)[0] === '[PD-AA:delivery-review:v1]' ? 'shared_priority_unavailable' : 'scene_not_matched',
            addedTarget: false, displacedActivationIds: [], selectedPrincipleIds: sharedActivePrinciplePrompt.principleIds };
        }
      }
      if (admissionHandoffMissing && sharedActivePrinciplePrompt.adaptivePacking?.nativeBaseline) {
        // The Native fallback is the effective prompt, not just replacement
        // text. Rebind the result before any evidence writer runs so content,
        // principle/activation/artifact IDs, budget and selection metadata all
        // describe the same prompt that will be returned to the host.
        sharedActivePrinciplePrompt = sharedActivePrinciplePrompt.adaptivePacking.nativeBaseline;
      }
      runtimePrinciplesContent = sharedActivePrinciplePrompt.additionalContext;
      for (const id of sharedActivePrinciplePrompt.principleIds) runtimePrincipleIds.add(id);
      v2Truncated = sharedActivePrinciplePrompt.truncated;
      v2SelectionPolicy = sharedActivePrinciplePrompt.selectionPolicy;
      v2EligibleCount = sharedActivePrinciplePrompt.eligibleCount;
      v2RotationStartIndex = sharedActivePrinciplePrompt.rotationStartIndex;
      // PRI-1137: the shared selection carries the trusted round it advanced
      // on; the injected event records the same fact instead of omitting it.
      v2RoundOrdinal = sharedActivePrinciplePrompt.selectionRoundOrdinal;
      v2DroppedActivationIds = sharedActivePrinciplePrompt.droppedActivationIds;
      v2OversizedActivationIds = sharedActivePrinciplePrompt.oversizedActivationIds;
    }

    commitRuntimeEvidence = () => {
    const sharedPrompt = sharedActivePrinciplePrompt;
    // ── Emit structured observability event ──
    // PRI-1137: the event describes the ONE shared selection that was actually
    // rendered. No plugin-local fallback exists, so an absent shared result
    // emits nothing (the wiring failure was already logged at warn).
    if (!sharedPrompt) return;
    try {
      const eventLog = wctx.eventLog;
      // PRI-537: pair the source arrays with the INJECTED subset — all three
      // arrays come from the same shared selection, so index alignment cannot
      // drift between them.
      // SPEC-PD-MODEL-AWARE-PROMPT-BUDGET-001: the budget THIS injection ran
      // under — the shared route's own resolution. Never a restated constant:
      // a recorded budget that differs from the executed one is a silent lie.
      const v2EventBudget = appliedPrincipleBudgetChars(sharedPrompt);
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
        principleIds: sharedPrompt.principleIds,
        activationIds: sharedPrompt.activationIds,
        artifactIds: sharedPrompt.artifactIds,
        injectedCount: runtimePrincipleIds.size,
        skippedWarnings: v2ResultWarnings,
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
        // with the event — the shared route carries its own resolution; absent
        // resolution (aborted build) means policy unknown, which readers must
        // treat as fixed-budget.
        ...(sharedPrompt.budgetPolicyVersion !== undefined ? { budgetPolicyVersion: sharedPrompt.budgetPolicyVersion } : {}),
        ...(sharedPrompt.budgetCapacitySource !== undefined ? { budgetCapacitySource: sharedPrompt.budgetCapacitySource } : {}),
        ...(sharedPrompt.budgetCapacityStatus !== undefined ? { budgetCapacityStatus: sharedPrompt.budgetCapacityStatus } : {}),
        ...(sharedPrompt.budgetContextWindowTokens != null ? { budgetContextWindowTokens: sharedPrompt.budgetContextWindowTokens } : {}),
        // SPEC §7 v0.2: bounded fallback reason code.
        ...(sharedPrompt.budgetFallbackReason !== undefined ? { budgetFallbackReason: sharedPrompt.budgetFallbackReason } : {}),
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
    // INJECTED subset. The shared selection already carries parallel arrays.
    // PRI-899: the SAME aligned array now feeds BOTH the session tracker (the
    // pairing the self_report effect row is written from) and the presence
    // writer below, so the two receipt levels pair principles to activations
    // identically — one pairing derivation, not two.
    const alignedActivationIds = sharedPrompt.activationIds;
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
      const evidenceInjected = sharedPrompt.principleIds
        .map((principleId, index) => ({
          principleId,
          activationId: sharedPrompt.activationIds[index] ?? '',
          artifactId: sharedPrompt.artifactIds[index],
        }))
        .filter((entry) => entry.activationId.length > 0);
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
  if (runtimePrincipleIds.size > 0 && sharedActivePrinciplePrompt) {
    if (adaptiveOutcome) adaptivePrefix = prependSystemContext;
    prependSystemContext += adaptiveDirectiveText ?? sharedActivePrinciplePrompt.additionalContext;
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
        appliedPrincipleBudgetChars(sharedActivePrinciplePrompt),
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
        totalBudgetChars: resolveTotalInjectionBudgetChars(appliedPrincipleBudgetChars(sharedActivePrinciplePrompt)),
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
          > resolveTotalInjectionBudgetChars(appliedPrincipleBudgetChars(sharedActivePrinciplePrompt))) {
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
  //
  // PRI-1137 merge note: the plugin-local activation reader (dedupedV2) is
  // retired — per-principle raw bodies come exclusively from the PD-internal
  // host-runtime freeze (`injectedExpectations` on ActivePrinciplePromptResult,
  // PRI-1150), which is already escaped rendered text (preEscaped). The
  // hook-result field of the same name that OpenClaw whitelist-drops is NOT a
  // Path A dependency: the registry below is PD-internal memory.
  //
  // PRI-1150 review (D3): EVERY applicable assembly registers its snapshot —
  // including empty ones — so a callback can never inherit a previous
  // assembly's sole snapshot. The empty KIND is distinguished:
  //   none_injected              → confirmed: no principles assembled this build;
  //   shared_field_absent        → shared result carried principles but the frozen
  //                                per-principle field was absent (cannot obtain
  //                                expectations — NOT evidence of zero injection);
  //   target_removed_by_fallback → a fallback replaced the assembly and the
  //                                prioritized target is gone;
  //   generation_failed          → expectation generation threw (fail-open).
  // Registration requires trusted workspace + run + session identity.
  let presenceSnapshotKind: 'none_injected' | 'shared_field_absent' | 'target_removed_by_fallback' | 'generation_failed' | undefined;
  let presenceExpectations: ReturnType<typeof buildInjectedExpectations> | undefined;
  try {
    const sharedHasPrinciples = (sharedActivePrinciplePrompt?.principleIds.length ?? 0) > 0;
    const sharedFieldPresent = Array.isArray(sharedActivePrinciplePrompt?.injectedExpectations);
    if (presenceFallbackApplied) {
      presenceSnapshotKind = 'target_removed_by_fallback';
    } else if (!sharedHasPrinciples && !adaptiveExpectedTarget) {
      presenceSnapshotKind = 'none_injected';
    } else if (sharedActivePrinciplePrompt && !sharedFieldPresent) {
      presenceSnapshotKind = 'shared_field_absent';
    }
    presenceExpectations = buildInjectedExpectations({
      finalAssembly: prependSystemContext,
      preGuardAssembly: presenceFallbackApplied ? undefined : preGuardPrependSystemContext,
      target: adaptiveTargetBody && adaptiveExpectedTarget?.activationId
        ? {
            activationId: adaptiveExpectedTarget.activationId,
            body: adaptiveTargetBody,
            // Renderer contract (adaptive-principle-intervention.ts): targetBody is
            // the ALREADY ESCAPED <directive> slice — re-escaping would hide it.
            preEscaped: true,
          }
        : undefined,
      rendered: (sharedActivePrinciplePrompt?.injectedExpectations ?? []).map((entry) => ({
        activationId: entry.activationId,
        body: entry.bodyText,
        preEscaped: true,
      })),
    });
    if (!presenceExpectations && presenceSnapshotKind === undefined) {
      presenceSnapshotKind = 'generation_failed';
    }
  } catch (presenceErr) {
    // Fail-open: expectation generation must never break the prompt hook.
    logger?.warn?.(`[PD:presence] expectation generation failed (observation degraded): ${String(presenceErr)}`);
    presenceSnapshotKind = 'generation_failed';
    presenceExpectations = undefined;
  }

  // PRI-1150 Path A: register the FINAL calibrated snapshot for this run so the
  // official llm_input callback (async, no assembly identity) can bind under
  // the registry's verdict rules. Memory-only; requires trusted workspace,
  // run and session identity (all three) — anything less is skipped with a
  // diagnostic, never silently.
  if (workspaceDir && runId && sessionId) {
    try {
      const registration = getPromptPresenceRegistry().registerAssemblySnapshot({
        runId,
        sessionId,
        workspaceDir,
        expectations: (presenceExpectations?.expectations ?? []).map((entry) => ({
          activationId: entry.activationId,
          bodyText: entry.bodyText,
          bodyChars: entry.bodyChars,
          bodyComplete: entry.bodyComplete,
        })),
        overflowCount: presenceExpectations?.overflowCount ?? 0,
        emptyKind: presenceExpectations?.expectations.length
          ? undefined
          : (presenceSnapshotKind ?? 'none_injected'),
      });
      if (registration.degradedReason) {
        logger?.warn?.(`[PD:presence] snapshot registered DEGRADED (${registration.degradedReason}): assemblySeq=${registration.assemblySeq}`);
      }
    } catch (registryErr) {
      logger?.warn?.(`[PD:presence] snapshot registration failed (observation skipped this build): ${String(registryErr)}`);
    }
  } else if (runId || sessionId) {
    logger?.warn?.(
      `[PD:presence] snapshot registration skipped — incomplete identity: workspaceDir=${!!workspaceDir} runId=${!!runId} sessionId=${!!sessionId}. ` +
      `nextAction: presence observation for this build is unavailable (unknown), not zero-injection.`,
    );
  }

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
