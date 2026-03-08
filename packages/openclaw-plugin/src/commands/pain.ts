import { DictionaryService } from '../core/dictionary-service.js';
import { getSession, resetFriction } from '../core/session-tracker.js';
import type { PluginCommandContext, PluginCommandResult } from '../openclaw-sdk.js';
import * as path from 'path';

/**
 * Handles the /pain status or /pain reset command to report or manage the current state of the Digital Nerve System.
 */
export function handlePainCommand(ctx: PluginCommandContext): PluginCommandResult {
    const workspaceDir = (ctx.config?.workspaceDir as string) || process.cwd();
    const stateDir = (ctx.config?.stateDir as string) || path.join(workspaceDir, 'memory', '.state');
    const args = (ctx.args || '').trim();
    const sessionId = (ctx as any).sessionId;

    if (args === 'reset') {
        if (sessionId) {
            resetFriction(sessionId);
            return { text: `✅ GFI for current session reset to 0.` };
        }
        return { text: `⚠️ No active session to reset.` };
    }
    
    const dictionary = DictionaryService.get(stateDir);
    const session = sessionId ? getSession(sessionId) : undefined;
    
    let report = `# 🦷 Principles Disciple — Digital Nerve System Status\n\n`;
    
    // 1. GFI Status (Track A)
    report += `### Track A: 经验摩擦指数 (Empirical Friction - GFI)\n`;
    report += `*监测工具调用的报错频率与重复度。得分越高，系统越倾向于启动自动进化。*\n\n`;
    if (session) {
        const gfi = session.currentGfi || 0;
        const status = gfi >= 80 ? '🔴 (危急)' : (gfi >= 40 ? '🟡 (警告)' : '🟢 (正常)');
        report += `- **当前 GFI 阻力**: ${status} **${gfi.toFixed(1)}** / 100\n`;
        report += `- **连续错误计数**: ${session.consecutiveErrors}\n`;
        report += `- **认知停滞循环**: ${session.stuckLoops || 0} 次 (输入过高/输出过低)\n\n`;
        
        if (gfi >= 40) {
            report += `> 💡 **建议**: 当前阻力较大，您可以输入 \`/evolve-task\` 尝试让系统自愈。\n\n`;
        }
    } else {
        report += `*当前会话暂无活跃数据。*\n\n`;
    }
    
    // 2. Dictionary Stats (Track B)
    report += `### Track B: 语义痛觉字典 (Semantic Pain Dictionary)\n`;
    report += `*监测 AI 的“心声”与“用户情绪”。一旦命中规则，将产生语义阻力。*\n\n`;
    const rules = dictionary.getAllRules();
    
    if (Object.keys(rules).length === 0) {
        report += `*字典中暂无规则。*\n`;
    } else {
        report += `| 规则 ID | 痛感权重 | 命中次数 | 当前状态 |\n|---|---|---|---|\n`;
        for (const [id, rule] of Object.entries(rules)) {
            const statusIcon = rule.status === 'active' ? '✅ 运行中' : '💤 休眠';
            const translatedId = translateRuleId(id);
            report += `| ${translatedId} | ${rule.severity} | ${rule.hits} | ${statusIcon} |\n`;
        }
    }
    
    return { text: report };
}

/**
 * Translates technical Rule IDs to human-readable labels.
 */
function translateRuleId(id: string): string {
    const map: Record<string, string> = {
        'P_CONFUSION_ZH': '认知困惑 (中)',
        'P_CONFUSION_EN': 'Cognitive Confusion (En)',
        'P_LOOP_ZH': '死亡螺旋 (中)',
        'P_LOOP_EN': 'Infinite Loop (En)',
    };
    if (id.startsWith('P_PROMOTED_')) {
        return `✨ 晋升规则 (${id.substring(11, 17)})`;
    }
    return map[id] || id;
}
