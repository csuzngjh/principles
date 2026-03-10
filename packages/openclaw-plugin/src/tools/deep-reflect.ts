import type { OpenClawPluginApi } from '../openclaw-sdk.js';
import { Type } from '@sinclair/typebox';
import { randomUUID } from 'node:crypto';
import * as fs from 'fs';
import * as path from 'node:path';

// Deep Reflection 配置类型
interface DeepReflectionConfig {
    enabled: boolean;
    mode: 'auto' | 'forced' | 'disabled';
    auto_trigger_conditions?: {
        min_tool_calls?: number;
        error_rate_threshold?: number;
        complexity_keywords?: string[];
    };
    default_model?: string;
    default_depth?: number;
    timeout_ms?: number;
}

// 默认配置
const DEFAULT_CONFIG: DeepReflectionConfig = {
    enabled: true,
    mode: 'auto',
    auto_trigger_conditions: {
        min_tool_calls: 5,
        error_rate_threshold: 0.3,
        complexity_keywords: ['refactor', 'architecture', 'design', 'optimize', 'security', 'critical']
    },
    default_model: 'T-01',
    default_depth: 2,
    timeout_ms: 60000
};

// 安全日志函数
function safeLog(api: OpenClawPluginApi, level: 'info' | 'debug' | 'warn' | 'error', message: string): void {
    try {
        if (api.logger && typeof api.logger[level] === 'function') {
            api.logger[level](message);
        }
    } catch {
        // Ignore logging errors
    }
}

/**
 * 读取 Deep Reflection 配置
 */
function loadConfig(workspaceDir: string | undefined, api: OpenClawPluginApi): DeepReflectionConfig {
    if (!workspaceDir) {
        safeLog(api, 'debug', '[DeepReflect] No workspaceDir, using default config');
        return DEFAULT_CONFIG;
    }

    const stateDir = path.join(workspaceDir, 'memory', '.state');
    const configPath = path.join(stateDir, 'pain_settings.json');

    try {
        if (fs.existsSync(configPath)) {
            const raw = fs.readFileSync(configPath, 'utf-8');
            const settings = JSON.parse(raw);
            const config = settings.deep_reflection || DEFAULT_CONFIG;
            safeLog(api, 'debug', `[DeepReflect] Loaded config: ${JSON.stringify(config)}`);
            return config;
        }
    } catch (err) {
        safeLog(api, 'warn', `[DeepReflect] Failed to load config: ${String(err)}`);
    }

    return DEFAULT_CONFIG;
}

function buildCritiquePrompt(modelId: string, context: string, depth: number = 2): string {
    const depthInstructions = depth === 1 
        ? 'Provide a quick surface-level analysis.' 
        : depth === 3 
            ? 'Provide an extremely thorough and exhaustive analysis, considering all edge cases and second-order effects.'
            : 'Provide a balanced analysis with moderate depth.';

    return `You are a Critique Engine — a cognitive reflection assistant.

## Your Role
You are the "Shoulder Angel" AI — a critical voice that challenges assumptions and finds blind spots. You do NOT:
- Write code or produce final deliverables
- Complete the user's task directly
- Make decisions for the main agent
- Be polite or agreeable (be rigorously critical)

## Active Cognitive Model
Model ID: ${modelId}
Apply the principles of this model RIGIDLY and UNFORGIVINGLY.

## Your Task
${depthInstructions}

Analyze the following context:
---
${context}
---

## Required Output Structure

### 🎯 Blind Spots (What might the main agent be missing?)
- List at least 2-3 potential blind spots
- Be specific about what information or perspectives are lacking

### ⚠️ Risk Warnings (What could go wrong?)
- Identify potential failure modes
- Consider edge cases and error handling
- Think about security, performance, and maintainability

### 💡 Alternative Approaches (Is there a better way?)
- Propose at least 2 different approaches
- Compare trade-offs

### 📊 Recommendations (Not decisions, but suggestions)
- Prioritize by impact and effort
- Be actionable and specific

### 🔮 Confidence Level
- State your confidence: LOW / MEDIUM / HIGH
- Explain why you chose this level`;
}

