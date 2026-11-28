/**
 * PRI-1278 Phase 5 (Companion-runtime removal) — owner-label attribution.
 *
 * The lease/consumer owner label is observable ONLY as an argument the
 * worker hands to the shared downstream executor: durable leases clear
 * `lease_owner` on every terminal transition, so no post-cycle store read
 * can prove which label was written. This suite captures the wiring at the
 * existing host-runtime seam (the same seam corrupt-admission-worker tests
 * in the Codex adapter use) and pins the NEW identity:
 *
 *   - every downstream invocation carries owner 'service-host-worker';
 *   - the retired 'companion-worker' label is never produced again
 *     (historical lease records keep it — durable facts are not migrated).
 *
 * The rest of the worker path (config ladder, reconcile, declaration,
 * liveness) stays REAL — only the downstream consumer boundary is captured,
 * exactly like the openclaw worker parity test.
 */
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import Database from 'better-sqlite3';

const { runDownstream } = vi.hoisted(() => ({
  runDownstream: vi.fn(async () => ({ ran: false as const, skipReason: 'no_ready_tasks' as const })),
}));
vi.mock('@principles/host-runtime', async (importOriginal) => ({
  ...await importOriginal<typeof import('@principles/host-runtime')>(),
  runInternalizationConsumerCycle: runDownstream,
}));

import { runWorkbuddyWorkspaceWorkerCycle } from '../src/worker/workspace-worker.js';
import { makeHome, makeGovernance, cleanupTempDirs } from './helpers/workbench.js';

const TRAJECTORY_DDL = [
  'CREATE TABLE sessions (session_id TEXT PRIMARY KEY, started_at TEXT NOT NULL, updated_at TEXT NOT NULL)',
  'CREATE TABLE tool_calls (id INTEGER PRIMARY KEY AUTOINCREMENT, session_id TEXT NOT NULL, tool_name TEXT NOT NULL, outcome TEXT NOT NULL, duration_ms INTEGER, exit_code INTEGER, error_type TEXT, error_message TEXT, gfi_before REAL, gfi_after REAL, params_json TEXT NOT NULL, result_preview TEXT, created_at TEXT NOT NULL)',
  'CREATE TABLE pain_events (id INTEGER PRIMARY KEY AUTOINCREMENT, session_id TEXT NOT NULL, source TEXT NOT NULL, score REAL NOT NULL, reason TEXT, severity TEXT, origin TEXT, confidence REAL, text TEXT, canonical_pain_id TEXT, runtime_task_id TEXT, host_kind TEXT, created_at TEXT NOT NULL)',
  'CREATE UNIQUE INDEX idx_pain_events_canonical_pain_id ON pain_events(canonical_pain_id) WHERE canonical_pain_id IS NOT NULL',
];

function makeWorkerWorkspace(): string {
  const home = makeHome();
  const governance = makeGovernance(home, { workbuddyFlag: true, readyRuntime: true });
  const configPath = path.join(governance, '.pd', 'config.yaml');
  const config = JSON.parse(fs.readFileSync(configPath, 'utf8')) as { features: Record<string, { enabled: boolean } | undefined> };
  if (config.features['internalization_auto_consumer']) config.features['internalization_auto_consumer'].enabled = true;
  fs.writeFileSync(configPath, JSON.stringify(config));
  fs.mkdirSync(path.join(governance, '.state'), { recursive: true });
  const trajectory = new Database(path.join(governance, '.state', 'trajectory.db'));
  for (const statement of TRAJECTORY_DDL) trajectory.prepare(statement).run();
  trajectory.close();
  return governance;
}

afterAll(() => {
  cleanupTempDirs();
});

beforeEach(() => runDownstream.mockClear());

describe('WorkBuddy worker owner-label attribution (PRI-1278 Phase 5)', () => {
  it('hands the shared downstream cycle the service-host-worker identity — never the retired companion-worker label', async () => {
    const governance = makeWorkerWorkspace();
    const result = await runWorkbuddyWorkspaceWorkerCycle({ workspaceDir: governance });
    expect(result.mode).not.toBe('degraded');
    expect(runDownstream).toHaveBeenCalledTimes(1);
    const ports = runDownstream.mock.calls[0]?.[1] as { owner?: string; logLabel?: string };
    expect(ports.owner).toBe('service-host-worker');
    expect(ports.owner).not.toBe('companion-worker');
    expect(ports.logLabel).toBe('WorkbuddyWorker');
  });
});
