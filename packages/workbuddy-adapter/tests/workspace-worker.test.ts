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
import { runWorkbuddyWorkspaceWorkerCycle, readWorkbuddyWorkerLiveness } from '../src/worker/workspace-worker.js';
import { HOST_TOOL_DECLARATION_VERSION, ensureGovernanceSchema, recordConversationIngestionConsent } from '@principles/host-runtime';
import { createDiagnosticianTaskId, createRuntimeStateHandle, disposePainSignalBridgesForWorkspace } from '@principles/core/runtime';
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

describe('WorkBuddy worker cycle — cycle liveness (Phase 2, PRI-1280)', () => {
  it('a completed cycle records start, completion, duration, mode and the driver identity', async () => {
    const governance = makeWorkerWorkspace({ workbuddy: true, consumer: true });
    const previous = process.env.PD_INVOCATION_SOURCE;
    try {
      process.env.PD_INVOCATION_SOURCE = 'service_host';
      const result = await runWorkbuddyWorkspaceWorkerCycle({ workspaceDir: governance });
      expect(result.mode).toBe('ready');
      const liveness = readWorkbuddyWorkerLiveness(governance);
      expect(liveness).not.toBeNull();
      expect(liveness?.lastCycleDriver).toBe('service_host');
      expect(liveness?.lastCycleMode).toBe('ready');
      expect(liveness?.runningStage).toBeNull();
      expect(liveness?.stageDeadline).toBeNull();
      expect(typeof liveness?.lastCycleStartedAt).toBe('string');
      expect(typeof liveness?.lastCycleCompletedAt).toBe('string');
      expect(typeof liveness?.lastCycleDurationMs).toBe('number');
      // FR-10: registration/PID presence is NOT health — the completion
      // FACTS above are the evidence the Service Host health projection reads.
      expect(liveness?.lastCycleCompletedAt).not.toBe(liveness?.lastCycleStartedAt);
    } finally {
      if (previous === undefined) delete process.env.PD_INVOCATION_SOURCE;
      else process.env.PD_INVOCATION_SOURCE = previous;
    }
  });

  it('driver mapping covers the two live identities and collapses the retired companion driver to manual', async () => {
    const governance = makeWorkerWorkspace({ workbuddy: true, consumer: true });
    const previous = process.env.PD_INVOCATION_SOURCE;
    try {
      // PRI-1278 Phase 5: 'companion' is retired — no Companion runtime exists
      // that could produce it, so a legacy env leftover self-declaring it is
      // not authoritative and attributes as manual. Only service_host and
      // manual remain producible driver identities.
      for (const [source, expected] of [['service_host', 'service_host'], [undefined, 'manual'], ['companion', 'manual']] as const) {
        if (source === undefined) delete process.env.PD_INVOCATION_SOURCE;
        else process.env.PD_INVOCATION_SOURCE = source;
        await runWorkbuddyWorkspaceWorkerCycle({ workspaceDir: governance });
        expect(readWorkbuddyWorkerLiveness(governance)?.lastCycleDriver).toBe(expected);
      }
    } finally {
      if (previous === undefined) delete process.env.PD_INVOCATION_SOURCE;
      else process.env.PD_INVOCATION_SOURCE = previous;
    }
  });

  it('parse tolerance: a historical liveness record written with the retired companion driver still reads back verbatim', () => {
    const governance = makeWorkerWorkspace({ workbuddy: true, consumer: true });
    // Pre-removal workers persisted `lastCycleDriver: 'companion'`. Those
    // records are durable facts: readers must tolerate them as-is (the
    // string is never rewritten, never migrated, never rejected).
    const historical = {
      lastCycleStartedAt: '2026-11-20T10:00:00.000Z',
      lastCycleCompletedAt: '2026-11-20T10:00:41.000Z',
      lastCycleDurationMs: 41_000,
      lastCycleMode: 'ready',
      lastCycleDriver: 'companion',
      runningStage: null,
      stageDeadline: null,
      updatedAt: '2026-11-20T10:00:41.000Z',
    };
    fs.writeFileSync(
      path.join(governance, '.state', 'workbuddy-worker-liveness.json'),
      JSON.stringify(historical),
    );
    const read = readWorkbuddyWorkerLiveness(governance);
    expect(read).not.toBeNull();
    expect(read?.lastCycleDriver).toBe('companion');
    expect(read?.lastCycleMode).toBe('ready');
  });

  it('a degraded cycle records the degradation reason in the liveness file', async () => {
    const governance = makeWorkerWorkspace({ workbuddy: true, consumer: true });
    fs.writeFileSync(path.join(governance, '.state', 'trajectory.db'), 'definitely not a sqlite database');
    const result = await runWorkbuddyWorkspaceWorkerCycle({ workspaceDir: governance });
    expect(result.mode).toBe('degraded');
    const liveness = readWorkbuddyWorkerLiveness(governance);
    expect(liveness?.lastCycleMode).toBe('degraded');
    expect(String(liveness?.lastDegradedReason ?? '')).toContain('reconcile');
  });

  it('a host-flag CONFIG pause keeps a fresh paused heartbeat (same PRI-1264 discipline as Codex)', async () => {
    const governance = makeWorkerWorkspace({ workbuddy: false });
    const result = await runWorkbuddyWorkspaceWorkerCycle({ workspaceDir: governance });
    expect(result.mode).toBe('paused');
    const liveness = readWorkbuddyWorkerLiveness(governance);
    expect(liveness?.runningStage).toBe('paused');
    expect(liveness?.stageDeadline).toBeNull();
    const started = Date.parse(liveness?.lastCycleStartedAt ?? '');
    expect(Number.isFinite(started)).toBe(true);
    expect(Date.now() - started).toBeLessThan(60_000);
  });

  it('F9: a consumer-flag pause SETTLES the liveness record — no stale mid-stage runningStage', async () => {
    const governance = makeWorkerWorkspace({ workbuddy: true, consumer: false });
    const result = await runWorkbuddyWorkspaceWorkerCycle({ workspaceDir: governance });
    expect(result.mode).toBe('paused');
    expect(result.reason).toBe('internalization_auto_consumer_disabled');
    const liveness = readWorkbuddyWorkerLiveness(governance);
    // The cycle ENDED (paused): the catch_up stage write must not survive it.
    expect(liveness?.runningStage).toBeNull();
    expect(liveness?.stageDeadline).toBeNull();
    expect(liveness?.lastCycleMode).toBe('paused');
    expect(typeof liveness?.lastCycleCompletedAt).toBe('string');
    expect(typeof liveness?.lastCycleDurationMs).toBe('number');
  });

  it('F13: a service_host-driven cycle records the coordinator invocation id in liveness', async () => {
    const governance = makeWorkerWorkspace({ workbuddy: true, consumer: true });
    const previousSource = process.env.PD_INVOCATION_SOURCE;
    const previousId = process.env.PD_INVOCATION_ID;
    try {
      process.env.PD_INVOCATION_SOURCE = 'service_host';
      process.env.PD_INVOCATION_ID = 'inv-wb-corr-123';
      await runWorkbuddyWorkspaceWorkerCycle({ workspaceDir: governance });
      const liveness = readWorkbuddyWorkerLiveness(governance);
      expect(liveness?.lastInvocationId).toBe('inv-wb-corr-123');
    } finally {
      if (previousSource === undefined) delete process.env.PD_INVOCATION_SOURCE;
      else process.env.PD_INVOCATION_SOURCE = previousSource;
      if (previousId === undefined) delete process.env.PD_INVOCATION_ID;
      else process.env.PD_INVOCATION_ID = previousId;
    }
  });

  it('R5: a manual (non-Service-Host) cycle CLEARS the previous shadow run\'s invocation id from liveness', async () => {
    const governance = makeWorkerWorkspace({ workbuddy: true, consumer: true });
    const previousSource = process.env.PD_INVOCATION_SOURCE;
    const previousId = process.env.PD_INVOCATION_ID;
    try {
      // A shadow-driven cycle records the coordinator's invocation id…
      process.env.PD_INVOCATION_SOURCE = 'service_host';
      process.env.PD_INVOCATION_ID = 'inv-shadow-999';
      await runWorkbuddyWorkspaceWorkerCycle({ workspaceDir: governance });
      expect(readWorkbuddyWorkerLiveness(governance)?.lastInvocationId).toBe('inv-shadow-999');
      // …then a manual cycle (no PD_INVOCATION_ID) must not keep wearing it.
      process.env.PD_INVOCATION_SOURCE = 'manual';
      delete process.env.PD_INVOCATION_ID;
      await runWorkbuddyWorkspaceWorkerCycle({ workspaceDir: governance });
      const liveness = readWorkbuddyWorkerLiveness(governance);
      expect(liveness?.lastCycleDriver).toBe('manual');
      expect(liveness?.lastInvocationId ?? null).toBeNull();
    } finally {
      if (previousSource === undefined) delete process.env.PD_INVOCATION_SOURCE;
      else process.env.PD_INVOCATION_SOURCE = previousSource;
      if (previousId === undefined) delete process.env.PD_INVOCATION_ID;
      else process.env.PD_INVOCATION_ID = previousId;
    }
  });

  it('readWorkbuddyWorkerLiveness returns null for an unreadable/missing record', () => {
    const governance = makeWorkerWorkspace({ workbuddy: true, consumer: true });
    expect(readWorkbuddyWorkerLiveness(governance)).toBeNull();
    expect(readWorkbuddyWorkerLiveness(path.join(os.tmpdir(), 'pd-workbuddy-no-such-ws'))).toBeNull();
  });
});

