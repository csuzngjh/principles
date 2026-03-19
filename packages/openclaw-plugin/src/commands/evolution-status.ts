import { EvolutionReducerImpl } from '../core/evolution-reducer.js';
import { normalizeLanguage } from '../i18n/commands.js';
import type { PluginCommandContext } from '../openclaw-sdk.js';
import { getAgentScorecard } from '../core/trust-engine.js';
import { EventLogService } from '../core/event-log.js';
import * as fs from 'fs';
import * as path from 'path';

interface EvolutionQueueItem {
  id: string;
  status: string;
  task?: string;
  score?: number;
  source?: string;
  timestamp?: string;
  completed_at?: string;
}

function getQueueStats(workspaceDir: string): { pending: number; completed: number; inProgress: number } {
  const stateDir = path.join(workspaceDir, '.state', 'principles');
  const queuePath = path.join(stateDir, 'evolution_queue.json');
  
  let pending = 0;
  let completed = 0;
  let inProgress = 0;
  
  try {
    if (fs.existsSync(queuePath)) {
      const queue: EvolutionQueueItem[] = JSON.parse(fs.readFileSync(queuePath, 'utf-8'));
      for (const item of queue) {
        if (item.status === 'completed') {
          completed++;
        } else if (item.status === 'in_progress') {
          inProgress++;
        } else {
          pending++;
        }
      }
    }
  } catch {
    // Ignore errors, return zeros
  }
  
  return { pending, completed, inProgress };
}

function getCurrentPain(workspaceDir: string): { painScore: number; painSource: string } {
  const stateDir = path.join(workspaceDir, '.state', 'principles');
  const painFlagPath = path.join(stateDir, '.pain_flag');
  
  try {
    if (fs.existsSync(painFlagPath)) {
      const data = JSON.parse(fs.readFileSync(painFlagPath, 'utf-8'));
      return {
        painScore: data.score || 0,
        painSource: data.source || 'none'
      };
    }
  } catch {
    // Ignore errors
  }
  
  return { painScore: 0, painSource: 'none' };
}

export function handleEvolutionStatusCommand(ctx: PluginCommandContext): { text: string } {
  const workspaceDir = (ctx.config?.workspaceDir as string) || process.cwd();
  const reducer = new EvolutionReducerImpl({ workspaceDir });
  const stats = reducer.getStats();
  
  // Get Trust Score
  let trustScore = 0;
  let trustStage = 1;
  try {
    const scorecard = getAgentScorecard(workspaceDir);
    trustScore = scorecard.trust_score ?? 0;
    trustStage = trustScore >= 80 ? 4 : trustScore >= 60 ? 3 : trustScore >= 30 ? 2 : 1;
  } catch {
    // Ignore errors, use defaults
  }
  
  // Get EventLog for GFI and Pain stats
  let gfiPeak = 0;
  let painSignals = 0;
  try {
    const stateDir = path.join(workspaceDir, '.state', 'principles');
    const eventLog = EventLogService.get(stateDir);
    const today = new Date().toISOString().split('T')[0];
    const dailyStats = eventLog.getDailyStats(today);
    gfiPeak = dailyStats.gfi?.peak ?? 0;
    painSignals = dailyStats.pain?.signalsDetected ?? 0;
  } catch {
    // Ignore errors, use defaults
  }
  
  // Get Queue Stats
  const queueStats = getQueueStats(workspaceDir);
  
  // Get Current Pain
  const currentPain = getCurrentPain(workspaceDir);
  
  // Determine language - handle both 'zh' and 'zh-CN' formats
  const rawLang = (ctx.config?.language as string) || 'en';
  const lang = normalizeLanguage(rawLang);
  
  if (lang === 'zh') {
    const lines: string[] = [
      '📈 Evolution 状态',
      '━━━━━━━━━━━━━━━━━━━━━━━━━━━━',
      '',
      `🛡️ Trust Score: ${trustScore}/100 (Stage ${trustStage})`,
      `😴 GFI Peak: ${gfiPeak.toFixed(1)}`,
      `⚡ Current Pain: ${currentPain.painScore} pts (${currentPain.painSource})`,
      `📈 Pain Signals Today: ${painSignals}`,
      '',
      '📊 Evolution Rules',
      '━━━━━━━━━━━━━━━━━━━━━━━━━━━━',
      `- 候选原则: ${stats.candidateCount}`,
      `- 观察期原则: ${stats.probationCount}`,
      `- 生效原则: ${stats.activeCount}`,
      `- 已废弃原则: ${stats.deprecatedCount}`,
      `- 最近晋升时间: ${stats.lastPromotedAt ?? '无'}`,
      '',
      '📋 Evolution Queue',
      '━━━━━━━━━━━━━━━━━━━━━━━━━━━━',
      `- 待处理: ${queueStats.pending} 项`,
      `- 进行中: ${queueStats.inProgress} 项`,
      `- 已完成: ${queueStats.completed} 项`,
    ];
    
    return { text: lines.join('\n') };
  }
  
  // English
  const lines: string[] = [
    '📈 Evolution Status',
    '━━━━━━━━━━━━━━━━━━━━━━━━━━━━',
    '',
    `🛡️ Trust Score: ${trustScore}/100 (Stage ${trustStage})`,
    `😴 GFI Peak: ${gfiPeak.toFixed(1)}`,
    `⚡ Current Pain: ${currentPain.painScore} pts (${currentPain.painSource})`,
    `📈 Pain Signals Today: ${painSignals}`,
    '',
    '📊 Evolution Rules',
    '━━━━━━━━━━━━━━━━━━━━━━━━━━━━',
    `- candidate principles: ${stats.candidateCount}`,
    `- probation principles: ${stats.probationCount}`,
    `- active principles: ${stats.activeCount}`,
    `- deprecated principles: ${stats.deprecatedCount}`,
    `- last promoted: ${stats.lastPromotedAt ?? 'none'}`,
    '',
    '📋 Evolution Queue',
    '━━━━━━━━━━━━━━━━━━━━━━━━━━━━',
    `- Pending: ${queueStats.pending}`,
    `- In Progress: ${queueStats.inProgress}`,
    `- Completed: ${queueStats.completed}`,
  ];
  
  return { text: lines.join('\n') };
}
