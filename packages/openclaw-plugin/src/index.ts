import type {
  OpenClawPluginApi,
  PluginHookBeforePromptBuildEvent,
  PluginHookAgentContext,
  PluginHookBeforePromptBuildResult,
  PluginHookBeforeToolCallEvent,
  PluginHookToolContext,
  PluginHookBeforeToolCallResult,
  PluginHookAfterToolCallEvent,
  PluginHookBeforeResetEvent,
  PluginHookBeforeCompactionEvent,
  PluginHookAfterCompactionEvent,
  PluginHookLlmOutputEvent,
  PluginHookBeforeMessageWriteEvent,
} from './openclaw-sdk.js';
import * as path from 'path';
import { loadFeatureFlagFromConfig } from './core/pd-config-loader.js';
import { scheduleTelemetryExportForWorkspace } from './core/product-telemetry-trigger.js';
import { checkConversationAccessConfig, getPluginEntry, ensureConversationAccessInConfig } from './core/config-health.js';
export { checkConversationAccessConfig, getPluginEntry, ensureConversationAccessInConfig } from './core/config-health.js';
export type { ConversationAccessCheckResult } from './core/config-health.js';
import { getCommandDescription } from './i18n/commands.js';
import { WorkspaceContext } from './core/workspace-context.js';
import { handleBeforePromptBuild, selectLegacyPrinciplesForPrompt, type LegacyPrinciplePromptSelection } from './hooks/prompt.js';
import { buildOpenClawRuleInputEnrichment, buildRuleContextIfEnabled, handleBeforeToolCall, handleSharedRuleHostResult } from './hooks/gate.js';
import { handleAfterToolCall, handleSharedPainEvidenceResult, prepareOrdinaryAfterToolCallForSharedRuntime } from './hooks/pain.js';
import { handleBeforeReset, handleBeforeCompaction, handleAfterCompaction } from './hooks/lifecycle.js';
import { handleLlmOutput } from './hooks/llm.js';
import * as TrajectoryCollector from './hooks/trajectory-collector.js';
import { handleInitStrategy } from './commands/strategy.js';
import { handleBootstrapTools, handleResearchTools } from './commands/capabilities.js';
import { handlePainCommand, handlePainReportCommand } from './commands/pain.js';
import { handleContextCommand } from './commands/context.js';
import { handleFocusCommand } from './commands/focus.js';
import { handleRollbackCommand } from './commands/rollback.js';
import { handlePromoteImplCommand } from './commands/promote-impl.js';
import { handleDisableImplCommand } from './commands/disable-impl.js';
import { handleArchiveImplCommand } from './commands/archive-impl.js';
import { handleRollbackImplCommand } from './commands/rollback-impl.js';
import { handleEvolutionStatusCommand } from './commands/evolution-status.js';
import { handlePrincipleRollbackCommand } from './commands/principle-rollback.js';
import { handleExportCommand } from './commands/export.js';
import { handleSamplesCommand } from './commands/samples.js';
import { handleWorkflowDebugCommand } from './commands/workflow-debug.js';
import { EvolutionWorkerService } from './service/evolution-worker.js';
import { CorrectionObserverService } from './service/correction-observer-service.js';
import { InternalizationAutoConsumerService } from './service/internalization-auto-consumer-service.js';
import { TrajectoryService } from './service/trajectory-service.js';
import { PDTaskService } from './core/pd-task-service.js';
import { ensureWorkspaceTemplates } from './core/init.js';
import { migrateDirectoryStructure } from './core/migration.js';
import { migrateStaleWorkspaceGuidance } from './core/workspace-guidance-migrator.js';
import { SystemLogger } from './core/system-logger.js';
import { PathResolver } from './core/path-resolver.js';
import { resolveCommandWorkspaceDir, resolveToolHookWorkspaceDirSafe, resolveHookWorkspaceDir } from './utils/workspace-resolver.js';
import { validateWorkspaceDir } from './core/workspace-dir-validation.js';
import { checkSurfaceGuard, guardHook, guardService, safeStringifyPreview } from '@principles/core/runtime-v2';
import { createOpenClawHostRuntime } from './host-runtime/openclaw-host-runtime.js';

// Track started workspaces — one-time init + evolution worker per workspace
const startedWorkspaces = new Set<string>();

// PRI-343: Module-level auto-fix for allowConversationAccess.
// Runs IMMEDIATELY when this bundle is imported (before register() is called).
// Uses file locking to prevent race conditions with concurrent writers.
try {
  ensureConversationAccessInConfig();
} catch {
  // Best-effort — register() will retry with logging.
}

// ── Conversation Access Health Check (PRI-343) ────────────────────────────
// Re-exported from core/config-health.ts for backward compatibility.
// Implementation moved to avoid circular imports with trajectory-collector.ts.

// ── Feature Flag Loader (plugin I/O boundary) ─────────────────────────────
// Reads workspace .pd/config.yaml and checks a specific flag.
// (ADR-0016: the legacy .pd/feature-flags.yaml is no longer read by production runtime.)
// Returns the flag definition with effective enabled state.
function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/**
 * PRI-305/PRI-307: Load feature flag from .pd/config.yaml instead of .pd/feature-flags.yaml.
 * Delegates to the shared plugin config loader for consistency.
 */
function loadFeatureFlagFromWorkspace(
  workspaceDir: string,
  flagId: string,
  logger?: { warn?: (msg: string) => void; info?: (msg: string) => void },
): { enabled: boolean; source: string } {
  return loadFeatureFlagFromConfig(workspaceDir, flagId, logger);
}

// ── Evolution Worker Startup Gate (shared between index.ts and tests) ───────
// Determines whether the legacy evolution worker should start and produces
// structured observability when disabled (ERR-002).

export interface EvolutionWorkerGateResult {
  shouldStart: boolean;
  flagSource: string;
  disabledInfo: string | null;
}

export function shouldStartEvolutionWorker(
  workspaceDir: string,
  logger: { info?: (msg: string) => void; warn?: (msg: string) => void },
): EvolutionWorkerGateResult {
  const flag = loadFeatureFlagFromWorkspace(workspaceDir, 'evolution_worker', logger);
  if (flag.enabled) {
    return { shouldStart: true, flagSource: flag.source, disabledInfo: null };
  }
  const disabledInfo = JSON.stringify({
    reason: 'mvp_quiet_per_adr0014',
    nextAction: 'set features.evolution_worker.enabled=true in .pd/config.yaml to enable',
    featureFlag: 'evolution_worker',
    boundedContext: 'legacy_evolution_worker',
    flagSource: flag.source,
  });
  return { shouldStart: false, flagSource: flag.source, disabledInfo };
}

