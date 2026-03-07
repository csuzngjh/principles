import { PluginHookSubagentEndedEvent, PluginHookAgentContext } from '../openclaw-sdk.js';
import { writePainFlag } from '../core/pain.js';

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

    // If the subagent failed/timed-out, this is a strong symptom of systemic pain
    if (score > 30) {
        writePainFlag(workspaceDir, {
            source: 'subagent_crash',
            score: String(score),
            time: new Date().toISOString(),
            reason: `Subagent session '${event.targetSessionKey}' terminated with outcome: ${outcome}. Reason: ${event.reason || 'Unknown'}`,
            is_risky: 'false',
        });
    }
}
