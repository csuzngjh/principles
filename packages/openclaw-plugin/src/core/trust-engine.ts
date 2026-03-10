import * as fs from 'fs';
import * as path from 'path';

export interface AgentScorecard {
    trust_score: number;
    wins?: number;
    losses?: number;
    [key: string]: any;
}

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

export function adjustTrustScore(workspaceDir: string, delta: number): number {
    const scorecard = getAgentScorecard(workspaceDir);
    const currentScore = scorecard.trust_score ?? 50;
    const newScore = Math.max(0, Math.min(100, currentScore + delta));
    scorecard.trust_score = newScore;
    saveAgentScorecard(workspaceDir, scorecard);
    return newScore;
}
