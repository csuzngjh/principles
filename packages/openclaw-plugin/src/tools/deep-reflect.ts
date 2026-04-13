/* eslint-disable @typescript-eslint/no-use-before-define */
import type { OpenClawPluginApi } from '../openclaw-sdk.js';
import { Type } from '@sinclair/typebox';
import * as fs from 'fs';
import { EventLogService } from '../core/event-log.js';
import { resolvePdPath } from '../core/paths.js';
import { resolveWorkspaceDirFromApi } from '../core/path-resolver.js';
import { WorkspaceNotFoundError } from '../config/index.js';
import {
    DeepReflectWorkflowManager,
    deepReflectWorkflowSpec,
    type DeepReflectTaskInput,
} from '../service/subagent-workflow/index.js';

interface DeepReflectionConfig {
    enabled: boolean;
    mode: 'auto' | 'forced' | 'disabled';
    auto_trigger_conditions: {
        min_tool_calls: number;
        error_rate_threshold: number;
        high_gfi_threshold: number;
    };
    modelsDir?: string;
    timeout_ms?: number;
}

const DEFAULT_CONFIG: DeepReflectionConfig = {
    enabled: true,
    mode: 'auto',
    auto_trigger_conditions: {
        min_tool_calls: 5,
        error_rate_threshold: 0.3,
        high_gfi_threshold: 70
    },
    timeout_ms: 60000
};

function safeLog(
    api: OpenClawPluginApi | undefined,
    level: 'info' | 'debug' | 'warn' | 'error',
    message: string
): void {
    try {
        if (api?.logger && typeof api.logger[level] === 'function') {
            api.logger[level](message);
        }
    } catch {
        // Never recurse on logger failures
    }
}

function loadConfig(workspaceDir: string | undefined, api: OpenClawPluginApi): DeepReflectionConfig {
    if (!workspaceDir) return DEFAULT_CONFIG;
    const configPath = resolvePdPath(workspaceDir, 'PAIN_SETTINGS');
    try {
        if (fs.existsSync(configPath)) {
            const raw = fs.readFileSync(configPath, 'utf-8');
            const settings = JSON.parse(raw);
            return { ...DEFAULT_CONFIG, ...settings.deep_reflection };
        }
    } catch (err) {
        safeLog(api, 'warn', `[DeepReflect] Failed to load config: ${String(err)}`);
    }
    return DEFAULT_CONFIG;
}

function readStringParam(rawParams: Record<string, unknown>, key: string): string | undefined {
    const value = rawParams[key];
    if (typeof value === 'string') return value.trim() || undefined;

    const snakeKey = key.replace(/([A-Z])/g, '_$1').toLowerCase();
    const snakeValue = rawParams[snakeKey];
    if (typeof snakeValue === 'string') return snakeValue.trim() || undefined;

    return undefined;
}

function readNumberParam(rawParams: Record<string, unknown>, key: string): number | undefined {
    const value = rawParams[key];
    if (typeof value === 'number') return value;

    const snakeKey = key.replace(/([A-Z])/g, '_$1').toLowerCase();
    const snakeValue = rawParams[snakeKey];
    if (typeof snakeValue === 'number') return snakeValue;

    return undefined;
}

