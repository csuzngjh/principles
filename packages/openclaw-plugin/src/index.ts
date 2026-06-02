import type {
  OpenClawPluginApi,
  PluginCommandContext,
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
  PluginHookSubagentEndedEvent,
  PluginHookLlmOutputEvent,
  PluginHookSubagentSpawningEvent,
  PluginHookSubagentSpawningResult,
  PluginHookSubagentContext,
} from './openclaw-sdk.js';
import * as path from 'path';
import * as fs from 'fs';
import * as yaml from 'js-yaml';
import { computeEffectiveFlags, DEFAULT_FEATURE_FLAGS } from '@principles/core/runtime-v2';
import { classifyTask } from './core/local-worker-routing.js';
import { completeShadowObservation, recordShadowRouting } from './core/shadow-observation-registry.js';
import { getCommandDescription } from './i18n/commands.js';
import { WorkspaceContext } from './core/workspace-context.js';
import { handleBeforePromptBuild } from './hooks/prompt.js';
import { handleBeforeToolCall } from './hooks/gate.js';
import { handleAfterToolCall } from './hooks/pain.js';
import { handleBeforeReset, handleBeforeCompaction, handleAfterCompaction } from './hooks/lifecycle.js';
import { handleLlmOutput } from './hooks/llm.js';
import { handleSubagentEnded } from './hooks/subagent.js';
import * as TrajectoryCollector from './hooks/trajectory-collector.js';
import { handleInitStrategy } from './commands/strategy.js';
import { handleBootstrapTools, handleResearchTools } from './commands/capabilities.js';
import { handleThinkingOs } from './commands/thinking-os.js';
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
import { TrajectoryService } from './service/trajectory-service.js';
import { PDTaskService } from './core/pd-task-service.js';
import { CentralSyncService } from './service/central-sync-service.js';
import { ensureWorkspaceTemplates } from './core/init.js';
import { migrateDirectoryStructure } from './core/migration.js';
import { migrateStaleWorkspaceGuidance } from './core/workspace-guidance-migrator.js';
import { SystemLogger } from './core/system-logger.js';
import { PathResolver } from './core/path-resolver.js';
import { resolveCommandWorkspaceDir, resolveToolHookWorkspaceDirSafe, resolveHookWorkspaceDir } from './utils/workspace-resolver.js';
import { computeRuntimeShadowTaskFingerprint, PD_LOCAL_PROFILES } from './utils/shadow-fingerprint.js';
import type { WorkerProfile } from './core/model-deployment-registry.js';
import { validateWorkspaceDir } from './core/workspace-dir-validation.js';
import { resolveWorkspaceDirFromApi } from './core/path-resolver.js';
import { checkSurfaceGuard, guardHook, guardService } from './core/surface-guard.js';

// Track started workspaces — one-time init + evolution worker per workspace
const startedWorkspaces = new Set<string>();

const HOOK_WORKSPACE_RESOLUTION_NEXT_ACTION =
  'set PD_WORKSPACE_DIR environment variable or create ~/.openclaw/principles-disciple.json ' +
  'with a "workspace" field; PD canonical config is now the primary resolution source (PRI-259)';

// Map from childSessionKey → shadowObservationId
// Used to complete shadow observations when subagent ends
const pendingShadowObservations = new Map<string, string>();

