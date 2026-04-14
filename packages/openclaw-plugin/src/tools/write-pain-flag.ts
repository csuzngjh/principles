import type { OpenClawPluginApi } from '../openclaw-sdk.js';
import { Type } from '@sinclair/typebox';
// eslint-disable-next-line @typescript-eslint/no-unused-vars
import { buildPainFlag, writePainFlag } from '../core/pain.js';
import { resolveWorkspaceDirFromApi } from '../core/path-resolver.js';
import * as fs from 'fs';
import * as path from 'path';

// Pain flag contract required fields
const PAIN_FLAG_REQUIRED_FIELDS = ['source', 'score', 'time', 'reason'] as const;

/**
 * Atomic file write: write to temp file then rename.
 * Prevents corruption if process crashes mid-write.
 */
function writePainFlagAtomic(filePath: string, content: string): void {
    const dir = path.dirname(filePath);
    if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
    }
    const tmpPath = `${filePath}.tmp.${Date.now()}.${process.pid}`;
    fs.writeFileSync(tmpPath, content, 'utf-8');
    fs.renameSync(tmpPath, filePath);
}

/**
 * Creates the `write_pain_flag` tool.
 *
 * This tool allows the agent to record a pain signal when it recognizes
 * that it made a mistake, violated a principle, or needs to flag an issue
 * for later reflection.
 *
 * The tool wraps `buildPainFlag` + atomic `writePainFlag` to ensure:
 * - Correct KV format serialization (never [object Object] corruption)
 * - Atomic writes (temp file + rename, crash-safe)
 * - Full contract compliance (source, score, time, reason)
 *
 * The agent should NEVER write to .pain_flag directly.
 */
export function createWritePainFlagTool(api: OpenClawPluginApi) {
    return {
        name: 'write_pain_flag',
        description:
            'Record a pain signal to flag mistakes, principle violations, or issues for later reflection. ' +
            'Use this tool INSTEAD of writing .pain_flag directly. ' +
            'Pain signals are processed by the evolution system on the next heartbeat cycle.',
        parameters: Type.Object({
            reason: Type.String({
                description:
                    'Describe specifically what went wrong. ' +
                    'Include the error, the violated principle, or the issue. ' +
                    'Be concrete: "I edited config.ts without reading it first, breaking the export" ' +
                    'is better than "I made a mistake".',
            }),
            score: Type.Optional(Type.Number({
                description:
                    'Pain severity score (0-100). Default: 80. ' +
                    'Guidelines: 30-50 (minor issue), 50-70 (moderate error), ' +
                    '70-100 (severe principle violation or data loss risk).',
                minimum: 0,
                maximum: 100,
            })),
            source: Type.Optional(Type.String({
                description:
                    'Source of the pain signal. ' +
                    'Values: manual (user flagged), tool_failure (tool error), ' +
                    'user_empathy (user frustration), principle_violation (principle broken), ' +
                    'human_intervention (user manually intervened). ' +
                    'Default: manual.',
            })),
            session_id: Type.Optional(Type.String({
                description:
                    'Session ID where the pain occurred. ' +
                    'If not provided, the system will use the current session.',
            })),
            is_risky: Type.Optional(Type.Boolean({
                description:
                    'Whether this involves a high-risk operation (e.g., writing to sensitive files). ' +
                    'Default: false.',
            })),
        }),

        async execute(
            _toolCallId: string,
            rawParams: Record<string, unknown>
        ): Promise<{ content: { type: string; text: string }[] }> {
            const reason = typeof rawParams.reason === 'string' ? rawParams.reason.trim() : '';
            const score = typeof rawParams.score === 'number' ? Math.max(0, Math.min(100, Math.round(rawParams.score))) : 80;
            const source = typeof rawParams.source === 'string' && rawParams.source.trim() ? rawParams.source.trim() : 'manual';
            const sessionId = typeof rawParams.session_id === 'string' ? rawParams.session_id.trim() : '';
            const isRisky = rawParams.is_risky === true;

            // ── Validate required fields ──
            if (!reason) {
                api.logger?.warn?.('[PD:write_pain_flag] Missing required field: reason');
                return {
                    content: [{
                        type: 'text',
                        text: '❌ Error: The `reason` parameter is required.\n' +
                            'Describe specifically what went wrong. Example:\n' +
                            '"I edited config.ts without reading it first, breaking the export"',
                    }],
                };
            }

            // ── Resolve workspace ──
            const workspaceDir = resolveWorkspaceDirFromApi(api);
            if (!workspaceDir) {
                api.logger?.error?.('[PD:write_pain_flag] Cannot resolve workspace directory');
                return {
                    content: [{
                        type: 'text',
                        text: '❌ Error: Cannot determine the workspace directory. ' +
                            'Please ensure you are in an active workspace.',
                    }],
                };
            }

            try {
                // ── Build pain flag data (KV format) ──
                const painData = buildPainFlag({
                    source,
                    score: String(score),
                    reason,
                    session_id: sessionId,
                    is_risky: isRisky,
                });

                // ── Validate contract compliance ──
                const missingFields: string[] = [];
                for (const field of PAIN_FLAG_REQUIRED_FIELDS) {
                    if (!painData[field] || painData[field].trim() === '') {
                        missingFields.push(field);
                    }
                }
                if (missingFields.length > 0) {
                    api.logger?.error?.(`[PD:write_pain_flag] Pain flag missing required fields: ${missingFields.join(', ')}`);
                    return {
                        content: [{
                            type: 'text',
                            text: `❌ Error: Pain flag is missing required fields: ${missingFields.join(', ')}. ` +
                                'This is an internal error — please report it.',
                        }],
                    };
                }

                // ── Atomic write (temp file + rename) ──
                const painFlagPath = path.join(workspaceDir, '.state', '.pain_flag');
                const { serializeKvLines } = await import('../utils/io.js');
                const content = serializeKvLines(painData);
                writePainFlagAtomic(painFlagPath, content);

                // ── Log success ──
                api.logger?.info?.(
                    `[PD:write_pain_flag] Pain signal recorded: source=${source}, score=${score}, ` +
                    `reason="${reason.slice(0, 80)}"${reason.length > 80 ? '...' : ''}"`
                );

                // ── Agent feedback ──
                return {
                    content: [{
                        type: 'text',
                        text: `✅ Pain signal recorded successfully.\n\n` +
                            `- **Reason**: ${reason}\n` +
                            `- **Score**: ${score}/100\n` +
                            `- **Source**: ${source}\n` +
                            `- **Risk**: ${isRisky ? 'Yes' : 'No'}\n` +
                            `- **Session**: ${sessionId || '(current)'}\n\n` +
                            `The evolution system will process this signal on the next heartbeat cycle ` +
                            `(typically within 60 seconds).`,
                    }],
                };
            } catch (err) {
                // ── Log failure with stack trace ──
                const errorMsg = err instanceof Error ? err.message : String(err);
                const stack = err instanceof Error ? err.stack?.split('\n').slice(0, 3).join(' → ') : '';
                api.logger?.error?.(
                    `[PD:write_pain_flag] Failed to write pain flag: ${errorMsg}` +
                    (stack ? `\n  Stack: ${stack}` : '')
                );

                return {
                    content: [{
                        type: 'text',
                        text: `❌ Failed to record pain signal: ${errorMsg}\n\n` +
                            'The error has been logged. Please try again or report this issue.',
                    }],
                };
            }
        },
    };
}
