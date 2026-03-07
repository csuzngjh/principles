import * as fs from 'fs';
import * as path from 'path';
import type { PluginCommandContext, PluginCommandResult } from '../openclaw-sdk.js';

const MODEL_NAMES: Record<string, string> = {
    'T-01': 'Map Before Territory (地图先于领土)',
    'T-02': 'Constraints as Lighthouses (约束即灯塔)',
    'T-03': 'Evidence Over Intuition (证据先于直觉)',
    'T-04': 'Reversibility Governs Speed (可逆性决定速度)',
    'T-05': 'Via Negativa (否定优于肯定)',
    'T-06': "Occam's Razor (奥卡姆剃刀)",
    'T-07': 'Minimum Viable Change (最小必要干预)',
    'T-08': 'Pain as Signal (痛苦即信号)',
    'T-09': 'Divide and Conquer (分而治之)',
};

function getWorkspaceDir(ctx: PluginCommandContext): string {
    return (ctx.config?.workspaceDir as string) || process.cwd();
}

function formatUsageReport(workspaceDir: string): string {
    const logPath = path.join(workspaceDir, 'memory', '.thinking_os_usage.json');
    if (!fs.existsSync(logPath)) {
        return '📊 No usage data yet. The Thinking OS has not been active long enough to collect statistics.';
    }

    try {
        const usage: Record<string, number> = JSON.parse(fs.readFileSync(logPath, 'utf8'));
        const totalTurns = usage['_total_turns'] || 1;

        let report = `# 🧠 Thinking OS — Usage Report\n\n`;
        report += `Total turns tracked: **${totalTurns}**\n\n`;
        report += `| Model | Name | Hits | Rate |\n|---|---|---|---|\n`;

        for (const [id, name] of Object.entries(MODEL_NAMES)) {
            const hits = usage[id] || 0;
            const rate = totalTurns > 0 ? ((hits / totalTurns) * 100).toFixed(1) : '0.0';
            const status = hits === 0 ? '⚠️' : (parseFloat(rate) < 5 ? '🔸' : '✅');
            report += `| ${id} | ${name} | ${hits} | ${status} ${rate}% |\n`;
        }

        // Identify dormant models
        const dormant = Object.entries(MODEL_NAMES)
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

function handlePropose(workspaceDir: string, proposal: string): string {
    if (!proposal.trim()) {
        return '❌ Usage: `/thinking-os propose <description of your proposed mental model>`';
    }

    const candidatesPath = path.join(workspaceDir, 'docs', 'THINKING_OS_CANDIDATES.md');
    const timestamp = new Date().toISOString();
    const entry = `\n### Candidate (${timestamp})\n${proposal.trim()}\n- Status: PENDING\n- Validated in tasks: 0/3\n---\n`;

    try {
        fs.appendFileSync(candidatesPath, entry, 'utf8');
        return `✅ Mental model proposal recorded in \`THINKING_OS_CANDIDATES.md\`.\nIt needs validation in ≥3 different task types and human approval before promotion.`;
    } catch (e) {
        return `❌ Failed to write proposal: ${String(e)}`;
    }
}

function formatAuditReport(workspaceDir: string): string {
    const logPath = path.join(workspaceDir, 'memory', '.thinking_os_usage.json');
    const thinkingOsPath = path.join(workspaceDir, 'docs', 'THINKING_OS.md');

    let report = `# 🔍 Thinking OS — Audit Report\n\n`;

    // Check if Thinking OS exists
    if (!fs.existsSync(thinkingOsPath)) {
        report += `⚠️ **THINKING_OS.md not found.** The cognitive layer is not active.\n`;
        return report;
    }

    const thinkingOs = fs.readFileSync(thinkingOsPath, 'utf8');
    const modelCount = (thinkingOs.match(/### T-\d+/g) || []).length;
    report += `**Active models**: ${modelCount}\n\n`;

    if (!fs.existsSync(logPath)) {
        report += `📊 No usage data collected yet. Run some tasks first.\n`;
        return report;
    }

    const usage: Record<string, number> = JSON.parse(fs.readFileSync(logPath, 'utf8'));
    const totalTurns = usage['_total_turns'] || 1;

    // Identify overused and underused models
    const overused: string[] = [];
    const underused: string[] = [];
    const healthy: string[] = [];

    for (const [id, name] of Object.entries(MODEL_NAMES)) {
        const hits = usage[id] || 0;
        const rate = (hits / totalTurns) * 100;

        if (rate > 50) overused.push(`- ${id} (${name}): ${rate.toFixed(1)}% — possibly too broad a pattern?`);
        else if (hits === 0 && totalTurns > 10) underused.push(`- ${id} (${name}): 0 hits in ${totalTurns} turns — candidate for archival?`);
        else healthy.push(`- ${id} (${name}): ${rate.toFixed(1)}%`);
    }

    if (healthy.length > 0) report += `### ✅ Healthy\n${healthy.join('\n')}\n\n`;
    if (overused.length > 0) report += `### 🔸 Possibly Over-triggered\n${overused.join('\n')}\n\n`;
    if (underused.length > 0) report += `### ⚠️ Candidate for Archival\n${underused.join('\n')}\n\n`;

    // Check candidates pool
    const candidatesPath = path.join(workspaceDir, 'docs', 'THINKING_OS_CANDIDATES.md');
    if (fs.existsSync(candidatesPath)) {
        const candidates = fs.readFileSync(candidatesPath, 'utf8');
        const pendingCount = (candidates.match(/Status: PENDING/g) || []).length;
        if (pendingCount > 0) {
            report += `### 📝 Pending Candidates: ${pendingCount}\nReview \`THINKING_OS_CANDIDATES.md\` for proposed new models.\n`;
        }
    }

    return report;
}

export function handleThinkingOs(ctx: PluginCommandContext): PluginCommandResult {
    const workspaceDir = getWorkspaceDir(ctx);
    const args = (ctx.args || '').trim();
    const subCommand = args.split(/\s+/)[0]?.toLowerCase();
    const rest = args.slice(subCommand?.length || 0).trim();

    switch (subCommand) {
        case 'status':
            return { text: formatUsageReport(workspaceDir) };
        case 'propose':
            return { text: handlePropose(workspaceDir, rest) };
        case 'audit':
            return { text: formatAuditReport(workspaceDir) };
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
