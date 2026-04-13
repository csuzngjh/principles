import type { OpenClawPluginApi } from '../openclaw-sdk.js';
import { Type } from '@sinclair/typebox';
import { buildPainFlag, writePainFlag } from '../core/pain.js';
import { resolveWorkspaceDirFromApi } from '../core/path-resolver.js';

/**
 * Creates the `write_pain_flag` tool.
 *
 * This tool allows the agent to record a pain signal when it recognizes
 * that it made a mistake, violated a principle, or needs to flag an issue
 * for later reflection.
 *
 * Usage (agent-side):
 *   write_pain_flag({ reason: "I forgot to check the file before editing", score: 70 })
 *
 * The tool wraps `buildPainFlag` + `writePainFlag` to ensure correct KV format
 * serialization — the agent never writes to .pain_flag directly.
 */
export function createWritePainFlagTool(api: OpenClawPluginApi) {
    return {
        name: 'write_pain_flag',
        description: '记录一个痛苦信号，标记智能体犯了错误、违反了原则或需要后续反思的问题。不要直接写 .pain_flag 文件，使用此工具代替。',
        parameters: Type.Object({
            reason: Type.String({ description: '痛苦的原因，描述具体发生了什么错误或不满足原则的地方。' }),
            score: Type.Optional(Type.Number({
                description: '痛苦分数 (0-100)。默认 80。建议值：30-50 轻微问题，50-70 中等错误，70-100 严重违反原则。',
                minimum: 0,
                maximum: 100,
            })),
            source: Type.Optional(Type.String({
                description: '痛苦来源。可选值: tool_failure(工具失败), user_empathy(用户不满), manual(手动标记), principle_violation(违反原则)。',
            })),
            is_risky: Type.Optional(Type.Boolean({
                description: '是否是高风险操作（如写入敏感文件）。默认 false。',
            })),
        }),

        async execute(
            _toolCallId: string,
            rawParams: Record<string, unknown>
        ): Promise<{ content: { type: string; text: string }[] }> {
            const reason = typeof rawParams.reason === 'string' ? rawParams.reason.trim() : '';
            const score = typeof rawParams.score === 'number' ? Math.max(0, Math.min(100, rawParams.score)) : 80;
            const source = typeof rawParams.source === 'string' ? rawParams.source : 'manual';
            const isRisky = rawParams.is_risky === true;

            if (!reason) {
                return { content: [{ type: 'text', text: '❌ 错误: 必须提供 reason 参数，描述痛苦的原因。' }] };
            }

            try {
                const workspaceDir = resolveWorkspaceDirFromApi(api);
                if (!workspaceDir) {
                    return { content: [{ type: 'text', text: '❌ 错误: 无法确定工作目录。' }] };
                }

                const painData = buildPainFlag({
                    source,
                    score: String(score),
                    reason,
                    is_risky: isRisky,
                });

                writePainFlag(workspaceDir, painData);

                return {
                    content: [{
                        type: 'text',
                        text: `✅ 痛苦信号已记录。\n- 原因: ${reason}\n- 分数: ${score}\n- 来源: ${source}\n- 风险: ${isRisky ? '是' : '否'}\n\n进化系统将在下一个心跳周期处理此信号。`,
                    }],
                };
            } catch (err) {
                api.logger?.error?.(`[PD:write_pain_flag] Failed to write pain flag: ${String(err)}`);
                return { content: [{ type: 'text', text: `❌ 记录痛苦信号失败: ${String(err)}` }] };
            }
        },
    };
}