// ── Feature Flag Loader (plugin I/O boundary) ─────────────────────────────
// Reads workspace feature-flags.yaml and checks a specific flag.
// Returns the flag definition with effective enabled state.
const DANGEROUS_KEYS = new Set(['__proto__', 'constructor', 'prototype']);

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function loadFeatureFlagFromWorkspace(
  workspaceDir: string,
  flagId: string,
  logger?: { warn?: (msg: string) => void; info?: (msg: string) => void },
): { enabled: boolean; source: string } {
  const configPath = path.join(workspaceDir, '.pd', 'feature-flags.yaml');

  if (!fs.existsSync(configPath)) {
    const flags = computeEffectiveFlags({}, DEFAULT_FEATURE_FLAGS, configPath);
    const flag = flags.flags[flagId];
    return { enabled: flag?.enabled ?? false, source: 'defaults' };
  }

  let raw: string;
  try {
    raw = fs.readFileSync(configPath, 'utf8');
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    logger?.warn?.(`[PD:FeatureFlags] Feature flags unreadable: ${msg} — using defaults`);
    const flags = computeEffectiveFlags({}, DEFAULT_FEATURE_FLAGS, configPath);
    const flag = flags.flags[flagId];
    return { enabled: flag?.enabled ?? false, source: 'defaults' };
  }

  let parsed: unknown;
  try {
    parsed = yaml.load(raw, { schema: yaml.JSON_SCHEMA });
  } catch (e) {
    const parseMsg = e instanceof Error ? e.message : String(e);
    logger?.warn?.(`[PD:FeatureFlags] Feature flags YAML parse error: ${parseMsg} — using defaults`);
    const flags = computeEffectiveFlags({}, DEFAULT_FEATURE_FLAGS, configPath);
    const flag = flags.flags[flagId];
    return { enabled: flag?.enabled ?? false, source: 'defaults' };
  }

  if (!isRecord(parsed)) {
    logger?.warn?.(`[PD:FeatureFlags] Feature flags not a mapping — using defaults`);
    const flags = computeEffectiveFlags({}, DEFAULT_FEATURE_FLAGS, configPath);
    const flag = flags.flags[flagId];
    return { enabled: flag?.enabled ?? false, source: 'defaults' };
  }

  // parsed is now narrowed to Record<string, unknown> by isRecord guard
  const parsedRecord: Record<string, unknown> = Object.create(null);
  for (const key of Object.keys(parsed)) {
    if (DANGEROUS_KEYS.has(key)) continue;
    if (Object.hasOwn(parsed, key)) {
      parsedRecord[key] = parsed[key];
    }
  }

  const flags = computeEffectiveFlags(parsedRecord, DEFAULT_FEATURE_FLAGS, configPath);
  const flag = flags.flags[flagId];
  return { enabled: flag?.enabled ?? false, source: flags.source };
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
    nextAction: 'set evolution_worker.enabled=true in .pd/feature-flags.yaml to enable',
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
    nextAction: 'set correction_observer.enabled=true in .pd/feature-flags.yaml to enable',
    featureFlag: 'correction_observer',
    boundedContext: 'correction_observer_service',
    flagSource: flag.source,
  });
  return { shouldStart: false, flagSource: flag.source, disabledInfo };
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
    }, 1000);
    healthCheckTimer.unref(); // Don't keep process alive for health check

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

    const language = (api.pluginConfig?.language as string) || 'en';

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
          }

          const result = await handleBeforePromptBuild(event, { ...ctx, api: api as Parameters<typeof handleBeforePromptBuild>[1]['api'], workspaceDir });
          
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
      guardHook('hook:before_tool_call', api.logger, (event: PluginHookBeforeToolCallEvent, ctx: PluginHookToolContext): PluginHookBeforeToolCallResult | void => {
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
          const result = handleBeforeToolCall(event, { ...ctx, workspaceDir, pluginConfig, logger });

          WorkspaceContext.fromHookContext({ workspaceDir }).eventLog.recordHookExecution({
            hook: 'before_tool_call'
          }, { flushImmediately: true });

          return result;
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
    api.on(
      'after_tool_call',
      guardHook('hook:after_tool_call', api.logger, (event: PluginHookAfterToolCallEvent, ctx: PluginHookToolContext): void => {
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
          handleAfterToolCall(event, { ...ctx, workspaceDir, pluginConfig }, api);

          WorkspaceContext.fromHookContext({ workspaceDir }).eventLog.recordHookExecution({
            hook: 'after_tool_call'
          }, { flushImmediately: true });
        } catch (err) {
          WorkspaceContext.fromHookContext({ workspaceDir }).eventLog.recordHookExecution({
            hook: 'after_tool_call',
            error: String(err)
          }, { flushImmediately: true });
          api.logger.error(`[PD:EmpathyObserver] Error in after_tool_call: ${String(err)}`);
        }
      })
    );

    // ── Hook: LLM Analysis ──
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
      })
    );

    // ── Hook: Trajectory Collection (Behavior Evolution Phase 0) ──
    // Note: after_tool_call and llm_output are safe to collect
    api.on(
      'after_tool_call',
      guardHook('hook:after_tool_call.trajectory', api.logger, (event: PluginHookAfterToolCallEvent, ctx: PluginHookToolContext): void => {
        try {
          const workspaceDir = resolveToolHookWorkspaceDirSafe(ctx, api, 'trajectory.after_tool_call');
          if (!workspaceDir) return;
          TrajectoryCollector.handleAfterToolCall(event, { ...ctx, workspaceDir });
          // eslint-disable-next-line @typescript-eslint/no-unused-vars -- Reason: catch binding intentionally unused
        } catch (_err) {
          // Non-critical: don't log, just skip
        }
      })
    );

    api.on(
      'llm_output',
      guardHook('hook:llm_output.trajectory', api.logger, (event: PluginHookLlmOutputEvent, ctx: PluginHookAgentContext): void => {
        try {
          const workspaceDir = resolveToolHookWorkspaceDirSafe(ctx, api, 'trajectory.llm_output');
          if (!workspaceDir) return;
          TrajectoryCollector.handleLlmOutput(event, { ...ctx, workspaceDir });
          // eslint-disable-next-line @typescript-eslint/no-unused-vars -- Reason: catch binding intentionally unused
        } catch (_err) {
          // Non-critical: don't log, just skip
        }
      })
    );

    // ── Hook: Subagent Loop Closure ──
    api.on(
      'subagent_spawning',
       
      guardHook('hook:subagent_spawning', api.logger, (event: PluginHookSubagentSpawningEvent, _ctx: PluginHookSubagentContext): void | PluginHookSubagentSpawningResult => {
        try {
          // FIX (B): Never fall back to '.' — fail-fast with ERROR log if workspaceDir cannot be resolved.
          // For subagent hooks, we use event.agentId as the target agent for workspace resolution.
          const workspaceDir = resolveWorkspaceDirFromApi(api, event.agentId);
          if (!workspaceDir) {
            api.logger.error(`[PD] subagent_spawning: cannot resolve workspaceDir for agent "${event.agentId}" — skipping shadow routing`);
            return { status: 'ok' };
          }
          api.logger?.debug?.(`[PD] workspaceDir resolved for subagent_spawning: ${workspaceDir}`);
          const { agentId, childSessionKey } = event;
          // Only handle PD local worker profiles
          if (!PD_LOCAL_PROFILES.has(agentId as WorkerProfile)) {
            return { status: 'ok' };
          }
          // Use the real runtime hook to record shadow evidence. We still consult the
          // routing/deployment state here, but the observation itself must originate
          // from actual subagent execution rather than an operator command path.
          const routingInput = { targetProfile: agentId as WorkerProfile };
          const decision = classifyTask(routingInput, workspaceDir);
          const shouldRecordShadow =
            decision.activeCheckpointState === 'shadow_ready' &&
            !!decision.activeCheckpointId &&
            decision.deploymentCheck.routingEnabled &&
            decision.deploymentCheck.checkpointDeployable;

          if (shouldRecordShadow) {
            const observation = recordShadowRouting(workspaceDir, {
              checkpointId: decision.activeCheckpointId!,  
              workerProfile: agentId as WorkerProfile,
              taskFingerprint: computeRuntimeShadowTaskFingerprint(event),
            });
            pendingShadowObservations.set(childSessionKey, observation.observationId);
          }
          return { status: 'ok' };
        } catch (err) {
          api.logger.error(`[PD] Error in subagent_spawning shadow routing: ${String(err)}`);
          return { status: 'ok' }; // Don't block spawn on shadow observation errors
        }
      })
    );

    api.on(
      'subagent_ended',
      guardHook('hook:subagent_ended', api.logger, (event: PluginHookSubagentEndedEvent, ctx: PluginHookSubagentContext): void => {
        try {
          // FIX (B): Never fall back to '.' — fail-fast with ERROR log if workspaceDir cannot be resolved.
          const workspaceDir = resolveWorkspaceDirFromApi(api, undefined);
          if (!workspaceDir) {
            api.logger.error(`[PD] subagent_ended: cannot resolve workspaceDir — skipping shadow observation completion`);
            return;
          }
          api.logger?.debug?.(`[PD] workspaceDir resolved for subagent_ended: ${workspaceDir}`);
          // Complete any pending shadow observation for this subagent session
          const shadowObsId = pendingShadowObservations.get(event.targetSessionKey);
          if (shadowObsId && workspaceDir) {
            try {
              const outcome = event.outcome === 'ok'
                ? 'accepted'
                : event.outcome === 'error'
                  ? 'rejected'
                  : 'escalated';
              completeShadowObservation(workspaceDir, {
                observationId: shadowObsId,
                outcome,
                failureSignals: event.outcome === 'error' ? { threwException: true, timedOut: false, invalidOutput: false, profileRejected: false, extra: {} } : undefined,
              });
              pendingShadowObservations.delete(event.targetSessionKey);
            } catch (err) {
              api.logger.error(`[PD] Failed to complete shadow observation: ${String(err)}`);
            }
          }
          handleSubagentEnded(event, { ...ctx, workspaceDir, api });
        } catch (err) {
          api.logger.error(`[PD] Error in subagent_ended: ${String(err)}`);
        }
      })
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

    // ── Service: Background Evolution Worker ──
    try {
      EvolutionWorkerService.api = api;
      const guardedEvolutionWorker = guardService('service:evolution-worker', EvolutionWorkerService, api.logger);
      if (guardedEvolutionWorker) api.registerService(guardedEvolutionWorker);
      const guardedCorrectionObserver = guardService('service:correction-observer', CorrectionObserverService, api.logger);
      if (guardedCorrectionObserver) api.registerService(guardedCorrectionObserver);
      const guardedTrajectory = guardService('service:trajectory', TrajectoryService, api.logger);
      if (guardedTrajectory) api.registerService(guardedTrajectory);
      const guardedPdTask = guardService('service:pd-task', PDTaskService, api.logger);
      if (guardedPdTask) api.registerService(guardedPdTask);
      const guardedCentralSync = guardService('service:central-sync', CentralSyncService, api.logger);
      if (guardedCentralSync) api.registerService(guardedCentralSync);
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

    registerCommandWithAlias('pd-thinking', 'pdt', getCommandDescription('pd-thinking', language), (ctx: any) => handleThinkingOs(ctx), { acceptsArgs: true });

    registerCommandWithAlias('pd-help', 'pdh', getCommandDescription('pd-help', language), () => {
        if (language === 'zh') {
          return { text: `
📖 **Principles Disciple 命令大全**

## 快速开始
| 短命令 | 长命令 | 用途 |
|--------|--------|------|
| \`/pdi\` | \`/pd-init\` | 初始化工作区 |
| \`/pdb\` | \`/pd-bootstrap\` | 环境工具扫描 |
| \`/pdr\` | \`/pd-research\` | 研究工具方案 |

## 状态查询
| 短命令 | 长命令 | 用途 |
|--------|--------|------|
| \`/pdt\` | \`/pd-thinking\` | 思维模型管理 |

## 其他命令
| 命令 | 用途 |
|------|------|
| \`/pd-status\` | 查看系统状态 |
| \`/pd-context\` | 控制上下文注入 |
| \`/pd-focus\` | 焦点文件管理 |
| \`/pd-export\` | 导出数据 |
| \`/pd-samples\` | 审核纠错样本 |
| \`/pd-rollback\` | 回滚情绪事件惩罚 |
| \`/pd-principle-rollback\` | 回滚原则 |
| \`/pd-help\` | 显示本帮助 |
`.trim() };
        } else {
          return { text: `
📖 **Principles Disciple Command Reference**

## Quick Start
| Short | Full | Purpose |
|-------|------|---------|
| \`/pdi\` | \`/pd-init\` | Initialize workspace |
| \`/pdb\` | \`/pd-bootstrap\` | Scan environment tools |
| \`/pdr\` | \`/pd-research\` | Research tool solutions |

## Status
| Short | Full | Purpose |
|-------|------|---------|
| \`/pdt\` | \`/pd-thinking\` | Mental model management |

## Other Commands
| Command | Purpose |
|---------|---------|
| \`/pd-status\` | View system status |
| \`/pd-context\` | Control context injection |
| \`/pd-focus\` | Focus file management |
| \`/pd-export\` | Export data |
| \`/pd-samples\` | Review correction samples |
| \`/pd-rollback\` | Rollback empathy penalty |
| \`/pd-principle-rollback\` | Rollback principle |
| \`/pd-help\` | Show this help |
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
      description: language === 'zh'
        ? '从 OpenClaw 会话中报告 pain（context-bound provenance）'
        : 'Report pain from OpenClaw session (context-bound provenance)',
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
      description: 'Debug helper workflow state and events [workflowId]',
      acceptsArgs: true,
      handler: (ctx) => {
        try {
          const workspaceDir = resolveCommandWorkspaceDir(api, ctx);
          if (ctx.config) ctx.config.workspaceDir = workspaceDir;
          return handleWorkflowDebugCommand(ctx as PluginCommandContext & { args?: string });
        } catch (err) {
          api.logger.error(`[PD] Command /pd-workflow-debug failed: ${String(err)}`);
          return { text: `Workflow debug command failed: ${String(err)}` };
        }
      }
    });

    // ── Implementation Lifecycle Commands (Phase 13) ──
    api.registerCommand({
      name: "pd-promote-impl",
      description: 'Promote a candidate implementation to active [list|show <id>|<id>]',
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
      description: 'Disable an active implementation [list|<id> --reason "..."]',
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
      description: 'Archive an implementation permanently [list|<id>]',
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
      description: 'Rollback current active implementation to previous active [list|<id> --reason "..."]',
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

export { PrincipleTreeLedgerAdapter } from './core/principle-tree-ledger-adapter.js';
/* istanbul ignore next — test exports for evolution worker gate */
export { loadFeatureFlagFromWorkspace, isRecord };

export default plugin;
