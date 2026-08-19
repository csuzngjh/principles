
import * as fs from 'fs';
import type { PluginCommandContext, PluginCommandResult } from '../openclaw-sdk.js';
import { normalizeCommandArgs } from '../utils/io.js';
import { resolvePluginCommandWorkspaceDir } from '../utils/workspace-resolver.js';
import { WorkspaceContext } from '../core/workspace-context.js';

function getWorkspaceDir(ctx: PluginCommandContext): string {
    return resolvePluginCommandWorkspaceDir(ctx, 'thinking-os');
}

function handlePropose(wctx: WorkspaceContext, proposal: string): string {
    if (!proposal.trim()) {
        return '❌ Usage: `/pd-thinking propose <description of your proposed mental model>`';
    }

    if (!proposal.toLowerCase().includes('signal') && !proposal.includes('信号')) {
        return '❌ Invalid proposal: A mental model must include a "Signal detection / 信号检测" section explaining how to detect its usage via regex.';
    }

    const candidatesPath = wctx.resolve('THINKING_OS_CANDIDATES');

    if (fs.existsSync(candidatesPath)) {
        try {
            const content = fs.readFileSync(candidatesPath, 'utf8');
            const snippet = proposal.substring(0, 30);
            if (content.includes(snippet)) {
                return '❌ Duplicate proposal detected. A similar candidate already exists.';
            }
        } catch (e) {
            console.debug('[PD] Error reading candidates file:', e);
        }
    }

    const timestamp = new Date().toISOString();
    const entry = `\n### Candidate (${timestamp})\n${proposal.trim()}\n- Status: PENDING\n- Validated in tasks: 0/3\n---\n`;

    try {
        fs.appendFileSync(candidatesPath, entry, 'utf8');
        return `✅ Mental model proposal recorded in \`${candidatesPath.replace(wctx.workspaceDir, '')}\`.\nIt needs validation in ≥3 different task types and human approval before promotion.`;
    } catch (e) {
        return `❌ Failed to write proposal: ${String(e)}`;
    }
}

export function handleThinkingOs(ctx: PluginCommandContext): PluginCommandResult {
    const workspaceDir = getWorkspaceDir(ctx);
    const wctx = WorkspaceContext.fromHookContext({ workspaceDir, ...ctx.config });
    const args = normalizeCommandArgs(ctx.args).trim();
    const subCommand = args.split(/\s+/)[0]?.toLowerCase();
    const rest = args.slice(subCommand?.length || 0).trim();

    switch (subCommand) {
        case 'propose':
            return { text: handlePropose(wctx, rest) };
        case 'status':
        case 'audit':
            // Thinking Activity retirement (2026-08-19): usage statistics and
            // audit relied on THINKING_OS_USAGE.json, whose writer was retired
            // (no product reader remained). Keep the refusal explicit instead
            // of silently returning empty data.
            return {
                text: `ℹ️ \`/pd-thinking ${subCommand}\` was retired: Thinking Model usage telemetry no longer exists. ` +
                    `Thinking OS guidance and \`/pd-thinking propose\` remain available.`,
            };
        default:
            return {
                text:
                    `🧠 **Thinking OS — Governance Console**\n\n` +
                    `Usage:\n` +
                    `- \`/pd-thinking propose <model description>\` — Propose a new mental model`
            }
    }
}
