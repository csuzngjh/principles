#!/usr/bin/env node
/**
 * Validate Live Path Script (Phase 18)
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

  // 1. Check bootstrapped rules
  // eslint-disable-next-line @typescript-eslint/init-declarations
  let rules: LedgerRule[];
  try {
    rules = loadBootstrappedRules();
  } catch {
    console.error('FAIL: principle_training_state.json not found. Run Phase 17 bootstrap first: npm run bootstrap-rules');
    process.exit(1);
  }

  if (rules.length === 0) {
    console.error('FAIL: No _stub_bootstrap rules found. Run Phase 17 bootstrap first: npm run bootstrap-rules');
    process.exit(1);
  }

  if (verbose) {
    console.log(`Found ${rules.length} bootstrapped rule(s)`);
    for (const rule of rules) {
      console.log(`  - ${rule.id} (principleId=${rule.principleId}, action=${rule.action})`);
    }
  }

  // 2. Generate task ID
  const taskId = `validation-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

  // 3. Build synthetic snapshot for validation
  const snapshot = buildSyntheticSnapshot(taskId);
  if (verbose) {
    console.log(`Created synthetic snapshot: sessionId=${snapshot.sessionId}`);
  }

  // 4. Enqueue task (with lock acquisition)
  try {
    await enqueueSleepReflectionTask(taskId);
    if (verbose) {
      console.log(`Enqueued sleep_reflection task: ${taskId}`);
    }
  } catch (error: unknown) {
    console.error('FAIL: Failed to enqueue sleep_reflection task:', String(error));
    process.exit(1);
  }

  // 5. Poll for completion
  const deadline = Date.now() + POLL_TIMEOUT_MS;
  if (verbose) {
    console.log('Polling for workflow completion...');
  }

  while (Date.now() < deadline) {
    await new Promise(resolve => setTimeout(resolve, POLL_INTERVAL_MS));

    const result = verifyWorkflowCompletion(taskId);
    if (result) {
      console.log(`RESULT: workflow=${result.workflowId} state=${result.state} resolution=${result.resolution} taskId=${taskId}`);

      if (result.resolution === 'MISSING' || result.resolution === 'expired') {
        console.error('FAIL: resolution not explicit');
        process.exit(1);
      }

      console.log('PASS: Live path validation successful');
      process.exit(0);
    }

    if (verbose) {
      process.stdout.write('.');
    }
  }

  console.error('FAIL: Poll timeout — no completed nocturnal workflow found for taskId');
  process.exit(1);
}

main().catch(err => {
  console.error('FAIL:', err);
  process.exit(1);
});
