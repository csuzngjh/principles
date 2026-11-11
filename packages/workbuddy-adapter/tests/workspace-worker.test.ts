/**
 * WorkBuddy workspace worker cycle tests (SPEC workbuddy-host-adapter §5
 * Part 5): the flag ladder is WorkBuddy's OWN (no Codex flag borrowing), the
 * shared reconcile/downstream authorities run on the real SQLite governance
 * workspace, and the WorkBuddy host tool declaration is persisted for
 * host-neutral consumers. LLM-execution paths reuse the exact Codex-tested
 * bridge contract and are exercised end-to-end in the real-chain acceptance;
 * here the empty-queue cycle proves the production wiring with zero LLM.
 */
import { afterAll, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';
import { runWorkbuddyWorkspaceWorkerCycle } from '../src/worker/workspace-worker.js';
import { HOST_TOOL_DECLARATION_VERSION } from '@principles/host-runtime';
import { makeHome, makeGovernance, cleanupTempDirs } from './helpers/workbench.js';

const TRAJECTORY_DDL = [
  'CREATE TABLE sessions (session_id TEXT PRIMARY KEY, started_at TEXT NOT NULL, updated_at TEXT NOT NULL)',
  'CREATE TABLE tool_calls (id INTEGER PRIMARY KEY AUTOINCREMENT, session_id TEXT NOT NULL, tool_name TEXT NOT NULL, outcome TEXT NOT NULL, duration_ms INTEGER, exit_code INTEGER, error_type TEXT, error_message TEXT, gfi_before REAL, gfi_after REAL, params_json TEXT NOT NULL, result_preview TEXT, created_at TEXT NOT NULL)',
  'CREATE TABLE pain_events (id INTEGER PRIMARY KEY AUTOINCREMENT, session_id TEXT NOT NULL, source TEXT NOT NULL, score REAL NOT NULL, reason TEXT, severity TEXT, origin TEXT, confidence REAL, text TEXT, canonical_pain_id TEXT, runtime_task_id TEXT, host_kind TEXT, created_at TEXT NOT NULL)',
  'CREATE UNIQUE INDEX idx_pain_events_canonical_pain_id ON pain_events(canonical_pain_id) WHERE canonical_pain_id IS NOT NULL',
];

interface WorkerOverrides {
  workbuddy?: boolean;
  consumer?: boolean;
  codex?: boolean;
  malformed?: boolean;
}

function makeWorkerWorkspace(overrides: WorkerOverrides = {}): string {
  const home = makeHome();
  const governance = makeGovernance(home, { workbuddyFlag: overrides.workbuddy ?? true, malformed: overrides.malformed, readyRuntime: true });
  if (!overrides.malformed) {
    const configPath = path.join(governance, '.pd', 'config.yaml');
    const config = JSON.parse(fs.readFileSync(configPath, 'utf8')) as { features: Record<string, { enabled: boolean } | undefined> };
    if (config.features['internalization_auto_consumer']) config.features['internalization_auto_consumer'].enabled = overrides.consumer ?? true;
    if (config.features['host.codex']) config.features['host.codex'].enabled = overrides.codex ?? false;
    fs.writeFileSync(configPath, JSON.stringify(config));
  }
  fs.mkdirSync(path.join(governance, '.state'), { recursive: true });
  const trajectory = new Database(path.join(governance, '.state', 'trajectory.db'));
  for (const statement of TRAJECTORY_DDL) trajectory.prepare(statement).run();
  trajectory.close();
  return governance;
}

afterAll(() => {
  cleanupTempDirs();
});

describe('WorkBuddy worker cycle — flag ladder', () => {
  it('host.workbuddy=false → paused, no steps run (host.codex=true does NOT activate it)', async () => {
    const governance = makeWorkerWorkspace({ workbuddy: false, codex: true });
    const result = await runWorkbuddyWorkspaceWorkerCycle({ workspaceDir: governance });
    expect(result.mode).toBe('paused');
    expect(result.reason).toBe('host.workbuddy_disabled');
    expect(result.report).toBeUndefined();
    // No host declaration, no downstream writes on a paused workspace.
    expect(fs.existsSync(path.join(governance, '.pd', 'host-tool-semantics'))).toBe(false);
  });

  it('workspace missing → degraded, nothing mutated', async () => {
    const result = await runWorkbuddyWorkspaceWorkerCycle({ workspaceDir: path.join(os.tmpdir(), 'pd-workbuddy-definitely-missing') });
    expect(result.mode).toBe('degraded');
    expect(result.reason).toBe('workspace_missing');
  });

  it('malformed governance config → degraded with the pd_config_invalid reason', async () => {
    const governance = makeWorkerWorkspace({ malformed: true });
    const result = await runWorkbuddyWorkspaceWorkerCycle({ workspaceDir: governance });
    expect(result.mode).toBe('degraded');
    expect(result.reason).toContain('pd_config_invalid');
  });

  it('internalization_auto_consumer=false → paused execution (reconcile already ran)', async () => {
    const governance = makeWorkerWorkspace({ consumer: false });
    const result = await runWorkbuddyWorkspaceWorkerCycle({ workspaceDir: governance });
    expect(result.mode).toBe('paused');
    expect(result.reason).toBe('internalization_auto_consumer_disabled');
    expect(result.report?.downstream).toBeNull();
    expect(fs.existsSync(path.join(governance, '.pd', 'host-tool-semantics'))).toBe(false);
  });
});

describe('WorkBuddy worker cycle — production ready path (empty queue, zero LLM)', () => {
  it('runs reconcile + downstream and persists the WorkBuddy host tool declaration', async () => {
    const governance = makeWorkerWorkspace({ workbuddy: true, consumer: true });
    const result = await runWorkbuddyWorkspaceWorkerCycle({ workspaceDir: governance });
    expect(result.mode).toBe('ready');
    expect(result.reason).toBeUndefined();
    expect(result.report?.reconcile.ok).toBe(true);
    expect(result.report?.diagnostician).toBeNull();
    expect(result.report?.downstream).not.toBeNull();

    // The declaration names the WorkBuddy host with the probe-verified tool
    // mappings — host-neutral consumers must resolve workbuddy semantics.
    const declarationPath = path.join(governance, '.pd', 'host-tool-semantics', 'workbuddy.json');
    expect(fs.existsSync(declarationPath)).toBe(true);
    const declaration = JSON.parse(fs.readFileSync(declarationPath, 'utf8')) as { hostKind: string; version: number };
    expect(declaration.hostKind).toBe('workbuddy');
    expect(declaration.version).toBe(HOST_TOOL_DECLARATION_VERSION);
  });

  it('declaration persist failure degrades and SKIPS the downstream cycle', async () => {
    const governance = makeWorkerWorkspace({ workbuddy: true, consumer: true });
    // Block the declarations directory with a regular file so
    // saveHostToolDeclaration cannot create workbuddy.json.
    fs.writeFileSync(path.join(governance, '.pd', 'host-tool-semantics'), 'not a directory');
    const result = await runWorkbuddyWorkspaceWorkerCycle({ workspaceDir: governance });
    expect(result.mode).toBe('degraded');
    expect(result.reason).toContain('host_tool_declaration_persist_failed');
    expect(result.report?.downstream).toBeNull();
  });

  it('never borrows the Codex catch-up: no CODEX_HOME/env read, no transcript access', async () => {
    const governance = makeWorkerWorkspace({ workbuddy: true, consumer: true });
    // The cycle options carry no Codex env at all — if the cycle tried any
    // Codex ingestion it would need CODEX_HOME or a sessions directory;
    // neither exists. The run must still be ready.
    const result = await runWorkbuddyWorkspaceWorkerCycle({ workspaceDir: governance });
    expect(result.mode).toBe('ready');
  });
});

describe('WorkBuddy worker status mode (host-runtime authority)', () => {
  it('mirrors the flag ladder without executing anything', async () => {
    const { computeWorkbuddyWorkerStatusMode } = await import('@principles/host-runtime');
    const off = makeWorkerWorkspace({ workbuddy: false });
    expect(computeWorkbuddyWorkerStatusMode({ workspaceDir: off, registeredInInstallManifest: true })).toMatchObject({ mode: 'paused', reason: 'host.workbuddy_disabled' });
    const ready = makeWorkerWorkspace({ workbuddy: true, consumer: true });
    expect(computeWorkbuddyWorkerStatusMode({ workspaceDir: ready, registeredInInstallManifest: true })).toMatchObject({ mode: 'ready' });
    expect(computeWorkbuddyWorkerStatusMode({ workspaceDir: ready, registeredInInstallManifest: false })).toMatchObject({ mode: 'manual_action_required', reason: 'workspace_not_in_install_manifest' });
  });
});

describe('WorkBuddy worker cycle — bare Pain is evidence only (Phase A)', () => {
  /**
   * Seed one bare WorkBuddy Pain row directly into the trajectory store. The
   * historical bare-pain admission is retired, so such rows only represent
   * pre-existing evidence: the worker must leave them readable and must never
   * turn them into an admission marker or a Diagnostician task.
   */
  function seedHistoricalBarePain(governance: string): string {
    const painId = 'pain_host_wbbare_phase_a_1';
    const db = new Database(path.join(governance, '.state', 'trajectory.db'));
    try {
      db.prepare(
        `INSERT INTO pain_events (session_id, source, score, reason, canonical_pain_id, host_kind, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      ).run(
        'wb-session-1',
        'workbuddy:post_tool_use',
        45,
        'bare host pain (historical)',
        painId,
        'workbuddy',
        '2026-09-01T00:00:00.000Z',
      );
    } finally {
      db.close();
    }
    return painId;
  }

  it('never creates an admission marker or a Diagnostician task for a bare WorkBuddy pain', async () => {
    const governance = makeWorkerWorkspace({ workbuddy: true, consumer: true });
    const painId = seedHistoricalBarePain(governance);

    const result = await runWorkbuddyWorkspaceWorkerCycle({ workspaceDir: governance });
    expect(result.mode).toBe('ready');
    // The bare-pain admission report field is gone with the mechanism it reported.
    expect(result.report).not.toHaveProperty('admission');

    const db = new Database(path.join(governance, '.state', 'trajectory.db'), { readonly: true });
    try {
      expect(db.prepare('SELECT COUNT(*) AS n FROM governance_signal_admissions').get()).toEqual({ n: 0 });
      // Historical evidence stays readable; nothing rewrites it.
      expect(db.prepare('SELECT COUNT(*) AS n FROM pain_events WHERE canonical_pain_id = ?').get(painId)).toEqual({ n: 1 });
    } finally {
      db.close();
    }

    // No admission means no queue entry at all (the governor state DB is never
    // created for this workspace).
    if (fs.existsSync(path.join(governance, '.pd', 'state.db'))) {
      const state = new Database(path.join(governance, '.pd', 'state.db'), { readonly: true });
      try {
        expect(state.prepare("SELECT COUNT(*) AS n FROM tasks WHERE task_kind = 'diagnostician'").get()).toEqual({ n: 0 });
      } finally {
        state.close();
      }
    }
  });

  it('a corrupt trajectory store still degrades the cycle observably and stays retryable (rc-9)', async () => {
    const governance = makeWorkerWorkspace({ workbuddy: true, consumer: true });
    seedHistoricalBarePain(governance);
    // Corrupt the trajectory store: the reconciliation pass must report the
    // degradation; the cycle becomes degraded with a nextAction and no silent skip.
    fs.writeFileSync(path.join(governance, '.state', 'trajectory.db'), 'definitely not a sqlite database');
    const result = await runWorkbuddyWorkspaceWorkerCycle({ workspaceDir: governance });
    expect(result.mode).toBe('degraded');
    expect(result.nextAction).toBeTruthy();
    expect(result.report?.reconcile.ok).toBe(false);
  });
});
