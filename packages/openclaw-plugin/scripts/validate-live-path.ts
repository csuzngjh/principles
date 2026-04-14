#!/usr/bin/env node
/**
 * Validate Live Path Script (Phase 18) — with Data Flow Monitoring
 *
 * Validates the end-to-end nocturnal workflow path with bootstrapped principles.
 *
 * Purpose:
 * - Reads bootstrapped rules from principle_training_state.json
 * - Creates synthetic snapshot with recentPain to pass hasUsableNocturnalSnapshot() guard
 * - Enqueues sleep_reflection task with proper file locking
 * - Polls subagent_workflows.db directly for nocturnal workflows
 * - Correlates workflow to queue item via taskId
 * - Verifies state='completed' and explicit resolution (not 'expired')
 * - Monitors data flow: queue state → workflow state → artifact persistence
 * - Outputs summary and exits 0 on success, non-zero on failure
 *
 * Usage:
 *   tsx scripts/validate-live-path.ts [--verbose]
 *
 * Environment:
 *   WORKSPACE_DIR - Optional workspace directory (defaults to process.cwd())
 */

import * as Database from 'better-sqlite3';
import * as fs from 'fs';
import * as path from 'path';

// ─── Constants ───────────────────────────────────────────────────────────
const POLL_INTERVAL_MS = 5_000;
const POLL_TIMEOUT_MS = 5 * 60 * 1000;  // 5 minutes
const LOCK_SUFFIX = '.lock';
const LOCK_MAX_RETRIES = 50;
const LOCK_RETRY_DELAY_MS = 50;
const LOCK_STALE_MS = 30_000;
const WORKSPACE_DIR = process.env.WORKSPACE_DIR || process.cwd();
const STATE_DIR = path.join(WORKSPACE_DIR, '.state');
const QUEUE_PATH = path.join(STATE_DIR, 'EVOLUTION_QUEUE');
const LEDGER_PATH = path.join(STATE_DIR, 'principle_training_state.json');
const DB_PATH = path.join(STATE_DIR, 'subagent_workflows.db');
const PAIN_FLAG_PATH = path.join(STATE_DIR, '.pain_flag');
const SAMPLES_DIR = path.join(STATE_DIR, 'nocturnal', 'samples');

// ─── Helpers ─────────────────────────────────────────────────────────────
function timestamp(): string {
  return new Date().toISOString();
}

function logStep(step: string, detail: string): void {
  console.log(`[${timestamp()}] ▸ ${step}: ${detail}`);
}

function logData(label: string, data: unknown): void {
  const display = typeof data === 'string' ? data : JSON.stringify(data).slice(0, 300);
  console.log(`[${timestamp()}]   📦 ${label}: ${display}`);
}

