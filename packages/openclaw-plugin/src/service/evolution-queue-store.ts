/**
 * Evolution Queue Store — Encapsulated queue persistence layer
 *
 * Extracts all queue I/O (read/write/migrate/purge/lock) from evolution-worker.ts
 * into a dedicated class with write/read validation contracts.
 *
 * Design decisions:
 * - D-01: Class instantiated with workspaceDir, follows EvolutionEngine pattern
 * - D-02: Permissive validation (required fields only, ignore unknowns)
 * - D-03: All public methods auto-acquire/release file lock internally
 * - D-05: Corrupted reads return structured error (not silent fallback)
 */

import * as fs from 'fs';
import * as path from 'path';
import { createHash } from 'crypto';
import { resolvePdPath } from '../core/paths.js';
import { withLockAsync } from '../utils/file-lock.js';
import type { TaskKind, TaskPriority } from '../core/trajectory-types.js';

class QueueValidationError extends Error {
  constructor(taskId: string, reasons: string[]) {
    super(`[PD:Queue] Invalid queue item ${taskId}: ${reasons.join('; ')}`);
    this.name = 'QueueValidationError';
  }
}

// ── Types (relocated from evolution-worker.ts L175-274) ────────────────────

export type QueueStatus = 'pending' | 'in_progress' | 'completed' | 'failed' | 'canceled';
export type TaskResolution =
  | 'marker_detected'
  | 'auto_completed_timeout'
  | 'failed_max_retries'
  | 'runtime_unavailable'
  | 'canceled'
  | 'late_marker_principle_created'
  | 'late_marker_no_principle'
  | 'stub_fallback';

/**
 * Recent pain context attached to sleep_reflection tasks.
 */
export interface RecentPainContext {
  /** Most recent unresolved pain event */
  mostRecent: {
    score: number;
    source: string;
    reason: string;
    timestamp: string;
    /** Session ID where the pain occurred */
    sessionId: string;
  } | null;
  /** Count of pain events in the recent window (for signal strength) */
  recentPainCount: number;
  /** Highest pain score in the recent window */
  recentMaxPainScore: number;
}

export interface EvolutionQueueItem {
  // Core identity
  id: string;
  taskKind: TaskKind;
  priority: TaskPriority;
  source: string;
  traceId?: string;

  // Legacy fields (still used for pain_diagnosis)
  task?: string;
  score: number;
  reason: string;
  timestamp: string;
  enqueued_at?: string;
  started_at?: string;
  completed_at?: string;
  assigned_session_key?: string;
  trigger_text_preview?: string;
  status: QueueStatus;
  resolution?: TaskResolution;
  session_id?: string;
  agent_id?: string;

  // V2 retry support
  retryCount: number;
  maxRetries: number;
  lastError?: string;

  // V2 result reference
  resultRef?: string;

  // V2: Recent pain context for sleep_reflection tasks
  recentPainContext?: RecentPainContext;
}

/**
 * Legacy queue item shape (pre-V2) for migration compatibility.
 */
interface LegacyEvolutionQueueItem {
  id: string;
  task?: string;
  score: number;
  source: string;
  reason: string;
  timestamp: string;
  enqueued_at?: string;
  started_at?: string;
  completed_at?: string;
  assigned_session_key?: string;
  trigger_text_preview?: string;
  status?: string;
  resolution?: string;
  session_id?: string;
  agent_id?: string;
  traceId?: string;
  taskKind?: string;
  priority?: string;
  retryCount?: number;
  maxRetries?: number;
  lastError?: string;
  resultRef?: string;
}

type RawQueueItem = Record<string, unknown>;

// ── Validation result types (new per D-02, CONTRACT-01, CONTRACT-02) ──────

export interface QueueItemValidationResult {
  status: 'valid' | 'invalid';
  reasons: string[];
  item?: EvolutionQueueItem;
}

export interface QueueLoadResult {
  status: 'ok' | 'corrupted';
  reasons: string[];
  queue: EvolutionQueueItem[];
  backupPath?: string;
}

// ── Constants (relocated from evolution-worker.ts) ─────────────────────────

