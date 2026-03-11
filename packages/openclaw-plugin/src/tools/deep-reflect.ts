import type { OpenClawPluginApi, SubagentWaitResult } from '../openclaw-sdk.js';
import { Type } from '@sinclair/typebox';
import { randomUUID } from 'node:crypto';
import * as fs from 'fs';
import * as path from 'node:path';
import { EventLogService } from '../core/event-log.js';
import { buildCritiquePromptV2 } from './critique-prompt.js';
import { resolvePdPath } from '../core/paths.js';

// Deep Reflection 配置类型
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
    } catch { }
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

export const deepReflectTool = {
    name: 'deep_reflect',
    description: '执行深层次的元认知反思，分析当前任务的潜在风险、逻辑漏洞或架构改进点。',
    parameters: Type.Object({
        context: Type.String({ description: '需要反思的任务上下文、代码片段或当前遇到的困难。' }),
        depth: Type.Optional(Type.Number({ description: '反思深度 (1-3)。1: 快速扫描, 2: 均衡分析, 3: 彻底解构。默认为 2。', minimum: 1, maximum: 3 })),
        model_id: Type.Optional(Type.String({ description: '可选：强制指定使用的思维模型 ID。' }))
    }),

    /**
     * 万能兼容 Handler
     * @param workspaceDir 第三参数，专为单元测试设计
     */
    async handler(
        params: { context: string; depth?: number; model_id?: string },
        api: OpenClawPluginApi,
        workspaceDir?: string
    ): Promise<string> {
        const { context, depth = 2, model_id } = params;
        
        if (!context) return '❌ 错误: 必须提供反思上下文 (context)。';

        // 路径解析优先级：显式传入 > api.config > api.workspaceDir > api.resolvePath
        const effectiveWorkspaceDir = workspaceDir 
            || (api.config?.workspaceDir as string) 
            || api.workspaceDir
            || api.resolvePath?.('.');
        
        if (!effectiveWorkspaceDir) {
            return `❌ 反思执行失败: Workspace directory is required for deep reflection.。请检查 API 配置或网络连接。`;
        }

        const config = loadConfig(effectiveWorkspaceDir, api);
        if (config.mode === 'disabled' || !config.enabled) {
            return `⏭️ Deep Reflection 已禁用。`;
        }

        if (model_id) {
            safeLog(api, 'warn', `[DeepReflect] The 'model_id' parameter is deprecated. The agent will now auto-select models based on the context index.`);
        }

        const agentId = 'main';
        const sessionKey = `agent:${agentId}:reflection:${randomUUID()}`;
        const sessionId = sessionKey.split(':').pop();

        const stateDir = resolvePdPath(effectiveWorkspaceDir, 'STATE_DIR');
        const eventLog = EventLogService.get(stateDir, api.logger);

        try {
            const extraSystemPrompt = buildCritiquePromptV2({
                context,
                depth,
                model_id,
                api,
                workspaceDir: effectiveWorkspaceDir
            });

            const startTime = Date.now();
            const subagentRuntime = api.runtime.subagent;
            if (!subagentRuntime) throw new Error('OpenClaw subagent runtime not found.');

            await subagentRuntime.run({
                sessionKey, // 👈 对齐官方字段
                message: `请对我当前的任务进行深层次反思。\n\n上下文：${context}`, // 👈 对齐官方字段
                extraSystemPrompt,
                deliver: false
            });

            const finalStatus: SubagentWaitResult = await subagentRuntime.waitForRun({ runId: sessionKey }); // 👈 对齐官方对象传参
            const duration = Date.now() - startTime;

            if (finalStatus.status === 'timeout') {
                return `⚠️ 反思任务执行超时。你可以尝试减少上下文长度或增加深度。`;
            }

            if (finalStatus.status === 'ok') { // 👈 对齐官方状态码
                const rawMessages = await subagentRuntime.getSessionMessages({ sessionKey });
                
                let insights = '';
                if ((rawMessages as any).assistantTexts && Array.isArray((rawMessages as any).assistantTexts)) {
                    insights = (rawMessages as any).assistantTexts.join('\n');
                } else {
                    const messages = rawMessages.messages || [];
                    const lastMessage: any = messages[messages.length - 1];
                    if (typeof lastMessage?.content === 'string') {
                        insights = lastMessage.content;
                    } else if (Array.isArray(lastMessage?.content)) {
                        insights = lastMessage.content.filter((c: any) => c.type === 'text').map((c: any) => c.text).join('\n');
                    }
                }

                if (insights.includes('REFLECTION_OK')) {
                    return `✅ 反思完成：当前任务逻辑严密，未发现显著问题。`;
                }

                if (eventLog && sessionId) {
                    eventLog.recordDeepReflection(sessionId, {
                        modelId: model_id || 'auto-select',
                        modelSelectionMode: model_id ? 'manual' : 'auto',
                        depth,
                        contextPreview: context.substring(0, 200),
                        resultPreview: insights.substring(0, 300),
                        durationMs: duration,
                        passed: true,
                        timeout: false
                    });
                }

                return `
# 💎 Deep Reflection Insights
---
**Selected Model(s)**: ${model_id || 'auto-select'}
**Reflection Depth**: ${depth}
**Analysis Duration**: ${(duration / 1000).toFixed(1)}s

${insights}

---
*Generated by Principles Disciple Meta-Cognitive Engine*
`.trim();
            } else {
                throw new Error(`Subagent status: ${finalStatus.status}`);
            }

        } catch (err) {
            const errorMsg = err instanceof Error ? err.message : String(err);
            safeLog(api, 'error', `[DeepReflect] Reflection failed: ${errorMsg}`);

            if (eventLog && sessionId) {
                eventLog.recordDeepReflection(sessionId, {
                    modelId: model_id || 'auto-select',
                    modelSelectionMode: model_id ? 'manual' : 'auto',
                    depth,
                    contextPreview: context.substring(0, 200),
                    durationMs: 0,
                    passed: false,
                    timeout: errorMsg.toLowerCase().includes('timeout'),
                    error: errorMsg
                });
            }

            if (errorMsg === 'API throw') throw err;
            return `❌ 反思执行失败: ${errorMsg}。请检查 API 配置或网络连接。`;
        } finally {
            if (api.runtime.subagent) await api.runtime.subagent.deleteSession({ sessionKey }).catch(() => {});
        }
    }
};
