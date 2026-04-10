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
  PluginHookSubagentEndedEvent,
  PluginHookLlmOutputEvent,
  PluginHookSubagentSpawningEvent,
  PluginHookSubagentSpawningResult,
  PluginHookSubagentContext,
} from './openclaw-sdk.js';
import * as crypto from 'crypto';
import type { WorkerProfile } from './core/model-deployment-registry.js';
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
import { handleInitStrategy, handleManageOkr } from './commands/strategy.js';
import { handleBootstrapTools, handleResearchTools } from './commands/capabilities.js';
import { handleThinkingOs } from './commands/thinking-os.js';
import { handlePainCommand } from './commands/pain.js';
import { handleContextCommand } from './commands/context.js';
import { handleFocusCommand } from './commands/focus.js';
import { handleRollbackCommand } from './commands/rollback.js';
import { handlePromoteImplCommand } from './commands/promote-impl.js';
import { handleDisableImplCommand } from './commands/disable-impl.js';
import { handlePdReflect } from './commands/pd-reflect.js';
import { handleArchiveImplCommand } from './commands/archive-impl.js';
import { handleRollbackImplCommand } from './commands/rollback-impl.js';
import { handleEvolutionStatusCommand } from './commands/evolution-status.js';
import { handlePrincipleRollbackCommand } from './commands/principle-rollback.js';
import { handleExportCommand } from './commands/export.js';
import { handleSamplesCommand } from './commands/samples.js';
import { handleNocturnalReviewCommand } from './commands/nocturnal-review.js';
import { handleNocturnalTrainCommand } from './commands/nocturnal-train.js';
import { handleNocturnalRolloutCommand } from './commands/nocturnal-rollout.js';
import { handleWorkflowDebugCommand } from './commands/workflow-debug.js';
import { EvolutionWorkerService } from './service/evolution-worker.js';
import { TrajectoryService } from './service/trajectory-service.js';
import { PDTaskService } from './core/pd-task-service.js';
import { CentralSyncService } from './service/central-sync-service.js';
import { ensureWorkspaceTemplates } from './core/init.js';
import { migrateDirectoryStructure } from './core/migration.js';
import { SystemLogger } from './core/system-logger.js';
import { createDeepReflectTool } from './tools/deep-reflect.js';
import { PathResolver, resolveWorkspaceDirFromApi } from './core/path-resolver.js';
import { validateWorkspaceDir } from './core/workspace-dir-validation.js';
import { createPrinciplesConsoleRoute } from './http/principles-console-route.js';

// Track initialization to avoid repeated calls
let workspaceInitialized = false;

/**
 * Resolve workspaceDir for slash commands.
 * Chain: ctx.workspaceDir → resolveWorkspaceDirFromApi (official OpenClaw API + env vars)
 * 
 * CRITICAL: Throws if workspaceDir cannot be resolved. Silent failures are dangerous
 * because commands might operate on the wrong directory.
 */
function resolveCommandWorkspaceDir(
  api: OpenClawPluginApi,
  ctx: { workspaceDir?: string },
): string {
  // 1. Direct from command context (most reliable — set by OpenClaw for current session)
  if (ctx.workspaceDir) {
    const issue = validateWorkspaceDir(ctx.workspaceDir);
    if (!issue) return ctx.workspaceDir;
    api.logger.error(`[PD:Command] ctx.workspaceDir="${ctx.workspaceDir}" is invalid: ${issue}`);
  }

  // 2. Official OpenClaw API → env vars → config file
  const resolved = resolveWorkspaceDirFromApi(api);
  if (resolved) return resolved;

  // CRITICAL FAILURE: Cannot determine workspace directory
  const errorMsg = `[PD:Command] CRITICAL: Cannot resolve workspace directory. ` +
    `ctx.workspaceDir="${ctx.workspaceDir}" is invalid, and all fallbacks failed. ` +
    `Commands will NOT execute to prevent data corruption.`;
  api.logger.error(errorMsg);
  
  throw new Error(errorMsg);
}