const DEFAULT_TASK_KIND: TaskKind = 'pain_diagnosis';
const DEFAULT_PRIORITY: TaskPriority = 'medium';
const DEFAULT_MAX_RETRIES = 3;
const PAIN_QUEUE_DEDUP_WINDOW_MS = 30 * 60 * 1000;
const STALE_FAILED_TASK_MAX_AGE_MS = 24 * 60 * 60 * 1000; // 24 hours

// Lock constants (private to class)
const LOCK_SUFFIX = '.lock';
const LOCK_MAX_RETRIES = 50;
const LOCK_RETRY_DELAY_MS = 50;
const LOCK_STALE_MS = 30_000;

// ── Validation ─────────────────────────────────────────────────────────────

const REQUIRED_FIELDS = ['id', 'taskKind', 'priority', 'source', 'score', 'reason', 'timestamp', 'status', 'retryCount', 'maxRetries'] as const;
const VALID_STATUSES: readonly string[] = ['pending', 'in_progress', 'completed', 'failed', 'canceled'];

/**
 * Permissive write validation — checks required fields only, ignores unknowns (D-02).
 */
function validateQueueItemForWrite(raw: unknown): QueueItemValidationResult {
  if (!raw || typeof raw !== 'object') {
    return { status: 'invalid', reasons: ['Item is not an object'] };
  }
  const item = raw as Record<string, unknown>;
  const reasons: string[] = [];

  for (const field of REQUIRED_FIELDS) {
    if (!(field in item) || item[field] === undefined || item[field] === null) {
      reasons.push(`Missing required field: ${field}`);
    }
  }

  // Validate status is one of the known values
  if ('status' in item && typeof item.status === 'string' && !VALID_STATUSES.includes(item.status)) {
    reasons.push(`Invalid status: ${item.status}`);
  }

  if (reasons.length > 0) {
    return { status: 'invalid', reasons };
  }

  return { status: 'valid', reasons: [], item: item as unknown as EvolutionQueueItem };
}

/**
 * Permissive read validation — same check as write (D-02).
 * Used after JSON parse + migration to detect corruption.
 */
function validateQueueItemForRead(raw: unknown): QueueItemValidationResult {
  return validateQueueItemForWrite(raw);
}

// ── Migration (relocated from evolution-worker.ts L276-318) ────────────────

function migrateToV2(item: LegacyEvolutionQueueItem): EvolutionQueueItem {
  return {
    id: item.id,
    taskKind: (item.taskKind as TaskKind) || DEFAULT_TASK_KIND,
    priority: (item.priority as TaskPriority) || DEFAULT_PRIORITY,
    source: item.source,
    traceId: item.traceId,
    task: item.task,
    score: item.score,
    reason: item.reason,
    timestamp: item.timestamp,
    enqueued_at: item.enqueued_at,
    started_at: item.started_at,
    completed_at: item.completed_at,
    assigned_session_key: item.assigned_session_key,
    trigger_text_preview: item.trigger_text_preview,
    status: (item.status as QueueStatus) || 'pending',
    resolution: item.resolution as TaskResolution | undefined,
    session_id: item.session_id,
    agent_id: item.agent_id,
    retryCount: item.retryCount || 0,
    maxRetries: item.maxRetries || DEFAULT_MAX_RETRIES,
    lastError: item.lastError,
    resultRef: item.resultRef,
  };
}

function isLegacyQueueItem(item: RawQueueItem): boolean {
  return item != null && typeof item === 'object' && !('taskKind' in item);
}

function migrateQueueToV2(queue: RawQueueItem[]): EvolutionQueueItem[] {
  return queue.map(item =>
    isLegacyQueueItem(item)
      ? migrateToV2(item as unknown as LegacyEvolutionQueueItem)
      : (item as unknown as EvolutionQueueItem)
  );
}

// ── Dedup helpers (relocated from evolution-worker.ts L429-498) ────────────

function normalizePainDedupKey(source: string, preview: string, reason?: string): string {
  const normalizedReason = (reason || '').trim().toLowerCase();
  return `${source.trim().toLowerCase()}::${preview.trim().toLowerCase()}::${normalizedReason}`;
}

