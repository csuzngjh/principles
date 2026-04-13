/**
 * EventLog Auditor — Search and verify events across all .state directories
 * 
 * This tool addresses a common debugging issue where hook events may be
 * written to the wrong .state directory due to workspaceDir resolution bugs.
 * 
 * Usage:
 *   const report = await auditEventLogs(openclawDir, ['after_tool_call', 'before_tool_call']);
 *   console.log(report.summary);
 */

import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';

interface EventLogEntry {
  ts: string;
  date: string;
  type: string;
  category: string;
  sessionId?: string;
  data: Record<string, unknown>;
}

interface LocationReport {
  path: string;
  lastModified: Date | null;
  totalEntries: number;
  hookCounts: Record<string, number>;
  recentEntries: EventLogEntry[];
}

interface AuditReport {
  searchedPaths: string[];
  locations: LocationReport[];
  primaryPath: string | null;
  misplacedEvents: { path: string; entries: EventLogEntry[] }[];
}

/**
 * Find all events.jsonl files under a directory tree.
 */
function findEventLogs(baseDir: string, maxDepth = 4): string[] {
  const results: string[] = [];
  
  function scan(dir: string, depth: number): void {
    if (depth > maxDepth) return;
    try {
      const entries = fs.readdirSync(dir, { withFileTypes: true });
      for (const entry of entries) {
        if (entry.name === 'events.jsonl') {
          results.push(path.join(dir, entry.name));
        } else if (entry.isDirectory() && !entry.name.startsWith('.')) {
          scan(path.join(dir, entry.name), depth + 1);
        }
      }
    } catch {
      // Permission denied or directory doesn't exist
    }
  }
  
  scan(baseDir, 0);
  return results;
}

/**
 * Find events.jsonl in well-known locations.
 */
function findKnownEventLogPaths(): string[] {
  const homeDir = os.homedir();
  const candidates: string[] = [];
  
  // Common patterns
  const patterns = [
    path.join(homeDir, '.state', 'logs', 'events.jsonl'),
    path.join(homeDir, '.openclaw', '.state', 'logs', 'events.jsonl'),
    path.join(homeDir, '.openclaw', 'workspace-main', '.state', 'logs', 'events.jsonl'),
    path.join(homeDir, '.openclaw', 'workspace-builder', '.state', 'logs', 'events.jsonl'),
    path.join(homeDir, '.openclaw', 'workspace-pm', '.state', 'logs', 'events.jsonl'),
    path.join(homeDir, '.openclaw', 'workspace-hr', '.state', 'logs', 'events.jsonl'),
    path.join(homeDir, '.openclaw', 'workspace-repair', '.state', 'logs', 'events.jsonl'),
    path.join(homeDir, '.openclaw', 'workspace-research', '.state', 'logs', 'events.jsonl'),
    path.join(homeDir, '.openclaw', 'workspace-scout', '.state', 'logs', 'events.jsonl'),
  ];
  
  for (const p of patterns) {
    if (fs.existsSync(p)) {
      candidates.push(p);
    }
  }
  
  return candidates;
}

/**
 * Read the last N entries from an events.jsonl file.
 */
function readRecentEntries(filePath: string, count = 50): EventLogEntry[] {
  try {
    const content = fs.readFileSync(filePath, 'utf-8');
    const lines = content.trim().split('\n').filter(Boolean);
    const recent = lines.slice(-count);
    return recent.map(line => JSON.parse(line));
  } catch {
    return [];
  }
}

/**
 * Count all hooks in the entire file (for summary).
 */
function countAllHooks(filePath: string): Record<string, number> {
  const counts: Record<string, number> = {};
  try {
    const content = fs.readFileSync(filePath, 'utf-8');
    const lines = content.trim().split('\n').filter(Boolean);
    for (const line of lines) {
      try {
        const entry = JSON.parse(line) as EventLogEntry;
        if (entry.type === 'hook_execution' && entry.data?.hook) {
          const hook = entry.data.hook as string;
          counts[hook] = (counts[hook] || 0) + 1;
        }
      } catch {
        // Skip malformed lines
      }
    }
  } catch {
    // File doesn't exist or can't be read
  }
  return counts;
}

