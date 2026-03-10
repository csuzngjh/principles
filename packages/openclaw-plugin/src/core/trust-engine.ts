import * as fs from 'fs';
import * as path from 'path';
import type { OpenClawPluginApi } from '../openclaw-sdk.js';
import { EventLogService } from './event-log.js';

export interface AgentScorecard {
    trust_score: number;
    wins?: number;
    losses?: number;
    [key: string]: any;
}

/**
 * Stage thresholds and limits
 */
export const TRUST_CONFIG = {
    STAGES: {
        STAGE_1_OBSERVER: 30,
        STAGE_2_EDITOR: 60,
        STAGE_3_DEVELOPER: 80,
    },
    PENALTIES: {
        TOOL_FAILURE: -10,
        RISKY_FAILURE: -20,
        GATE_BYPASS_ATTEMPT: -5,
    },
    REWARDS: {
        SUBAGENT_SUCCESS: 2,
        STREAK_BONUS: 5,
    },
    LIMITS: {
        STAGE_2_MAX_LINES: 10,
        STAGE_3_MAX_LINES: 100,
    }
};

export function getAgentScorecard(workspaceDir: string): AgentScorecard {
    const scorecardPath = path.join(workspaceDir, 'docs', 'AGENT_SCORECARD.json');
    if (!fs.existsSync(scorecardPath)) {
        return { trust_score: 50 }; // Default initialization
    }
    try {
        const content = fs.readFileSync(scorecardPath, 'utf8');
        return JSON.parse(content);
    } catch (e) {
        return { trust_score: 50 };
    }
}

export function saveAgentScorecard(workspaceDir: string, scorecard: AgentScorecard): void {
    const scorecardPath = path.join(workspaceDir, 'docs', 'AGENT_SCORECARD.json');
    const dir = path.dirname(scorecardPath);
    if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
    }
    
    // Ensure trust_score stays within bounds
    if (scorecard.trust_score !== undefined) {
        scorecard.trust_score = Math.max(0, Math.min(100, scorecard.trust_score));
    }
    
    fs.writeFileSync(scorecardPath, JSON.stringify(scorecard, null, 2), 'utf8');
}

/**
 * Adjusts the trust score and records the event.
 */
export function adjustTrustScore(
    workspaceDir: string, 
    delta: number, 
    reason: string,
    ctx?: { sessionId?: string; stateDir?: string; api?: OpenClawPluginApi }
): number {
    const scorecard = getAgentScorecard(workspaceDir);
    const previousScore = scorecard.trust_score ?? 50;
    const newScore = Math.max(0, Math.min(100, previousScore + delta));
    
    scorecard.trust_score = newScore;
    saveAgentScorecard(workspaceDir, scorecard);

    // Record the change in the event log
    if (ctx) {
        const stateDir = ctx.stateDir || path.join(workspaceDir, 'memory', '.state');
        const eventLog = EventLogService.get(stateDir, ctx.api?.logger);
        eventLog.recordTrustChange(ctx.sessionId, {
            previousScore,
            newScore,
            delta,
            reason
        });
    }

    return newScore;
}