// ── EvolutionQueueStore class ──────────────────────────────────────────────

export class EvolutionQueueStore {
  private readonly workspaceDir: string;
  private readonly queuePath: string;
  private readonly lockOptions: {
    lockSuffix: string;
    maxRetries: number;
    baseRetryDelayMs: number;
    lockStaleMs: number;
  };

  /**
   * @param workspaceDir - The workspace directory (used to compute default queue path)
   * @param queuePathOverride - Optional: override the queue path (e.g., for test mocks or custom paths)
   */
  constructor(workspaceDir: string, queuePathOverride?: string) {
    this.workspaceDir = workspaceDir;
    this.queuePath = queuePathOverride ?? resolvePdPath(workspaceDir, 'EVOLUTION_QUEUE');
    this.lockOptions = {
      lockSuffix: LOCK_SUFFIX,
      maxRetries: LOCK_MAX_RETRIES,
      baseRetryDelayMs: LOCK_RETRY_DELAY_MS,
      lockStaleMs: LOCK_STALE_MS,
    };
  }

  // ── Public API ─────────────────────────────────────────────────────────

  /**
   * Load queue from disk with validation and migration (CONTRACT-02, D-05).
   * Auto-acquires file lock.
   */
  async load(): Promise<QueueLoadResult> {
    return withLockAsync(this.queuePath, async () => {
      // File does not exist → empty queue
      if (!fs.existsSync(this.queuePath)) {
        return { status: 'ok' as const, reasons: [], queue: [] };
      }

      let rawContent: string;
      try {
        rawContent = fs.readFileSync(this.queuePath, 'utf8');
      } catch (readErr) {
        // Backup corrupted file
        const backupPath = `${this.queuePath}.corrupted.${Date.now()}`;
        try {
          fs.renameSync(this.queuePath, backupPath);
        } catch {
          // If rename fails, just report corruption without backup
        }
        return {
          status: 'corrupted' as const,
          reasons: [`Read error: ${readErr instanceof Error ? readErr.message : String(readErr)}`],
          queue: [],
          backupPath: fs.existsSync(backupPath) ? backupPath : undefined,
        };
      }

      let rawQueue: RawQueueItem[];
      try {
        rawQueue = JSON.parse(rawContent);
      } catch (parseErr) {
        // Backup corrupted file
        const backupPath = `${this.queuePath}.corrupted.${Date.now()}`;
        try {
          fs.renameSync(this.queuePath, backupPath);
        } catch {
          // If rename fails, report without backup
        }
        return {
          status: 'corrupted' as const,
          reasons: [`Parse error: ${parseErr instanceof Error ? parseErr.message : String(parseErr)}`],
          queue: [],
          backupPath: fs.existsSync(backupPath) ? backupPath : undefined,
        };
      }

      // Migrate legacy items
      const migrated = migrateQueueToV2(rawQueue);

      // Validate each item
      const validItems: EvolutionQueueItem[] = [];
      const allReasons: string[] = [];

      for (let i = 0; i < migrated.length; i++) {
        const result = validateQueueItemForRead(migrated[i]);
        if (result.status === 'valid' && result.item) {
          validItems.push(result.item);
        } else {
          allReasons.push(...result.reasons.map(r => `Item ${i}: ${r}`));
        }
      }

      if (allReasons.length > 0) {
        return { status: 'corrupted' as const, reasons: allReasons, queue: validItems };
      }

      return { status: 'ok' as const, reasons: [], queue: validItems };
    }, this.lockOptions);
  }

