/**
 * pd legacy cleanup
 *
 * Cleans legacy artifacts from workspaces:
 * - .state/pd_tasks.json  (removes empathy-optimizer entries)
 * - .state/sessions/*.json (archives sessions with cron:pd-empathy-optimizer)
 * - .state/diagnostician_tasks.json (archives)
 * - .state/.evolution_complete_* (archives)
 * - .state/.diagnostician_report_* (archives)
 * - ~/.openclaw/cron/jobs.json (removes pd-empathy-optimizer cron jobs)
 *
 * Usage:
 *   pd legacy cleanup --workspace <path> --dry-run
 *   pd legacy cleanup --workspace <path> --apply
 */

import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';

interface CleanupTarget {
  path: string;
  action: 'remove' | 'archive';
  reason: string;
  archivePath?: string;
}

interface CronJobRecord {
  id?: string;
  name?: string;
  [key: string]: unknown;
}

interface _CronStore {
  jobs: CronJobRecord[];
}

interface TaskRecord {
  id?: string;
  name?: string;
  [key: string]: unknown;
}

function glob(pattern: string): string[] {
  const results: string[] = [];
  const baseDir = path.dirname(pattern);
  const filePattern = path.basename(pattern).replace(/\*/g, '');

  if (!fs.existsSync(baseDir)) return [];

  for (const file of fs.readdirSync(baseDir)) {
    if (file.startsWith(filePattern) || filePattern === '') {
      const fullPath = path.join(baseDir, file);
      const stat = fs.statSync(fullPath);
      if (stat.isFile()) results.push(fullPath);
    }
  }
  return results;
}

async function _archiveFile(filePath: string, archiveDir: string): Promise<string> {
  if (!fs.existsSync(archiveDir)) {
    fs.mkdirSync(archiveDir, { recursive: true });
  }
  const archivePath = path.join(archiveDir, path.basename(filePath));
  fs.copyFileSync(filePath, archivePath);
  fs.unlinkSync(filePath);
  return archivePath;
}

function findLegacyTargets(workspacePath: string): CleanupTarget[] {
  const targets: CleanupTarget[] = [];
  const stateDir = path.join(workspacePath, '.state');
  const archiveTimestamp = new Date().toISOString().replace(/[:.]/g, '-');
  const archiveDir = path.join(stateDir, 'legacy-archive', archiveTimestamp);

  // 1. pd_tasks.json — remove empathy-optimizer entries
  const pdTasksPath = path.join(stateDir, 'pd_tasks.json');
  if (fs.existsSync(pdTasksPath)) {
    try {
      const content = fs.readFileSync(pdTasksPath, 'utf-8');
      const tasks = JSON.parse(content);
      const filtered = tasks.filter((t: TaskRecord) =>
        !t.id?.includes('empathy-optimizer') && !t.name?.includes('Empathy Optimizer')
      );
      if (filtered.length !== tasks.length) {
        targets.push({
          path: pdTasksPath,
          action: 'archive',
          reason: 'Removed empathy-optimizer entries from pd_tasks.json',
          archivePath: path.join(archiveDir, 'pd_tasks.json.backup'),
        });
      }
    } catch { /* skip invalid JSON */ }
  }

  // 2. sessions/*.json — archive empathy cron sessions
  const sessionsDir = path.join(stateDir, 'sessions');
  if (fs.existsSync(sessionsDir)) {
    for (const file of fs.readdirSync(sessionsDir)) {
      if (!file.endsWith('.json')) continue;
      const filePath = path.join(sessionsDir, file);
      try {
        const content = fs.readFileSync(filePath, 'utf-8');
        const session = JSON.parse(content);
        if (session.sessionKey?.includes('cron:pd-empathy-optimizer') ||
            session.sessionKey?.includes('cron:empathy-optimizer')) {
          targets.push({
            path: filePath,
            action: 'archive',
            reason: `Legacy empathy cron session: ${session.sessionKey}`,
            archivePath: path.join(archiveDir, 'sessions', file),
          });
        }
      } catch { /* skip */ }
    }
  }

  // 3. diagnostician_tasks.json
  const diagPath = path.join(stateDir, 'diagnostician_tasks.json');
  if (fs.existsSync(diagPath)) {
    targets.push({
      path: diagPath,
      action: 'archive',
      reason: 'Legacy diagnostician task store',
      archivePath: path.join(archiveDir, 'diagnostician_tasks.json'),
    });
  }

  // 4. .evolution_complete_* markers
  for (const marker of glob(path.join(stateDir, '.evolution_complete_*'))) {
    targets.push({
      path: marker,
      action: 'archive',
      reason: 'Legacy evolution marker',
      archivePath: path.join(archiveDir, path.basename(marker)),
    });
  }

  // 5. .diagnostician_report_* markers
  for (const marker of glob(path.join(stateDir, '.diagnostician_report_*'))) {
    targets.push({
      path: marker,
      action: 'archive',
      reason: 'Legacy diagnostician report marker',
      archivePath: path.join(archiveDir, path.basename(marker)),
    });
  }

  // 6. OpenClaw cron jobs.json
  const cronPath = path.join(os.homedir(), '.openclaw', 'cron', 'jobs.json');
  if (fs.existsSync(cronPath)) {
    try {
      const content = fs.readFileSync(cronPath, 'utf-8');
      const store = JSON.parse(content) as _CronStore;
      const filtered = store.jobs.filter((j: CronJobRecord) =>
        !j.id?.includes('pd-empathy-optimizer') && !j.name?.includes('Empathy Optimizer')
      );
      if (filtered.length !== store.jobs.length) {
        targets.push({
          path: cronPath,
          action: 'archive',
          reason: 'Removed pd-empathy-optimizer cron jobs',
          archivePath: path.join(os.homedir(), '.openclaw', 'cron', `jobs.json.backup-${archiveTimestamp}`),
        });
      }
    } catch { /* skip */ }
  }

  return targets;
}

export async function handleLegacyCleanup(
  workspacePath: string,
  dryRun: boolean
): Promise<{ targets: CleanupTarget[]; applied: number }> {
  const targets = findLegacyTargets(workspacePath);
  let applied = 0;

  if (dryRun) {
    console.log(`\n=== DRY RUN: Would process ${targets.length} target(s) ===`);
    for (const t of targets) {
      console.log(`  ${t.action}: ${t.path}`);
      console.log(`         Reason: ${t.reason}`);
      if (t.archivePath) {
        console.log(`         Archive: ${t.archivePath}`);
      }
    }
    if (targets.length === 0) {
      console.log('  No legacy artifacts found.');
    }
  } else {
    console.log(`\n=== Applying ${targets.length} cleanup(s) ===`);
    for (const t of targets) {
      try {
        if (t.action === 'archive' && t.archivePath) {
          const archiveDir = path.dirname(t.archivePath);
          if (!fs.existsSync(archiveDir)) {
            fs.mkdirSync(archiveDir, { recursive: true });
          }
          fs.copyFileSync(t.path, t.archivePath);
          fs.unlinkSync(t.path);
          console.log(`  Archived: ${t.path} -> ${t.archivePath}`);
        } else {
          fs.unlinkSync(t.path);
          console.log(`  Removed: ${t.path}`);
        }
        applied++;
      } catch (err) {
        console.error(`  ERROR processing ${t.path}: ${String(err)}`);
      }
    }
  }

  return { targets, applied };
}
