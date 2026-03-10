import type { OpenClawPluginApi } from '../openclaw-sdk.js';
import { Type } from '@sinclair/typebox';
import { randomUUID } from 'node:crypto';
import * as fs from 'fs';
import * as path from 'node:path';
import { EventLogService } from '../core/event-log.js';
import type { DeepReflectionEventData } from '../types/event-types.js';
import { buildCritiquePromptV2 } from './critique-prompt.js';

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
function safeLog(api: OpenClawPluginApi | undefined, level: 'info' | 'debug' | 'warn' | 'error', message: string): void {
    try {
        if (api?.logger && typeof api.logger[level] === 'function') {
            api.logger[level](message);
        }
    } catch {
        // Ignore logging errors
    }
}

/**
 * 从反思输出中提取统计信息
 */
function extractStatsFromOutput(output: string): { 
    confidence?: 'LOW' | 'MEDIUM' | 'HIGH';
    blindSpotsCount: number;
    risksCount: number;
} {
    const result = {
        confidence: undefined as 'LOW' | 'MEDIUM' | 'HIGH' | undefined,
        blindSpotsCount: 0,
        risksCount: 0
    };
    
    // 提取置信度
    const confidenceMatch = output.match(/Confidence.*?(LOW|MEDIUM|HIGH)/i);
    if (confidenceMatch) {
        result.confidence = confidenceMatch[1].toUpperCase() as 'LOW' | 'MEDIUM' | 'HIGH';
    }
    
    // 统计盲点数量（bullet points under 🎯 Blind Spots）
    const blindSpotsMatch = output.match(/🎯\s*Blind Spots[\s\S]*?(?=###|---|$)/i);
    if (blindSpotsMatch) {
        const bullets = blindSpotsMatch[0].match(/^- /gm);
        result.blindSpotsCount = bullets ? bullets.length : 0;
    }
    
    // 统计风险数量
    const risksMatch = output.match(/⚠️\s*Risk Warnings[\s\S]*?(?=###|---|$)/i);
    if (risksMatch) {
        const bullets = risksMatch[0].match(/^- /gm);
        result.risksCount = bullets ? bullets.length : 0;
    }
    
    return result;
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

export const deepReflectTool = {
    name: "deep_reflect",
    description: `Cognitive Analysis Tool — Performs critical analysis before executing complex tasks to identify blind spots, risks, and alternatives.

## PURPOSE
Invokes an independent reasoning process to analyze your intended actions. Use this to think deeply BEFORE acting on complex or ambiguous tasks.

## WHEN TO CALL
Call this tool when:
- Task is complex or multi-step (planning, design, analysis, decision-making)
- Information is incomplete or requirements are ambiguous
- Stakes are high (important decisions, irreversible actions, significant impact)
- You are uncertain about the best approach
- You need to consider multiple perspectives

## EXAMPLES OF USE
- Planning a marketing strategy or campaign
- Designing a product feature or user experience
- Making architectural or design decisions
- Analyzing a problem before proposing solutions
- Evaluating trade-offs between multiple options

## BENEFITS
- Identifies blind spots and missing information
- Surfaces potential risks and failure modes
- Proposes alternative approaches with trade-off analysis
- Applies structured thinking models for deeper insight
- Can use domain-specific models (marketing, strategy, etc.)

## HOW IT WORKS
The sub-agent will:
1. Analyze your task context
2. Select appropriate thinking models (meta-cognitive or domain-specific)
3. Apply rigorous analysis
4. Return structured critical feedback

## WHEN NOT TO CALL
- Simple, straightforward tasks with clear outcomes
- User explicitly requests immediate action
- Task is trivial or routine`,
    parameters: Type.Object({
        model_id: Type.Optional(Type.String({
            description: "[DEPRECATED] Thinking model ID. The sub-agent will now select models automatically. This parameter is kept for backward compatibility."
        })),
        context: Type.String({
            description: "Describe your plan, what you're about to do, and any concerns. Include relevant context and constraints."
        }),
        depth: Type.Optional(Type.Number({
            description: "Reflection depth: 1=quick, 2=balanced (default), 3=exhaustive"
        }))
    }),
    handler: async (
        params: { model_id?: string; context: string; depth?: number },
        api: OpenClawPluginApi,
        workspaceDir?: string
    ): Promise<string> => {
        const { model_id, context, depth } = params;
        
        // 向后兼容警告
        const modelSelectionMode = model_id ? 'manual' : 'auto';
        if (model_id) {
            safeLog(api, 'warn', '[DeepReflect] model_id parameter is deprecated. The sub-agent will select models automatically.');
        }
        
        // 加载配置
        const config = loadConfig(workspaceDir, api);
        
        // 配置迁移警告
        if (config.default_model) {
            safeLog(api, 'warn', '[DeepReflect] default_model in config is deprecated. Sub-agent will now select models automatically.');
        }
        
        // 检查是否启用
        if (!config.enabled || config.mode === 'disabled') {
            safeLog(api, 'info', '[DeepReflect] Feature is disabled in config');
            return `⏭️ Deep Reflection 已禁用。如需启用，请在 pain_settings.json 中设置 deep_reflection.enabled = true`;
        }

        const actualDepth = depth ?? config.default_depth ?? 2;
        const timeoutMs = config.timeout_ms ?? 60000;
        const agentId = 'main';
        const sessionKey = `agent:${agentId}:reflection:${randomUUID()}`;
        const sessionId = sessionKey.split(':').pop(); // Extract UUID as sessionId

        // 初始化事件日志
        const stateDir = workspaceDir ? path.join(workspaceDir, 'memory', '.state') : undefined;
        const eventLog = stateDir ? EventLogService.get(stateDir, api.logger) : null;

        // 用于日志显示的模型标识
        const modelIdForLog = model_id || 'auto-select';

        // 详细日志：开始
        safeLog(api, 'info', 
            `\n` +
            `╔══════════════════════════════════════════════════════════════╗\n` +
            `║  [DEEP REFLECTION] STARTING                                   ║\n` +
            `╠══════════════════════════════════════════════════════════════╣\n` +
            `║  Model: ${modelIdForLog.padEnd(52)}║\n` +
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
        let eventData: DeepReflectionEventData = {
            modelId: model_id || 'auto-select',
            modelSelectionMode,
            depth: actualDepth,
            contextPreview,
            durationMs: 0,
            passed: false,
            timeout: false,
        };

        try {
            // 使用新的提示词构建函数（同步）
            const extraSystemPrompt = buildCritiquePromptV2({
                context,
                workspaceDir,
                depth: actualDepth,
                api,
            });

            // 1. Spawning Subagent
            safeLog(api, 'info', `[DeepReflect] Step 1: Spawning critique subagent...`);
            
            const { runId } = await api.runtime.subagent.run({
                sessionKey,
                message: `Please perform a critical analysis of the following plan:

${context}

Follow the Critical Analysis Engine output structure: Blind Spots, Risk Warnings, Alternative Approaches, Recommendations, and Confidence Level.`,
                extraSystemPrompt,
                deliver: false  // 对用户不可见
            });

            safeLog(api, 'info', `[DeepReflect] Step 2: Subagent spawned (runId: ${runId}), waiting for completion...`);

            // 2. Await Completion
            const waitResult = await api.runtime.subagent.waitForRun({ runId, timeoutMs });

            if (waitResult.status === 'timeout') {
                const elapsed = Date.now() - startTime;
                eventData.durationMs = elapsed;
                eventData.timeout = true;
                
                // 记录事件日志
                eventLog?.recordDeepReflection(sessionId, eventData);
                eventLog?.flush();
                
                safeLog(api, 'warn', `[DeepReflect] TIMEOUT after ${elapsed}ms`);
                return `⚠️ [Deep Reflection] 分析超时 (${elapsed}ms)

**建议：**
- 尝试使用 depth=1 进行轻量分析
- 简化问题描述
- 检查网络连接`;
            }

            if (waitResult.status === 'error') {
                const elapsed = Date.now() - startTime;
                eventData.durationMs = elapsed;
                eventData.error = waitResult.error || 'Unknown error';
                
                // 记录事件日志
                eventLog?.recordDeepReflection(sessionId, eventData);
                eventLog?.flush();
                
                safeLog(api, 'error', `[DeepReflect] ERROR: ${waitResult.error}`);
                return `❌ [Deep Reflection] 执行失败: ${waitResult.error || 'Unknown error'}

**建议：**
- 检查 OpenClaw Gateway 日志`;
            }

            // 3. Extract Messages
            safeLog(api, 'info', `[DeepReflect] Step 3: Extracting critique results...`);
            const result = await api.runtime.subagent.getSessionMessages({ sessionKey });

            const reflectionText = (result.assistantTexts || []).join('\n\n');
            const elapsed = Date.now() - startTime;

            // 日志：原始输出
            safeLog(api, 'debug', `[DeepReflect] Raw output length: ${reflectionText.length} chars`);
            
            // 提取统计信息
            const stats = extractStatsFromOutput(reflectionText);
            
            // 更新事件数据
            eventData.durationMs = elapsed;
            eventData.outputLength = reflectionText.length;
            eventData.confidence = stats.confidence;
            eventData.blindSpotsCount = stats.blindSpotsCount;
            eventData.risksCount = stats.risksCount;
            
            if (reflectionText.includes('REFLECTION_OK') || reflectionText.trim() === '') {
                eventData.passed = true;
                
                // 记录事件日志
                eventLog?.recordDeepReflection(sessionId, eventData);
                eventLog?.flush();
                
                safeLog(api, 'info',
                    `╔══════════════════════════════════════════════════════════════╗\n` +
                    `║  [DEEP REFLECTION] PASSED ✓                                   ║\n` +
                    `╠══════════════════════════════════════════════════════════════╣\n` +
                    `║  Model: ${modelIdForLog.padEnd(52)}║\n` +
                    `║  Duration: ${(elapsed + 'ms').padEnd(52)}║\n` +
                    `║  Result: No significant issues found                          ║\n` +
                    `╚══════════════════════════════════════════════════════════════╝`
                );
                return `✅ [Deep Reflection] 方案通过审查

**分析耗时:** ${elapsed}ms
**结果:** 未发现显著问题，可以继续执行。`;
            }

            // 更新事件数据（发现问题）
            eventData.resultPreview = reflectionText.length > 200 ? reflectionText.substring(0, 200) + '...' : reflectionText;
            
            // 记录事件日志
            eventLog?.recordDeepReflection(sessionId, eventData);
            eventLog?.flush();

            // 详细日志：完成
            safeLog(api, 'info',
                `╔══════════════════════════════════════════════════════════════╗\n` +
                `║  [DEEP REFLECTION] COMPLETE 🎯                                ║\n` +
                `╠══════════════════════════════════════════════════════════════╣\n` +
                `║  Model: ${modelIdForLog.padEnd(52)}║\n` +
                `║  Duration: ${(elapsed + 'ms').padEnd(52)}║\n` +
                `║  Output: ${reflectionText.length} chars                                          ║\n` +
                `║  Blind Spots: ${String(stats.blindSpotsCount).padEnd(46)}║\n` +
                `║  Risks: ${String(stats.risksCount).padEnd(54)}║\n` +
                `║  Confidence: ${(stats.confidence || 'N/A').padEnd(50)}║\n` +
                `╚══════════════════════════════════════════════════════════════╝`
            );

            // 日志：完整输出（用于调试）
            safeLog(api, 'debug', `[DeepReflect] Full critique output:\n${reflectionText}`);

            return `🎯 [Deep Reflection] 批判性分析结果

**分析耗时:** ${elapsed}ms
**置信度:** ${stats.confidence || 'N/A'}
**盲点:** ${stats.blindSpotsCount} | **风险:** ${stats.risksCount}

---

${reflectionText}

---
*这是来自"肩上小人"的批判性反馈。请认真考虑上述建议，但最终决策权在你。*`;
        } catch (err) {
            const elapsed = Date.now() - startTime;
            eventData.durationMs = elapsed;
            eventData.error = String(err);
            
            // 记录事件日志
            eventLog?.recordDeepReflection(sessionId, eventData);
            eventLog?.flush();
            
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
