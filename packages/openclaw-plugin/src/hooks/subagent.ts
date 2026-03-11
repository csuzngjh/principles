import { PluginHookSubagentEndedEvent, PluginHookAgentContext } from '../openclaw-sdk.js';
import { writePainFlag } from '../core/pain.js';
import { adjustTrustScore, TRUST_CONFIG } from '../core/trust-engine-v2.js';
import * as fs from 'fs';
import * as path from 'path';

// Map of termination outcomes to autonomous pain scores
const OUTCOME_SCORES: Record<string, number> = {
    'error': 80,   // Subagent crashed
    'timeout': 65,   // Subagent timed out
    'killed': 70,   // Subagent forcefully killed by supervisor/gateway
    'reset': 40,   // Reset usually means it took a wrong path and needed restarting
    'ok': 0,   // Subagent completed normally
    'deleted': 0,   // Normal cleanup
};

export function handleSubagentEnded(
    event: PluginHookSubagentEndedEvent,
    ctx: PluginHookAgentContext & { workspaceDir?: string }
): void {
    const { workspaceDir } = ctx;
    if (!workspaceDir) return;

    // Extract outcome
    const outcome = event.outcome;
    if (!outcome) return;

    const score = OUTCOME_SCORES[outcome] || 0;

    // 1. If the subagent failed/timed-out, this is a strong symptom of systemic pain
    if (score > 30) {
        writePainFlag(workspaceDir, {
            source: 'subagent_crash',
            score: String(score),
            time: new Date().toISOString(),
            reason: `Subagent session '${event.targetSessionKey}' terminated with outcome: ${outcome}. Reason: ${event.reason || 'Unknown'}`,
            is_risky: 'false',
        });
    }

    // 2. Loop Closure: Clean up evolution queue if any subagent finished successfully
    // Since we can't reliably detect the agentId from targetSessionKey,
    // we clear the oldest in_progress task assuming it was the one being worked on.
    if (outcome === 'ok' || outcome === 'deleted') {
        // ── Trust Engine: Increment score on success ──
        adjustTrustScore(workspaceDir, TRUST_CONFIG.REWARDS.SUBAGENT_SUCCESS, `subagent:${event.targetSessionKey}`, {
            sessionId: ctx.sessionId,
            stateDir: (ctx as any).stateDir,
            api: (ctx as any).api
        });

        const queuePath = path.join(workspaceDir, 'docs', 'evolution_queue.json');
        if (fs.existsSync(queuePath)) {
            try {
                const queue = JSON.parse(fs.readFileSync(queuePath, 'utf8'));
                let changed = false;
                
                // Find the oldest in_progress task and mark it completed
                const inProgressTasks = queue.filter((t: any) => t.status === 'in_progress');
                if (inProgressTasks.length > 0) {
                    const oldestTask = inProgressTasks.sort((a: any, b: any) => new Date(a.timestamp).getTime() - new Date(b.timestamp).getTime())[0];
                    oldestTask.status = 'completed';
                    changed = true;
                    
                    // Clean up the .pain_flag if it was queued, to reset the environment
                    const painFlagPath = path.join(workspaceDir, 'docs', '.pain_flag');
                    if (fs.existsSync(painFlagPath)) {
                        try {
                            const painData = fs.readFileSync(painFlagPath, 'utf8');
                            if (painData.includes('status: queued')) {
                                fs.unlinkSync(painFlagPath);
                            }
                        } catch (e) {
                             console.warn('[PD] Failed to clean pain_flag:', e);
                        }
                    }
                }
                
                if (changed) {
                    fs.writeFileSync(queuePath, JSON.stringify(queue, null, 2), 'utf8');
                }
            } catch (e) {}
        }
    }
}
