import { PluginHookSubagentEndedEvent, PluginHookAgentContext } from '../openclaw-sdk.js';
import { writePainFlag } from '../core/pain.js';
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

    // 2. Loop Closure: Clean up evolution queue if diagnostician finished successfully
    if (outcome === 'ok' || outcome === 'deleted') {
        if (event.targetSessionKey && event.targetSessionKey.includes('diagnostician')) {
            const queuePath = path.join(workspaceDir, 'docs', 'evolution_queue.json');
            if (fs.existsSync(queuePath)) {
                try {
                    const queue = JSON.parse(fs.readFileSync(queuePath, 'utf8'));
                    let changed = false;
                    for (const task of queue) {
                        if (task.status === 'in_progress') {
                            task.status = 'completed';
                            changed = true;
                        }
                    }
                    if (changed) {
                        fs.writeFileSync(queuePath, JSON.stringify(queue, null, 2), 'utf8');
                    }
                } catch (e) {}
            }

            // Clean up the .pain_flag if it was queued, to reset the environment
            const painFlagPath = path.join(workspaceDir, 'docs', '.pain_flag');
            if (fs.existsSync(painFlagPath)) {
                try {
                    const painData = fs.readFileSync(painFlagPath, 'utf8');
                    if (painData.includes('status: queued')) {
                        fs.unlinkSync(painFlagPath);
                    }
                } catch (e) {}
            }
        }
    }
}
