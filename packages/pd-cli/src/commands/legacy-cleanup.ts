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
 * PRI-439 Phase 6: V1 Artificer artifact cleanup.
 * - Identifies V1 artifacts: task_kind=artificer + artifact_kind=principle + no implementationCode
 * - Preserves V2 artifacts (with implementationCode), pain, Dreamer, Philosopher, Scribe
 * - --apply deletes activations → approvals → pi_artifacts (in that order, no cascade)
 * - No V1 runtime reader — V1 artifacts are removed, not interpreted
 *
 * Usage:
 *   pd legacy cleanup --workspace <path>                    # dry-run (default)
 *   pd legacy cleanup --workspace <path> --dry-run          # explicit dry-run
 *   pd legacy cleanup --workspace <path> --apply            # apply cleanup
 *   pd legacy cleanup --workspace <path> --apply --json     # apply with JSON output
 */

import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import type { Database } from 'better-sqlite3';
import { RuntimeStateManager } from '@principles/core/runtime-v2';

// ── Types ────────────────────────────────────────────────────────────────────

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

/**
 * A V1 Artificer artifact identified for cleanup.
 * - artifactId: pi_artifacts.artifact_id
 * - sourceTaskId: pi_artifacts.source_task_id (references tasks.task_id with task_kind='artificer')
 * - approvalCount: number of approvals referencing this artifact
 * - activationCount: number of activations referencing this artifact
 */
export interface V1ArtifactTarget {
  artifactId: string;
  sourceTaskId: string;
  createdAt: string;
  approvalCount: number;
  activationCount: number;
}

export interface LegacyCleanupOptions {
  workspacePath: string;
  /** Dry-run mode (default). Mutually exclusive with `apply`. */
  dryRun?: boolean;
  /** Apply mode. Mutually exclusive with `dryRun`. */
  apply?: boolean;
  /** Output raw JSON */
  json?: boolean;
}

export interface LegacyCleanupResult {
  status: 'ok' | 'partial' | 'failed';
  mode: 'dry-run' | 'apply';
  fileTargets: CleanupTarget[];
  v1Artifacts: V1ArtifactTarget[];
  appliedFiles: number;
  appliedV1Artifacts: number;
  appliedApprovals: number;
  appliedActivations: number;
  errors: string[];
  reason?: string;
  nextAction?: string;
}

// ── Pure logic: V1 artifact identification ──────────────────────────────────

/**
 * Returns true if the parsed content_json represents a V1 Artificer output
 * (i.e., no valid non-empty `implementationCode` string).
 *
 * V1 = plan-only acceptance path (removed in PRI-439).
 * V2 = unified ArtificerRuleOutput with mandatory implementationCode.
 *
 * Returns false for:
 * - V2 artifacts (with non-empty implementationCode string)
 * - Invalid JSON (skip — do not delete corrupted artifacts)
 * - null/non-object JSON
 */
export function isV1ArtificerArtifact(contentJson: string): boolean {
  let parsed: unknown;
  try {
    parsed = JSON.parse(contentJson);
  } catch {
    return false; // invalid JSON — skip, do not delete
  }

  if (typeof parsed !== 'object' || parsed === null) {
    return false; // null or non-object — skip
  }

  // V1 = no implementationCode field OR implementationCode is not a non-empty string
  if (!Object.hasOwn(parsed, 'implementationCode')) {
    return true; // V1: field absent
  }

  const code = (parsed as Record<string, unknown>).implementationCode;
  if (typeof code !== 'string') {
    return true; // V1: field present but not a string (e.g., null, number)
  }
  if (code.trim() === '') {
    return true; // V1: empty or whitespace-only
  }

  return false; // V2: has non-empty implementationCode string
}

// ── DB integration: find V1 Artificer artifacts ─────────────────────────────

interface V1ArtifactRow {
  artifact_id: string;
  source_task_id: string;
  created_at: string;
  content_json: string;
  approval_count: number;
  activation_count: number;
}

/**
 * Queries the SQLite DB for V1 Artificer artifacts.
 *
 * V1 criteria:
 * - pi_artifacts.artifact_kind = 'principle'
 * - tasks.task_kind = 'artificer' (joined via source_task_id)
 * - content_json lacks a non-empty implementationCode (checked in JS via isV1ArtificerArtifact)
 *
 * Returns the list of V1 artifacts with their approval/activation counts.
 */