export const deepReflectTool = {
    name: "deep_reflect",
    description: `[DEEP REFLECTION] Before proceeding with complex or risky operations, invoke this tool to get critical feedback.

**WHEN TO USE THIS TOOL (IMPORTANT!):**
- You are about to make significant changes to core files (src/, infra/, db/)
- You encountered errors and are about to retry
- The task involves refactoring, architecture changes, or design decisions
- You feel uncertain about the best approach
- The user asks for "careful" or "thorough" analysis
- You see keywords like: refactor, architecture, optimize, security, critical

**WHAT THIS TOOL DOES:**
Summons a "Shoulder Angel" AI that will rigorously critique your approach, find blind spots, and suggest alternatives.

**DO NOT USE FOR:**
- Simple file reads
- Trivial edits
- When the user explicitly says to skip reflection

**COST:** Runs in background, no visible output to user unless issues found.`,
    parameters: Type.Object({
        model_id: Type.String({
            description: "Thinking model ID (T-01 to T-09). Default T-01 (地图先于领土). T-05 (否定优于肯定) is great for risk analysis."
        }),
        context: Type.String({
            description: "Describe your current plan, what you're about to do, and any concerns you have. Be specific!"
        }),
        depth: Type.Optional(Type.Number({
            description: "Reflection depth: 1=quick, 2=balanced (default), 3=exhaustive"
        }))
    }),
    handler: async (
        params: { model_id: string; context: string; depth?: number },
        api: OpenClawPluginApi,
        workspaceDir?: string
    ): Promise<string> => {
        const { model_id, context, depth } = params;
        
        // 加载配置
        const config = loadConfig(workspaceDir, api);
        
        // 检查是否启用
        if (!config.enabled || config.mode === 'disabled') {
            safeLog(api, 'info', '[DeepReflect] Feature is disabled in config');
            return `⏭️ Deep Reflection 已禁用。如需启用，请在 pain_settings.json 中设置 deep_reflection.enabled = true`;
        }

        const actualDepth = depth ?? config.default_depth ?? 2;
        const timeoutMs = config.timeout_ms ?? 60000;
        const agentId = 'main';
        const sessionKey = `agent:${agentId}:reflection:${randomUUID()}`;

        // 详细日志：开始
        safeLog(api, 'info', 
            `\n` +
            `╔══════════════════════════════════════════════════════════════╗\n` +
            `║  [DEEP REFLECTION] STARTING                                   ║\n` +
            `╠══════════════════════════════════════════════════════════════╣\n` +
            `║  Model: ${model_id.padEnd(52)}║\n` +
            `║  Depth: ${actualDepth.toString().padEnd(52)}║\n` +
            `║  Session: ${sessionKey.substring(0, 50).padEnd(52)}║\n` +
            `║  Timeout: ${(timeoutMs / 1000 + 's').padEnd(52)}║\n` +
            `║  Mode: ${config.mode.padEnd(52)}║\n` +
            `╚══════════════════════════════════════════════════════════════╝`
        );

        // 日志：上下文摘要
        const contextPreview = context.length > 200 ? context.substring(0, 200) + '...' : context;
        safeLog(api, 'debug', `[DeepReflect] Context preview: ${contextPreview}`);

        const startTime = Date.now();

        try {
            const extraSystemPrompt = buildCritiquePrompt(model_id, context, actualDepth);

            // 1. Spawning Subagent
            safeLog(api, 'info', `[DeepReflect] Step 1: Spawning critique subagent...`);
            
            const { runId } = await api.runtime.subagent.run({
                sessionKey,
                message: `请基于思维模型 ${model_id} 对以下计划进行批判性分析：\n\n${context}\n\n请严格按照批判引擎的要求输出：盲点、风险、替代方案、建议和置信度。`,
                extraSystemPrompt,
                deliver: false  // 对用户不可见
            });

            safeLog(api, 'info', `[DeepReflect] Step 2: Subagent spawned (runId: ${runId}), waiting for completion...`);

            // 2. Await Completion
            const waitResult = await api.runtime.subagent.waitForRun({ runId, timeoutMs });

            if (waitResult.status === 'timeout') {
                const elapsed = Date.now() - startTime;
                safeLog(api, 'warn', `[DeepReflect] TIMEOUT after ${elapsed}ms`);
                return `⚠️ [Deep Reflection] 分析超时 (${elapsed}ms)\n\n**建议：**\n- 尝试使用 depth=1 进行轻量分析\n- 简化问题描述\n- 检查网络连接`;
            }

            if (waitResult.status === 'error') {
                safeLog(api, 'error', `[DeepReflect] ERROR: ${waitResult.error}`);
                return `❌ [Deep Reflection] 执行失败: ${waitResult.error || 'Unknown error'}\n\n**建议：**\n- 检查 model_id 是否正确 (T-01 到 T-09)\n- 检查 OpenClaw Gateway 日志`;
            }

            // 3. Extract Messages
            safeLog(api, 'info', `[DeepReflect] Step 3: Extracting critique results...`);
            const result = await api.runtime.subagent.getSessionMessages({ sessionKey });

            const reflectionText = (result.assistantTexts || []).join('\n\n');
            const elapsed = Date.now() - startTime;

            // 日志：原始输出
            safeLog(api, 'debug', `[DeepReflect] Raw output length: ${reflectionText.length} chars`);
            
            if (reflectionText.includes('REFLECTION_OK') || reflectionText.trim() === '') {
                safeLog(api, 'info',
                    `╔══════════════════════════════════════════════════════════════╗\n` +
                    `║  [DEEP REFLECTION] PASSED ✓                                   ║\n` +
                    `╠══════════════════════════════════════════════════════════════╣\n` +
                    `║  Model: ${model_id.padEnd(52)}║\n` +
                    `║  Duration: ${(elapsed + 'ms').padEnd(52)}║\n` +
                    `║  Result: No significant issues found                          ║\n` +
                    `╚══════════════════════════════════════════════════════════════╝`
                );
                return `✅ [Deep Reflection ${model_id}] 方案通过审查\n\n**分析耗时:** ${elapsed}ms\n**结果:** 未发现显著问题，可以继续执行。`;
            }

            // 详细日志：完成
            safeLog(api, 'info',
                `╔══════════════════════════════════════════════════════════════╗\n` +
                `║  [DEEP REFLECTION] COMPLETE 🎯                                ║\n` +
                `╠══════════════════════════════════════════════════════════════╣\n` +
                `║  Model: ${model_id.padEnd(52)}║\n` +
                `║  Duration: ${(elapsed + 'ms').padEnd(52)}║\n` +
                `║  Output: ${reflectionText.length} chars                                          ║\n` +
                `╚══════════════════════════════════════════════════════════════╝`
            );

            // 日志：完整输出（用于调试）
            safeLog(api, 'debug', `[DeepReflect] Full critique output:\n${reflectionText}`);

            return `🎯 [Deep Reflection ${model_id}] 批判性分析结果\n\n**分析耗时:** ${elapsed}ms\n**置信度:** 见下方报告\n\n---\n\n${reflectionText}\n\n---\n*这是来自"肩上小人"的批判性反馈。请认真考虑上述建议，但最终决策权在你。*`;
        } catch (err) {
            const elapsed = Date.now() - startTime;
            safeLog(api, 'error',
                `[DeepReflect] EXCEPTION after ${elapsed}ms: ${String(err)}\n` +
                `Stack: ${(err as Error).stack || 'N/A'}`
            );
            throw err;
        } finally {
            // 4. Guaranteed Cleanup
            await api.runtime.subagent.deleteSession({ sessionKey })
                .catch(err => safeLog(api, 'error', `[DeepReflect] Failed to cleanup session: ${String(err)}`));
            
            safeLog(api, 'info', `[DeepReflect] Session cleaned up: ${sessionKey}`);
        }
    }
};
