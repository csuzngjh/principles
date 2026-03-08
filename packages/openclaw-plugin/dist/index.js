import { handleBeforePromptBuild } from './hooks/prompt.js';
import { handleBeforeToolCall } from './hooks/gate.js';
import { handleAfterToolCall } from './hooks/pain.js';
import { handleBeforeReset, handleBeforeCompaction } from './hooks/lifecycle.js';
import { handleLlmOutput } from './hooks/llm.js';
import { handleSubagentEnded } from './hooks/subagent.js';
import { handleInitStrategy, handleManageOkr } from './commands/strategy.js';
import { handleEvolveTask } from './commands/evolver.js';
import { handleBootstrapTools, handleResearchTools } from './commands/capabilities.js';
import { handleThinkingOs } from './commands/thinking-os.js';
import { handlePainCommand } from './commands/pain.js';
import { EvolutionWorkerService } from './service/evolution-worker.js';
import { ensureWorkspaceTemplates } from './core/init.js';
import { SystemLogger } from './core/system-logger.js';
// Track initialization to avoid repeated calls
let workspaceInitialized = false;
const plugin = {
    id: "principles-disciple",
    name: "Principles Disciple",
    description: "Evolutionary programming agent framework with strategic guardrails and reflection loops.",
    register(api) {
        api.logger.info("Principles Disciple Plugin registered.");
        // Note: workspaceDir will be obtained from hook context (ctx.workspaceDir)
        // which is correctly set by OpenClaw based on config.
        // Do NOT use api.resolvePath('.') here - it returns process.cwd(), not config workspace.
        const language = api.pluginConfig?.language || 'en';
        // ── Prompt injection ──
        api.on('before_prompt_build', async (event, ctx) => {
            try {
                // Initialize workspace templates once (uses correct workspaceDir from context)
                if (!workspaceInitialized && ctx.workspaceDir) {
                    ensureWorkspaceTemplates(api, ctx.workspaceDir, language);
                    SystemLogger.log(ctx.workspaceDir, 'SYSTEM_BOOT', `Principles Disciple online. Language: ${language}`);
                    workspaceInitialized = true;
                }
                return await handleBeforePromptBuild(event, { ...ctx, api });
            }
            catch (err) {
                api.logger.error(`[PD] Error in before_prompt_build: ${String(err)}`);
            }
        });
        // ── Gatekeeper ──
        api.on('before_tool_call', (event, ctx) => {
            try {
                const pluginConfig = api.pluginConfig ?? {};
                const workspaceDir = ctx.workspaceDir;
                return handleBeforeToolCall(event, { ...ctx, workspaceDir, pluginConfig });
            }
            catch (err) {
                api.logger.error(`[PD] Error in before_tool_call: ${String(err)}`);
            }
        });
        // ── Pain signal ──
        api.on('after_tool_call', (event, ctx) => {
            try {
                const pluginConfig = api.pluginConfig ?? {};
                const workspaceDir = ctx.workspaceDir;
                handleAfterToolCall(event, { ...ctx, workspaceDir, pluginConfig });
            }
            catch (err) {
                api.logger.error(`[PD] Error in after_tool_call: ${String(err)}`);
            }
        });
        // ── Lifecycle: Reset ──
        api.on('before_reset', async (event, ctx) => {
            try {
                await handleBeforeReset(event, ctx);
            }
            catch (err) {
                api.logger.error(`[PD] Error in before_reset: ${String(err)}`);
            }
        });
        // ── Lifecycle: Compaction ──
        api.on('before_compaction', async (event, ctx) => {
            try {
                await handleBeforeCompaction(event, ctx);
            }
            catch (err) {
                api.logger.error(`[PD] Error in before_compaction: ${String(err)}`);
            }
        });
        // ── LLM Cognitive Tracking: Catch agent confusion ──
        api.on('llm_output', (event, ctx) => {
            try {
                const workspaceDir = ctx.workspaceDir;
                handleLlmOutput(event, { ...ctx, workspaceDir });
            }
            catch (err) {
                api.logger.error(`[PD] Error in llm_output: ${String(err)}`);
            }
        });
        // ── Subagent propagation ──
        api.on('subagent_spawning', (event, ctx) => {
            try {
                api.logger.info(`[PD] Subagent spawning: ${event.agentId} (child: ${event.childSessionKey}). Principles protocol injected.`);
                return { status: "ok" };
            }
            catch (err) {
                api.logger.error(`[PD] Error in subagent_spawning: ${String(err)}`);
                return { status: "ok" };
            }
        });
        // ── Subagent outcome: Catch subagent failures ──
        api.on('subagent_ended', (event, ctx) => {
            try {
                const workspaceDir = ctx.workspaceDir;
                handleSubagentEnded(event, { ...ctx, workspaceDir });
            }
            catch (err) {
                api.logger.error(`[PD] Error in subagent_ended: ${String(err)}`);
            }
        });
        // ── Service: Autonomous Background Evolution Worker ──
        try {
            EvolutionWorkerService.api = api;
            api.registerService(EvolutionWorkerService);
        }
        catch (err) {
            api.logger.error(`[PD] Failed to register EvolutionWorkerService: ${String(err)}`);
        }
        // ── Slash commands ──
        api.registerCommand({
            name: "init-strategy",
            description: "Initialize evolutionary OKR strategy",
            acceptsArgs: false,
            handler: (ctx) => {
                try {
                    return handleInitStrategy(ctx);
                }
                catch (err) {
                    api.logger.error(`[PD] Command /init-strategy failed: ${String(err)}`);
                    return { text: "Command failed. Check logs." };
                }
            }
        });
        api.registerCommand({
            name: "manage-okr",
            description: "Manage project OKRs and focus areas",
            acceptsArgs: false,
            handler: (ctx) => {
                try {
                    return handleManageOkr(ctx);
                }
                catch (err) {
                    api.logger.error(`[PD] Command /manage-okr failed: ${String(err)}`);
                    return { text: "Command failed. Check logs." };
                }
            }
        });
        api.registerCommand({
            name: "evolve-task",
            description: "Trigger the Evolver agent for deep code repair via sessions_spawn",
            acceptsArgs: true,
            handler: (ctx) => {
                try {
                    return handleEvolveTask(ctx);
                }
                catch (err) {
                    api.logger.error(`[PD] Command /evolve-task failed: ${String(err)}`);
                    return { text: "Command failed. Check logs." };
                }
            }
        });
        api.registerCommand({
            name: "bootstrap-tools",
            description: "Scan and upgrade environment capabilities",
            acceptsArgs: false,
            handler: (ctx) => {
                try {
                    return handleBootstrapTools(ctx);
                }
                catch (err) {
                    api.logger.error(`[PD] Command /bootstrap-tools failed: ${String(err)}`);
                    return { text: "Command failed. Check logs." };
                }
            }
        });
        api.registerCommand({
            name: "research-tools",
            description: "Ask the agent to research front-edge CLI tools online",
            acceptsArgs: true,
            handler: (ctx) => {
                try {
                    return handleResearchTools(ctx);
                }
                catch (err) {
                    api.logger.error(`[PD] Command /research-tools failed: ${String(err)}`);
                    return { text: "Command failed. Check logs." };
                }
            }
        });
        api.registerCommand({
            name: "thinking-os",
            description: "Manage the Thinking OS cognitive layer (status/propose/audit)",
            acceptsArgs: true,
            handler: (ctx) => {
                try {
                    return handleThinkingOs(ctx);
                }
                catch (err) {
                    api.logger.error(`[PD] Command /thinking-os failed: ${String(err)}`);
                    return { text: "Command failed. Check logs." };
                }
            }
        });
        api.registerCommand({
            name: "pd-status",
            description: "View Digital Nerve System status (GFI and Pain Dictionary)",
            acceptsArgs: true,
            handler: (ctx) => {
                try {
                    return handlePainCommand(ctx);
                }
                catch (err) {
                    api.logger.error(`[PD] Command /pd-status failed: ${String(err)}`);
                    return { text: "Command failed. Check logs." };
                }
            }
        });
        api.registerCommand({
            name: "daily-report",
            description: "Configure and send daily evolution report (email/IM/voice)",
            acceptsArgs: false,
            handler: (_ctx) => {
                return { text: "请执行 daily-report 技能来配置并发送进化日报。系统将引导你完成配置流程，包括发送时间、渠道和报告风格偏好。" };
            }
        });
    }
};
export default plugin;
