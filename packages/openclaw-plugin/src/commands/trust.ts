import { getAgentScorecard } from '../core/trust-engine.js';
import type { PluginHookAgentContext } from '../openclaw-sdk.js';

export function handleTrustCommand(ctx: PluginHookAgentContext & { workspaceDir?: string }): string {
    const { workspaceDir } = ctx;
    if (!workspaceDir) return 'Error: Workspace directory not found.';

    const scorecard = getAgentScorecard(workspaceDir);
    const trustScore = scorecard.trust_score ?? 50;
    
    let stage = 2;
    let title = 'Editor';
    let permissions = '- Small scale modifications (< 10 lines)\n- Modifications to non-risk paths allowed';
    let nextLevel = 'Trust Score >= 60';

    if (trustScore < 30) {
        stage = 1;
        title = 'Observer (Bankruptcy)';
        permissions = '- Read-only access\n- Diagnosis tools only';
        nextLevel = 'Trust Score >= 30';
    } else if (trustScore < 60) {
        // Default stage 2
    } else if (trustScore < 80) {
        stage = 3;
        title = 'Developer';
        permissions = '- Full modifications allowed\n- Modification to risk paths requires READY plan';
        nextLevel = 'Trust Score >= 80';
    } else {
        stage = 4;
        title = 'Architect';
        permissions = '- UNRESTRICTED access\n- Plan and Audit are optional but recommended';
        nextLevel = 'MAX LEVEL REACHED';
    }

    return `
💰 **Agent Trust Scorecard**
──────────────────────────────
**Current Score**: ${trustScore}/100
**Security Stage**: ${stage} (${title})

**Permissions**:
${permissions}

**Next Promotion**: ${nextLevel}
──────────────────────────────
*Trust is earned through successful tasks and lost through critical failures.*
`.trim();
}