export function createDeepReflectTool(api: OpenClawPluginApi) {
    return {
        name: 'deep_reflect',
        description: '执行深层次的元认知反思，分析当前任务的潜在风险、逻辑漏洞或架构改进点。',
        parameters: Type.Object({
            context: Type.String({ description: '需要反思的任务上下文、代码片段或当前遇到的困难。' }),
            depth: Type.Optional(Type.Number({ description: '反思深度 (1-3)。1: 快速扫描, 2: 均衡分析, 3: 彻底解构。默认为 2。', minimum: 1, maximum: 3 })),
            model_id: Type.Optional(Type.String({ description: '可选：强制指定使用的思维模型 ID。' }))
        }),

        async execute(
            _toolCallId: string,
            rawParams: Record<string, unknown>
        ): Promise<{ content: { type: string; text: string }[] }> {
            const context = readStringParam(rawParams, 'context') || '';
            const depth = readNumberParam(rawParams, 'depth') ?? 2;
            const model_id = readStringParam(rawParams, 'model_id');

            if (!context) {
                return { content: [{ type: 'text', text: '❌ 错误: 必须提供反思上下文 (context)。' }] };
            }

             
            const effectiveWorkspaceDir = resolveReflectionWorkspace(api);

            const config = loadConfig(effectiveWorkspaceDir, api);
            if (config.mode === 'disabled' || !config.enabled) {
                return { content: [{ type: 'text', text: '⏭️ Deep Reflection 已禁用。' }] };
            }

            if (model_id) {
                safeLog(api, 'warn', `[DeepReflect] The 'model_id' parameter is deprecated. The agent will now auto-select models based on the context index.`);
            }

            try {
                 
                return await executeReflectionWorkflow(effectiveWorkspaceDir, config, context, depth, model_id, api);
            } catch (err) {
                 
                return handleReflectionError(err, context, depth, model_id, effectiveWorkspaceDir, api);
            }
        }
    };
}

/**
 * Resolve workspace directory for deep reflection tool.
 */
function resolveReflectionWorkspace(api: OpenClawPluginApi): string {
    const dir = (api.config?.workspaceDir as string)
        || resolveWorkspaceDirFromApi(api);
    if (!dir) {
        throw new WorkspaceNotFoundError('deep-reflect: workspace directory could not be resolved via API or config');
    }
    return dir;
}

/**
 * Execute the deep reflection workflow: start, poll, collect results.
 */
 
async function executeReflectionWorkflow(
    effectiveWorkspaceDir: string,
    config: DeepReflectionConfig,
    context: string,
    depth: number,
    model_id: string | undefined,
    api: OpenClawPluginApi,
): Promise<{ content: { type: string; text: string }[] }> {
    const stateDir = resolvePdPath(effectiveWorkspaceDir, 'STATE_DIR');
    const eventLog = EventLogService.get(stateDir, api.logger);
    const parentSessionId = effectiveWorkspaceDir.replace(/[^a-zA-Z0-9_-]/g, '_').substring(0, 64);

    const manager = new DeepReflectWorkflowManager({
        workspaceDir: effectiveWorkspaceDir,
        logger: api.logger,
        // eslint-disable-next-line @typescript-eslint/no-explicit-any -- Reason: api.runtime.subagent has structurally compatible shape but differs from PluginRuntimeSubagent due to optional provider/model fields
        subagent: api.runtime.subagent as any,
        agentSession: api.runtime.agent?.session,
    });

    try {
        const taskInput: DeepReflectTaskInput = { context, depth, model_id };
        const handle = await manager.startWorkflow(deepReflectWorkflowSpec, {
            parentSessionId,
            workspaceDir: effectiveWorkspaceDir,
            taskInput,
        });

        const startTime = Date.now();
        const timeoutMs = config.timeout_ms ?? 60000;
         
        return await pollReflectionCompletion(manager, handle, timeoutMs, startTime, eventLog, effectiveWorkspaceDir, context, model_id, depth);
    } finally {
        manager.dispose();
    }
}

/**
 * Poll the reflection workflow until completion, timeout, or error.
 */
 
async function pollReflectionCompletion(
    manager: DeepReflectWorkflowManager,
    handle: { workflowId: string; childSessionKey: string },
    timeoutMs: number,
    startTime: number,
    eventLog: ReturnType<typeof EventLogService.get>,
    workspaceDir: string,
    context: string,
    model_id: string | undefined,
    depth: number,
): Promise<{ content: { type: string; text: string }[] }> {
    const pollInterval = 500;

    while (Date.now() - startTime < timeoutMs) {
        await new Promise(resolve => setTimeout(resolve, pollInterval));
        const workflowState = manager.getWorkflowState(handle.workflowId);
        if (!workflowState) break;

        if (workflowState === 'completed') {
             
            return formatReflectionSuccess(handle, context, depth, model_id, startTime, eventLog, workspaceDir);
        }

        if (workflowState === 'terminal_error' || workflowState === 'expired') {
            throw new Error(`Deep-reflect workflow failed: ${workflowState}`);
        }
    }

    return { content: [{ type: 'text', text: '⚠️ 反思任务执行超时。你可以尝试减少上下文长度或增加深度。' }] };
}

