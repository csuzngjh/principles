/**
 * SPEC-PD-PIPELINE-SPINE-001 §4.2 (PRI-1292 Phase 2A) — the single workspace
 * pipeline host collaborator assembly point.
 *
 * Pinned here: the five REQUIRED collaborators, the ONE shared consent-ledger
 * authorization instance between the default trajectory reader and the gate
 * (the double-instance defect this module removes), the OpenClaw
 * trajectoryTurnReaderOverride pass-through, and the workspace-scoped
 * telemetry sink persistence boundary. All against a REAL workspace directory.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';
import {
  getDefaultPdConfig,
  type TrajectoryTurnReader,
  type TrajectoryUserTurn,
} from '@principles/core/runtime';
import { resolveWorkspacePipelineHostDeps } from '../src/workspace-pipeline-host-deps.js';
import { ingestGovernanceObservations, type GovernanceObservationInput } from '../src/governance-observation-store.js';
import { recordConversationIngestionConsent } from '../src/conversation-ingestion/consent.js';
import { CODEX_INGESTION_DISCLOSURE_VERSION } from '../src/codex-disclosure.js';

const NOW = new Date('2026-11-25T10:00:00.000Z');
const ROLLOUT = '01a048ae-b2a5-71a1-9faf-0226980f98ff';
const ROOT_SESSION = 'thread-root-deps';

let workspaceDir: string;

beforeEach(() => {
  workspaceDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pd-pri1292-deps-'));
  fs.mkdirSync(path.join(workspaceDir, '.state'), { recursive: true });
  const sqlite = new Database(path.join(workspaceDir, '.state', 'trajectory.db'));
  sqlite.prepare('CREATE TABLE sessions (session_id TEXT PRIMARY KEY, started_at TEXT NOT NULL, updated_at TEXT NOT NULL)').run();
  sqlite.close();
});

afterEach(() => {
  fs.rmSync(workspaceDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 60 });
});

function seedUserTurn(visibleText: string): void {
  const input: GovernanceObservationInput = {
    hostKind: 'codex',
    rolloutIdentity: ROLLOUT,
    rootSessionId: ROOT_SESSION,
    hostTurnId: 't1',
    logicalObservationKey: 'deps-turn-1',
    kind: 'user_turn',
    source: 'transcript',
    completeness: 'complete',
    observedAt: NOW.toISOString(),
    visibleText,
  };
  const result = ingestGovernanceObservations({ workspaceDir, observations: [input], now: NOW });
  if (!result.ok) throw new Error(`seed failed: ${result.reason}`);
}

function grantCodexConsent(decision: 'granted' | 'revoked'): void {
  const write = recordConversationIngestionConsent(workspaceDir, 'codex', {
    decision,
    decidedVia: 'owner_directive',
    decidedAt: NOW.toISOString(),
    disclosureVersion: CODEX_INGESTION_DISCLOSURE_VERSION,
    evidenceRef: `test://consent/${decision}`,
  });
  if (!write.ok) throw new Error(`consent write failed: ${write.reason}`);
}

function effectiveConfig() {
  // Fresh defaults per workspace — a shared reference would let one test's
  // flag mutation leak into the others (same discipline as diagnostician-auto-run.test.ts).
  return JSON.parse(JSON.stringify(getDefaultPdConfig()));
}

describe('resolveWorkspacePipelineHostDeps (PRI-1292 Phase 2A)', () => {
  it('returns all five collaborators, none optional', () => {
    const deps = resolveWorkspacePipelineHostDeps({ workspaceDir, effectiveConfig: effectiveConfig() });
    expect(typeof deps.intentDocReader.readIntentDoc).toBe('function');
    expect(typeof deps.trajectoryTurnReader.listUserTurnsForSession).toBe('function');
    expect(typeof deps.trajectoryTurnReader.listAssistantTurns).toBe('function');
    expect(typeof deps.sourceMaterialAuthorization.isHostSourceMaterialAuthorized).toBe('function');
    expect(typeof deps.telemetrySink.emitTelemetry).toBe('function');
    expect(typeof deps.isAutoPainSubmissionAuthorized).toBe('function');
  });

  it('the default trajectory reader and the gate observe the SAME authorization state', () => {
    // Granted: the reader serves the authorized governance turn AND the gate
    // authorizes codex — one consent ledger, one port instance.
    grantCodexConsent('granted');
    seedUserTurn('original owner words');
    const deps = resolveWorkspacePipelineHostDeps({ workspaceDir, effectiveConfig: effectiveConfig() });
    const turns: TrajectoryUserTurn[] = deps.trajectoryTurnReader.listUserTurnsForSession(ROOT_SESSION);
    expect(turns.map((t) => t.rawExcerpt)).toEqual(['original owner words']);
    expect(deps.sourceMaterialAuthorization.isHostSourceMaterialAuthorized('codex').authorized).toBe(true);

    // Revoked AFTER the deps object exists: the SAME instances flip together —
    // the reader hides the turn and the gate denies, with no second
    // authorization instance lagging behind.
    grantCodexConsent('revoked');
    expect(deps.trajectoryTurnReader.listUserTurnsForSession(ROOT_SESSION)).toEqual([]);
    expect(deps.sourceMaterialAuthorization.isHostSourceMaterialAuthorized('codex').authorized).toBe(false);
  });

  it('trajectoryTurnReaderOverride replaces the default reader and returns the SAME reference', () => {
    const override: TrajectoryTurnReader = {
      listUserTurnsForSession: (sessionId) => [{
        id: `turn-${sessionId}`,
        turnIndex: 0,
        rawExcerpt: 'override text',
        correctionDetected: false,
        correctionCue: null,
        createdAt: NOW.toISOString(),
      }],
      listAssistantTurns: () => [],
    };
    const deps = resolveWorkspacePipelineHostDeps({
      workspaceDir,
      effectiveConfig: effectiveConfig(),
      trajectoryTurnReaderOverride: override,
    });
    // Identity (not structural equality): the OpenClaw Gateway passes its own
    // in-process reader and must get exactly that object back.
    expect(deps.trajectoryTurnReader).toBe(override);
    expect(deps.trajectoryTurnReader.listUserTurnsForSession('s1')[0]?.rawExcerpt).toBe('override text');
    // The override does not touch the authorization instance, which stays a
    // real workspace-scoped consent-ledger port answering with a structured state.
    const state = deps.sourceMaterialAuthorization.isHostSourceMaterialAuthorized('codex');
    expect(typeof state.authorized).toBe('boolean');
  });

  it('telemetrySink is workspace-scoped: allowlisted events persist, others do not', () => {
    const deps = resolveWorkspacePipelineHostDeps({ workspaceDir, effectiveConfig: effectiveConfig() });
    const sinkFile = path.join(workspaceDir, '.pd', 'telemetry', 'critical-events.jsonl');
    deps.telemetrySink.emitTelemetry({
      eventType: 'reuse_gate_triggered',
      traceId: 'trace-deps-1',
      timestamp: NOW.toISOString(),
      sessionId: '',
      payload: { candidateId: 'cand-1' },
    });
    deps.telemetrySink.emitTelemetry({
      eventType: 'runtime_adapter_selected',
      traceId: 'trace-deps-2',
      timestamp: NOW.toISOString(),
      sessionId: '',
      payload: { runtimeKind: 'pi-ai' },
    });
    expect(fs.existsSync(sinkFile)).toBe(true);
    const lines = fs.readFileSync(sinkFile, 'utf8').trim().split('\n');
    expect(lines).toHaveLength(1);
    expect(JSON.parse(lines[0] ?? '{}')).toMatchObject({ eventType: 'reuse_gate_triggered', traceId: 'trace-deps-1' });
  });

  it('isAutoPainSubmissionAuthorized reads the workspace flag, not the process default', () => {
    const config = effectiveConfig();
    config.features.automatic_pain_submission.enabled = true;
    fs.mkdirSync(path.join(workspaceDir, '.pd'), { recursive: true });
    fs.writeFileSync(path.join(workspaceDir, '.pd', 'config.yaml'), JSON.stringify(config));
    const deps = resolveWorkspacePipelineHostDeps({ workspaceDir, effectiveConfig: config });
    expect(deps.isAutoPainSubmissionAuthorized()).toBe(true);
  });
});
