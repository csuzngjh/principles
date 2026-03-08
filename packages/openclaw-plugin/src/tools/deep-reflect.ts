import type { OpenClawPluginApi } from '../openclaw-sdk.js';
import { Type } from '@sinclair/typebox';
import { randomUUID } from 'node:crypto';

function buildCritiquePrompt(modelId: string, context: string, depth: number = 2): string {
    return `You are a Critique Engine — a cognitive reflection assistant.

## Your Role
You provide critical analysis and alternative perspectives. You do NOT:
- Write code or produce final deliverables
- Complete the user's task directly
- Make decisions for the main agent

## Active Cognitive Model
Model ID: ${modelId}
Please apply the principles of this model rigidly.

## Your Task
Based on the provided ${depth > 1 ? 'deep ' : ''}thinking model, analyze the context:
${context}

Provide:
1. Potential blind spots
2. Alternative approaches
3. Risk warnings
4. Recommendations (not decisions)

## Output Format
- Be concise and actionable
- Use bullet points for clarity
- End with a confidence level (low/medium/high)`;
}

export const deepReflectTool = {
    name: "deep_reflect",
    description: "Trigger a cognitive subagent utilizing a specific thinking model to critique the current path, point out blindspots, and offer alternative perspectives.",
    parameters: Type.Object({
        model_id: Type.String({
            description: "The thinking model ID to activate (e.g., 'T-01', 'T-02'). Maps to the THINKING_OS directory."
        }),
        context: Type.String({
            description: "The context and problem statement to be critiqued by the cognitive subagent."
        }),
        depth: Type.Optional(Type.Number({
            description: "Optional depth of reflection (1-3). Defaults to 2."
        }))
    }),
    handler: async (
        params: { model_id: string; context: string; depth?: number },
        api: OpenClawPluginApi
    ): Promise<string> => {
        const { model_id, context, depth = 2 } = params;
        const agentId = 'main';
        const sessionKey = `agent:${agentId}:reflection:${randomUUID()}`;

        try {
            api.logger.info(`[PD] Spawning Critique Engine (Model: ${model_id}) with Session: ${sessionKey}`);

            const extraSystemPrompt = buildCritiquePrompt(model_id, context, depth);

            // 1. Spawning Subagent (Deliver = false meaning invisible to user)
            const { runId } = await api.runtime.subagent.run({
                sessionKey,
                message: `请基于思维模型 ${model_id} 进行深度反思分析。深度级别: ${depth}`,
                extraSystemPrompt,
                deliver: false
            });

            // 2. Await Completion (60s Timeout)
            const waitResult = await api.runtime.subagent.waitForRun({ runId, timeoutMs: 60000 });

            if (waitResult.status === 'timeout') {
                return `⚠️ 反思超时，建议稍后重试或简化问题。\n提示：尝试使用 depth=1 进行轻量分析`;
            }

            if (waitResult.status === 'error') {
                return `❌ 反思工具执行失败: ${waitResult.error || 'Unknown error'}\n建议：检查 model_id 是否正确`;
            }

            // 3. Extract Messages
            const result = await api.runtime.subagent.getSessionMessages({ sessionKey });

            const reflectionText = (result.assistantTexts || []).join('\n\n');
            if (reflectionText.includes('REFLECTION_OK') || reflectionText.trim() === '') {
                return `✅ 当前方案通过反思检查 [${model_id}]，未发现显著问题`;
            }

            return `Critique Engine [${model_id}] Feedback:\n\n${reflectionText}`;
        } catch (err) {
            api.logger.error(`[PD] Critique Engine error: ${String(err)}`);
            throw err;
        } finally {
            // 4. Guaranteed Cleanup
            await api.runtime.subagent.deleteSession({ sessionKey })
                .catch(err => api.logger.error(`[PD] Failed to delete critique session ${sessionKey}: ${String(err)}`));
        }
    }
};
