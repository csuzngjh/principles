import { WorkspaceContext } from '../core/workspace-context.js';
import type { PluginHookAgentContext } from '../openclaw-sdk.js';

/**
 * Creates a visual progress bar (e.g., [██████░░░░])
 */
function createProgressBar(value: number, max: number, length: number = 10): string {
    const filledLength = Math.round((value / max) * length);
    const emptyLength = length - filledLength;
    return `[${'█'.repeat(filledLength)}${'░'.repeat(emptyLength)}]`;
}

export function handleTrustCommand(ctx: PluginHookAgentContext & { workspaceDir?: string }): string {
    const { workspaceDir } = ctx;
    if (!workspaceDir) return 'Error: Workspace directory not found.';

    const wctx = WorkspaceContext.fromHookContext(ctx);
    const trustEngine = wctx.trust;
    const trustScore = trustEngine.getScore();
    const trustSettings = wctx.config.get('trust');
    const isZh = wctx.config.get('language') === 'zh';
    
    let stage = 2;
    let title = isZh ? '编辑者' : 'Editor';
    let permissions = isZh 
        ? `- 允许小范围修改 (< ${trustSettings.limits.stage_2_max_lines} 行)\n- 禁止修改风险目录`
        : `- Small modifications (< ${trustSettings.limits.stage_2_max_lines} lines)\n- Non-risk paths only`;
    let nextLevel = `Trust Score >= ${trustSettings.stages.stage_3_developer}`;

    if (trustScore < trustSettings.stages.stage_1_observer) {
        stage = 1;
        title = isZh ? '观察者 (只读模式)' : 'Observer (Read-only)';
        permissions = isZh ? '- 仅限只读访问\n- 仅限诊断工具' : '- Read-only access\n- Diagnosis tools only';
        nextLevel = `Trust Score >= ${trustSettings.stages.stage_1_observer}`;
    } else if (trustScore < trustSettings.stages.stage_2_editor) {
        // Default stage 2
        nextLevel = `Trust Score >= ${trustSettings.stages.stage_2_editor}`;
    } else if (trustScore < trustSettings.stages.stage_3_developer) {
        stage = 3;
        title = isZh ? '开发者' : 'Developer';
        permissions = isZh 
            ? `- 允许中等范围修改 (< ${trustSettings.limits.stage_3_max_lines} 行)\n- 风险目录修改需要有 PLAN (计划)`
            : `- Medium modifications (< ${trustSettings.limits.stage_3_max_lines} lines)\n- Risk paths require READY plan`;
        nextLevel = `Trust Score >= ${trustSettings.stages.stage_3_developer}`;
    } else {
        stage = 4;
        title = isZh ? '架构师' : 'Architect';
        permissions = isZh ? '- 🚨 **无限制访问**\n- 计划和审计非强制要求' : '- 🚨 **UNRESTRICTED access**\n- Plan and Audit are optional';
        nextLevel = isZh ? '已达最高级' : 'MAX LEVEL REACHED';
    }

    const progressBar = createProgressBar(trustScore, 100, 15);
    const hygiene = wctx.hygiene.getStats();
    const persistenceScore = Math.min(100, hygiene.persistenceCount * 10); // 10 points per persistence
    const hygieneBar = createProgressBar(persistenceScore, 100, 15);

    if (isZh) {
        return `
📊 **Principles Disciple - 系统状态看板**
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
🛡️ **安全阶级**: Stage ${stage} (${title})
💰 **信任积分**: ${progressBar} ${trustScore}/100
🧠 **认知卫生**: ${hygieneBar} ${hygiene.persistenceCount} 次落盘 (今日)

**当前操作权限**:
${permissions}

**今日知识沉淀**:
- 物理落盘: ${hygiene.persistenceCount} 次
- 累计字符: ${hygiene.totalCharsPersisted} chars
- 空间整理: ${hygiene.groomingExecutedCount > 0 ? '🟢 良好' : '🟡 待整理'}

**下一次晋升条件**: ${nextLevel}
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
*💡 提示：勤记笔记 (PLAN.md/memory) 有助于对抗上下文遗忘，提升系统稳定性。*
`.trim();
    } else {
        return `
📊 **Principles Disciple - System Dashboard**
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
🛡️ **Security Stage**: Stage ${stage} (${title})
💰 **Trust Score**: ${progressBar} ${trustScore}/100
🧠 **Cognitive Hygiene**: ${hygieneBar} ${hygiene.persistenceCount} actions (Today)

**Current Permissions**:
${permissions}

**Knowledge Assets Today**:
- Physical Persists: ${hygiene.persistenceCount} actions
- Total Chars: ${hygiene.totalCharsPersisted} chars
- Workspace Grooming: ${hygiene.groomingExecutedCount > 0 ? '🟢 Good' : '🟡 Pending'}

**Next Promotion Requirement**: ${nextLevel}
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
*💡 Hint: Frequent notes (PLAN.md/memory) prevent amnesia and ensure task continuity.*
`.trim();
    }
}
