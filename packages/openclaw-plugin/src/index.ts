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
  PluginHookBeforeMessageWriteEvent,
  PluginHookBeforeMessageWriteResult,
} from './openclaw-sdk.js';
import * as crypto from 'crypto';
import type { WorkerProfile } from './core/model-deployment-registry.js';
import { classifyTask } from './core/local-worker-routing.js';
import { completeShadowObservation, recordShadowRouting } from './core/shadow-observation-registry.js';
import { getCommandDescription } from './i18n/commands.js';
import { handleBeforePromptBuild } from './hooks/prompt.js';
import { handleBeforeToolCall } from './hooks/gate.js';
import { handleAfterToolCall } from './hooks/pain.js';
import { handleBeforeReset, handleBeforeCompaction, handleAfterCompaction } from './hooks/lifecycle.js';
import { handleLlmOutput } from './hooks/llm.js';
import { handleSubagentEnded } from './hooks/subagent.js';
import { handleBeforeMessageWrite } from './hooks/message-sanitize.js';
import * as TrajectoryCollector from './hooks/trajectory-collector.js';
import { handleInitStrategy, handleManageOkr } from './commands/strategy.js';
import { handleBootstrapTools, handleResearchTools } from './commands/capabilities.js';
import { handleThinkingOs } from './commands/thinking-os.js';
import { handleEvolveTask } from './commands/evolver.js';
import { handlePainCommand } from './commands/pain.js';
import { handleContextCommand } from './commands/context.js';
import { handleFocusCommand } from './commands/focus.js';
import { handleRollbackCommand } from './commands/rollback.js';
import { handleEvolutionStatusCommand } from './commands/evolution-status.js';
import { handlePrincipleRollbackCommand } from './commands/principle-rollback.js';
import { handleExportCommand } from './commands/export.js';
import { handleSamplesCommand } from './commands/samples.js';
import { handleNocturnalReviewCommand } from './commands/nocturnal-review.js';
import { handleNocturnalTrainCommand } from './commands/nocturnal-train.js';
import { handleNocturnalRolloutCommand } from './commands/nocturnal-rollout.js';
import { EvolutionWorkerService } from './service/evolution-worker.js';
import { TrajectoryService } from './service/trajectory-service.js';
import { ensureWorkspaceTemplates } from './core/init.js';
import { migrateDirectoryStructure } from './core/migration.js';
import { SystemLogger } from './core/system-logger.js';
import { createDeepReflectTool } from './tools/deep-reflect.js';
import { PathResolver } from './core/path-resolver.js';
import { createPrinciplesConsoleRoute } from './http/principles-console-route.js';

// Track initialization to avoid repeated calls
let workspaceInitialized = false;

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