  /**
   * Save queue to disk with write validation (CONTRACT-01).
   * Auto-acquires file lock.
   */
  async save(queue: EvolutionQueueItem[]): Promise<void> {
    return withLockAsync(this.queuePath, async () => {
      // Validate each item
      for (const item of queue) {
        const result = validateQueueItemForWrite(item);
        if (result.status === 'invalid') {
          throw new QueueValidationError(item.id ?? 'unknown', result.reasons);
        }
      }

      // Ensure directory exists
      const dir = path.dirname(this.queuePath);
      if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
      }

      fs.writeFileSync(this.queuePath, JSON.stringify(queue, null, 2), 'utf8');
    }, this.lockOptions);
  }

  /**
   * Add a single item to the queue.
   * Auto-acquires file lock.
   */
  async add(item: EvolutionQueueItem): Promise<void> {
    return withLockAsync(this.queuePath, async () => {
      // Validate new item
      const result = validateQueueItemForWrite(item);
      if (result.status === 'invalid') {
        throw new QueueValidationError(item.id ?? 'unknown', result.reasons);
      }

      // Read existing queue
      let existing: EvolutionQueueItem[] = [];
      if (fs.existsSync(this.queuePath)) {
        try {
          const raw = JSON.parse(fs.readFileSync(this.queuePath, 'utf8'));
          existing = migrateQueueToV2(raw);
        } catch {
          // Start with empty if file is malformed
        }
      }

      existing.push(item);

      // Ensure directory exists
      const dir = path.dirname(this.queuePath);
      if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
      }

      fs.writeFileSync(this.queuePath, JSON.stringify(existing, null, 2), 'utf8');
    }, this.lockOptions);
  }

  /**
   * Update queue atomically via updater function.
   * Auto-acquires file lock.
   */
  async update(updater: (queue: EvolutionQueueItem[]) => EvolutionQueueItem[]): Promise<void> {
    return withLockAsync(this.queuePath, async () => {
      // Read existing queue
      let existing: EvolutionQueueItem[] = [];
      if (fs.existsSync(this.queuePath)) {
        try {
          const raw = JSON.parse(fs.readFileSync(this.queuePath, 'utf8'));
          existing = migrateQueueToV2(raw);
        } catch {
          // Start with empty
        }
      }

      const updated = updater(existing);

      // Validate result
      for (const item of updated) {
        const result = validateQueueItemForWrite(item);
        if (result.status === 'invalid') {
          throw new QueueValidationError(item.id ?? 'unknown', result.reasons);
        }
      }

      // Ensure directory exists
      const dir = path.dirname(this.queuePath);
      if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
      }

      fs.writeFileSync(this.queuePath, JSON.stringify(updated, null, 2), 'utf8');
    }, this.lockOptions);
  }

  /**
   * Register a session key on an in-progress task (relocated from L1780-1819).
   * Auto-acquires file lock.
   */
  async registerSession(
    taskId: string,
    sessionKey: string,
    logger?: { warn?: (m: string) => void; info?: (m: string) => void }
  ): Promise<boolean> {
    return withLockAsync(this.queuePath, async () => {
      if (!fs.existsSync(this.queuePath)) return false;

      let rawQueue: RawQueueItem[];
      try {
        rawQueue = JSON.parse(fs.readFileSync(this.queuePath, 'utf8'));
      } catch (parseErr) {
        logger?.warn?.(`[PD:QueueStore] Failed to parse EVOLUTION_QUEUE for session registration: ${this.queuePath} - ${parseErr instanceof Error ? parseErr.message : String(parseErr)}`);
        return false;
      }

      // Migrate queue to current schema
      const queue: EvolutionQueueItem[] = migrateQueueToV2(rawQueue);

      const task = queue.find((item) => item.id === taskId && item.status === 'in_progress');
      if (!task) {
        logger?.warn?.(`[PD:QueueStore] Could not find in-progress evolution task ${taskId} for session assignment`);
        return false;
      }

      task.assigned_session_key = sessionKey;
      if (!task.started_at) {
        task.started_at = new Date().toISOString();
      }
      fs.writeFileSync(this.queuePath, JSON.stringify(queue, null, 2), 'utf8');
      return true;
    }, this.lockOptions);
  }

  /**
   * Expose lock scope for callers needing atomic multi-step operations (D-03).
   * Used by processEvolutionQueue's two-phase load-modify-save pattern.
   */
  async withLock<T>(fn: () => Promise<T>): Promise<T> {
    return withLockAsync(this.queuePath, fn, this.lockOptions);
  }

  // ── Synchronous helpers (no file I/O, operate on in-memory queue) ──────

  /**
   * Purge stale failed tasks from the queue (relocated from L456-486).
   * Pure function — mutates queue array in place.
   */
  purge(
    queue: EvolutionQueueItem[],
    logger?: { info?: (m: string) => void }
  ): { purged: number; remaining: number; byReason: Record<string, number> } {
    const cutoff = Date.now() - STALE_FAILED_TASK_MAX_AGE_MS;
    const byReason: Record<string, number> = {};

    const purged = queue.filter((t) => {
      if (t.status !== 'failed') return false;
      const taskTime = new Date(t.timestamp || t.enqueued_at || 0).getTime();
      if (!Number.isFinite(taskTime) || taskTime > cutoff) return false;
      const reason = t.lastError || t.resolution || 'unknown';
      byReason[reason] = (byReason[reason] || 0) + 1;
      return true;
    });

    if (purged.length === 0) return { purged: 0, remaining: queue.length, byReason };

    // Remove purged items from the queue (mutates in place)
    const purgedIds = new Set(purged.map((t) => t.id));
    for (let i = queue.length - 1; i >= 0; i--) {
      if (purgedIds.has(queue[i].id)) queue.splice(i, 1);
    }

    const summary = Object.entries(byReason)
      .map(([r, c]) => `${c}x ${r}`)
      .join('; ');
    logger?.info?.(`[PD:QueueStore] Purged ${purged.length} stale failed tasks (>24h): ${summary}`);

    return { purged: purged.length, remaining: queue.length, byReason };
  }

  /**
   * Find a recent duplicate task in the queue (relocated from L429-445).
   */
  findRecentDuplicate(
    queue: EvolutionQueueItem[],
    source: string,
    preview: string,
    now: number,
    reason?: string
  ): EvolutionQueueItem | undefined {
    const key = normalizePainDedupKey(source, preview, reason);
    return queue.find((task) => {
      if (task.status === 'completed') return false;
      const taskTime = new Date(task.enqueued_at || task.timestamp).getTime();
      if (!Number.isFinite(taskTime) || (now - taskTime) > PAIN_QUEUE_DEDUP_WINDOW_MS) return false;
      return normalizePainDedupKey(task.source, task.trigger_text_preview || '', task.reason) === key;
    });
  }

  /**
   * Check if a recent duplicate exists (convenience wrapper).
   */
  hasRecentDuplicate(
    queue: EvolutionQueueItem[],
    source: string,
    preview: string,
    now: number,
    reason?: string
  ): boolean {
    return !!this.findRecentDuplicate(queue, source, preview, now, reason);
  }

  /**
   * Check if an equivalent promoted rule exists in the dictionary (relocated from L500-512).
   */
  hasEquivalentPromotedRule(
    dictionary: { getAllRules(): Record<string, { type: string; phrases?: string[]; pattern?: string; status: string }> },
    phrase: string
  ): boolean {
    const normalizedPhrase = phrase.trim().toLowerCase();
    return Object.values(dictionary.getAllRules()).some((rule) => {
      if (rule.status !== 'active') return false;
      if (rule.type === 'exact_match' && Array.isArray(rule.phrases)) {
        return rule.phrases.some((candidate) => candidate.trim().toLowerCase() === normalizedPhrase);
      }
      if (rule.type === 'regex' && typeof rule.pattern === 'string') {
        return rule.pattern.trim().toLowerCase() === normalizedPhrase;
      }
      return false;
    });
  }

  // ── Static helpers (preserve exact signatures from evolution-worker.ts) ─

  /**
   * Create a deterministic task ID (relocated from L381-394).
   */
  static createTaskId(
    source: string,
    score: number,
    preview: string,
    reason: string,
    now: number
  ): string {
    return createHash('md5')
      .update(`${source}:${score}:${preview}:${reason}:${now}`)
      .digest('hex')
      .substring(0, 8);
  }

  /**
   * Extract task ID from a string containing [ID: xxx] (relocated from L422-426).
   */
  static extractTaskId(task: string): string | null {
    if (!task) return null;
    const match = /\[ID:\s*([A-Za-z0-9_-]+)\]/.exec(task);
    return match?.[1] || null;
  }
}