describe('P2-01 final-remediation — paused path aggregates EVERY earlier stage failure', () => {
  function enableIngestion(governance: string): void {
    const configPath = path.join(governance, '.pd', 'config.yaml');
    const config = JSON.parse(fs.readFileSync(configPath, 'utf8')) as { features: Record<string, { enabled: boolean } | undefined> };
    config.features['workbuddy_conversation_ingestion'] = { category: 'quiet', enabled: true } as { enabled: boolean };
    fs.writeFileSync(configPath, JSON.stringify(config));
  }

  it('paused + catch-up failure → degraded with catch_up: reason, catch-up nextAction kept', async () => {
    const governance = makeWorkerWorkspace({ consumer: false });
    enableIngestion(governance);
    fs.writeFileSync(path.join(governance, '.state', 'conversation-ingestion-consent.json'), '{not-json', 'utf8');
    const result = await runWorkbuddyWorkspaceWorkerCycle({ workspaceDir: governance });
    expect(result.mode).toBe('degraded');
    expect(result.reason).toContain('paused_stage_failures');
    expect(result.reason).toContain('catch_up:consent_unreadable');
    expect(result.degradations).toBeDefined();
    expect(result.degradations?.some((d) => d.startsWith('catch_up:'))).toBe(true);
    // The real failing stage's recovery hint wins over the generic pause text.
    expect(result.nextAction).toBeDefined();
    expect(result.nextAction).not.toContain('internalization execution is paused');
    const liveness = readWorkbuddyWorkerLiveness(governance);
    expect(liveness?.lastCycleMode).toBe('degraded');
  });

  it('paused + reconcile failure → degraded with reconcile: reason', async () => {
    const governance = makeWorkerWorkspace({ consumer: false });
    fs.writeFileSync(path.join(governance, '.state', 'trajectory.db'), 'garbage-not-sqlite', 'utf8');
    const result = await runWorkbuddyWorkspaceWorkerCycle({ workspaceDir: governance });
    expect(result.mode).toBe('degraded');
    expect(result.reason).toContain('reconcile:');
    expect(result.degradations?.some((d) => d.startsWith('reconcile:'))).toBe(true);
  });

  it('paused + BOTH stages failing → both degradation categories surface', async () => {
    const governance = makeWorkerWorkspace({ consumer: false });
    enableIngestion(governance);
    fs.writeFileSync(path.join(governance, '.state', 'conversation-ingestion-consent.json'), '{not-json', 'utf8');
    fs.writeFileSync(path.join(governance, '.state', 'trajectory.db'), 'garbage-not-sqlite', 'utf8');
    const result = await runWorkbuddyWorkspaceWorkerCycle({ workspaceDir: governance });
    expect(result.mode).toBe('degraded');
    expect(result.degradations?.some((d) => d.startsWith('catch_up:'))).toBe(true);
    expect(result.degradations?.some((d) => d.startsWith('reconcile:'))).toBe(true);
  });

  it('paused + NO failures → clean paused, unchanged behavior', async () => {
    const governance = makeWorkerWorkspace({ consumer: false });
    const result = await runWorkbuddyWorkspaceWorkerCycle({ workspaceDir: governance });
    expect(result.mode).toBe('paused');
    expect(result.reason).toBe('internalization_auto_consumer_disabled');
    expect(result.degradations).toBeUndefined();
  });
});

