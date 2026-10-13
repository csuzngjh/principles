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
import { getDefaultPdConfig } from '@principles/core/runtime-v2';
import { runWorkbuddyWorkspaceWorkerCycle } from '../src/worker/workspace-worker.js';
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
  const governance = makeGovernance(home, { workbuddyFlag: overrides.workbuddy ?? true, malformed: overrides.malformed });
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
    expect(declaration.version).toBe(1);
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