/**
 * Format the success response from a completed reflection.
 */
 
function formatReflectionSuccess(
    handle: { childSessionKey: string },
    context: string,
    depth: number,
    model_id: string | undefined,
    startTime: number,
    eventLog: ReturnType<typeof EventLogService.get>,
    workspaceDir: string,
): { content: { type: string; text: string }[] } {
    const reflectionLogPath = resolvePdPath(workspaceDir, 'REFLECTION_LOG');
    let insights = '';
    if (fs.existsSync(reflectionLogPath)) {
        const content = fs.readFileSync(reflectionLogPath, 'utf8');
        const match = /### Insights\n([\s\S]*?)(?=---|$)/.exec(content);
        if (match) insights = match[1].trim();
    }

    if (eventLog) {
        eventLog.recordDeepReflection(handle.childSessionKey, {
            modelId: model_id || 'auto-select',
            modelSelectionMode: model_id ? 'manual' : 'auto',
            depth,
            contextPreview: context.substring(0, 200),
            resultPreview: insights.substring(0, 300),
            durationMs: Date.now() - startTime,
            passed: true,
            timeout: false,
        });
    }

    return {
        content: [{
            type: 'text',
            text: `
# 💎 Deep Reflection Insights
---
**Selected Model(s)**: ${model_id || 'auto-select'}
**Reflection Depth**: ${depth}
**Analysis Duration**: ${((Date.now() - startTime) / 1000).toFixed(1)}s

${insights || '反思完成，详见 REFLECTION_LOG。'}

---
*Generated by Principles Disciple Meta-Cognitive Engine*
`.trim(),
        }],
    };
}

/**
 * Handle reflection errors and format error response.
 */
 
function handleReflectionError(
    err: unknown,
    context: string,
    depth: number,
    model_id: string | undefined,
    workspaceDir: string,
    api: OpenClawPluginApi,
): { content: { type: string; text: string }[] } {
    const errorMsg = err instanceof Error ? err.message : String(err);
    safeLog(api, 'error', `[DeepReflect] Reflection failed: ${errorMsg}`);

    const stateDir = resolvePdPath(workspaceDir, 'STATE_DIR');
    const eventLog = EventLogService.get(stateDir, api.logger);

    if (eventLog) {
        eventLog.recordDeepReflection('deep-reflect-error', {
            modelId: model_id || 'auto-select',
            modelSelectionMode: model_id ? 'manual' : 'auto',
            depth,
            contextPreview: context.substring(0, 200),
            durationMs: 0,
            passed: false,
            timeout: errorMsg.toLowerCase().includes('timeout'),
            error: errorMsg,
        });
    }

    return { content: [{ type: 'text', text: `❌ 反思执行失败: ${errorMsg}。请检查 API 配置或网络连接。` }] };
}

export const deepReflectTool = {
    name: 'deep_reflect',
    description: '执行深层次的元认知反思，分析当前任务的潜在风险、逻辑漏洞或架构改进点。',
    parameters: Type.Object({
        context: Type.String({ description: '需要反思的任务上下文、代码片段或当前遇到的困难。' }),
        depth: Type.Optional(Type.Number({ description: '反思深度 (1-3)。1: 快速扫描, 2: 均衡分析, 3: 彻底解构。默认为 2。', minimum: 1, maximum: 3 })),
        model_id: Type.Optional(Type.String({ description: '可选：强制指定使用的思维模型 ID。' }))
    }),
};
