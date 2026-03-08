import { DictionaryService } from '../core/dictionary-service.js';
import { getSession, resetFriction } from '../core/session-tracker.js';
import type { PluginCommandContext, PluginCommandResult } from '../openclaw-sdk.js';
import * as path from 'path';

/**
 * Handles the /pain status or /pain reset command to report or manage the current state of the Digital Nerve System.
 */
export function handlePainCommand(ctx: PluginCommandContext, lang: string = 'en'): PluginCommandResult {
    const workspaceDir = (ctx.config?.workspaceDir as string) || process.cwd();
    const stateDir = (ctx.config?.stateDir as string) || path.join(workspaceDir, 'memory', '.state');
    const args = (ctx.args || '').trim();
    const sessionId = (ctx as any).sessionId;

    const isZh = lang === 'zh';

    if (args === 'reset') {
        if (sessionId) {
            resetFriction(sessionId);
            return { text: isZh ? `✅ 当前会话的 GFI 阻力已重置为 0。` : `✅ GFI for current session reset to 0.` };
        }
        return { text: isZh ? `⚠️ 找不到当前活跃的会话数据。` : `⚠️ No active session to reset.` };
    }
    
    const dictionary = DictionaryService.get(stateDir);
    const session = sessionId ? getSession(sessionId) : undefined;
    
    let report = `# 🦷 Principles Disciple — Digital Nerve System Status\n\n`;
    
    // 1. GFI Status (Track A)
    report += isZh ? `### Track A: 经验摩擦指数 (Empirical Friction - GFI)\n` : `### Track A: Empirical Friction (GFI)\n`;
    report += isZh ? `*监测工具调用的报错频率与重复度。得分越高，系统越倾向于启动自动进化。*\n\n` : `*Monitors tool failure rates and repetitive loops. Higher scores trigger evolution.* \n\n`;
    
    if (session) {
        const gfi = session.currentGfi || 0;
        const statusZh = gfi >= 80 ? '🔴 (危急)' : (gfi >= 40 ? '🟡 (警告)' : '🟢 (正常)');
        const statusEn = gfi >= 80 ? '🔴 (Critical)' : (gfi >= 40 ? '🟡 (Warning)' : '🟢 (Normal)');
        const status = isZh ? statusZh : statusEn;

        report += isZh 
            ? `- **当前 GFI 阻力**: ${status} **${gfi.toFixed(1)}** / 100\n`
            : `- **Current GFI**: ${status} **${gfi.toFixed(1)}** / 100\n`;
        
        report += isZh 
            ? `- **连续错误计数**: ${session.consecutiveErrors}\n`
            : `- **Consecutive Errors**: ${session.consecutiveErrors}\n`;
            
        report += isZh
            ? `- **认知停滞循环**: ${session.stuckLoops || 0} 次 (输入过高/输出过低)\n\n`
            : `- **Cognitive Paralysis**: ${session.stuckLoops || 0} loops (high input/low output)\n\n`;
        
        if (gfi >= 40) {
            report += isZh 
                ? `> 💡 **建议**: 当前阻力较大，您可以输入 \`/evolve-task\` 尝试让系统自愈。\n\n`
                : `> 💡 **Tip**: High friction detected. You can run \`/evolve-task\` to self-heal.\n\n`;
        }
    } else {
        report += isZh ? `*当前会话暂无活跃数据。*\n\n` : `*No active session data found.*\n\n`;
    }
    
    // 2. Dictionary Stats (Track B)
    report += isZh ? `### Track B: 语义痛觉字典 (Semantic Pain Dictionary)\n` : `### Track B: Semantic Pain Dictionary\n`;
    report += isZh ? `*监测 AI 的“心声”与“用户情绪”。一旦命中规则，将产生语义阻力。*\n\n` : `*Monitors the AI's internal thoughts and user frustration. Rule hits generate semantic friction.*\n\n`;
    const rules = dictionary.getAllRules();
    
    if (Object.keys(rules).length === 0) {
        report += isZh ? `*字典中暂无规则。*\n` : `*No rules found in dictionary.*\n`;
    } else {
        const tableHeader = isZh 
            ? `| 规则 ID | 痛感权重 | 命中次数 | 当前状态 |\n`
            : `| Rule ID | Severity | Hits | Status |\n`;
        report += `${tableHeader}|---|---|---|---|\n`;
        
        for (const [id, rule] of Object.entries(rules)) {
            const statusIcon = rule.status === 'active' 
                ? (isZh ? '✅ 运行中' : '✅ active') 
                : (isZh ? '💤 休眠' : '💤 asleep');
            const translatedId = translateRuleId(id, isZh);
            report += `| ${translatedId} | ${rule.severity} | ${rule.hits} | ${statusIcon} |\n`;
        }
    }
    
    return { text: report };
}

/**
 * Translates technical Rule IDs to human-readable labels.
 */
function translateRuleId(id: string, isZh: boolean): string {
    const mapZh: Record<string, string> = {
        'P_CONFUSION_ZH': '认知困惑 (中)',
        'P_CONFUSION_EN': '认知困惑 (英)',
        'P_LOOP_ZH': '死亡螺旋 (中)',
        'P_LOOP_EN': '死亡螺旋 (英)',
    };
    const mapEn: Record<string, string> = {
        'P_CONFUSION_ZH': 'Cognitive Confusion (Zh)',
        'P_CONFUSION_EN': 'Cognitive Confusion (En)',
        'P_LOOP_ZH': 'Infinite Loop (Zh)',
        'P_LOOP_EN': 'Infinite Loop (En)',
    };

    if (id.startsWith('P_PROMOTED_')) {
        return isZh ? `✨ 晋升规则 (${id.substring(11, 17)})` : `✨ Promoted Rule (${id.substring(11, 17)})`;
    }
    
    return (isZh ? mapZh[id] : mapEn[id]) || id;
}
