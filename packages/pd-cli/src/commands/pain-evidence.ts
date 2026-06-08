/**
 * pd pain evidence command — PEAT-B2
 *
 * Query recent admission/trigger decisions from PD logs.
 * This is a read-only diagnostic command — no side effects.
 *
 * Usage:
 *   pd pain evidence [--workspace <path>] [--limit N] [--json]
 *
 * Shows the most recent TRIGGER_DECISION log entries.
 */

import * as fs from 'fs';
import * as path from 'path';
import { resolveWorkspaceDir } from '../resolve-workspace.js';

interface EvidenceOptions {
  workspace?: string;
  limit?: number;
  json?: boolean;
}

interface TriggerDecisionEntry {
  timestamp: string;
  outcome: string;
  sourceKind: string;
  reason: string;
  nextAction: string;
  tool?: string;
  path?: string;
  painId?: string;
  score?: number;
  sessionId?: string;
}

/**
 * Parse TRIGGER_DECISION entries from a log file.
 * Returns entries in reverse chronological order (newest first).
 */
function parseTriggerDecisions(logContent: string): TriggerDecisionEntry[] {
  const entries: TriggerDecisionEntry[] = [];
  const lines = logContent.split('\n');

  for (const line of lines) {
    if (!line.includes('TRIGGER_DECISION')) continue;

    // Extract JSON payload from log line
    const jsonStart = line.indexOf('{');
    if (jsonStart === -1) continue;

    try {
      const payload = JSON.parse(line.slice(jsonStart));
      // Extract timestamp from log line prefix (format: YYYY-MM-DD HH:MM:SS ...)
      const tsMatch = /^(\d{4}-\d{2}-\d{2}\s+\d{2}:\d{2}:\d{2})/.exec(line);
      entries.push({
        timestamp: tsMatch?.[1] ?? new Date().toISOString(),
        outcome: payload.outcome ?? 'unknown',
        sourceKind: payload.sourceKind ?? 'unknown',
        reason: payload.reason ?? '',
        nextAction: payload.nextAction ?? '',
        tool: payload.tool,
        path: payload.path,
        painId: payload.painId,
        score: payload.score,
        sessionId: payload.sessionId,
      });
    } catch {
      // Skip malformed entries
    }
  }

  return entries;
}

/**
 * Get the state directory for a workspace.
 */
function getStateDir(workspaceDir: string): string {
  return path.join(workspaceDir, '.state');
}

/**
 * Read recent trigger decisions from log files.
 */
function readRecentDecisions(stateDir: string, limit: number): TriggerDecisionEntry[] {
  const logsDir = path.join(stateDir, 'logs');
  if (!fs.existsSync(logsDir)) return [];

  const logFiles = fs.readdirSync(logsDir)
    .filter(f => f.startsWith('SYSTEM_') && f.endsWith('.log'))
    .sort()
    .reverse(); // newest first

  const allEntries: TriggerDecisionEntry[] = [];

  for (const logFile of logFiles) {
    if (allEntries.length >= limit) break;

    const filePath = path.join(logsDir, logFile);
    try {
      const content = fs.readFileSync(filePath, 'utf8');
      const entries = parseTriggerDecisions(content);
      allEntries.push(...entries);
    } catch {
      // Skip unreadable files
    }
  }

  return allEntries.slice(0, limit);
}

function getOutcomeEmoji(outcome: string): string {
  switch (outcome) {
    case 'diagnosis_created': return '🔧';
    case 'manual_owner_admitted': return '✅';
    case 'evidence_only': return '📋';
    case 'health_only': return '💚';
    case 'cooldown_skipped': return '⏳';
    case 'owner_confirm_required': return '❓';
    case 'refused': return '🚫';
    default: return '❔';
  }
}

function truncate(s: string, maxLen: number): string {
  if (s.length <= maxLen) return s;
  return s.slice(0, maxLen - 3) + '...';
}

export async function handlePainEvidence(opts: EvidenceOptions): Promise<void> {
  const workspaceDir = resolveWorkspaceDir(opts.workspace);
  const stateDir = getStateDir(workspaceDir);
  const limit = opts.limit ?? 20;

  const decisions = readRecentDecisions(stateDir, limit);

  if (opts.json) {
    console.log(JSON.stringify({ count: decisions.length, decisions }, null, 2));
    return;
  }

  if (decisions.length === 0) {
    console.log('No trigger decisions found in logs.');
    console.log(`Searched: ${stateDir}/logs/SYSTEM_*.log`);
    console.log('Tip: Enable painEvidenceAdmission feature flag to start recording trigger decisions.');
    return;
  }

  console.log(`Recent Pain Evidence Admission Decisions (${decisions.length}):`);
  console.log('─'.repeat(80));

  for (const d of decisions) {
    const outcomeEmoji = getOutcomeEmoji(d.outcome);
    console.log(`  ${outcomeEmoji} [${d.timestamp}] ${d.outcome}`);
    console.log(`    Source: ${d.sourceKind} | Score: ${d.score ?? 'N/A'}`);
    console.log(`    Reason: ${truncate(d.reason, 100)}`);
    if (d.nextAction && d.nextAction !== 'none') {
      console.log(`    Next: ${truncate(d.nextAction, 80)}`);
    }
    if (d.tool) console.log(`    Tool: ${d.tool} | Path: ${d.path ?? 'N/A'}`);
    console.log();
  }

  // Summary
  const byOutcome = new Map<string, number>();
  for (const d of decisions) {
    byOutcome.set(d.outcome, (byOutcome.get(d.outcome) ?? 0) + 1);
  }
  console.log('─'.repeat(80));
  console.log('Summary:');
  for (const [outcome, count] of byOutcome) {
    console.log(`  ${getOutcomeEmoji(outcome)} ${outcome}: ${count}`);
  }
}
