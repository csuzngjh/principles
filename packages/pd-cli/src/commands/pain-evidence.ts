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
 * Get the memory/logs directory for a workspace.
 * SystemLogger writes to <workspace>/memory/logs/SYSTEM_YYYY-MM-DD.log.
 */
function getLogDir(workspaceDir: string): string {
  return path.join(workspaceDir, 'memory', 'logs');
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
      // Extract timestamp from log line prefix.
      // SystemLogger produces two formats:
      //   - Plain:    "2026-06-08 10:16:00 [INFO] ..."
      //   - Bracketed ISO: "[2026-06-08T10:16:00.123Z] [INFO] ..."
      const tsMatch = /^(\d{4}-\d{2}-\d{2}\s+\d{2}:\d{2}:\d{2})/.exec(line)
        ?? /^\[(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z)\]/.exec(line);
      entries.push({
        timestamp: tsMatch?.[1] ?? new Date().toISOString(),
        outcome: typeof payload.outcome === 'string' ? payload.outcome : 'unknown',
        sourceKind: typeof payload.sourceKind === 'string' ? payload.sourceKind : 'unknown',
        reason: typeof payload.reason === 'string' ? payload.reason : '',
        nextAction: typeof payload.nextAction === 'string' ? payload.nextAction : '',
        tool: typeof payload.tool === 'string' ? payload.tool : undefined,
        path: typeof payload.path === 'string' ? payload.path : undefined,
        painId: typeof payload.painId === 'string' ? payload.painId : undefined,
        score: typeof payload.score === 'number' ? payload.score : undefined,
        sessionId: typeof payload.sessionId === 'string' ? payload.sessionId : undefined,
      });
    } catch (e) {
      // Skip malformed entries — always log for operator visibility (EP-03)
      console.error(`WARN: Malformed TRIGGER_DECISION entry: ${String(e).slice(0, 100)}`);
    }
  }

  return entries;
}

/**
 * Read recent trigger decisions from memory/logs files.
 * SystemLogger writes date-stamped files: SYSTEM_YYYY-MM-DD.log.
 */
function readRecentDecisions(logDir: string, limit: number): TriggerDecisionEntry[] {
  if (!fs.existsSync(logDir)) return [];

  const logFiles = fs.readdirSync(logDir)
    .filter(f => f.startsWith('SYSTEM_') && f.endsWith('.log'))
    .sort()
    .reverse(); // newest first

  const allEntries: TriggerDecisionEntry[] = [];

  for (const logFile of logFiles) {
    if (allEntries.length >= limit) break;

    const filePath = path.join(logDir, logFile);
    try {
      const content = fs.readFileSync(filePath, 'utf8');
      const entries = parseTriggerDecisions(content);
      // Reverse per-file entries so combined list is newest-first.
      // Log files are already sorted newest-first, but entries within
      // each file are in chronological (oldest-first) order.
      allEntries.push(...entries.reverse());
    } catch (e) {
      // Skip unreadable files — always log for operator visibility (EP-03)
      console.error(`WARN: Could not read log file ${logFile}: ${String(e).slice(0, 100)}`);
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
  const { workspace, limit: rawLimit, json } = opts;
  const workspaceDir = resolveWorkspaceDir(workspace);
  const logDir = getLogDir(workspaceDir);

  // Validate limit — fail loud for invalid values
  let effectiveLimit = 20;
  if (rawLimit !== undefined) {
    if (!Number.isInteger(rawLimit) || rawLimit < 1 || rawLimit > 10000) {
      const err = {
        status: 'refused',
        reason: `invalid_limit: limit must be an integer between 1 and 10000, got ${rawLimit}`,
        nextAction: 'Pass --limit with a valid integer (1-10000)',
      };
      const { reason, nextAction } = err;
      if (json) {
        console.log(JSON.stringify({ count: 0, error: err }));
      } else {
        console.error('Error: ' + reason);
        console.error('Next: ' + nextAction);
      }
      process.exit(1);
      return; // guard: test stubs of process.exit continue execution
    }
    effectiveLimit = rawLimit;
  }

  const decisions = readRecentDecisions(logDir, effectiveLimit);

  if (json) {
    console.log(JSON.stringify({ count: decisions.length, decisions, searchedPath: path.join(logDir, 'SYSTEM_*.log') }, null, 2));
    return;
  }

  if (decisions.length === 0) {
    console.log('No trigger decisions found in logs.');
    console.log(`Searched: ${path.join(logDir, 'SYSTEM_*.log')}`);
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

// Export for testing
// istanbul ignore next
export { parseTriggerDecisions, getLogDir };
