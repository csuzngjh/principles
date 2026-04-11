import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  EvolutionQueueStore,
  QueueCorruptionError,
  QueueValidationError,
  type EvolutionQueueItem,
} from '../../src/service/evolution-queue-store.js';

describe('EvolutionQueueStore', () => {
  let tmpDir: string;
  let store: EvolutionQueueStore;
  let queuePath: string;

  const validItem: EvolutionQueueItem = {
    id: 'abc12345',
    taskKind: 'pain_diagnosis',
    priority: 'medium',
    source: 'test-source',
    score: 5,
    reason: 'test reason',
    timestamp: new Date().toISOString(),
    status: 'pending',
    retryCount: 0,
    maxRetries: 3,
  };

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pd-queue-store-test-'));
    store = new EvolutionQueueStore(tmpDir);
    queuePath = path.join(tmpDir, '.state', 'evolution_queue.json');
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  // Helper: write raw content to queue file
  function writeRaw(content: string): void {
    const dir = path.dirname(queuePath);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }
    fs.writeFileSync(queuePath, content, 'utf8');
  }

  // Helper: read raw content from queue file
  function readRaw(): string {
    return fs.readFileSync(queuePath, 'utf8');
  }

  // ── Validation ──────────────────────────────────────────────────────

  describe('validation', () => {
    it('rejects item missing required fields on write', async () => {
      const badItem = { id: 'x' } as unknown as EvolutionQueueItem;
      await expect(store.save([badItem])).rejects.toThrow(QueueValidationError);
    });

    it('accepts item with extra unknown fields on write', async () => {
      const itemWithExtra = {
        ...validItem,
        customField: 'extra value',
        anotherUnknown: 42,
      } as EvolutionQueueItem;
      await expect(store.save([itemWithExtra])).resolves.toBeUndefined();
    });

    it('rejects item with invalid status on write', async () => {
      const badStatus = { ...validItem, status: 'unknown_status' } as unknown as EvolutionQueueItem;
      await expect(store.save([badStatus])).rejects.toThrow(QueueValidationError);
    });

    it('flags item missing required fields on read', async () => {
      const items = [{ id: 'only-id' }];
      writeRaw(JSON.stringify(items));
      const result = await store.load();
      expect(result.status).toBe('corrupted');
      expect(result.reasons.length).toBeGreaterThan(0);
      // The valid items should be empty (item was invalid)
      expect(result.queue).toHaveLength(0);
    });

    it('returns corrupted status with reasons on read', async () => {
      writeRaw('not valid json {{{');
      const result = await store.load();
      expect(result.status).toBe('corrupted');
      expect(result.reasons.length).toBeGreaterThan(0);
    });
  });

  // ── Load ────────────────────────────────────────────────────────────

  describe('load', () => {
    it('returns empty queue when file does not exist', async () => {
      const result = await store.load();
      expect(result.status).toBe('ok');
      expect(result.queue).toEqual([]);
      expect(result.reasons).toEqual([]);
    });

    it('returns ok status with valid queue', async () => {
      writeRaw(JSON.stringify([validItem]));
      const result = await store.load();
      expect(result.status).toBe('ok');
      expect(result.queue).toHaveLength(1);
      expect(result.queue[0].id).toBe('abc12345');
    });

    it('backs up and returns corrupted when file is malformed JSON', async () => {
      writeRaw('{{{invalid json');
      const result = await store.load();
      expect(result.status).toBe('corrupted');
      expect(result.queue).toEqual([]);
      expect(result.reasons.some(r => r.includes('Parse error'))).toBe(true);
      // Backup should exist (file was renamed)
      expect(result.backupPath).toBeDefined();
    });

    it('migrates legacy V1 items to V2 schema', async () => {
      const legacyItem = {
        id: 'legacy1',
        source: 'legacy-source',
        score: 3,
        reason: 'legacy reason',
        timestamp: '2025-01-01T00:00:00.000Z',
        // No taskKind, no priority, no retryCount, no maxRetries
      };
      writeRaw(JSON.stringify([legacyItem]));
      const result = await store.load();
      expect(result.status).toBe('ok');
      expect(result.queue).toHaveLength(1);
      const migrated = result.queue[0];
      expect(migrated.taskKind).toBe('pain_diagnosis');
      expect(migrated.priority).toBe('medium');
      expect(migrated.retryCount).toBe(0);
      expect(migrated.maxRetries).toBe(3);
    });
  });

  // ── Save ────────────────────────────────────────────────────────────

  describe('save', () => {
    it('persists valid queue to disk', async () => {
      await store.save([validItem]);
      const content = readRaw();
      const parsed = JSON.parse(content);
      expect(parsed).toHaveLength(1);
      expect(parsed[0].id).toBe('abc12345');
    });

    it('throws QueueValidationError for invalid item', async () => {
      const badItem = { id: 'x' } as unknown as EvolutionQueueItem;
      await expect(store.save([badItem])).rejects.toThrow('Validation failed');
    });

    it('writes JSON with 2-space indentation', async () => {
      await store.save([validItem]);
      const content = readRaw();
      // 2-space indentation means lines inside arrays/objects start with "  {"
      expect(content).toContain('  "id"');
    });

    it('creates directory if it does not exist', async () => {
      // tmpDir exists but .state subdirectory does not
      expect(fs.existsSync(path.dirname(queuePath))).toBe(false);
      await store.save([validItem]);
      expect(fs.existsSync(queuePath)).toBe(true);
    });
  });

  // ── Lock management ─────────────────────────────────────────────────

  describe('lock management', () => {
    it('acquires and releases lock on save', async () => {
      await store.save([validItem]);
      // Lock file should not remain after save
      const lockPath = queuePath + '.lock';
      expect(fs.existsSync(lockPath)).toBe(false);
    });

    it('acquires and releases lock on load', async () => {
      writeRaw(JSON.stringify([validItem]));
      await store.load();
      const lockPath = queuePath + '.lock';
      expect(fs.existsSync(lockPath)).toBe(false);
    });

    it('withLock exposes lock scope to caller', async () => {
      writeRaw(JSON.stringify([validItem]));
      const result = await store.withLock(async () => {
        // Inside the lock, we can safely read
        const content = fs.readFileSync(queuePath, 'utf8');
        return JSON.parse(content) as EvolutionQueueItem[];
      });
      expect(result).toHaveLength(1);
      // Lock released after withLock
      const lockPath = queuePath + '.lock';
      expect(fs.existsSync(lockPath)).toBe(false);
    });
  });

  // ── Add ─────────────────────────────────────────────────────────────

  describe('add', () => {
    it('adds a valid item to the queue', async () => {
      await store.add(validItem);
      const result = await store.load();
      expect(result.queue).toHaveLength(1);
      expect(result.queue[0].id).toBe('abc12345');
    });

    it('throws QueueValidationError for invalid item', async () => {
      const badItem = { id: 'x' } as unknown as EvolutionQueueItem;
      await expect(store.add(badItem)).rejects.toThrow(QueueValidationError);
    });

    it('appends to existing queue', async () => {
      await store.add(validItem);
      const secondItem = { ...validItem, id: 'def67890' };
      await store.add(secondItem);
      const result = await store.load();
      expect(result.queue).toHaveLength(2);
    });
  });

  // ── Update ──────────────────────────────────────────────────────────

  describe('update', () => {
    it('updates queue atomically via updater function', async () => {
      await store.save([validItem]);
      await store.update((queue) => {
        queue[0].status = 'in_progress';
        return queue;
      });
      const result = await store.load();
      expect(result.queue[0].status).toBe('in_progress');
    });
  });

  // ── Dedup ───────────────────────────────────────────────────────────

  describe('dedup', () => {
    it('finds recent duplicate within window', () => {
      const now = Date.now();
      const queue: EvolutionQueueItem[] = [{
        ...validItem,
        status: 'pending',
        reason: 'test reason',
        enqueued_at: new Date(now - 1000).toISOString(),
        trigger_text_preview: 'test preview',
      }];
      const found = store.findRecentDuplicate(queue, 'test-source', 'test preview', now, 'test reason');
      expect(found).toBeDefined();
      expect(found?.id).toBe('abc12345');
    });

    it('ignores completed tasks', () => {
      const now = Date.now();
      const queue: EvolutionQueueItem[] = [{
        ...validItem,
        status: 'completed',
        reason: 'test reason',
        enqueued_at: new Date(now - 1000).toISOString(),
        trigger_text_preview: 'test preview',
      }];
      const found = store.findRecentDuplicate(queue, 'test-source', 'test preview', now, 'test reason');
      expect(found).toBeUndefined();
    });

    it('ignores tasks outside dedup window', () => {
      const now = Date.now();
      const queue: EvolutionQueueItem[] = [{
        ...validItem,
        status: 'pending',
        reason: 'test reason',
        enqueued_at: new Date(now - 60 * 60 * 1000).toISOString(), // 1 hour ago (>30min window)
        trigger_text_preview: 'test preview',
      }];
      const found = store.findRecentDuplicate(queue, 'test-source', 'test preview', now, 'test reason');
      expect(found).toBeUndefined();
    });

    it('hasRecentDuplicate returns true when duplicate exists', () => {
      const now = Date.now();
      const queue: EvolutionQueueItem[] = [{
        ...validItem,
        status: 'pending',
        reason: 'test reason',
        enqueued_at: new Date(now - 1000).toISOString(),
        trigger_text_preview: 'test preview',
      }];
      expect(store.hasRecentDuplicate(queue, 'test-source', 'test preview', now, 'test reason')).toBe(true);
    });
  });

  // ── Purge ───────────────────────────────────────────────────────────

  describe('purge', () => {
    it('removes stale failed tasks older than 24h', () => {
      const old = Date.now() - 25 * 60 * 60 * 1000; // 25h ago
      const queue: EvolutionQueueItem[] = [{
        ...validItem,
        status: 'failed',
        timestamp: new Date(old).toISOString(),
        lastError: 'timeout',
      }];
      const result = store.purge(queue);
      expect(result.purged).toBe(1);
      expect(result.remaining).toBe(0);
    });

    it('keeps recent failed tasks', () => {
      const recent = Date.now() - 1000; // 1s ago
      const queue: EvolutionQueueItem[] = [{
        ...validItem,
        status: 'failed',
        timestamp: new Date(recent).toISOString(),
        lastError: 'timeout',
      }];
      const result = store.purge(queue);
      expect(result.purged).toBe(0);
      expect(result.remaining).toBe(1);
    });

    it('returns correct counts and byReason', () => {
      const old = Date.now() - 25 * 60 * 60 * 1000;
      const queue: EvolutionQueueItem[] = [
        { ...validItem, id: 'a', status: 'failed', timestamp: new Date(old).toISOString(), lastError: 'timeout' },
        { ...validItem, id: 'b', status: 'failed', timestamp: new Date(old).toISOString(), lastError: 'timeout' },
        { ...validItem, id: 'c', status: 'failed', timestamp: new Date(old).toISOString(), resolution: 'runtime_unavailable' },
        { ...validItem, id: 'd', status: 'pending', timestamp: new Date(old).toISOString() },
      ];
      const result = store.purge(queue);
      expect(result.purged).toBe(3);
      expect(result.remaining).toBe(1);
      expect(result.byReason['timeout']).toBe(2);
      expect(result.byReason['runtime_unavailable']).toBe(1);
    });
  });

  // ── RegisterSession ─────────────────────────────────────────────────

  describe('registerSession', () => {
    it('assigns session key to in-progress task', async () => {
      const item = { ...validItem, status: 'in_progress' as const };
      writeRaw(JSON.stringify([item]));
      const result = await store.registerSession('abc12345', 'session-key-1');
      expect(result).toBe(true);
      const content = readRaw();
      const parsed = JSON.parse(content) as EvolutionQueueItem[];
      expect(parsed[0].assigned_session_key).toBe('session-key-1');
      expect(parsed[0].started_at).toBeDefined();
    });

    it('returns false when task not found', async () => {
      writeRaw(JSON.stringify([validItem])); // status is 'pending', not 'in_progress'
      const result = await store.registerSession('abc12345', 'session-key-1');
      expect(result).toBe(false);
    });

    it('returns false when queue file missing', async () => {
      const result = await store.registerSession('abc12345', 'session-key-1');
      expect(result).toBe(false);
    });
  });

  // ── Static helpers ──────────────────────────────────────────────────

  describe('static helpers', () => {
    it('createTaskId produces deterministic 8-char hex', () => {
      const id = EvolutionQueueStore.createTaskId('src', 5, 'preview', 'reason', 1234567890);
      expect(id).toHaveLength(8);
      expect(/^[0-9a-f]{8}$/.test(id)).toBe(true);
      // Deterministic: same inputs → same output
      const id2 = EvolutionQueueStore.createTaskId('src', 5, 'preview', 'reason', 1234567890);
      expect(id).toBe(id2);
    });

    it('extractTaskId parses [ID: xxx] from string', () => {
      expect(EvolutionQueueStore.extractTaskId('task [ID: abc123] done')).toBe('abc123');
      expect(EvolutionQueueStore.extractTaskId('[ID: x_y-z]')).toBe('x_y-z');
      expect(EvolutionQueueStore.extractTaskId('no id here')).toBeNull();
      expect(EvolutionQueueStore.extractTaskId('')).toBeNull();
    });
  });
});
