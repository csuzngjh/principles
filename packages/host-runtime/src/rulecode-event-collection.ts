import * as fs from 'node:fs';
import * as path from 'node:path';
import { RUNTIME_EVENT_LOG_CANDIDATE_DIRS } from './prompt-injection-budget-observation.js';

export interface CollectedRuleCodeEventEntries {
  entries: unknown[];
  /** Number of candidate directories that actually exist on disk. */
  sourceDirsFound: number;
}

/**
 * PRI-577: RuleCode event telemetry candidate directories, in priority order.
 *
 * Runtime convention is `.pd/logs`, but the v1 EventLog writer
 * (openclaw-plugin `src/core/event-log.ts`) still emits `events_*.jsonl` under
 * `.state/logs`. No production code ever created `.pd/logs`, so scanning only
 * that path made every shadow metric report "unavailable" while 2500+ real
 * evaluations sat unread in `.state/logs`. Readers scan both candidates until
 * the writer migrates (ERR-031: every reader derives from the host-runtime
 * constant `RUNTIME_EVENT_LOG_CANDIDATE_DIRS`, so they cannot drift).
 */
export const RULECODE_EVENT_LOG_CANDIDATE_DIRS: readonly string[] = RUNTIME_EVENT_LOG_CANDIDATE_DIRS;

/**
 * Collect rulehost telemetry entries from all candidate log directories.
 * Malformed lines are excluded individually. A directory counts as a source
 * only after it can be enumerated, so an unreadable path cannot be mistaken
 * for a healthy channel with zero events (ERR-002).
 *
 * Exact lines copied between candidate directories are deduplicated by
 * priority. Different events in same-named daily files are retained.
 *
 * ONE implementation: this is the host-side filesystem reader the CLI
 * (`runtime activation promote`) and the Console Owner review both consume, so
 * a fix to the scan cannot land in one consumer and silently lag in the other.
 */
export function collectRuleCodeEventEntries(workspaceDir: string): CollectedRuleCodeEventEntries {
  const entries: unknown[] = [];
  let sourceDirsFound = 0;
  const higherPriorityLines = new Set<string>();
  for (const candidate of RULECODE_EVENT_LOG_CANDIDATE_DIRS) {
    const logsDir = path.join(workspaceDir, ...candidate.split('/'));
    if (!fs.existsSync(logsDir)) continue;
    try {
      const files = fs.readdirSync(logsDir)
        .filter(name => /^events_.*\.jsonl$/.test(name))
        .sort()
        .slice(-7);
      sourceDirsFound += 1;
      const currentSourceLines: string[] = [];
      for (const file of files) {
        const lines = fs.readFileSync(path.join(logsDir, file), 'utf8').split('\n').filter(Boolean);
        for (const line of lines) {
          currentSourceLines.push(line);
          if (higherPriorityLines.has(line)) continue;
          try { entries.push(JSON.parse(line) as unknown); } catch { /* exclude malformed telemetry */ }
        }
      }
      for (const line of currentSourceLines) higherPriorityLines.add(line);
    } catch { /* unreadable directory contributes no entries */ }
  }
  return { entries, sourceDirsFound };
}
