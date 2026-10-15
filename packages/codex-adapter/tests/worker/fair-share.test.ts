/**
 * SPEC-CODEX-PAIN-CLOSURE-001 review round-3 — fair-share regression:
 * with a continuously-eligible pending task AND a due retry_wait task, the
 * worker alternates service classes via the PERSISTED cursor — each class is
 * served within 2 cycles (inside the 3-cycle bound), and the rotation state
 * survives a worker restart (fresh state handle, same workspace DB).
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { getDefaultPdConfig } from '@principles/core/runtime-v2';
import { runCodexWorkspaceWorkerCycle } from '../../src/worker/workspace-worker.js';
import { createRuntimeStateHandle } from '@principles/core/runtime-v2';
void vi;

const dirs: string[] = [];

afterEach(async () => {
  // Windows may release closed SQLite handles asynchronously — gc delay then
  // bounded retries (same pattern as workspace-worker.test.ts).
  await new Promise((resolve) => setTimeout(resolve, 120));
  for (const dir of [...dirs]) {
    try { fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 60 }); } catch { /* temp dir: OS cleans */ }
  }
  dirs.splice(0);
});

describe('review round-3: fair-share pick with persisted rotation cursor', () => {
  it('alternates pending/retry_wait across cycles and survives restart', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pd-fair-share-'));
    dirs.push(root);
    fs.mkdirSync(path.join(root, '.pd'), { recursive: true });
    fs.mkdirSync(path.join(root, '.state'), { recursive: true });
    const config = getDefaultPdConfig();
    config.features['host.codex'].enabled = true;
    config.features.codex_conversation_ingestion.enabled = false;
    config.features.internalization_auto_consumer.enabled = true;
    fs.writeFileSync(path.join(root, '.pd', 'config.yaml'), JSON.stringify(config));

    // Two diagnostician tasks: one pending, one due retry_wait (backoff elapsed).
    const handle = await createRuntimeStateHandle({ workspaceDir: root, readonly: false });
    try {
      await handle.stateManager.createTask({ taskId: 'diagnosis_pending', taskKind: 'diagnostician', inputRef: 'p1', status: 'pending', attemptCount: 0, maxAttempts: 3 });
      await handle.stateManager.createTask({ taskId: 'diagnosis_retry', taskKind: 'diagnostician', inputRef: 'p2', status: 'retry_wait', attemptCount: 1, maxAttempts: 3, leaseOwner: null, leaseExpiresAt: new Date(Date.now() - 60_000).toISOString() });
    } finally {
      await handle.close();
    }

    // The cycle runs the full pipeline; the Split runner is NOT mocked here —
    // both attempts will fail with capability/runtime noise, but the PICK
    // order is what we assert, read back from each task's updated_at bump
    // (lease acquisition happens on pick).
    vi.spyOn(Date, 'now');

    const served: string[] = [];
    // Cycle 1 (fresh process equivalent: new handle each cycle = restart).
    const handle1 = await createRuntimeStateHandle({ workspaceDir: root, readonly: false });
    try {
      const cursorBefore = await handle1.stateManager.getDiagnosticianServiceCursor('codex-worker-diagnostician-fair-share');
      void cursorBefore;
      await runCodexWorkspaceWorkerCycle({ workspaceDir: root });
      const cursor1 = await handle1.stateManager.getDiagnosticianServiceCursor('codex-worker-diagnostician-fair-share');
      expect(cursor1).not.toBeNull();
      served.push(cursor1!.lastTaskId);
    } finally {
      await handle1.close();
    }
    // Cycle 2 — NEW handle (worker restart): the cursor must survive in state.db.
    const handle2 = await createRuntimeStateHandle({ workspaceDir: root, readonly: false });
    try {
      await runCodexWorkspaceWorkerCycle({ workspaceDir: root });
      const cursor2 = await handle2.stateManager.getDiagnosticianServiceCursor('codex-worker-diagnostician-fair-share');
      expect(cursor2).not.toBeNull();
      served.push(cursor2!.lastTaskId);
      // Rotation: the two cycles served DIFFERENT classes.
      expect(served[0]).not.toBe(served[1]);
      expect(['pending', 'retry_wait']).toContain(served[0]);
      expect(['pending', 'retry_wait']).toContain(served[1]);
    } finally {
      await handle2.close();
    }
  });
});