describe('PRI-1296 — WorkBuddy target-evidence reconcile before diagnostician picking', () => {
  const SESSION = 'wb-session-pri1296';
  const TURN = 'turn-10';

  async function seedWaitingTask(governance: string): Promise<{ painId: string; taskId: string }> {
    const painId = 'mcp_1700000001296_wb001296';
    const taskId = createDiagnosticianTaskId(painId);
    const handle = await createRuntimeStateHandle({ workspaceDir: governance, readonly: false, bootstrapIfMissing: true });
    const now = new Date().toISOString();
    try {
      await handle.stateManager.createTask({
        taskId,
        taskKind: 'diagnostician',
        status: 'pending',
        attemptCount: 0,
        maxAttempts: 3,
        inputRef: painId,
        diagnosticJson: JSON.stringify({
          painId,
          hostKind: 'workbuddy',
          evidence: [],
          painIngress: {
            verifiedHostSession: { status: 'verified', sessionId: SESSION, targetTurnId: TURN },
            evidenceClass: { status: 'unavailable', reason: 'not_applicable_unbound' },
          },
          recovery: {
            schemaVersion: 1,
            state: 'waiting_for_target_evidence',
            reasonCode: 'target_turn_text_pending',
            attemptCount: 1,
            lastCheckedAt: now,
          },
        }),
      });
    } finally {
      await handle.close();
    }
    return { painId, taskId };
  }

  function writeTargetTurn(governance: string): void {
    const db = new Database(path.join(governance, '.state', 'trajectory.db'));
    try {
      ensureGovernanceSchema(db);
      db.prepare(`INSERT INTO governance_rollouts (host_kind, rollout_identity, root_session_id, created_at, updated_at)
        VALUES ('workbuddy', ?, ?, ?, ?)`).run(SESSION, SESSION, now(), now());
      const rolloutId = Number((db.prepare('SELECT id FROM governance_rollouts WHERE rollout_identity = ?').get(SESSION) as { id: number }).id);
      db.prepare(`INSERT INTO governance_observations (
          rollout_row_id, host_kind, rollout_identity, root_session_id, host_turn_id, kind, logical_key,
          source_order, visible_text, source, completeness, retention_class, observed_at
        ) VALUES (?, 'workbuddy', ?, ?, ?, 'user_turn', ?, 1, ?, 'workbuddy-hook', 'complete', 'operational', ?)`)
        .run(rolloutId, SESSION, SESSION, TURN, 'workbuddy|wb-session-pri1296|turn-10|user_turn', 'WB-T10-OWNER-CORRECTION', now());
    } finally {
      db.close();
    }
  }

  function now(): string {
    return new Date().toISOString();
  }

  it('late target evidence backfills the SAME waiting task in one worker cycle; repeat cycles are no-ops', async () => {
    const governance = makeWorkerWorkspace({ workbuddy: true, consumer: true });
    const consent = recordConversationIngestionConsent(governance, 'workbuddy', {
      decision: 'granted', decidedVia: 'owner_directive', disclosureVersion: 'test-v1', evidenceRef: 'pri-1296-test',
    });
    expect(consent.ok).toBe(true);
    const { painId, taskId } = await seedWaitingTask(governance);

    const first = await runWorkbuddyWorkspaceWorkerCycle({ workspaceDir: governance });
    expect(first.mode).toBe('ready');
    expect(first.report?.targetEvidenceReconcile).toMatchObject({ checked: 1, flipped: 0, backfilled: 0, stillWaiting: 1 });
    expect(first.report?.diagnostician).toBeNull();

    writeTargetTurn(governance);
    const second = await runWorkbuddyWorkspaceWorkerCycle({ workspaceDir: governance });
    // The same cycle then reaches the picker: this intentionally minimal
    // fixture fails payload validation before any model/provider boundary,
    // which also proves reconcile ran BEFORE candidate execution with zero LLM.
    expect(second.mode).toBe('degraded');
    expect(second.report?.diagnostician).toMatchObject({ status: 'failed', errorCategory: 'input_invalid' });
    expect(second.report?.targetEvidenceReconcile).toMatchObject({ checked: 1, flipped: 1, backfilled: 1, blocked: 0 });

    const verify = await createRuntimeStateHandle({ workspaceDir: governance, readonly: true });
    try {
      const task = await verify.stateManager.getTask(taskId);
      expect(task?.inputRef).toBe(painId);
      const diagnostic = JSON.parse(task?.diagnosticJson ?? '{}') as Record<string, any>;
      expect(diagnostic.evidence).toEqual([
        { sourceRef: 'governance_observation:workbuddy|wb-session-pri1296|turn-10|user_turn', note: 'WB-T10-OWNER-CORRECTION' },
      ]);
      expect(diagnostic.painIngress.evidenceClass).toEqual({ status: 'available', entryCount: 1 });
      expect(diagnostic.recovery).toMatchObject({ state: 'ready_for_diagnosis', reasonCode: 'target_evidence_arrived' });
    } finally {
      await verify.close();
    }

    const third = await runWorkbuddyWorkspaceWorkerCycle({ workspaceDir: governance });
    expect(third.report?.targetEvidenceReconcile).toMatchObject({ checked: 0, flipped: 0, backfilled: 0 });
    // The worker's diagnosis bridge is workspace-scoped/cached; release its
    // SQLite handle explicitly so Windows cleanup can unlink state.db.
    await disposePainSignalBridgesForWorkspace(governance);
  });
});