export interface CorrectionObserverGateResult {
  shouldStart: boolean;
  flagSource: string;
  disabledInfo: string | null;
}

export function shouldStartCorrectionObserver(
  workspaceDir: string,
  logger: { info?: (msg: string) => void; warn?: (msg: string) => void },
): CorrectionObserverGateResult {
  const flag = loadFeatureFlagFromWorkspace(workspaceDir, 'correction_observer', logger);
  if (flag.enabled) {
    return { shouldStart: true, flagSource: flag.source, disabledInfo: null };
  }
  const disabledInfo = JSON.stringify({
    reason: 'correction_observer_disabled',
    nextAction: 'set features.correction_observer.enabled=true in .pd/config.yaml to enable',
    featureFlag: 'correction_observer',
    boundedContext: 'correction_observer_service',
    flagSource: flag.source,
  });
  return { shouldStart: false, flagSource: flag.source, disabledInfo };
}

export interface InternalizationAutoConsumerGateResult {
  shouldStart: boolean;
  flagSource: string;
  disabledInfo: string | null;
}

export function shouldStartInternalizationAutoConsumer(
  workspaceDir: string,
  logger: { info?: (msg: string) => void; warn?: (msg: string) => void },
): InternalizationAutoConsumerGateResult {
  const flag = loadFeatureFlagFromWorkspace(workspaceDir, 'internalization_auto_consumer', logger);
  if (flag.enabled) {
    return { shouldStart: true, flagSource: flag.source, disabledInfo: null };
  }
  const disabledInfo = JSON.stringify({
    reason: 'internalization_auto_consumer_disabled',
    nextAction: `pd runtime internalization run-once --workspace "${workspaceDir}" --runner dreamer --runtime config --json`,
    featureFlag: 'internalization_auto_consumer',
    boundedContext: 'internalization_auto_consumer',
    flagSource: flag.source,
  });
  return { shouldStart: false, flagSource: flag.source, disabledInfo };
}

export function shouldUseSharedHostRuntime(
  workspaceDir: string,
  logger: { info?: (msg: string) => void; warn?: (msg: string) => void },
): { enabled: boolean; source: string; rollbackReason: string | null } {
  const flag = loadFeatureFlagFromWorkspace(workspaceDir, 'abstraction_layer_v1', logger);
  if (flag.enabled) return { enabled: true, source: flag.source, rollbackReason: null };
  return {
    enabled: false,
    source: flag.source,
    rollbackReason: JSON.stringify({
      reason: 'abstraction_layer_v1_disabled',
      nextAction: 'set features.abstraction_layer_v1.enabled=true in .pd/config.yaml for controlled shared-runtime parity validation',
      route: 'openclaw_legacy',
      flagSource: flag.source,
    }),
  };
}

