/**
 * Pain → Diagnostician Loop E2E Tests
 *
 * M8: LEGACY TEST — diagnostician-task-store.ts deleted, imports fail.
 * Pain → Diagnostician loop is now via Runtime v2 SQLite task store.
 * This integration test is skipped until rewritten for the M8 architecture.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import {
  buildPainFlag,
  writePainFlag,
  readPainFlagData,
  validatePainFlag,
} from '../../src/core/pain.js';

// M8: diagnostician-task-store.ts deleted — imports removed, all tests skipped below

describe.skip('M8 Legacy', () => {
// ─────────────────────────────────────────────────────────────────────
// Helper functions
// ─────────────────────────────────────────────────────────────────────

function createTestWorkspace(): { workspaceDir: string; stateDir: string } {
  const workspaceDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pd-e2e-pain-'));
  const stateDir = path.join(workspaceDir, '.state');
  fs.mkdirSync(stateDir, { recursive: true });
  fs.mkdirSync(path.join(workspaceDir, '.principles'), { recursive: true });
  return { workspaceDir, stateDir };
}

function cleanupWorkspace(workspaceDir: string): void {
  try {
    fs.rmSync(workspaceDir, { recursive: true, force: true });
  } catch {
    // ignore
  }
}

// ─────────────────────────────────────────────────────────────────────
// PART 1: Business Invariants
// Tests that verify system MUST maintain these rules
// ─────────────────────────────────────────────────────────────────────

describe.skip('Pain → Diagnostician: Business Invariants', () => {
  let workspaceDir: string;
  let stateDir: string;

  beforeEach(() => {
    const ws = createTestWorkspace();
    workspaceDir = ws.workspaceDir;
    stateDir = ws.stateDir;
  });

  afterEach(() => {
    cleanupWorkspace(workspaceDir);
  });

  // ── INVARIANT 1: Pain flag format contract ──
  describe.skip('INVARIANT: Pain flag format contract', () => {
    it('MUST contain all required fields after writePainFlag', () => {
      const data = buildPainFlag({
        source: 'tool_failure',
        score: '70',
        reason: 'Command failed with exit code 1',
        session_id: 'test-session-123',
        agent_id: 'main',
        is_risky: true,
      });

      writePainFlag(workspaceDir, data);

      // Independent verification: read file directly, don't trust writePainFlag
      const painFlagPath = path.join(stateDir, '.pain_flag');
      expect(fs.existsSync(painFlagPath)).toBe(true);

      const content = fs.readFileSync(painFlagPath, 'utf-8');

      // INVARIANT: All required fields MUST be present
      expect(content).toContain('source: tool_failure');
      expect(content).toContain('score: 70');
      expect(content).toMatch(/time: \d{4}-\d{2}-\d{2}T/); // ISO timestamp with space
      expect(content).toContain('reason:');
      expect(content).toContain('is_risky: true');
    });

    it('MUST NOT write empty optional fields to disk', () => {
      const data = buildPainFlag({
        source: 'human_intervention',
        score: '50',
        reason: 'User feedback',
        // Optional fields omitted
      });

      writePainFlag(workspaceDir, data);

      const content = fs.readFileSync(path.join(stateDir, '.pain_flag'), 'utf-8');

      // INVARIANT: Empty optional fields MUST NOT appear in file
      // This prevents confusion when reading the file
      expect(content).not.toMatch(/trace_id:\s*$/m);
      expect(content).not.toMatch(/trigger_text_preview:\s*$/m);
    });

    it('score MUST be in valid range 0-100', () => {
      // Test boundary values
      const scores = ['0', '50', '100'];

      for (const score of scores) {
        const data = buildPainFlag({
          source: 'test',
          score,
          reason: 'Test',
        });

        writePainFlag(workspaceDir, data);

        const read = readPainFlagData(workspaceDir);
        const numScore = Number(read.score);

        // INVARIANT: Score MUST be in valid range
        expect(numScore).toBeGreaterThanOrEqual(0);
        expect(numScore).toBeLessThanOrEqual(100);
      }
    });
  });

  // ── INVARIANT 2: Pain flag validation contract ──
  describe.skip('INVARIANT: Pain flag validation', () => {
    it('validatePainFlag MUST reject flags missing required fields', () => {
      const invalidFlags = [
        { source: '', score: '50', time: '2024-01-01', reason: 'test' }, // empty source
        { source: 'test', score: '', time: '2024-01-01', reason: 'test' }, // empty score
        { source: 'test', score: '50', time: '', reason: 'test' }, // empty time
        { source: 'test', score: '50', time: '2024-01-01', reason: '' }, // empty reason
      ];

      for (const flag of invalidFlags) {
        const missing = validatePainFlag(flag);
        // INVARIANT: Missing required fields MUST be detected
        expect(missing.length).toBeGreaterThan(0);
      }
    });

    it('validatePainFlag MUST accept valid flags', () => {
      const validFlag = {
        source: 'tool_failure',
        score: '70',
        time: new Date().toISOString(),
        reason: 'Command failed',
        session_id: 'test',
        agent_id: 'main',
        is_risky: 'false',
      };

      const missing = validatePainFlag(validFlag);
      // INVARIANT: Valid flags MUST pass validation
      expect(missing).toEqual([]);
    });
  });

  // ── INVARIANT 3: Diagnostician task store contract ──
  describe.skip('INVARIANT: Diagnostician task store', () => {
    it('MUST persist tasks with correct structure', async () => {
      const taskId = `task-${Date.now()}`;
      const prompt = 'Diagnose the following pain signal:\n- source: tool_failure\n- score: 70';

      await addDiagnosticianTask(stateDir, taskId, prompt);

      // Independent verification: read file directly
      const tasksPath = path.join(stateDir, 'diagnostician_tasks.json');
      expect(fs.existsSync(tasksPath)).toBe(true);

      const store = JSON.parse(fs.readFileSync(tasksPath, 'utf-8'));

      // INVARIANT: Task MUST be in store with correct structure
      expect(store.tasks).toBeDefined();
      expect(store.tasks[taskId]).toBeDefined();
      expect(store.tasks[taskId].prompt).toBe(prompt);
      expect(store.tasks[taskId].status).toBe('pending');
      expect(store.tasks[taskId].createdAt).toBeDefined();
    });

    it('getPendingDiagnosticianTasks MUST only return pending tasks', async () => {
      // Add pending task
      await addDiagnosticianTask(stateDir, 'pending-task', 'Test prompt');

      // Add completed task manually
      const tasksPath = path.join(stateDir, 'diagnostician_tasks.json');
      const store = { tasks: {} };
      store.tasks['completed-task'] = {
        prompt: 'Completed',
        status: 'completed',
        createdAt: new Date().toISOString(),
      };
      fs.writeFileSync(tasksPath, JSON.stringify(store));

      // Add pending task to the store
      const existingStore = JSON.parse(fs.readFileSync(tasksPath, 'utf-8'));
      existingStore.tasks['pending-task'] = {
        prompt: 'Pending',
        status: 'pending',
        createdAt: new Date().toISOString(),
      };
      fs.writeFileSync(tasksPath, JSON.stringify(existingStore));

      const pending = getPendingDiagnosticianTasks(stateDir);

      // INVARIANT: Only pending tasks MUST be returned
      expect(pending.some(t => t.id === 'pending-task')).toBe(true);
      expect(pending.some(t => t.id === 'completed-task')).toBe(false);
    });
  });
});

// ─────────────────────────────────────────────────────────────────────
// PART 2: Resilience Tests
// Tests that verify system behavior under abnormal conditions
// ─────────────────────────────────────────────────────────────────────

describe.skip('Pain → Diagnostician: Resilience', () => {
  let workspaceDir: string;
  let stateDir: string;

  beforeEach(() => {
    const ws = createTestWorkspace();
    workspaceDir = ws.workspaceDir;
    stateDir = ws.stateDir;
  });

  afterEach(() => {
    cleanupWorkspace(workspaceDir);
  });

  // ── RESILIENCE 1: Corruption recovery ──
  describe.skip('RESILIENCE: Corruption recovery', () => {
    it('readPainFlagData MUST NOT crash on corrupted file', () => {
      // Write corrupted content
      fs.writeFileSync(path.join(stateDir, '.pain_flag'), 'invalid {{{ json');

      // This should NOT throw
      expect(() => readPainFlagData(workspaceDir)).not.toThrow();

      const data = readPainFlagData(workspaceDir);

      // INVARIANT: Should return safe default, not undefined/null
      expect(data).toBeDefined();
      expect(typeof data).toBe('object');
    });

    it('getPendingDiagnosticianTasks MUST NOT crash on missing file', () => {
      // Don't create diagnostician_tasks.json

      // This should NOT throw
      expect(() => getPendingDiagnosticianTasks(stateDir)).not.toThrow();

      const pending = getPendingDiagnosticianTasks(stateDir);

      // INVARIANT: Should return empty array, not crash
      expect(Array.isArray(pending)).toBe(true);
      expect(pending.length).toBe(0);
    });

    it('getPendingDiagnosticianTasks MUST NOT crash on corrupted JSON', () => {
      fs.writeFileSync(
        path.join(stateDir, 'diagnostician_tasks.json'),
        'not valid json {{{'
      );

      // This should NOT throw
      expect(() => getPendingDiagnosticianTasks(stateDir)).not.toThrow();

      const pending = getPendingDiagnosticianTasks(stateDir);

      // INVARIANT: Should return empty array as fallback
      expect(Array.isArray(pending)).toBe(true);
    });
  });

  // ── RESILIENCE 2: Concurrent access safety ──
  describe.skip('RESILIENCE: Concurrent access', () => {
    it('writePainFlag MUST handle rapid sequential writes', () => {
      // Simulate rapid consecutive writes
      for (let i = 0; i < 10; i++) {
        const data = buildPainFlag({
          source: `test-${i}`,
          score: String(i * 10),
          reason: `Test ${i}`,
        });
        writePainFlag(workspaceDir, data);
      }

      // INVARIANT: File must exist and be valid after rapid writes
      const painFlagPath = path.join(stateDir, '.pain_flag');
      expect(fs.existsSync(painFlagPath)).toBe(true);

      const content = fs.readFileSync(painFlagPath, 'utf-8');

      // Should not have corruption artifacts
      expect(content).not.toContain('undefined');
      expect(content).not.toContain('[object Object]');
      expect(content).not.toContain('null');
    });
  });
});

// ─────────────────────────────────────────────────────────────────────
// PART 3: Round-trip Tests
// Tests that verify data survives the full write → read cycle
// ─────────────────────────────────────────────────────────────────────

describe.skip('Pain → Diagnostician: Round-trip', () => {
  let workspaceDir: string;
  let stateDir: string;

  beforeEach(() => {
    const ws = createTestWorkspace();
    workspaceDir = ws.workspaceDir;
    stateDir = ws.stateDir;
  });

  afterEach(() => {
    cleanupWorkspace(workspaceDir);
  });

  it('Pain flag round-trip: write → read → verify', () => {
    const original = buildPainFlag({
      source: 'tool_failure',
      score: '75',
      reason: 'npm test failed with exit code 1',
      session_id: 'session-abc123',
      agent_id: 'main',
      is_risky: false,
      trace_id: 'trace-xyz789',
      trigger_text_preview: 'npm test',
    });

    writePainFlag(workspaceDir, original);
    const read = readPainFlagData(workspaceDir);

    // INVARIANT: All fields MUST survive round-trip
    expect(read.source).toBe(original.source);
    expect(read.score).toBe(original.score);
    expect(read.reason).toBe(original.reason);
    expect(read.session_id).toBe(original.session_id);
    expect(read.agent_id).toBe(original.agent_id);
    expect(read.is_risky).toBe(original.is_risky);
    expect(read.trace_id).toBe(original.trace_id);
    expect(read.trigger_text_preview).toBe(original.trigger_text_preview);
  });

  it('Diagnostician task round-trip: add → get → verify', async () => {
    const taskId = 'round-trip-task';
    const prompt = 'Analyze the following error:\n```\nError: ENOENT\n```';

    await addDiagnosticianTask(stateDir, taskId, prompt);
    const pending = getPendingDiagnosticianTasks(stateDir);
    const task = pending.find(t => t.id === taskId);

    // INVARIANT: Task MUST survive round-trip
    expect(task).toBeDefined();
    expect(task!.task.prompt).toBe(prompt);
    expect(task!.task.status).toBe('pending');
  });
});
});