/**
 * Audit all events.jsonl files.
 * 
 * @param openclawDir - Base OpenClaw directory (e.g., ~/.openclaw)
 * @param expectedToolHooks - Hook names that should appear in the primary workspace
 */
    // eslint-disable-next-line complexity -- complexity 11, slightly over threshold
export async function auditEventLogs(
  openclawDir: string,
  expectedToolHooks: string[] = ['before_tool_call', 'after_tool_call'],
): Promise<AuditReport> {
  const homeDir = os.homedir();
  
  // Find all event logs
  const knownPaths = findKnownEventLogPaths();
  const scannedPaths = findEventLogs(homeDir, 4);
  const allPaths = [...new Set([...knownPaths, ...scannedPaths])];
  
  const locations: LocationReport[] = [];
  let primaryPath: string | null = null;
  
  for (const filePath of allPaths) {
    try {
      const stat = fs.statSync(filePath);
      const allCounts = countAllHooks(filePath);
      const recent = readRecentEntries(filePath, 30);

      locations.push({
        path: filePath,
        lastModified: stat.mtime,
        totalEntries: Object.values(allCounts).reduce((a, b) => a + b, 0),
        hookCounts: allCounts,
        recentEntries: recent,
      });
      
      // Determine primary path (workspace-main or most recent)
      if (filePath.includes('workspace-main') || filePath.includes('workspace-main')) {
        primaryPath = filePath;
      }
    } catch {
      // Skip unreadable files
    }
  }
  
  // If no primary found, use most recent
  if (!primaryPath && locations.length > 0) {
    locations.sort((a, b) => {
      if (!a.lastModified) return 1;
      if (!b.lastModified) return -1;
      return b.lastModified.getTime() - a.lastModified.getTime();
    });
    primaryPath = locations[0].path;
  }
  
  // Detect misplaced tool hook events
  const misplacedEvents: { path: string; entries: EventLogEntry[] }[] = [];
  for (const loc of locations) {
    if (loc.path === primaryPath) continue;
    
    const toolHookEntries = loc.recentEntries.filter(e => 
      e.type === 'hook_execution' && expectedToolHooks.includes(e.data?.hook as string)
    );
    
    if (toolHookEntries.length > 0) {
      misplacedEvents.push({ path: loc.path, entries: toolHookEntries });
    }
  }
  
  return {
    searchedPaths: allPaths,
    locations,
    primaryPath,
    misplacedEvents,
  };
}

/**
 * Format audit report for display.
 */
    // eslint-disable-next-line complexity -- complexity 13, refactor candidate
export function formatAuditReport(report: AuditReport): string {
  const lines: string[] = [];
  
  lines.push('=== Event Log Audit Report ===\n');
  
  lines.push(`Searched ${report.searchedPaths.length} paths:\n`);
  for (const p of report.searchedPaths) {
    lines.push(`  ${p}`);
  }
  lines.push('');
  
  lines.push(`Primary: ${report.primaryPath ?? 'NOT FOUND'}\n`);
  
  for (const loc of report.locations) {
    const isPrimary = loc.path === report.primaryPath;
    lines.push(`─── ${isPrimary ? '[PRIMARY]' : '[OTHER]   '}${loc.path}`);
    lines.push(`    Last modified: ${loc.lastModified?.toISOString() ?? 'never'}`);
    lines.push(`    Hook counts:`);
    
    const hooks = Object.entries(loc.hookCounts).sort((a, b) => b[1] - a[1]);
    for (const [hook, count] of hooks) {
      lines.push(`      ${hook}: ${count}`);
    }
    
    if (hooks.length === 0) {
      lines.push(`      (no hooks recorded)`);
    }
    lines.push('');
  }
  
  if (report.misplacedEvents.length > 0) {
    lines.push('⚠️  MISPLACED tool hook events detected:');
    for (const me of report.misplacedEvents) {
      lines.push(`\n  ${me.path}:`);
      for (const entry of me.entries.slice(0, 5)) {
        lines.push(`    ${entry.ts} - ${entry.data.hook}`);
      }
      if (me.entries.length > 5) {
        lines.push(`    ... and ${me.entries.length - 5} more`);
      }
    }
    lines.push('');
    lines.push('This means tool hooks are writing events to the wrong .state directory.');
    lines.push('Check workspaceDir resolution in the hook handler.');
  } else {
    lines.push('✅ No misplaced tool hook events detected.');
  }
  
  return lines.join('\n');
}