const plugin = {
  name: "Principles Disciple",
  description: "Evolutionary programming agent framework with strategic guardrails and reflection loops.",

  register(api: OpenClawPluginApi) {
    api.logger.info(`Principles Disciple Plugin registered. (Path: ${api.rootDir ?? '(unknown)'})`);
    PathResolver.setExtensionRoot(api.rootDir ?? '.');

    // ── Startup Health Check: Verify workspaceDir resolution ──
    // Catches OpenClaw context bugs early (e.g., missing workspaceDir in tool hooks)
    const healthCheckTimer = setTimeout(() => {
      const testCtx = { agentId: 'main' };
      const toolWorkspaceDir = resolveToolHookWorkspaceDirSafe(testCtx, api, 'startup.health_check');
      const toolIssue = validateWorkspaceDir(toolWorkspaceDir);
      if (toolIssue) {
        api.logger.error(`[PD:health] Tool hook workspaceDir is INVALID: "${toolWorkspaceDir}" - ${toolIssue}`);
        api.logger.error(`[PD:health] Tool hook events will be written to the WRONG .state directory!`);
      } else {
        api.logger.info(`[PD:health] Tool hook workspaceDir OK: "${toolWorkspaceDir}"`);
      }

      // PRI-343: Check allowConversationAccess — auto-fix if missing/false, warn if fix fails.
      // Uses file locking to prevent race conditions with concurrent writers.
      const accessCheck = checkConversationAccessConfig(getPluginEntry(api.config, api.id));
      if (!accessCheck.authorized) {
        let fixed = false;
        try {
          fixed = ensureConversationAccessInConfig();
        } catch (err) {
          api.logger.warn(
            `[PD:health] auto-fix for allowConversationAccess failed: ${String(err instanceof Error ? err.message : err)}`,
          );
        }
        if (fixed) {
          api.logger.info(
            `[PD:health] allowConversationAccess auto-configured. Restart the gateway to activate conversation hooks.`,
          );
        } else {
          api.logger.error(
            `[PD:health] conversation hooks (llm_output / trajectory) will be BLOCKED by OpenClaw.\n` +
            `  reason: ${accessCheck.reason}\n` +
            `  nextAction: ${accessCheck.nextAction}`,
          );
        }
      } else {
        api.logger.info(`[PD:health] conversation hooks (allowConversationAccess) OK`);
      }
    }, 1000);
    healthCheckTimer.unref(); // Don't keep process alive for health check

    // Cache the shared-runtime gate per workspace so the hot-path tool hooks
    // (before_tool_call / after_tool_call) don't re-read the feature flag on
    // every call, and so the disabled-path rollback log is emitted once per
    // workspace. PD loads feature flags at startup, so a config change requires
    // a gateway restart to take effect.
    const runtimeGateCache = new Map<string, ReturnType<typeof shouldUseSharedHostRuntime>>();
    const loggedRollbackWorkspaces = new Set<string>();
    const runtimeGateFor = (workspaceDir: string): ReturnType<typeof shouldUseSharedHostRuntime> => {
      let gate = runtimeGateCache.get(workspaceDir);
      if (!gate) {
        gate = shouldUseSharedHostRuntime(workspaceDir, api.logger);
        runtimeGateCache.set(workspaceDir, gate);
      }
      if (!gate.enabled && !loggedRollbackWorkspaces.has(workspaceDir)) {
        loggedRollbackWorkspaces.add(workspaceDir);
        api.logger.info(`[PD:host-runtime] OpenClaw legacy route selected. ${gate.rollbackReason}`);
      }
      return gate;
    };

    // ── MVP Surface Guard (PRI-289): Verify surface classification ──
    const surfaceGuard = checkSurfaceGuard();
    if (!surfaceGuard.passed) {
      for (const violation of surfaceGuard.violations) {
        api.logger.error(`[PD:surface-guard] VIOLATION: ${violation}`);
      }
    }
    api.logger.info(`[PD:surface-guard] Core surfaces: ${surfaceGuard.enabledCoreSurfaces.join(', ')}`);
    api.logger.info(`[PD:surface-guard] Disabled non-core surfaces: ${surfaceGuard.disabledNonCoreSurfaces.length}`);
    for (const warning of surfaceGuard.warnings) {
      api.logger.warn(`[PD:surface-guard] ${warning}`);
    }

    // Language fallback must match openclaw.plugin.json configSchema default
    // ("zh") — an 'en' fallback silently served English templates/prompts to
    // every install that never set plugin config language (ERR-075 family).
    const language = (api.pluginConfig?.language as string) || 'zh';
    const preparedLegacyPromptSelections = new WeakMap<PluginHookBeforePromptBuildEvent, LegacyPrinciplePromptSelection>();
    const sharedHostRuntime = createOpenClawHostRuntime({
      promptExcludePrincipleIds: (event, context) => {
        try {
          const reducer = WorkspaceContext.fromHookContext({ ...context, workspaceDir: context.workspaceDir }).evolutionReducer;
          const selection = selectLegacyPrinciplesForPrompt(context.workspaceDir ?? '', reducer, api.logger);
          preparedLegacyPromptSelections.set(event, selection);
          return selection.selectedIds;
        } catch (error) {
          api.logger.info(`[PD:RuntimeV2] Legacy principle dedup unavailable; continuing with shared active principles: ${String(error)}`);
          return new Set<string>();
        }
      },
      beforePromptBuild: async (event, context, activePrinciplePrompt) => {
        const prepared = preparedLegacyPromptSelections.get(event);
        preparedLegacyPromptSelections.delete(event);
        return handleBeforePromptBuild(event, {
          ...context,
          api: api as Parameters<typeof handleBeforePromptBuild>[1]['api'],
        }, activePrinciplePrompt, prepared);
      },
      ruleContextProvider: (_event, context, request) => buildRuleContextIfEnabled(
        WorkspaceContext.fromHookContext({ ...context, workspaceDir: context.workspaceDir }),
        request.targetPath,
        context.sessionId,
        api.logger,
      ),
      ruleInputEnrichmentProvider: (event, context) => buildOpenClawRuleInputEnrichment(event, context.workspaceDir ?? '', context.sessionId),
      onBeforeToolResult: (event, context, result) => {
        if (!context.workspaceDir) {
          api.logger.warn('[PD_GATE:RULE_HOST] shared result mapping skipped: workspaceDir missing; nextAction=inspect OpenClaw hook context');
          return;
        }
        handleSharedRuleHostResult(event, { ...context, workspaceDir: context.workspaceDir, logger: api.logger }, result);
        const ruleDecision = result.metadata?.['ruleDecision'];
        if (ruleDecision === 'auto_correct' || ruleDecision === 'requireApproval') {
          return handleBeforeToolCall(event, {
            ...context,
            workspaceDir: context.workspaceDir,
            pluginConfig: api.pluginConfig ?? {},
            logger: api.logger,
          });
        }
      },
      painEnrichmentProvider: (event, context) => prepareOrdinaryAfterToolCallForSharedRuntime(event, {
        ...context,
        workspaceDir: context.workspaceDir ?? '',
        pluginConfig: api.pluginConfig ?? {},
      }),
      onAfterToolResult: (event, context, result) => handleSharedPainEvidenceResult(event, {
        ...context,
        workspaceDir: context.workspaceDir ?? '',
      }, result),
    });

    // ── Hook: Prompt Building ──
    api.on(
      'before_prompt_build',
      guardHook('hook:before_prompt_build', api.logger, async (event: PluginHookBeforePromptBuildEvent, ctx: PluginHookAgentContext): Promise<PluginHookBeforePromptBuildResult | void> => {
        const wsResult = resolveHookWorkspaceDir(ctx, api, 'before_prompt_build');
        if (!wsResult.ok) {
          api.logger.error(
            `[PD:before_prompt_build] workspaceDir resolution failed. ` +
            `reason=${wsResult.reason} agentId=${ctx.agentId ?? '(missing)'} sessionId=${ctx.sessionId ?? '(missing)'}. ` +
            `Hook skipped — no mutation will occur. ` +
            `NextAction: ${wsResult.nextAction}`,
          );
          return;
        }
        const workspaceDir = wsResult.workspaceDir;
        if (wsResult.consistencyWarning) {
          api.logger.warn(`[PD:before_prompt_build] ${wsResult.consistencyWarning}`);
        }
        try {
          if (!startedWorkspaces.has(workspaceDir)) {
            startedWorkspaces.add(workspaceDir);
            migrateDirectoryStructure(api, workspaceDir);
            migrateStaleWorkspaceGuidance(api, workspaceDir);
            ensureWorkspaceTemplates(api, workspaceDir, language);
            SystemLogger.log(workspaceDir, 'SYSTEM_BOOT', `Principles Disciple online. Language: ${language}`);

            // ── Start EvolutionWorker for THIS workspace ──
            // Gated behind evolution_worker feature flag (MVP-Quiet, default OFF per ADR-0014).
            const gate = shouldStartEvolutionWorker(workspaceDir, api.logger);
            if (gate.shouldStart) {
              EvolutionWorkerService.api = api;
              EvolutionWorkerService.start({
                config: api.config,
                workspaceDir,
                stateDir: path.join(workspaceDir, '.state'),
                logger: api.logger,
              });
              api.logger.info(`[PD] EvolutionWorker started for workspace: ${workspaceDir} (flag source: ${gate.flagSource})`);
            } else {
              // Structured observability per ERR-002: no silent skip
              api.logger.info(`[PD] EvolutionWorker NOT started for workspace: ${workspaceDir}. ${gate.disabledInfo}`);
              SystemLogger.log(workspaceDir, 'EVOLUTION_WORKER_DISABLED', gate.disabledInfo ?? '');
            }

            // ── Start CorrectionObserver for THIS workspace ──
            // MVP-Core per ADR-0014 amendment, independently owned (PRI-293).
            const corrGate = shouldStartCorrectionObserver(workspaceDir, api.logger);
            if (corrGate.shouldStart) {
              CorrectionObserverService.start({
                config: api.config,
                workspaceDir,
                stateDir: path.join(workspaceDir, '.state'),
                logger: api.logger,
              });
              api.logger.info(`[PD] CorrectionObserver started for workspace: ${workspaceDir} (flag source: ${corrGate.flagSource})`);
            } else {
              api.logger.info(`[PD] CorrectionObserver NOT started for workspace: ${workspaceDir}. ${corrGate.disabledInfo}`);
              SystemLogger.log(workspaceDir, 'CORRECTION_OBSERVER_DISABLED', corrGate.disabledInfo ?? '');
            }

            // ── Start InternalizationAutoConsumer for THIS workspace ──
            // PRI-381: Bounded auto-consumer for dreamer ready tasks.
            // Default ON for dogfood; kill switch via features.internalization_auto_consumer.enabled=false.
            const autoConsGate = shouldStartInternalizationAutoConsumer(workspaceDir, api.logger);
            if (autoConsGate.shouldStart) {
              InternalizationAutoConsumerService.start({
                config: api.config,
                workspaceDir,
                stateDir: path.join(workspaceDir, '.state'),
                logger: api.logger,
              });
              api.logger.info(`[PD] InternalizationAutoConsumer started for workspace: ${workspaceDir} (flag source: ${autoConsGate.flagSource})`);
            } else {
              api.logger.info(`[PD] InternalizationAutoConsumer NOT started for workspace: ${workspaceDir}. ${autoConsGate.disabledInfo}`);
              SystemLogger.log(workspaceDir, 'INTERNALIZATION_CONSUMER_DISABLED', autoConsGate.disabledInfo ?? '');
            }

            // ── Schedule anonymous product telemetry export (fire-and-forget) ──
            // PRI-595~603: opt-in (default OFF), one bounded attempt per
            // normal-activity window, never blocks hooks (unref'd timer, all
            // failures contained inside the service). Gating (flag + consent +
            // environment eligibility) happens inside maybeExportDaily.
            scheduleTelemetryExportForWorkspace(workspaceDir, api.logger);
          }

          const hookContext = { ...ctx, workspaceDir };
          const runtimeGate = runtimeGateFor(workspaceDir);
          const result = runtimeGate.enabled
            ? await sharedHostRuntime.dispatchBeforePromptBuild(event, hookContext)
            : await handleBeforePromptBuild(event, { ...hookContext, api: api as Parameters<typeof handleBeforePromptBuild>[1]['api'] });
          
          // Record success
          WorkspaceContext.fromHookContext({ workspaceDir }).eventLog.recordHookExecution({
            hook: 'before_prompt_build',
            sessionId: ctx.sessionId
          });
          
          return result;
        } catch (err) {
          WorkspaceContext.fromHookContext({ workspaceDir }).eventLog.recordHookExecution({
            hook: 'before_prompt_build',
            sessionId: ctx.sessionId,
            error: String(err)
          });
          api.logger.error(`[PD] Error in before_prompt_build: ${String(err)}`);
        }
      })
    );

    // ── Hook: Security Gate ──
    api.on(
      'before_tool_call',
      guardHook('hook:before_tool_call', api.logger, (event: PluginHookBeforeToolCallEvent, ctx: PluginHookToolContext): PluginHookBeforeToolCallResult | void | Promise<PluginHookBeforeToolCallResult | void> => {
        const wsResult = resolveHookWorkspaceDir(ctx, api, 'before_tool_call');
        if (!wsResult.ok) {
          api.logger.error(
            `[PD:before_tool_call] workspaceDir resolution failed. ` +
            `reason=${wsResult.reason} agentId=${ctx.agentId ?? '(missing)'} sessionId=${ctx.sessionId ?? '(missing)'}. ` +
            `Hook skipped — security gate bypassed. ` +
            `NextAction: ${wsResult.nextAction}`,
          );
          return;
        }
        const workspaceDir = wsResult.workspaceDir;
        if (wsResult.consistencyWarning) {
          api.logger.warn(`[PD:before_tool_call] ${wsResult.consistencyWarning}`);
        }
        try {
          const pluginConfig = api.pluginConfig ?? {};
          const {logger} = api;
          const hookContext = { ...ctx, workspaceDir, pluginConfig, logger };
          const runtimeGate = runtimeGateFor(workspaceDir);
          if (!runtimeGate.enabled) {
            const result = handleBeforeToolCall(event, hookContext);
            WorkspaceContext.fromHookContext({ workspaceDir }).eventLog.recordHookExecution({
              hook: 'before_tool_call'
            }, { flushImmediately: true });
            return result;
          }
          return sharedHostRuntime.dispatchBeforeToolCall(event, hookContext).then((result) => {
            WorkspaceContext.fromHookContext({ workspaceDir }).eventLog.recordHookExecution({
              hook: 'before_tool_call'
            }, { flushImmediately: true });
            return result;
          }).catch((err: unknown) => {
            const errorPreview = err instanceof Error
              ? err.message.slice(0, 500)
              : safeStringifyPreview(err).slice(0, 500);
            WorkspaceContext.fromHookContext({ workspaceDir }).eventLog.recordHookExecution({
              hook: 'before_tool_call', error: errorPreview
            }, { flushImmediately: true });
            api.logger.error(`[PD] Error in before_tool_call: ${errorPreview}`);
            return undefined;
          });
        } catch (err) {
          WorkspaceContext.fromHookContext({ workspaceDir }).eventLog.recordHookExecution({
            hook: 'before_tool_call',
            error: String(err)
          }, { flushImmediately: true });
          api.logger.error(`[PD] Error in before_tool_call: ${String(err)}`);
        }
      })
    );

    // ── Hook: Pain & Trust ──
    // timeoutMs=10s: OpenClaw has no default timeout for after_tool_call; without
    // this a stuck SQLite write (busy_timeout=5000ms) leaks the handler promise.
    // 10s gives 2x headroom over busy_timeout. fail-open means agent is unaffected.
    api.on(
      'after_tool_call',
      guardHook('hook:after_tool_call', api.logger, (event: PluginHookAfterToolCallEvent, ctx: PluginHookToolContext): void | Promise<void> => {
        const wsResult = resolveHookWorkspaceDir(ctx, api, 'after_tool_call');
        if (!wsResult.ok) {
          api.logger.error(
            `[PD:after_tool_call] workspaceDir resolution failed. ` +
            `reason=${wsResult.reason} agentId=${ctx.agentId ?? '(missing)'} sessionId=${ctx.sessionId ?? '(missing)'}. ` +
            `Hook skipped — pain detection bypassed. ` +
            `NextAction: ${wsResult.nextAction}`,
          );
          return;
        }
        const workspaceDir = wsResult.workspaceDir;
        if (wsResult.consistencyWarning) {
          api.logger.warn(`[PD:after_tool_call] ${wsResult.consistencyWarning}`);
        }
        try {
          const pluginConfig = api.pluginConfig ?? {};
          // Pass api separately to handleAfterToolCall to maintain type safety
          const hookContext = { ...ctx, workspaceDir, pluginConfig };
          const runtimeGate = runtimeGateFor(workspaceDir);
          if (!runtimeGate.enabled) {
            handleAfterToolCall(event, hookContext, api);
            WorkspaceContext.fromHookContext({ workspaceDir }).eventLog.recordHookExecution({
              hook: 'after_tool_call'
            }, { flushImmediately: true });
            return;
          }
          // Manual Owner pain remains an OpenClaw-owned path; PRI-523 shares
          // only ordinary after-tool classification/admission/evidence.
          if (event.toolName === 'pain' || event.toolName === 'skill:pain') {
            handleAfterToolCall(event, hookContext, api);
            WorkspaceContext.fromHookContext({ workspaceDir }).eventLog.recordHookExecution({ hook: 'after_tool_call' }, { flushImmediately: true });
            return;
          }
          return sharedHostRuntime.dispatchAfterToolCall(event, hookContext).then(() => {
            WorkspaceContext.fromHookContext({ workspaceDir }).eventLog.recordHookExecution({
              hook: 'after_tool_call'
            }, { flushImmediately: true });
          }).catch((err: unknown) => {
            const errorPreview = err instanceof Error
              ? err.message.slice(0, 500)
              : safeStringifyPreview(err).slice(0, 500);
            WorkspaceContext.fromHookContext({ workspaceDir }).eventLog.recordHookExecution({
              hook: 'after_tool_call', error: errorPreview
            }, { flushImmediately: true });
            api.logger.error(`[PD:EmpathyObserver] Error in after_tool_call: ${errorPreview}`);
          });
        } catch (err) {
          WorkspaceContext.fromHookContext({ workspaceDir }).eventLog.recordHookExecution({
            hook: 'after_tool_call',
            error: String(err)
          }, { flushImmediately: true });
          api.logger.error(`[PD:EmpathyObserver] Error in after_tool_call: ${String(err)}`);
        }
      }),
      { timeoutMs: 10_000 },
    );

    // ── Hook: LLM Analysis ──
    // timeoutMs=10s: OpenClaw has no default timeout for llm_output; without
    // this a stuck SQLite write leaks the handler promise. See after_tool_call.
    api.on(
      'llm_output',
      guardHook('hook:llm_output', api.logger, (event: PluginHookLlmOutputEvent, ctx: PluginHookAgentContext): void => {
        const wsResult = resolveHookWorkspaceDir(ctx, api, 'llm_output');
        if (!wsResult.ok) {
          api.logger.error(
            `[PD:llm_output] workspaceDir resolution failed. ` +
            `reason=${wsResult.reason} agentId=${ctx.agentId ?? '(missing)'} ` +
            `sessionId=${ctx.sessionId ?? '(missing)'}. ` +
            `Hook skipped — LLM analysis bypassed. ` +
            `NextAction: ${wsResult.nextAction}`,
          );
          return;
        }
        const workspaceDir = wsResult.workspaceDir;
        if (wsResult.consistencyWarning) {
          api.logger.warn(`[PD:llm_output] ${wsResult.consistencyWarning}`);
        }
        try {
          handleLlmOutput(event, { ...ctx, workspaceDir });

          WorkspaceContext.fromHookContext({ workspaceDir }).eventLog.recordHookExecution({
            hook: 'llm_output',
            sessionId: ctx.sessionId
          });
        } catch (err) {
          WorkspaceContext.fromHookContext({ workspaceDir }).eventLog.recordHookExecution({
            hook: 'llm_output',
            sessionId: ctx.sessionId,
            error: String(err)
          });
          api.logger.error(`[PD] Error in llm_output: ${String(err)}`);
        }
      }),
      { timeoutMs: 10_000 },
    );

    // ── Hook: Lifecycle ──
    api.on('before_reset', guardHook('hook:before_reset', api.logger, (event: PluginHookBeforeResetEvent, ctx: PluginHookAgentContext) => {
      const wsResult = resolveHookWorkspaceDir(ctx, api, 'before_reset');
      if (!wsResult.ok) {
        api.logger.error(
          `[PD:before_reset] workspaceDir resolution failed. ` +
          `reason=${wsResult.reason} agentId=${ctx.agentId ?? '(missing)'} sessionId=${ctx.sessionId ?? '(missing)'}. ` +
          `Hook skipped. NextAction: ${wsResult.nextAction}`,
        );
        return;
      }
      if (wsResult.consistencyWarning) {
        api.logger.warn(`[PD:before_reset] ${wsResult.consistencyWarning}`);
      }
      return handleBeforeReset(event, { ...ctx, workspaceDir: wsResult.workspaceDir });
    }));
    
    api.on('before_compaction', guardHook('hook:before_compaction', api.logger, (event: PluginHookBeforeCompactionEvent, ctx: PluginHookAgentContext) => {
      const wsResult = resolveHookWorkspaceDir(ctx, api, 'before_compaction');
      if (!wsResult.ok) {
        api.logger.error(
          `[PD:before_compaction] workspaceDir resolution failed. ` +
          `reason=${wsResult.reason} agentId=${ctx.agentId ?? '(missing)'} sessionId=${ctx.sessionId ?? '(missing)'}. ` +
          `Hook skipped. NextAction: ${wsResult.nextAction}`,
        );
        return;
      }
      if (wsResult.consistencyWarning) {
        api.logger.warn(`[PD:before_compaction] ${wsResult.consistencyWarning}`);
      }
      return handleBeforeCompaction(event, { ...ctx, workspaceDir: wsResult.workspaceDir });
    }));
    
    api.on('after_compaction', guardHook('hook:after_compaction', api.logger, (event: PluginHookAfterCompactionEvent, ctx: PluginHookAgentContext) => {
      const wsResult = resolveHookWorkspaceDir(ctx, api, 'after_compaction');
      if (!wsResult.ok) {
        api.logger.error(
          `[PD:after_compaction] workspaceDir resolution failed. ` +
          `reason=${wsResult.reason} agentId=${ctx.agentId ?? '(missing)'} sessionId=${ctx.sessionId ?? '(missing)'}. ` +
          `Hook skipped. NextAction: ${wsResult.nextAction}`,
        );
        return;
      }
      if (wsResult.consistencyWarning) {
        api.logger.warn(`[PD:after_compaction] ${wsResult.consistencyWarning}`);
      }
      return handleAfterCompaction(event, { ...ctx, workspaceDir: wsResult.workspaceDir });
    }));

    // ── Hook: Before Message Write (PRI-346) ──
    // Fallback trajectory collection when llm_output is blocked by
    // missing allowConversationAccess. Not in CONVERSATION_HOOK_NAMES
    // so OpenClaw always delivers it.
    api.on(
      'before_message_write',
      guardHook('hook:before_message_write', api.logger, (event: PluginHookBeforeMessageWriteEvent, ctx: PluginHookAgentContext): void => {
        const wsResult = resolveHookWorkspaceDir(ctx, api, 'before_message_write');
        if (!wsResult.ok) {
          api.logger.warn(`[PD:before_message_write] workspaceDir resolution failed: ${wsResult.reason}`);
          return;
        }
        try {
          TrajectoryCollector.handleBeforeMessageWrite(event, {
            ...ctx,
            workspaceDir: wsResult.workspaceDir,
            pluginConfig: getPluginEntry(api.config, api.id),
          });
        } catch (err) {
          // Non-critical: don't surface to user
          api.logger.warn(`[PD:before_message_write] error: ${String(err)}`);
        }
      })
    );

    // ── Service Registration (surface-guarded) ──
    // PRI-294: EvolutionWorker service registration removed — it starts via
    // before_prompt_build hook gate, not via api.registerService. The surface
    // guard already prevents registration when disabled (enabledByDefault=false).
    // Dead pre-assignment of EvolutionWorkerService.api removed.
    try {
      const guardedCorrectionObserver = guardService('service:correction-observer', CorrectionObserverService, api.logger);
      if (guardedCorrectionObserver) api.registerService(guardedCorrectionObserver);
      const guardedTrajectory = guardService('service:trajectory', TrajectoryService, api.logger);
      if (guardedTrajectory) api.registerService(guardedTrajectory);
      const guardedPdTask = guardService('service:pd-task', PDTaskService, api.logger);
      if (guardedPdTask) api.registerService(guardedPdTask);
      const guardedAutoConsumer = guardService('service:internalization-auto-consumer', InternalizationAutoConsumerService, api.logger);
      if (guardedAutoConsumer) api.registerService(guardedAutoConsumer);
    } catch (err) {
      api.logger.error(`[PD] Failed to register services: ${String(err)}`);
    }

    // ── Slash Commands ──
    // Register command with optional short alias
     
    const registerCommandWithAlias = (name: string, alias: string | null, desc: string, handler: any, opts?: { acceptsArgs?: boolean }) => {
      const base = {
        name,
        description: desc,
        handler,
        ...(opts?.acceptsArgs ? { acceptsArgs: true } : {}),
      };
      api.registerCommand(base);
      if (alias) {
        api.registerCommand({
          ...base,
          name: alias,
          description: `${desc} (alias of /${name})`,
        });
      }
    };

     
    registerCommandWithAlias('pd-init', 'pdi', getCommandDescription('pd-init', language), (ctx: any) => handleInitStrategy(ctx));
     
    registerCommandWithAlias('pd-bootstrap', 'pdb', getCommandDescription('pd-bootstrap', language), (ctx: any) => handleBootstrapTools(ctx));

    registerCommandWithAlias('pd-research', 'pdr', getCommandDescription('pd-research', language), (ctx: any) => handleResearchTools(ctx));

    registerCommandWithAlias('pd-help', 'pdh', getCommandDescription('pd-help', language), () => {
        if (language === 'zh') {
          return { text: `
📖 **Principles Disciple 命令大全**

## 🚀 快速开始
| 短命令 | 长命令 | 用途 |
|--------|--------|------|
| \`/pdi\` | \`/pd-init\` | 初始化工作区（生成 PRINCIPLES.md、THINKING_OS.md 等） |
| \`/pdb\` | \`/pd-bootstrap\` | 扫描环境工具并建议升级 |
| \`/pdr\` | \`/pd-research\` | 研究工具升级方案 |

## 📊 状态与监控
| 短命令 | 长命令 | 用途 |
|--------|--------|------|
|  | \`/pd-status\` | 查看系统状态（GFI、Pain 词典） |
|  | \`/pd-pain\` | 从 OpenClaw 会话报告 pain |
|  | \`/pd-evolution-status\` | 查看 evolution 闭环状态（candidate/probation/active） |
|  | \`/pd-workflow-debug\` | 调试 workflow 状态与事件 [workflowId] |

## ⚙️ 配置与上下文
| 命令 | 用途 |
|------|------|
| \`/pd-context\` | 控制上下文注入 [status\\|thinking\\|reflection\\|focus\\|preset] |
| \`/pd-focus\` | 管理 CURRENT_FOCUS.md [status\\|history\\|compress\\|rollback] |

## ↩️ 回滚操作
| 命令 | 用途 |
|------|------|
| \`/pd-rollback\` | 回滚情绪事件惩罚 <event-id>\\|last |
| \`/pd-principle-rollback\` | 回滚原则并加入黑名单 <principle-id> [reason] |

## 📦 数据与导出
| 命令 | 用途 |
|------|------|
| \`/pd-export\` | 导出数据 [analytics\\|corrections --redacted] |
| \`/pd-samples\` | 查看或审核纠错样本 [review approve\\|reject <sample-id> [note]] |

## 🔧 实现生命周期（半废弃）
> ⚠️ 以下命令的 replay 生成路径已在 PRI-230 退役，仅查询/状态相关子命令可用。

| 命令 | 用途 |
|------|------|
| \`/pd-promote-impl\` | 提升候选实现到 active [list\\|show <id>\\|<id>] |
| \`/pd-disable-impl\` | 禁用 active 实现 [list\\|<id> --reason "..."] |
| \`/pd-archive-impl\` | 永久归档实现 [list\\|<id>] |
| \`/pd-rollback-impl\` | 回滚到上一个 active 实现 [list\\|<id> --reason "..."] |

## ❓ 帮助
| 命令 | 用途 |
|------|------|
| \`/pd-help\` | 显示本帮助 |

💡 完整文档请访问：https://principles-disciple.dev/docs/slash-commands
`.trim() };
        } else {
          return { text: `
📖 **Principles Disciple Command Reference**

## 🚀 Quick Start
| Short | Full | Purpose |
|-------|------|---------|
| \`/pdi\` | \`/pd-init\` | Initialize workspace (PRINCIPLES.md, THINKING_OS.md, etc.) |
| \`/pdb\` | \`/pd-bootstrap\` | Scan environment tools and suggest upgrades |
| \`/pdr\` | \`/pd-research\` | Research tool upgrade solutions |

## 📊 Status & Monitoring
| Short | Full | Purpose |
|-------|------|---------|
|  | \`/pd-status\` | View system status (GFI, Pain dictionary) |
|  | \`/pd-pain\` | Report pain from OpenClaw session |
|  | \`/pd-evolution-status\` | Show evolution loop status (candidate/probation/active) |
|  | \`/pd-workflow-debug\` | Debug workflow state and events [workflowId] |

## ⚙️ Configuration & Context
| Command | Purpose |
|---------|---------|
| \`/pd-context\` | Control context injection [status\\|thinking\\|reflection\\|focus\\|preset] |
| \`/pd-focus\` | Manage CURRENT_FOCUS.md [status\\|history\\|compress\\|rollback] |

## ↩️ Rollback
| Command | Purpose |
|---------|---------|
| \`/pd-rollback\` | Rollback empathy event penalty <event-id>\\|last |
| \`/pd-principle-rollback\` | Rollback principle and blacklist pattern <principle-id> [reason] |

## 📦 Data & Export
| Command | Purpose |
|---------|---------|
| \`/pd-export\` | Export data [analytics\\|corrections --redacted] |
| \`/pd-samples\` | List or review correction samples [review approve\\|reject <sample-id> [note]] |

## 🔧 Implementation Lifecycle (Semi-deprecated)
> ⚠️ Replay generation path for these commands was retired in PRI-230. Only list/show/status subcommands remain useful.

| Command | Purpose |
|---------|---------|
| \`/pd-promote-impl\` | Promote candidate implementation to active [list\\|show <id>\\|<id>] |
| \`/pd-disable-impl\` | Disable active implementation [list\\|<id> --reason "..."] |
| \`/pd-archive-impl\` | Archive implementation permanently [list\\|<id>] |
| \`/pd-rollback-impl\` | Rollback to previous active implementation [list\\|<id> --reason "..."] |

## ❓ Help
| Command | Purpose |
|---------|---------|
| \`/pd-help\` | Show this help |

💡 Full documentation: https://principles-disciple.dev/docs/slash-commands
`.trim() };
        }
    });

    api.registerCommand({
      name: "pd-status",
      description: getCommandDescription('pd-status', language),
      acceptsArgs: true,
      handler: (ctx) => {
        try {
          const workspaceDir = resolveCommandWorkspaceDir(api, ctx);
          // Ensure workspaceDir is in config for handlePainCommand
          if (ctx.config) ctx.config.workspaceDir = workspaceDir;
          return handlePainCommand(ctx);
        } catch (err) {
          api.logger.error(`[PD] Command /pd-status failed: ${String(err)}`);
          return { text: language === 'zh' ? "命令执行失败，请检查日志。" : "Command failed. Check logs." };
        }
      }
    });

    api.registerCommand({
      name: "pd-pain",
      description: getCommandDescription('pd-pain', language),
      acceptsArgs: true,
      handler: async (ctx) => {
        try {
          const workspaceDir = resolveCommandWorkspaceDir(api, ctx);
          ctx.workspaceDir = workspaceDir;
          if (ctx.config) ctx.config.workspaceDir = workspaceDir;
          return await handlePainReportCommand(ctx);
        } catch (err) {
          api.logger.error(`[PD] Command /pd-pain failed: ${String(err)}`);
          return { text: language === 'zh' ? "命令执行失败，请检查日志。" : "Command failed. Check logs." };
        }
      }
    });

    api.registerCommand({
      name: "pd-context",
      description: getCommandDescription('pd-context', language),
      acceptsArgs: true,
      handler: (ctx) => {
        try {
          const workspaceDir = resolveCommandWorkspaceDir(api, ctx);
          if (ctx.config) ctx.config.workspaceDir = workspaceDir;
          return handleContextCommand(ctx);
        } catch (err) {
          api.logger.error(`[PD] Command /pd-context failed: ${String(err)}`);
          return { text: language === 'zh' ? "命令执行失败，请检查日志。" : "Command failed. Check logs." };
        }
      }
    });

    api.registerCommand({
      name: "pd-focus",
      description: getCommandDescription('pd-focus', language),
      acceptsArgs: true,
      handler: (ctx) => {
        try {
          const workspaceDir = resolveCommandWorkspaceDir(api, ctx);
          if (ctx.config) ctx.config.workspaceDir = workspaceDir;
          return handleFocusCommand(ctx, api);
        } catch (err) {
          api.logger.error(`[PD] Command /pd-focus failed: ${String(err)}`);
          return { text: language === 'zh' ? "命令执行失败，请检查日志。" : "Command failed. Check logs." };
        }
      }
    });


    api.registerCommand({
      name: "pd-evolution-status",
      description: getCommandDescription('pd-evolution-status', language),
      handler: (ctx) => {
        try {
          const workspaceDir = resolveCommandWorkspaceDir(api, ctx);
          if (ctx.config) ctx.config.workspaceDir = workspaceDir;
          return handleEvolutionStatusCommand(ctx);
        } catch (err) {
          api.logger.error(`[PD] Command /pd-evolution-status failed: ${String(err)}`);
          return { text: language === 'zh' ? "命令执行失败，请检查日志。" : "Command failed. Check logs." };
        }
      }
    });

    api.registerCommand({
      name: "pd-principle-rollback",
      description: getCommandDescription('pd-principle-rollback', language),
      acceptsArgs: true,
      handler: (ctx) => {
        try {
          const workspaceDir = resolveCommandWorkspaceDir(api, ctx);
          if (ctx.config) ctx.config.workspaceDir = workspaceDir;
          return handlePrincipleRollbackCommand(ctx);
        } catch (err) {
          api.logger.error(`[PD] Command /pd-principle-rollback failed: ${String(err)}`);
          return { text: language === 'zh' ? "命令执行失败，请检查日志。" : "Command failed. Check logs." };
        }
      }
    });

    api.registerCommand({
      name: "pd-rollback",
      description: getCommandDescription('pd-rollback', language),
      acceptsArgs: true,
      handler: (ctx) => {
        try {
          const workspaceDir = resolveCommandWorkspaceDir(api, ctx);
          if (ctx.config) ctx.config.workspaceDir = workspaceDir;
          return handleRollbackCommand(ctx);
        } catch (err) {
          api.logger.error(`[PD] Command /pd-rollback failed: ${String(err)}`);
          return { text: language === 'zh' ? "命令执行失败，请检查日志。" : "Command failed. Check logs." };
        }
      }
    });

    // ── Tools ──
    api.registerCommand({
      name: "pd-export",
      description: getCommandDescription('pd-export', language),
      acceptsArgs: true,
      handler: (ctx) => {
        try {
          const workspaceDir = resolveCommandWorkspaceDir(api, ctx);
          if (ctx.config) ctx.config.workspaceDir = workspaceDir;
          return handleExportCommand(ctx);
        } catch (err) {
          api.logger.error(`[PD] Command /pd-export failed: ${String(err)}`);
          return { text: language === 'zh' ? "导出失败，请检查日志。" : "Export failed. Check logs." };
        }
      }
    });

    api.registerCommand({
      name: "pd-samples",
      description: getCommandDescription('pd-samples', language),
      acceptsArgs: true,
      handler: (ctx) => {
        try {
          const workspaceDir = resolveCommandWorkspaceDir(api, ctx);
          if (ctx.config) ctx.config.workspaceDir = workspaceDir;
          return handleSamplesCommand(ctx);
        } catch (err) {
          api.logger.error(`[PD] Command /pd-samples failed: ${String(err)}`);
          return { text: language === 'zh' ? "样本命令执行失败，请检查日志。" : "Samples command failed. Check logs." };
        }
      }
    });

    api.registerCommand({
      name: "pd-workflow-debug",
      description: getCommandDescription('pd-workflow-debug', language),
      acceptsArgs: true,
      handler: (ctx) => {
        try {
          const workspaceDir = resolveCommandWorkspaceDir(api, ctx);
          if (ctx.config) ctx.config.workspaceDir = workspaceDir;
          return handleWorkflowDebugCommand(ctx);
        } catch (err) {
          api.logger.error(`[PD] Command /pd-workflow-debug failed: ${String(err)}`);
          return { text: `Workflow debug command failed: ${String(err)}` };
        }
      }
    });

    // ── Implementation Lifecycle Commands (Phase 13) ──
    api.registerCommand({
      name: "pd-promote-impl",
      description: getCommandDescription('pd-promote-impl', language),
      acceptsArgs: true,
      handler: (ctx) => {
        try {
          const workspaceDir = resolveCommandWorkspaceDir(api, ctx);
          if (ctx.config) ctx.config.workspaceDir = workspaceDir;
          return handlePromoteImplCommand(ctx);
        } catch (err) {
          api.logger.error(`[PD] Command /pd-promote-impl failed: ${String(err)}`);
          return { text: language === 'zh' ? '\u547d\u4ee4\u6267\u884c\u5931\u8d25\uff0c\u8bf7\u68c0\u67e5\u65e5\u5fd7\u3002' : 'Command failed. Check logs.' };
        }
      }
    });

    api.registerCommand({
      name: "pd-disable-impl",
      description: getCommandDescription('pd-disable-impl', language),
      acceptsArgs: true,
      handler: (ctx) => {
        try {
          const workspaceDir = resolveCommandWorkspaceDir(api, ctx);
          if (ctx.config) ctx.config.workspaceDir = workspaceDir;
          return handleDisableImplCommand(ctx);
        } catch (err) {
          api.logger.error(`[PD] Command /pd-disable-impl failed: ${String(err)}`);
          return { text: language === 'zh' ? '\u547d\u4ee4\u6267\u884c\u5931\u8d25\uff0c\u8bf7\u68c0\u67e5\u65e5\u5fd7\u3002' : 'Command failed. Check logs.' };
        }
      }
    });

    api.registerCommand({
      name: "pd-archive-impl",
      description: getCommandDescription('pd-archive-impl', language),
      acceptsArgs: true,
      handler: (ctx) => {
        try {
          const workspaceDir = resolveCommandWorkspaceDir(api, ctx);
          if (ctx.config) ctx.config.workspaceDir = workspaceDir;
          return handleArchiveImplCommand(ctx);
        } catch (err) {
          api.logger.error(`[PD] Command /pd-archive-impl failed: ${String(err)}`);
          return { text: language === 'zh' ? '\u547d\u4ee4\u6267\u884c\u5931\u8d25\uff0c\u8bf7\u68c0\u67e5\u65e5\u5fd7\u3002' : 'Command failed. Check logs.' };
        }
      }
    });

    api.registerCommand({
      name: "pd-rollback-impl",
      description: getCommandDescription('pd-rollback-impl', language),
      acceptsArgs: true,
      handler: (ctx) => {
        try {
          const workspaceDir = resolveCommandWorkspaceDir(api, ctx);
          if (ctx.config) ctx.config.workspaceDir = workspaceDir;
          return handleRollbackImplCommand(ctx);
        } catch (err) {
          api.logger.error(`[PD] Command /pd-rollback-impl failed: ${String(err)}`);
          return { text: language === 'zh' ? '\u547d\u4ee4\u6267\u884c\u5931\u8d25\uff0c\u8bf7\u68c0\u67e5\u65e5\u5fd7\u3002' : 'Command failed. Check logs.' };
        }
      }
    });

  }
};

// PrincipleTreeLedgerAdapter is exported from @principles/core/runtime-v2 (canonical,
// consolidated in PRI-459). The plugin-local duplicate was removed; re-export the core
// symbol so any external consumer importing from the plugin still resolves it.
export { PrincipleTreeLedgerAdapter } from '@principles/core/runtime-v2';
/* istanbul ignore next — test exports for evolution worker gate */
export { loadFeatureFlagFromWorkspace, isRecord };

// Schema initialization exports for `pd runtime init` (unified DB init).
// These functions open the DB in write mode, apply the full schema, and close the DB.
// They do NOT run runtime side-effects (importLegacyArtifacts, pruneUnreferencedBlobs).
export { initTrajectorySchema } from './core/trajectory.js';
export { initWorkflowSchema } from './service/subagent-workflow/workflow-store.js';

export default plugin;