function safeReadJson(filePath: string): unknown {
  try {
    if (!fs.existsSync(filePath)) return null;
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch { return null; }
}

// ─── Types ───────────────────────────────────────────────────────────────
interface LedgerRule {
  id: string;
  principleId: string;
  action: string;
  type: string;
}

interface HybridLedgerStore {
  tree: {
    rules: Record<string, LedgerRule>;
  };
}

interface WorkflowRow {
  workflow_id: string;
  workflow_type: string;
  state: string;
  metadata_json: string;
  created_at: number;
}

interface QueueItem {
  id: string;
  taskKind: string;
  status: string;
  resolution?: string;
  resultRef?: string;
}

interface LockContext {
  lockPath: string;
  pid: number;
  release: () => void;
}

// ─── File Lock Functions (simplified from file-lock.ts) ──────────────────
async function acquireLockAsync(filePath: string, options: {
  lockSuffix?: string;
  maxRetries?: number;
  baseRetryDelayMs?: number;
  lockStaleMs?: number;
} = {}): Promise<LockContext> {
  const lockSuffix = options.lockSuffix ?? LOCK_SUFFIX;
  const maxRetries = options.maxRetries ?? LOCK_MAX_RETRIES;
  const baseRetryDelayMs = options.baseRetryDelayMs ?? LOCK_RETRY_DELAY_MS;
  const lockStaleMs = options.lockStaleMs ?? LOCK_STALE_MS;
  const { pid } = process;
  const lockPath = filePath + lockSuffix;

  for (let attempt = 0; attempt < maxRetries; attempt++) {
    try {
      // Check if lock file exists and is stale
      if (fs.existsSync(lockPath)) {
        const lockContent = fs.readFileSync(lockPath, 'utf8');
        const lockPid = parseInt(lockContent, 10);
        const lockStats = fs.statSync(lockPath);
        const lockAge = Date.now() - lockStats.mtimeMs;

        // Clean up stale lock
        if (lockAge > lockStaleMs) {
          fs.unlinkSync(lockPath);
        } else if (lockPid !== pid) {
          // Lock held by another process
          await new Promise(resolve => setTimeout(resolve, baseRetryDelayMs));
          continue;
        }
      }

      // Acquire lock
      fs.writeFileSync(lockPath, pid.toString(), { flag: 'wx' });
      return {
        lockPath,
        pid,
        release: () => {
          try {
            if (fs.existsSync(lockPath)) {
              fs.unlinkSync(lockPath);
            }
          } catch {
            // Ignore errors during release
          }
        },
      };
    } catch (error: unknown) {
      const err = error as { code?: string };
      if (err.code === 'EEXIST') {
        if (attempt < maxRetries - 1) {
          await new Promise(resolve => setTimeout(resolve, baseRetryDelayMs));
          continue;
        }
      }
      const lockError = new Error(`Failed to acquire lock for ${filePath}: ${String(error)}`);
      lockError.cause = error;
      throw lockError;
    }
  }

  throw new Error(`Failed to acquire lock for ${filePath} after ${maxRetries} attempts`);
}

function releaseLock(ctx: LockContext): void {
  ctx.release();
}

// ─── Step 1: Check bootstrapped rules ─────────────────────────────────────
function loadBootstrappedRules(): LedgerRule[] {
  if (!fs.existsSync(LEDGER_PATH)) {
    throw new Error('FAIL: principle_training_state.json not found. Run Phase 17 bootstrap first: npm run bootstrap-rules');
  }

  const ledger: HybridLedgerStore = JSON.parse(fs.readFileSync(LEDGER_PATH, 'utf8'));
  const bootstrappedRules = Object.values(ledger.tree.rules).filter(r =>
    r.id.endsWith('_stub_bootstrap')
  );

  return bootstrappedRules;
}

// ─── Step 2: Build synthetic snapshot ──────────────────────────────────────
function buildSyntheticSnapshot(taskId: string) {
  return {
    sessionId: `validation-${taskId}`,
    startedAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    assistantTurns: [],
    userTurns: [],
    toolCalls: [],
    painEvents: [],
    gateBlocks: [],
    stats: {
      totalAssistantTurns: 0,
      totalToolCalls: 0,
      failureCount: 0,
      totalPainEvents: 1,
      totalGateBlocks: 0,
    },
    recentPain: [{
      source: 'live-validation',
      score: 50,
      severity: 'moderate',
      reason: 'Synthetic snapshot for live path validation',
      createdAt: new Date().toISOString(),
    }],
    _dataSource: 'pain_context_fallback',
  };
}

// ─── Step 3: Enqueue sleep_reflection task with proper file locking ──────────
// Uses acquireLockAsync to prevent TOCTOU race conditions (T-18-01 mitigation)
async function enqueueSleepReflectionTask(taskId: string): Promise<void> {
  let lockCtx: LockContext | null = null;
  try {
    // Acquire lock before reading queue file (T-18-01 mitigation)
    lockCtx = await acquireLockAsync(QUEUE_PATH, {
      lockSuffix: LOCK_SUFFIX,
      maxRetries: LOCK_MAX_RETRIES,
      baseRetryDelayMs: LOCK_RETRY_DELAY_MS,
      lockStaleMs: LOCK_STALE_MS,
    });

    let queue: QueueItem[] = [];
    if (fs.existsSync(QUEUE_PATH)) {
      const queueContent = fs.readFileSync(QUEUE_PATH, 'utf8');
      queue = JSON.parse(queueContent);
    }

    queue.push({
      id: taskId,
      taskKind: 'sleep_reflection',
      status: 'pending',
    });

    fs.writeFileSync(QUEUE_PATH, JSON.stringify(queue, null, 2), 'utf8');
  } finally {
    if (lockCtx) {
      releaseLock(lockCtx);
    }
  }
}

// ─── Step 4: Poll workflow store (raw SQLite, no WorkflowStore import) ─────
// Uses better-sqlite3 directly to avoid WorkflowStore async initialization issues in standalone script
function listNocturnalWorkflows(): WorkflowRow[] {
  if (!fs.existsSync(DB_PATH)) {
    return [];
  }

  const db = new Database(DB_PATH, { readonly: true });
  const rows = db.prepare(`
    SELECT workflow_id, workflow_type, state, metadata_json, created_at
    FROM subagent_workflows
    WHERE workflow_type = 'nocturnal'
    ORDER BY created_at DESC
  `).all() as WorkflowRow[];
  db.close();
  return rows;
}

// ─── Step 5: Correlate and verify ─────────────────────────────────────────
function verifyWorkflowCompletion(taskId: string): {
  workflowId: string;
  state: string;
  resolution: string;
} | null {
  const workflows = listNocturnalWorkflows();

  for (const wf of workflows) {
    const meta = JSON.parse(wf.metadata_json);
    if (meta.taskId !== taskId) continue;
    if (wf.state !== 'completed') continue;

    // Read resolution from queue (resolution is on queue item, not on WorkflowRow)
    let queue: QueueItem[] = [];
    try {
      if (fs.existsSync(QUEUE_PATH)) {
        const queueContent = fs.readFileSync(QUEUE_PATH, 'utf8');
        queue = JSON.parse(queueContent);
      }
    } catch {
      // Queue file missing or corrupted — resolution unknown
    }

    const queueItem = queue.find(q => q.id === taskId);
    const resolution = queueItem?.resolution;

    return {
      workflowId: wf.workflow_id,
      state: wf.state,
      resolution: resolution || 'MISSING',
    };
  }

  return null;
}

// ─── Main ─────────────────────────────────────────────────────────────────
async function main() {
  const verbose = process.argv.includes('--verbose');

  console.log('╔══════════════════════════════════════════════════════════╗');
  console.log('║     Nocturnal Live Path Validation + Data Flow Monitor  ║');
  console.log('╚══════════════════════════════════════════════════════════╝');
  logStep('WORKSPACE', WORKSPACE_DIR);

  // 0. Baseline: snapshot current state
  logStep('BASELINE', 'Capturing current state before validation');
  const queueBefore = safeReadJson(QUEUE_PATH) as QueueItem[] | null;
  logData('EVOLUTION_QUEUE (before)', queueBefore?.length ?? 0);
  if (fs.existsSync(PAIN_FLAG_PATH)) {
    logData('.pain_flag', 'EXISTS — ' + fs.readFileSync(PAIN_FLAG_PATH, 'utf8').slice(0, 100));
  } else {
    logData('.pain_flag', 'not present');
  }
  if (fs.existsSync(SAMPLES_DIR)) {
    const samplesBefore = fs.readdirSync(SAMPLES_DIR).length;
    logData('nocturnal/samples/', `${samplesBefore} files`);
  } else {
    logData('nocturnal/samples/', 'directory not present');
  }
  if (fs.existsSync(DB_PATH)) {
    const wfCount = listNocturnalWorkflows().length;
    logData('subagent_workflows.db', `${wfCount} nocturnal workflows`);
  } else {
    logData('subagent_workflows.db', 'not present');
  }

  // 1. Check bootstrapped rules
  // eslint-disable-next-line @typescript-eslint/init-declarations
  let rules: LedgerRule[];
  try {
    rules = loadBootstrappedRules();
    logStep('STEP 1', `Found ${rules.length} bootstrapped rule(s)`);
  } catch {
    console.error('FAIL: principle_training_state.json not found. Run Phase 17 bootstrap first: npm run bootstrap-rules');
    process.exit(1);
  }

  if (rules.length === 0) {
    console.error('FAIL: No _stub_bootstrap rules found. Run Phase 17 bootstrap first: npm run bootstrap-rules');
    process.exit(1);
  }

  if (verbose) {
    for (const rule of rules) {
      console.log(`  - ${rule.id} (principleId=${rule.principleId}, action=${rule.action})`);
    }
  }

  // 2. Generate task ID
  const taskId = `validation-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

  // 3. Build synthetic snapshot for validation
  const snapshot = buildSyntheticSnapshot(taskId);
  logStep('STEP 2', `Synthetic snapshot: sessionId=${snapshot.sessionId}`);
  logData('snapshot.recentPain', JSON.stringify(snapshot.recentPain));

  // 4. Enqueue task (with lock acquisition)
  try {
    await enqueueSleepReflectionTask(taskId);
    logStep('STEP 3', `Enqueued sleep_reflection task: ${taskId}`);

    // Post-enqueue: verify queue state
    const queueAfter = safeReadJson(QUEUE_PATH) as QueueItem[] | null;
    const taskItem = queueAfter?.find(q => q.id === taskId);
    logData('EVOLUTION_QUEUE (after)', `${queueAfter?.length ?? 0} tasks`);
    logData(`task[${taskId}]`, taskItem ? JSON.stringify(taskItem) : 'NOT FOUND');
  } catch (error: unknown) {
    console.error('FAIL: Failed to enqueue sleep_reflection task:', String(error));
    process.exit(1);
  }

  // 5. Poll for completion — with data flow monitoring
  const deadline = Date.now() + POLL_TIMEOUT_MS;
  let pollCount = 0;
  let lastQueueStatus = 'unknown';
  let lastWorkflowState = 'none';
  logStep('STEP 4', `Polling for workflow completion (timeout: ${POLL_TIMEOUT_MS / 1000 / 60}min, interval: ${POLL_INTERVAL_MS / 1000}s)`);

  while (Date.now() < deadline) {
    pollCount++;
    await new Promise(resolve => setTimeout(resolve, POLL_INTERVAL_MS));

    // Capture queue state
    const queueNow = safeReadJson(QUEUE_PATH) as QueueItem[] | null;
    const taskNow = queueNow?.find(q => q.id === taskId);
    const currentQueueStatus = taskNow?.status ?? 'not_in_queue';

    // Capture workflow DB state
    const workflows = listNocturnalWorkflows();
    const matchingWf = workflows.find(w => {
      try {
        const meta = JSON.parse(w.metadata_json);
        return meta.taskId === taskId;
      } catch { return false; }
    });
    const currentWorkflowState = matchingWf?.state ?? 'not_in_db';

    // Log state changes
    if (currentQueueStatus !== lastQueueStatus || currentWorkflowState !== lastWorkflowState) {
      logStep(`POLL #${pollCount}`, `queue=${currentQueueStatus}, workflow=${currentWorkflowState}`);
      if (taskNow) logData('queue item', JSON.stringify({ status: taskNow.status, resolution: taskNow.resolution }));
      if (matchingWf) logData('workflow', JSON.stringify({ state: matchingWf.state, type: matchingWf.workflow_type }));
      lastQueueStatus = currentQueueStatus;
      lastWorkflowState = currentWorkflowState;
    } else if (verbose) {
      process.stdout.write('.');
    }

    // Check for completion
    const result = verifyWorkflowCompletion(taskId);
    if (result) {
      console.log(''); // newline if dots were printed
      logStep('STEP 5', `Workflow completed!`);
      logData('RESULT', `workflowId=${result.workflowId} state=${result.state} resolution=${result.resolution}`);

      // Check artifact persistence
      if (fs.existsSync(SAMPLES_DIR)) {
        const newSamples = fs.readdirSync(SAMPLES_DIR).filter(f => {
          const stat = fs.statSync(path.join(SAMPLES_DIR, f));
          return stat.isFile() && f.endsWith('.json') && (Date.now() - stat.mtimeMs) < 60000; // created in last minute
        });
        if (newSamples.length > 0) {
          logData('new artifacts', newSamples.join(', '));
          const firstArtifact = safeReadJson(path.join(SAMPLES_DIR, newSamples[0]));
          if (firstArtifact) logData('artifact content (first)', JSON.stringify(firstArtifact).slice(0, 300));
        } else {
          logData('new artifacts', 'none created in last 60s');
        }
      }

      // Check pain_flag cleanup
      if (fs.existsSync(PAIN_FLAG_PATH)) {
        const flagContent = fs.readFileSync(PAIN_FLAG_PATH, 'utf8');
        if (flagContent.includes('[object Object]')) {
          logStep('⚠️ WARNING', 'pain_flag is corrupted ([object Object])');
        } else {
          logData('.pain_flag (after)', `still exists, ${flagContent.length} bytes`);
        }
      } else {
        logData('.pain_flag (after)', 'cleaned up (file removed)');
      }

      if (result.resolution === 'MISSING' || result.resolution === 'expired') {
        console.error('FAIL: resolution not explicit');
        process.exit(1);
      }

      console.log('PASS: Live path validation successful');
      process.exit(0);
    }
  }

  // Timeout — dump final state for debugging
  console.log('');
  logStep('TIMEOUT', `Poll timeout after ${pollCount} polls (${POLL_TIMEOUT_MS / 1000 / 60}min)`);
  logData('FINAL queue status', lastQueueStatus);
  logData('FINAL workflow state', lastWorkflowState);

  // Dump full queue for debugging
  const finalQueue = safeReadJson(QUEUE_PATH);
  if (finalQueue) logData('FINAL queue dump', JSON.stringify(finalQueue).slice(0, 500));

  // Dump full workflow DB for debugging
  const finalWorkflows = listNocturnalWorkflows();
  if (finalWorkflows.length > 0) {
    logData('FINAL workflows', finalWorkflows.map(w => `${w.workflow_id}: state=${w.state}`).join(', '));
  }

  console.error('FAIL: No completed nocturnal workflow found for taskId');
  process.exit(1);
}

main().catch(err => {
  console.error('FAIL:', err);
  process.exit(1);
});