// Map from childSessionKey → shadowObservationId
// Used to complete shadow observations when subagent ends
const pendingShadowObservations = new Map<string, string>();

// PD local worker profiles that are managed by the shadow routing policy
const PD_LOCAL_PROFILES = new Set<WorkerProfile>(['local-reader', 'local-editor']);

function computeRuntimeShadowTaskFingerprint(event: PluginHookSubagentSpawningEvent): string {
  const payload = {
    childSessionKey: event.childSessionKey,
    agentId: event.agentId,
    label: event.label ?? '',
    mode: event.mode,
    threadRequested: event.threadRequested,
    requesterChannel: event.requester?.channel ?? '',
    requesterThreadId: event.requester?.threadId ?? '',
  };
  return crypto.createHash('sha256').update(JSON.stringify(payload)).digest('hex').slice(0, 16);
}

import { resolveValidWorkspaceDir } from './core/workspace-dir-validation.js';

function resolveToolHookWorkspaceDir(
  ctx: { workspaceDir?: string; agentId?: string },
  api: OpenClawPluginApi,
  source: string,
): string {
  return resolveValidWorkspaceDir(ctx, api, { source });
}

const plugin = {
  name: "Principles Disciple",
  description: "Evolutionary programming agent framework with strategic guardrails and reflection loops.",

  register(api: OpenClawPluginApi) {
    api.logger.info(`Principles Disciple Plugin registered. (Path: ${api.rootDir ?? '(unknown)'})`);
    PathResolver.setExtensionRoot(api.rootDir ?? '.');
    api.registerHttpRoute(createPrinciplesConsoleRoute(api));

    // ── Startup Health Check: Verify workspaceDir resolution ──
    // Catches OpenClaw context bugs early (e.g., missing workspaceDir in tool hooks)
    setTimeout(() => {
      const testCtx = { agentId: 'main' };
      const toolWorkspaceDir = resolveToolHookWorkspaceDir(testCtx, api, 'startup.health_check');
      const toolIssue = validateWorkspaceDir(toolWorkspaceDir);
      if (toolIssue) {
        api.logger.error(`[PD:health] Tool hook workspaceDir is INVALID: "${toolWorkspaceDir}" - ${toolIssue}`);
        api.logger.error(`[PD:health] Tool hook events will be written to the WRONG .state directory!`);
      } else {
        api.logger.info(`[PD:health] Tool hook workspaceDir OK: "${toolWorkspaceDir}"`);
      }
    }, 1000);

    const language = (api.pluginConfig?.language as string) || 'en';

    // ── Hook: Prompt Building ──
    api.on(
      'before_prompt_build',
      async (event: PluginHookBeforePromptBuildEvent, ctx: PluginHookAgentContext): Promise<PluginHookBeforePromptBuildResult | void> => {
        try {
          const workspaceDir = ctx.workspaceDir || api.resolvePath('.');
          if (!workspaceInitialized && workspaceDir) {
            migrateDirectoryStructure(api, workspaceDir);
            ensureWorkspaceTemplates(api, workspaceDir, language);
            SystemLogger.log(workspaceDir, 'SYSTEM_BOOT', `Principles Disciple online. Language: ${language}`);
            workspaceInitialized = true;
          }
          const result = await handleBeforePromptBuild(event, { ...ctx, api, workspaceDir });
          
          // Record success
          WorkspaceContext.fromHookContext({ workspaceDir }).eventLog.recordHookExecution({
            hook: 'before_prompt_build',
            sessionId: ctx.sessionId
          });
          
          return result;
        } catch (err) {
          const workspaceDir = ctx.workspaceDir || api.resolvePath('.');
          WorkspaceContext.fromHookContext({ workspaceDir }).eventLog.recordHookExecution({
            hook: 'before_prompt_build',
            sessionId: ctx.sessionId,
            error: String(err)
          });
          api.logger.error(`[PD] Error in before_prompt_build: ${String(err)}`);
        }
      }
    );

    // ── Hook: Security Gate ──
    api.on(
      'before_tool_call',
      (event: PluginHookBeforeToolCallEvent, ctx: PluginHookToolContext): PluginHookBeforeToolCallResult | void => {
        const workspaceDir = resolveToolHookWorkspaceDir(ctx, api, 'before_tool_call');
        try {
          const pluginConfig = api.pluginConfig ?? {};
          const {logger} = api;
          const result = handleBeforeToolCall(event, { ...ctx, workspaceDir, pluginConfig, logger });

          WorkspaceContext.fromHookContext({ workspaceDir }).eventLog.recordHookExecution({
            hook: 'before_tool_call'
          }, { flushImmediately: true });

          return result;
        } catch (err) {
          const fallbackDir = resolveToolHookWorkspaceDir(ctx, api, 'before_tool_call');
          WorkspaceContext.fromHookContext({ workspaceDir: fallbackDir }).eventLog.recordHookExecution({
            hook: 'before_tool_call',
            error: String(err)
          }, { flushImmediately: true });
          api.logger.error(`[PD] Error in before_tool_call: ${String(err)}`);
        }
      }
    );

    // ── Hook: Pain & Trust ──
    api.on(
      'after_tool_call',
      (event: PluginHookAfterToolCallEvent, ctx: PluginHookToolContext): void => {
        const workspaceDir = resolveToolHookWorkspaceDir(ctx, api, 'after_tool_call');
        try {
          const pluginConfig = api.pluginConfig ?? {};
          // Pass api separately to handleAfterToolCall to maintain type safety
          handleAfterToolCall(event, { ...ctx, workspaceDir, pluginConfig }, api);

          WorkspaceContext.fromHookContext({ workspaceDir }).eventLog.recordHookExecution({
            hook: 'after_tool_call'
          }, { flushImmediately: true });
        } catch (err) {
          const fallbackDir = resolveToolHookWorkspaceDir(ctx, api, 'after_tool_call');
          WorkspaceContext.fromHookContext({ workspaceDir: fallbackDir }).eventLog.recordHookExecution({
            hook: 'after_tool_call',
            error: String(err)
          }, { flushImmediately: true });
          api.logger.error(`[PD:EmpathyObserver] Error in after_tool_call: ${String(err)}`);
        }
      }
    );

    // ── Hook: LLM Analysis ──
    api.on(
      'llm_output',
      (event: PluginHookLlmOutputEvent, ctx: PluginHookAgentContext): void => {
        const workspaceDir = resolveToolHookWorkspaceDir(ctx as unknown as Record<string, unknown>, api, 'llm_output');
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
      }
    );

    // ── Hook: Trajectory Collection (Behavior Evolution Phase 0) ──
    // Note: after_tool_call and llm_output are safe to collect
    api.on(
      'after_tool_call',
      (event: PluginHookAfterToolCallEvent, ctx: PluginHookToolContext): void => {
        try {
          const workspaceDir = resolveToolHookWorkspaceDir(ctx, api, 'trajectory.after_tool_call');
          TrajectoryCollector.handleAfterToolCall(event, { ...ctx, workspaceDir });
          // eslint-disable-next-line no-unused-vars, @typescript-eslint/no-unused-vars -- Reason: catch binding intentionally unused
        } catch (_err) {
          // Non-critical: don't log, just skip
        }
      }
    );

    api.on(
      'llm_output',
      (event: PluginHookLlmOutputEvent, ctx: PluginHookAgentContext): void => {
        try {
          const workspaceDir = resolveToolHookWorkspaceDir(ctx as unknown as Record<string, unknown>, api, 'trajectory.llm_output');
          TrajectoryCollector.handleLlmOutput(event, { ...ctx, workspaceDir });
          // eslint-disable-next-line no-unused-vars, @typescript-eslint/no-unused-vars -- Reason: catch binding intentionally unused
        } catch (_err) {
          // Non-critical: don't log, just skip
        }
      }
    );

    // ── Hook: Subagent Loop Closure ──
    api.on(
      'subagent_spawning',
      // eslint-disable-next-line no-unused-vars, @typescript-eslint/no-unused-vars -- Reason: ctx param required by hook callback signature but not used in this handler
      (event: PluginHookSubagentSpawningEvent, _ctx: PluginHookSubagentContext): void | PluginHookSubagentSpawningResult => {
        try {
          // Resolve workspace via official API, falling back to PathResolver
          const workspaceDir = resolveWorkspaceDirFromApi(api, event.agentId) || '.';
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
              checkpointId: decision.activeCheckpointId!, // eslint-disable-line @typescript-eslint/no-non-null-assertion -- Reason: !!decision.activeCheckpointId guard above ensures truthiness
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
      }
    );

    api.on(
      'subagent_ended',
      (event: PluginHookSubagentEndedEvent, ctx: PluginHookSubagentContext): void => {
        try {
          // Resolve workspace via official API, falling back to PathResolver
          const workspaceDir = resolveWorkspaceDirFromApi(api, undefined) || '.';
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
      }
    );

    // ── Hook: Lifecycle ──
    api.on('before_reset', (event: PluginHookBeforeResetEvent, ctx: PluginHookAgentContext) => {
      const workspaceDir = ctx.workspaceDir || api.resolvePath('.');
      return handleBeforeReset(event, { ...ctx, workspaceDir });
    });
    
    api.on('before_compaction', (event: PluginHookBeforeCompactionEvent, ctx: PluginHookAgentContext) => {
      const workspaceDir = ctx.workspaceDir || api.resolvePath('.');
      return handleBeforeCompaction(event, { ...ctx, workspaceDir });
    });
    
    api.on('after_compaction', (event: PluginHookAfterCompactionEvent, ctx: PluginHookAgentContext) => {
      const workspaceDir = ctx.workspaceDir || api.resolvePath('.');
      return handleAfterCompaction(event, { ...ctx, workspaceDir });
    });

    // ── Service: Background Evolution Worker ──
    try {
      EvolutionWorkerService.api = api;
      api.registerService(EvolutionWorkerService);
      api.registerService(TrajectoryService);
      api.registerService(PDTaskService);
      api.registerService(CentralSyncService);
    } catch (err) {
      api.logger.error(`[PD] Failed to register EvolutionWorkerService: ${String(err)}`);
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
    registerCommandWithAlias('pd-okr', 'pdk', getCommandDescription('pd-okr', language), (ctx: any) => handleManageOkr(ctx));
    registerCommandWithAlias('pd-bootstrap', 'pdb', getCommandDescription('pd-bootstrap', language), (ctx: any) => handleBootstrapTools(ctx));
    registerCommandWithAlias('pd-research', 'pdr', getCommandDescription('pd-research', language), (ctx: any) => handleResearchTools(ctx));
    registerCommandWithAlias('pd-thinking', 'pdt', getCommandDescription('pd-thinking', language), (ctx: any) => handleThinkingOs(ctx), { acceptsArgs: true });
    registerCommandWithAlias('pd-reflect', 'pdrl', getCommandDescription('pd-reflect', language), (ctx: any) => {
      try {
        (ctx as any).api = api;
        return handlePdReflect.handler(ctx as any);
      } catch (err) {
        api.logger.error(`[PD] Command /pd-reflect failed: ${String(err)}`);
        return { text: language === 'zh' ? "命令执行失败，请检查日志。" : "Command failed. Check logs." };
      }
    });
    registerCommandWithAlias('pd-daily', 'pdd', getCommandDescription('pd-daily', language), () => ({
      text: language === 'zh'
        ? "请执行 pd-daily 技能来配置并发送进化日报。系统将引导你完成配置流程，包括发送时间、渠道和报告风格偏好。"
        : "Please execute the pd-daily skill to configure and send your daily evolution report. The system will guide you through the configuration process."
    }));
    registerCommandWithAlias('pd-grooming', 'pdg', getCommandDescription('pd-grooming', language), () => ({
      text: language === 'zh'
        ? "请执行 pd-grooming 技能来执行大扫除。例如输入: '执行 pd-grooming 技能'"
        : "Please execute the pd-grooming skill to clean up. For example: 'Execute pd-grooming skill'"
    }));
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
| \`/pdk\` | \`/pd-okr\` | OKR 目标管理 |
| \`/pdt\` | \`/pd-thinking\` | 思维模型管理 |
| \`/pdrl\` | \`/pd-reflect\` | 手动触发反思 |
| \`/pdd\` | \`/pd-daily\` | 进化日报 |
| \`/pdg\` | \`/pd-grooming\` | 工作区清理 |

## 其他命令
| 命令 | 用途 |
|------|------|
| \`/pd-status\` | 查看系统状态 |
| \`/pd-context\` | 控制上下文注入 |
| \`/pd-focus\` | 焦点文件管理 |
| \`/pd-export\` | 导出数据 |
| \`/pd-samples\` | 审核纠错样本 |
| \`/pd-nocturnal-review\` | 审核 nocturnal 样本 |
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
| \`/pdk\` | \`/pd-okr\` | OKR goal management |
| \`/pdt\` | \`/pd-thinking\` | Mental model management |
| \`/pdrl\` | \`/pd-reflect\` | Manual reflection trigger |
| \`/pdd\` | \`/pd-daily\` | Evolution report |
| \`/pdg\` | \`/pd-grooming\` | Workspace cleanup |

## Other Commands
| Command | Purpose |
|---------|---------|
| \`/pd-status\` | View system status |
| \`/pd-context\` | Control context injection |
| \`/pd-focus\` | Focus file management |
| \`/pd-export\` | Export data |
| \`/pd-samples\` | Review correction samples |
| \`/pd-nocturnal-review\` | Review nocturnal samples |
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
      name: "pd-nocturnal-review",
      description: 'Review nocturnal dataset samples [list|show|approve|reject|set-family|stats]',
      acceptsArgs: true,
      handler: (ctx) => {
        try {
          const workspaceDir = resolveCommandWorkspaceDir(api, ctx);
          if (ctx.config) ctx.config.workspaceDir = workspaceDir;
          return handleNocturnalReviewCommand(ctx);
        } catch (err) {
          api.logger.error(`[PD] Command /pd-nocturnal-review failed: ${String(err)}`);
          return { text: language === 'zh' ? "Nocturnal review 命令执行失败，请检查日志。" : "Nocturnal review command failed. Check logs." };
        }
      }
    });

    api.registerCommand({
      name: "nocturnal-train",
      description: 'Nocturnal training operations [create-experiment|show-experiment|import-result|attach-eval|show-lineage|list-experiments|list-checkpoints|stats]',
      acceptsArgs: true,
      handler: (ctx) => {
        try {
          const workspaceDir = resolveCommandWorkspaceDir(api, ctx);
          if (ctx.config) ctx.config.workspaceDir = workspaceDir;
          return handleNocturnalTrainCommand(ctx);
        } catch (err) {
          api.logger.error(`[PD] Command /nocturnal-train failed: ${String(err)}`);
          return { text: language === 'zh' ? "Nocturnal train 命令执行失败，请检查日志。" : "Nocturnal train command failed. Check logs." };
        }
      }
    });

    api.registerCommand({
      name: "nocturnal-rollout",
      description: 'Nocturnal rollout and promotion [evaluate-promotion|advance-promotion|bind|enable-routing|disable-routing|rollback|status|show-promotion]',
      acceptsArgs: true,
      handler: (ctx) => {
        try {
          const workspaceDir = resolveCommandWorkspaceDir(api, ctx);
          if (ctx.config) ctx.config.workspaceDir = workspaceDir;
          return handleNocturnalRolloutCommand(ctx);
        } catch (err) {
          api.logger.error(`[PD] Command /nocturnal-rollout failed: ${String(err)}`);
          return { text: language === 'zh' ? "Nocturnal rollout 命令执行失败，请检查日志。" : "Nocturnal rollout command failed. Check logs." };
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

    api.registerTool(createDeepReflectTool(api));
  }
};

export default plugin;