const plugin = {
  name: "Principles Disciple",
  description: "Evolutionary programming agent framework with strategic guardrails and reflection loops.",

  register(api: OpenClawPluginApi) {
    api.logger.info("Principles Disciple Plugin registered.");
    PathResolver.setExtensionRoot(api.rootDir);
    api.registerHttpRoute(createPrinciplesConsoleRoute(api));

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
          return await handleBeforePromptBuild(event, { ...ctx, api, workspaceDir });
        } catch (err) {
          api.logger.error(`[PD] Error in before_prompt_build: ${String(err)}`);
        }
      }
    );

    // ── Hook: Security Gate ──
    api.on(
      'before_tool_call',
      (event: PluginHookBeforeToolCallEvent, ctx: PluginHookToolContext): PluginHookBeforeToolCallResult | void => {
        try {
          const pluginConfig = api.pluginConfig ?? {};
          const workspaceDir = ctx.workspaceDir || api.resolvePath('.');
          const logger = api.logger;
          return handleBeforeToolCall(event, { ...ctx, workspaceDir, pluginConfig, logger });
        } catch (err) {
          api.logger.error(`[PD] Error in before_tool_call: ${String(err)}`);
        }
      }
    );

    // ── Hook: Pain & Trust ──
    api.on(
      'after_tool_call',
      (event: PluginHookAfterToolCallEvent, ctx: PluginHookToolContext): void => {
        try {
          const pluginConfig = api.pluginConfig ?? {};
          const workspaceDir = ctx.workspaceDir || api.resolvePath('.');
          // Pass api separately to handleAfterToolCall to maintain type safety
          handleAfterToolCall(event, { ...ctx, workspaceDir, pluginConfig }, api);
        } catch (err) {
          api.logger.error(`[PD] Error in after_tool_call: ${String(err)}`);
        }
      }
    );

    // ── Hook: LLM Analysis ──
    api.on(
      'llm_output',
      (event: PluginHookLlmOutputEvent, ctx: PluginHookAgentContext): void => {
        try {
          const workspaceDir = ctx.workspaceDir || api.resolvePath('.');
          handleLlmOutput(event, { ...ctx, workspaceDir });
        } catch (err) {
          api.logger.error(`[PD] Error in llm_output: ${String(err)}`);
        }
      }
    );

    // ── Hook: Message Sanitization ──
    api.on(
      'before_message_write',
      (event: PluginHookBeforeMessageWriteEvent): PluginHookBeforeMessageWriteResult | void => {
        try {
          return handleBeforeMessageWrite(event);
        } catch (err) {
          api.logger.error(`[PD] Error in before_message_write: ${String(err)}`);
        }
      }
    );

    // ── Hook: Trajectory Collection (Behavior Evolution Phase 0) ──
    // Note: after_tool_call and llm_output are safe to collect
    // before_message_write conflicts with message-sanitize, skipping for now
    api.on(
      'after_tool_call',
      (event: PluginHookAfterToolCallEvent, ctx: PluginHookToolContext): void => {
        try {
          const workspaceDir = ctx.workspaceDir || api.resolvePath('.');
          TrajectoryCollector.handleAfterToolCall(event, { ...ctx, workspaceDir });
        } catch (err) {
          // Non-critical: don't log, just skip
        }
      }
    );

    api.on(
      'llm_output',
      (event: PluginHookLlmOutputEvent, ctx: PluginHookAgentContext): void => {
        try {
          const workspaceDir = ctx.workspaceDir || api.resolvePath('.');
          TrajectoryCollector.handleLlmOutput(event, { ...ctx, workspaceDir });
        } catch (err) {
          // Non-critical: don't log, just skip
        }
      }
    );

    // ── Hook: Subagent Loop Closure ──
    api.on(
      'subagent_spawning',
      (event: PluginHookSubagentSpawningEvent, ctx: PluginHookSubagentContext): void | PluginHookSubagentSpawningResult => {
        try {
          const workspaceDir = ctx.workspaceDir || api.resolvePath('.');
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
      }
    );

    api.on(
      'subagent_ended',
      (event: PluginHookSubagentEndedEvent, ctx: PluginHookSubagentContext): void => {
        try {
          const workspaceDir = api.resolvePath('.');
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
    } catch (err) {
      api.logger.error(`[PD] Failed to register EvolutionWorkerService: ${String(err)}`);
    }

    // ── Slash Commands ──
    api.registerCommand({
      name: "pd-init",
      description: getCommandDescription('pd-init', language),
      handler: (ctx) => handleInitStrategy(ctx)
    });

    api.registerCommand({
      name: "pd-okr",
      description: getCommandDescription('pd-okr', language),
      handler: (ctx) => handleManageOkr(ctx)
    });

    api.registerCommand({
      name: "pd-bootstrap",
      description: getCommandDescription('pd-bootstrap', language),
      handler: (ctx) => handleBootstrapTools(ctx)
    });

    api.registerCommand({
      name: "pd-research",
      description: getCommandDescription('pd-research', language),
      handler: (ctx) => handleResearchTools(ctx)
    });

    api.registerCommand({
      name: "pd-thinking",
      description: getCommandDescription('pd-thinking', language),
      acceptsArgs: true,
      handler: (ctx) => handleThinkingOs(ctx)
    });

    api.registerCommand({
      name: "pd-evolve",
      description: getCommandDescription('pd-evolve', language),
      acceptsArgs: true,
      handler: (ctx) => handleEvolveTask(ctx)
    });

    api.registerCommand({
      name: "pd-daily",
      description: getCommandDescription('pd-daily', language),
      handler: (_ctx) => {
        return { text: language === 'zh' 
          ? "请执行 pd-daily 技能来配置并发送进化日报。系统将引导你完成配置流程，包括发送时间、渠道和报告风格偏好。"
          : "Please execute the pd-daily skill to configure and send your daily evolution report. The system will guide you through the configuration process." };
      }
    });

    api.registerCommand({
      name: "pd-grooming",
      description: getCommandDescription('pd-grooming', language),
      handler: (_ctx) => {
        return { text: language === 'zh'
          ? "请执行 pd-grooming 技能来执行大扫除。例如输入: '执行 pd-grooming 技能'"
          : "Please execute the pd-grooming skill to clean up. For example: 'Execute pd-grooming skill'" };
      }
    });

    api.registerCommand({
      name: "pd-help",
      description: getCommandDescription('pd-help', language),
      handler: (_ctx) => {
        if (language === 'zh') {
          return { text: `
📖 **Principles Disciple 命令大全**

## 🚀 快速开始
| 命令 | 用途 | 使用时机 |
|------|------|----------|
| \`/pd-init\` | 初始化工作区 | 新项目开始时 |
| \`/pd-bootstrap\` | 环境工具扫描 | 缺少开发工具时 |

## 📊 状态查询
| 命令 | 用途 | 使用时机 |
|------|------|----------|
| \`/pd-status\` | 查看进化状态 | 想了解当前 GFI 和 Pain 情况 |
| \`/pd-focus\` | 焦点文件管理 | 查看/压缩/回滚历史版本 |
| \`/pd-export\` | 导出数据 | 导出 analytics/corrections/orpo |
| \`/pd-samples\` | 审核纠错样本 | 查看待审核样本并批准/拒绝 |
| \`/pd-nocturnal-review\` | 审核 nocturnal 样本 | 审核 nocturnal 训练样本并导出 ORPO |

## ⚙️ 配置管理
| 命令 | 用途 | 使用时机 |
|------|------|----------|
| \`/pd-context\` | 控制上下文注入 | 想减少/增加注入内容 |
| \`/pd-okr\` | OKR 目标管理 | 设置战略目标 |

## 🧠 进化相关
| 命令 | 用途 | 使用时机 |
|------|------|----------|
| \`/pd-evolve\` | 执行进化循环 | 有 Pain 需要处理时 |
| \`/pd-thinking\` | 思维模型管理 | 更新 Thinking OS |
| \`/pd-daily\` | 进化日报 | 每日回顾时 |
| \`/pd-grooming\` | 工作区大扫除 | 定期清理 |

## 💡 常用命令示例

**减少 token 消耗：**
\`\`\`
/pd-context minimal
\`\`\`

**恢复完整上下文：**
\`\`\`
/pd-context full
\`\`\`

**查看当前配置：**
\`\`\`
/pd-context status
\`\`\`

🔍 输入任意命令后加 \`help\` 可查看详细帮助，如 \`/pd-context help\`
`.trim() };
        } else {
          return { text: `
📖 **Principles Disciple Command Reference**

## 🚀 Quick Start
| Command | Purpose | When to Use |
|---------|---------|-------------|
| \`/pd-init\` | Initialize workspace | Starting a new project |
| \`/pd-bootstrap\` | Scan environment tools | Missing dev tools |

## 📊 Status Query
| Command | Purpose | When to Use |
|---------|---------|-------------|
| \`/pd-status\` | View evolution status | Check GFI and Pain status |
| \`/pd-focus\` | Focus file management | View/compress/rollback history |
| \`/pd-export\` | Export data | Export analytics/corrections/orpo |
| \`/pd-samples\` | Review correction samples | Review pending correction samples |
| \`/pd-nocturnal-review\` | Review nocturnal samples | Review nocturnal training samples and export ORPO |

## ⚙️ Configuration
| Command | Purpose | When to Use |
|---------|---------|-------------|
| \`/pd-context\` | Control context injection | Reduce/increase injected content |
| \`/pd-okr\` | OKR goal management | Set strategic goals |

## 🧠 Evolution
| Command | Purpose | When to Use |
|---------|---------|-------------|
| \`/pd-evolve\` | Run evolution loop | Process Pain signals |
| \`/pd-thinking\` | Mental model management | Update Thinking OS |
| \`/pd-daily\` | Evolution report | Daily review |
| \`/pd-grooming\` | Workspace cleanup | Periodic cleanup |

## 💡 Common Examples

**Reduce token usage:**
\`\`\`
/pd-context minimal
\`\`\`

**Restore full context:**
\`\`\`
/pd-context full
\`\`\`

**View current config:**
\`\`\`
/pd-context status
\`\`\`

🔍 Add \`help\` after any command for details, e.g., \`/pd-context help\`
`.trim() };
        }
      }
    });

    api.registerCommand({
      name: "pd-status",
      description: getCommandDescription('pd-status', language),
      acceptsArgs: true,
      handler: (ctx) => {
        try {
          const workspaceDir = api.resolvePath('.');
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
          const workspaceDir = api.resolvePath('.');
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
          const workspaceDir = api.resolvePath('.');
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
          const workspaceDir = api.resolvePath('.');
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
          const workspaceDir = api.resolvePath('.');
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
          const workspaceDir = api.resolvePath('.');
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
          const workspaceDir = api.resolvePath('.');
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
          const workspaceDir = api.resolvePath('.');
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
          const workspaceDir = api.resolvePath('.');
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
          const workspaceDir = api.resolvePath('.');
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
          const workspaceDir = api.resolvePath('.');
          if (ctx.config) ctx.config.workspaceDir = workspaceDir;
          return handleNocturnalRolloutCommand(ctx);
        } catch (err) {
          api.logger.error(`[PD] Command /nocturnal-rollout failed: ${String(err)}`);
          return { text: language === 'zh' ? "Nocturnal rollout 命令执行失败，请检查日志。" : "Nocturnal rollout command failed. Check logs." };
        }
      }
    });

    api.registerTool(createDeepReflectTool(api));
  }
};

export default plugin;