export function findV1ArtificerArtifacts(db: Database): V1ArtifactTarget[] {
  // Check if pi_artifacts table exists (graceful degradation for fresh workspaces)
  const tableExists = db.prepare(
    "SELECT name FROM sqlite_master WHERE type='table' AND name='pi_artifacts'"
  ).get() as { name: string } | undefined;
  if (!tableExists) {
    return [];
  }

  const rows = db.prepare(`
    SELECT
      a.artifact_id,
      a.source_task_id,
      a.created_at,
      a.content_json,
      (SELECT COUNT(*) FROM approvals p WHERE p.artifact_id = a.artifact_id) AS approval_count,
      (SELECT COUNT(*) FROM activations act WHERE act.artifact_id = a.artifact_id) AS activation_count
    FROM pi_artifacts a
    JOIN tasks t ON a.source_task_id = t.task_id
    WHERE a.artifact_kind = 'principle' AND t.task_kind = 'artificer'
  `).all() as V1ArtifactRow[];

  const targets: V1ArtifactTarget[] = [];
  for (const row of rows) {
    if (isV1ArtificerArtifact(row.content_json)) {
      targets.push({
        artifactId: row.artifact_id,
        sourceTaskId: row.source_task_id,
        createdAt: row.created_at,
        approvalCount: row.approval_count,
        activationCount: row.activation_count,
      });
    }
  }
  return targets;
}

/**
 * Applies V1 artifact cleanup: deletes activations → approvals → pi_artifacts.
 * Order matters: delete dependents first to avoid orphan references (no FK cascade).
 *
 * Wrapped in a SQLite transaction so the 3 deletions are atomic — if any fails,
 * all roll back and no orphan rows are left behind.
 *
 * Returns counts of deleted rows per table.
 */
function applyV1ArtifactCleanup(
  db: Database,
  artifactIds: string[]
): { deletedArtifacts: number; deletedApprovals: number; deletedActivations: number } {
  if (artifactIds.length === 0) {
    return { deletedArtifacts: 0, deletedApprovals: 0, deletedActivations: 0 };
  }

  const placeholders = artifactIds.map(() => '?').join(', ');

  // Transaction ensures atomicity: all 3 deletions succeed or all roll back
  const cleanupTransaction = db.transaction(() => {
    // 1. Delete activations first (dependents)
    const delActivations = db.prepare(
      `DELETE FROM activations WHERE artifact_id IN (${placeholders})`
    ).run(...artifactIds);

    // 2. Delete approvals (dependents)
    const delApprovals = db.prepare(
      `DELETE FROM approvals WHERE artifact_id IN (${placeholders})`
    ).run(...artifactIds);

    // 3. Delete pi_artifacts (principal)
    const delArtifacts = db.prepare(
      `DELETE FROM pi_artifacts WHERE artifact_id IN (${placeholders})`
    ).run(...artifactIds);

    return {
      deletedArtifacts: delArtifacts.changes,
      deletedApprovals: delApprovals.changes,
      deletedActivations: delActivations.changes,
    };
  });

  return cleanupTransaction();
}

// ── File-system cleanup (existing functionality) ────────────────────────────

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

/**
 * Validate a workspace root before cleanup scans derive paths from it.
 * Uses `path.normalize` (pure string normalization, no filesystem access)
 * to collapse `..` segments, then rejects empty, parent-traversal, and
 * filesystem-root paths (CWE-22 boundary guard). No `path.isAbsolute`
 * check: absolute-ness is platform-dependent (a Windows-style path is not
 * absolute on POSIX runners) and relative paths resolve inside cwd.
 */
function assertCleanupWorkspaceRoot(workspacePath: string): string {
  if (!workspacePath || workspacePath.trim().length === 0) {
    throw new Error('Invalid workspace path: path is empty');
  }
  const normalized = path.normalize(workspacePath);
  if (normalized.split(/[\\/]/).includes('..')) {
    throw new Error(`Invalid workspace path: "${workspacePath}" contains parent traversal`);
  }
  if (normalized === path.parse(normalized).root) {
    throw new Error(`Invalid workspace path: "${workspacePath}" resolves to filesystem root`);
  }
  return normalized;
}

