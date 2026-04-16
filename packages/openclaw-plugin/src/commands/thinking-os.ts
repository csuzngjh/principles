/* eslint-disable no-console */
import * as fs from 'fs';
import type { PluginCommandContext, PluginCommandResult } from '../openclaw-sdk.js';
import { WorkspaceContext } from '../core/workspace-context.js';

function getWorkspaceDir(ctx: PluginCommandContext): string {
    return (ctx.config?.workspaceDir as string) || process.cwd();
}

function getModels(wctx: WorkspaceContext): Record<string, string> {
    const modelsPath = wctx.resolve('THINKING_OS');
    const models: Record<string, string> = {};
    if (!fs.existsSync(modelsPath)) return models;

    try {
        const content = fs.readFileSync(modelsPath, 'utf8');
        const lines = content.split('\n');
        for (const line of lines) {
            const match = /^###\s*(T-\d+):\s*(.*)/.exec(line);
            if (match) {
                models[match[1]] = match[2].trim();
            }
        }
    } catch (e) {
        console.debug('[PD] Failed to read THINKING_OS.md:', e);
    }
    return models;
}

function formatUsageReport(wctx: WorkspaceContext): string {
    const logPath = wctx.resolve('THINKING_OS_USAGE');

    if (!fs.existsSync(logPath)) {
        return '📊 No usage data yet. The Thinking OS has not been active long enough to collect statistics.';
    }

    try {
        const usage: Record<string, number> = JSON.parse(fs.readFileSync(logPath, 'utf8'));
        const totalTurns = usage._total_turns || 1;
        const models = getModels(wctx);

        let report = `# 🧠 Thinking OS — Usage Report\n\n`;
        report += `Total turns tracked: **${totalTurns}**\n\n`;
        report += `| Model | Name | Hits | Rate |\n|---|---|---|---|\n`;

        for (const [id, name] of Object.entries(models)) {
            const hits = usage[id] || 0;
            const rate = totalTurns > 0 ? ((hits / totalTurns) * 100).toFixed(1) : '0.0';
            const status = hits === 0 ? '⚠️' : (parseFloat(rate) < 5 ? '🔸' : '✅');
            report += `| ${id} | ${name} | ${hits} | ${status} ${rate}% |\n`;
        }

        const dormant = Object.entries(models)
            .filter(([id]) => (usage[id] || 0) === 0)
            .map(([id, name]) => `- ${id}: ${name}`);

        if (dormant.length > 0) {
            report += `\n### ⚠️ Dormant Models (0 hits)\n${dormant.join('\n')}\n`;
            report += `\nConsider: Are these models not applicable to current tasks, or is the agent ignoring them?\n`;
        }

        return report;
    } catch (e) {
        return `❌ Failed to read usage data: ${String(e)}`;
    }
}

function handlePropose(wctx: WorkspaceContext, proposal: string): string {
    if (!proposal.trim()) {
        return '❌ Usage: `/thinking-os propose <description of your proposed mental model>`';
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

function formatAuditReport(wctx: WorkspaceContext): string {
    const logPath = wctx.resolve('THINKING_OS_USAGE');
    const thinkingOsPath = wctx.resolve('THINKING_OS');

    let report = `# 🔍 Thinking OS — Audit Report\n\n`;

    if (!fs.existsSync(thinkingOsPath)) {
        report += `⚠️ **THINKING_OS.md not found.** The cognitive layer is not active.\n`;
        return report;
    }

    const models = getModels(wctx);
    const modelCount = Object.keys(models).length;
    report += `**Active models**: ${modelCount}\n\n`;

    if (!fs.existsSync(logPath)) {
        report += `📊 No usage data collected yet. Run some tasks first.\n`;
        return report;
    }

    try {
        const usage: Record<string, number> = JSON.parse(fs.readFileSync(logPath, 'utf8'));
        const totalTurns = usage._total_turns || 1;

        const overused: string[] = [];
        const underused: string[] = [];
        const healthy: string[] = [];

        for (const [id, name] of Object.entries(models)) {
            const hits = usage[id] || 0;
            const rate = (hits / totalTurns) * 100;

            if (rate > 50) overused.push(`- ${id} (${name}): ${rate.toFixed(1)}% — possibly too broad a pattern?`);
            else if (hits === 0 && totalTurns > 10) underused.push(`- ${id} (${name}): 0 hits in ${totalTurns} turns — candidate for archival?`);
            else healthy.push(`- ${id} (${name}): ${rate.toFixed(1)}%`);
        }

        if (healthy.length > 0) report += `### ✅ Healthy\n${healthy.join('\n')}\n\n`;
        if (overused.length > 0) report += `### 🔸 Possibly Over-triggered\n${overused.join('\n')}\n\n`;
        if (underused.length > 0) {
            report += `### ⚠️ Candidate for Archival\n${underused.join('\n')}\n`;
            report += `> 💡 Suggestion: Review these models. If they are obsolete, move them to the archive.\n\n`;
        }

        const candidatesPath = wctx.resolve('THINKING_OS_CANDIDATES');
        if (fs.existsSync(candidatesPath)) {
            const candidates = fs.readFileSync(candidatesPath, 'utf8');
            const pendingCount = (candidates.match(/Status: PENDING/g) || []).length;
            if (pendingCount > 0) {
                report += `### 📝 Pending Candidates: ${pendingCount}\nReview candidates to fill gaps.\n`;
            }
        }

        return report;
    } catch (e) {
        return `❌ Failed to generate audit report: ${String(e)}`;
    }
}

export function handleThinkingOs(ctx: PluginCommandContext): PluginCommandResult {
    const workspaceDir = getWorkspaceDir(ctx);
    const wctx = WorkspaceContext.fromHookContext({ workspaceDir, ...ctx.config });
    const args = (ctx.args || '').trim();
    const subCommand = args.split(/\s+/)[0]?.toLowerCase();
    const rest = args.slice(subCommand?.length || 0).trim();

    switch (subCommand) {
        case 'status':
            return { text: formatUsageReport(wctx) };
        case 'propose':
            return { text: handlePropose(wctx, rest) };
        case 'audit':
            return { text: formatAuditReport(wctx) };
        default:
            return {
                text:
                    `🧠 **Thinking OS — Governance Console**\n\n` +
                    `Usage:\n` +
                    `- \`/thinking-os status\` — View mental model usage statistics\n` +
                    `- \`/thinking-os propose <model description>\` — Propose a new mental model\n` +
                    `- \`/thinking-os audit\` — Audit model health and candidates`
            };
    }
}
