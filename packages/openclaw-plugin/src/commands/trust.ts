import { TRUST_CONFIG } from '../core/trust-engine.js';
import { WorkspaceContext } from '../core/workspace-context.js';
import type { PluginHookAgentContext } from '../openclaw-sdk.js';

export function handleTrustCommand(ctx: PluginHookAgentContext & { workspaceDir?: string }): string {
    const { workspaceDir } = ctx;
    if (!workspaceDir) return 'Error: Workspace directory not found.';

    const wctx = WorkspaceContext.fromHookContext(ctx);
    const scorecard = wctx.trust.getScorecard();
    const trustScore = scorecard.trust_score;
    
    let stage = 2;
    let title = 'Editor';
    let permissions = `- Small modifications (< ${TRUST_CONFIG.LIMITS.STAGE_2_MAX_LINES} lines)\n- Non-risk paths only`;
    let nextLevel = `Trust Score >= ${TRUST_CONFIG.STAGES.STAGE_2_EDITOR}`;

    if (trustScore < TRUST_CONFIG.STAGES.STAGE_1_OBSERVER) {
        stage = 1;
        title = 'Observer (Bankruptcy)';
        permissions = '- Read-only access\n- Diagnosis tools only';
        nextLevel = `Trust Score >= ${TRUST_CONFIG.STAGES.STAGE_1_OBSERVER}`;
    } else if (trustScore < TRUST_CONFIG.STAGES.STAGE_2_EDITOR) {
        // Default stage 2
    } else if (trustScore < TRUST_CONFIG.STAGES.STAGE_3_DEVELOPER) {
        stage = 3;
        title = 'Developer';
        permissions = `- Medium modifications (< ${TRUST_CONFIG.LIMITS.STAGE_3_MAX_LINES} lines)\n- Risk paths require READY plan`;
        nextLevel = `Trust Score >= ${TRUST_CONFIG.STAGES.STAGE_3_DEVELOPER}`;
    } else {
        stage = 4;
        title = 'Architect';
        permissions = '- UNRESTRICTED access\n- Plan and Audit are optional';
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
*Trust is earned through successful tasks (+${TRUST_CONFIG.REWARDS.SUBAGENT_SUCCESS}) and lost through failures (${TRUST_CONFIG.PENALTIES.TOOL_FAILURE_BASE}).*
`.trim();
}
