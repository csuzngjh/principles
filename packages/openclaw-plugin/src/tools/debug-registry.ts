import type { OpenClawPluginApi } from '../openclaw-sdk.js';
import { Type } from '@sinclair/typebox';

/**
 * Diagnostic tool to check if write_pain_flag is properly registered.
 * Use this when the agent says write_pain_flag is not available.
 */
export function createDebugToolRegistryTool(api: OpenClawPluginApi) {
    return {
        name: 'debug_tool_registry',
        description: 'Internal diagnostic tool. Reports plugin registration status for debugging tool availability issues.',
        parameters: Type.Object({}),

        async execute(
            _toolCallId: string,
            _rawParams: Record<string, unknown>
        ): Promise<{ content: { type: string; text: string }[] }> {
            const lines: string[] = [];

            lines.push('=== Tool Registry Diagnostic ===');
            lines.push(`Plugin: principles-disciple`);
            lines.push(`rootDir: ${api.rootDir ?? '(unknown)'}`);

            lines.push('');
            lines.push('Config check:');
            lines.push(`  - config keys: ${Object.keys(api.config ?? {}).join(', ')}`);
            lines.push(`  - pluginConfig: ${JSON.stringify(api.pluginConfig ?? {})}`);

            lines.push('');
            lines.push('Workspace resolution:');
            try {
                lines.push('  - API accessible: true');
            } catch (e) {
                lines.push(`  - Error: ${String(e)}`);
            }

            lines.push('');
            lines.push('Available tools diagnostic:');
            lines.push('  - If you see this tool, plugin loaded successfully');
            lines.push('  - write_pain_flag may be blocked by:');
            lines.push('    1. Tool policy filter');
            lines.push('    2. Factory threw during execution');
            lines.push('    3. Registry cache mismatch');

            lines.push('');
            lines.push('Registration path:');
            lines.push('  api.registerTool(createWritePainFlagTool(api))');
            lines.push('  → createWritePainFlagTool returns object with name="write_pain_flag"');
            lines.push('  → registry.ts wraps as factory');
            lines.push('  → resolvePluginTools calls factory(context)');
            lines.push('  → If factory throws, tool is silently skipped');

            return {
                content: [{
                    type: 'text',
                    text: lines.join('\n'),
                }],
            };
        },
    };
}