function findLegacyTargets(workspacePath: string): CleanupTarget[] {
  const targets: CleanupTarget[] = [];
  // CWE-22: resolve the workspace root once and verify it is a valid,
  // non-root directory so every derived path stays inside the boundary.
  const workspaceRoot = assertCleanupWorkspaceRoot(workspacePath);
  const stateDir = path.join(workspaceRoot, '.state');
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
      const filePath = path.resolve(sessionsDir, file);
      // CWE-22: verify the joined path stays inside the sessions dir before
      // any filesystem access (readdir results are trusted, but defense-in-depth).
      if (!filePath.startsWith(sessionsDir + path.sep)) continue;
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

// ── Main handler ────────────────────────────────────────────────────────────

export async function handleLegacyCleanup(opts: LegacyCleanupOptions): Promise<LegacyCleanupResult> {
  // CLI gate rule 4: --dry-run and --apply are mutually exclusive
  if (opts.dryRun && opts.apply) {
    const result: LegacyCleanupResult = {
      status: 'failed',
      mode: 'dry-run',
      fileTargets: [],
      v1Artifacts: [],
      appliedFiles: 0,
      appliedV1Artifacts: 0,
      appliedApprovals: 0,
      appliedActivations: 0,
      errors: [],
      reason: '--dry-run and --apply are mutually exclusive',
      nextAction: 'Specify either --dry-run or --apply, not both',
    };
    if (opts.json) {
      console.log(JSON.stringify(result, null, 2));
    } else {
      console.error('Error: --dry-run and --apply are mutually exclusive');
    }
    process.exitCode = 1;
    return result;
  }

  // Default to dry-run if neither flag is set (CLI gate rule 4: default to dry-run)
  // Apply mode if --apply is true OR --dry-run is explicitly false
  const isDryRun = opts.apply === true ? false : opts.dryRun !== false;

  const { workspacePath } = opts;
  const errors: string[] = [];

  // ── File cleanup (existing functionality) ──
  const fileTargets = findLegacyTargets(workspacePath);
  let appliedFiles = 0;

  if (!isDryRun) {
    for (const t of fileTargets) {
      try {
        if (t.action === 'archive' && t.archivePath) {
          const archiveDir = path.dirname(t.archivePath);
          if (!fs.existsSync(archiveDir)) {
            fs.mkdirSync(archiveDir, { recursive: true });
          }
          fs.copyFileSync(t.path, t.archivePath);
          fs.unlinkSync(t.path);
        } else {
          fs.unlinkSync(t.path);
        }
        appliedFiles++;
      } catch (err) {
        errors.push(`File cleanup error for ${t.path}: ${String(err)}`);
      }
    }
  }

  // ── V1 Artificer artifact cleanup (PRI-439 Phase 6) ──
  let v1Artifacts: V1ArtifactTarget[] = [];
  let appliedV1Artifacts = 0;
  let appliedApprovals = 0;
  let appliedActivations = 0;

  const dbPath = path.join(workspacePath, '.pd', 'state.db');
  if (fs.existsSync(dbPath)) {
    let stateManager: RuntimeStateManager | null = null;
    try {
      stateManager = new RuntimeStateManager({ workspaceDir: workspacePath });
      await stateManager.initialize();
      const db = stateManager.connection.getDb();

      v1Artifacts = findV1ArtificerArtifacts(db);

      if (!isDryRun && v1Artifacts.length > 0) {
        const artifactIds = v1Artifacts.map(t => t.artifactId);
        const deleted = applyV1ArtifactCleanup(db, artifactIds);
        appliedV1Artifacts = deleted.deletedArtifacts;
        appliedApprovals = deleted.deletedApprovals;
        appliedActivations = deleted.deletedActivations;
      }
    } catch (err) {
      errors.push(`V1 artifact cleanup error: ${String(err)}`);
    } finally {
      if (stateManager) {
        await stateManager.close();
      }
    }
  }

  // ── Build result ──
  const status: LegacyCleanupResult['status'] = errors.length > 0 ? 'partial' : 'ok';
  const result: LegacyCleanupResult = {
    status,
    mode: isDryRun ? 'dry-run' : 'apply',
    fileTargets,
    v1Artifacts,
    appliedFiles,
    appliedV1Artifacts,
    appliedApprovals,
    appliedActivations,
    errors,
  };

  if (status === 'partial') {
    result.reason = `${errors.length} error(s) occurred during cleanup`;
    result.nextAction = 'Review errors array and re-run after fixing issues';
  }

  // ── Output ──
  if (opts.json) {
    console.log(JSON.stringify(result, null, 2));
  } else {
    const modeLabel = isDryRun ? 'DRY RUN' : 'APPLY';
    console.log(`\n=== ${modeLabel}: Legacy cleanup ===`);

    console.log(`\n── File cleanup (${fileTargets.length} target(s)) ──`);
    if (fileTargets.length === 0) {
      console.log('  No legacy files found.');
    }
    for (const t of fileTargets) {
      console.log(`  ${t.action}: ${t.path}`);
      console.log(`         Reason: ${t.reason}`);
      if (t.archivePath) {
        console.log(`         Archive: ${t.archivePath}`);
      }
    }
    if (!isDryRun) {
      console.log(`  Applied: ${appliedFiles} file(s)`);
    }

    console.log(`\n── V1 Artificer artifacts (${v1Artifacts.length} found) ──`);
    if (v1Artifacts.length === 0) {
      console.log('  No V1 Artificer artifacts found.');
    }
    for (const a of v1Artifacts) {
      console.log(`  ${a.artifactId} (task: ${a.sourceTaskId})`);
      console.log(`    approvals: ${a.approvalCount}, activations: ${a.activationCount}`);
    }
    if (!isDryRun) {
      console.log(`  Applied: ${appliedV1Artifacts} artifact(s), ${appliedApprovals} approval(s), ${appliedActivations} activation(s)`);
    }

    if (errors.length > 0) {
      console.log(`\n── Errors (${errors.length}) ──`);
      for (const e of errors) {
        console.log(`  ${e}`);
      }
    }
  }

  return result;
}
