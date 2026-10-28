/**
 * SPEC-CODEX-PAIN-CLOSURE-001 CR-07 — the explicit Owner pain-report entry
 * (`PD记录痛苦：<反馈原文>` in the CURRENT Codex user message), driven through
 * the REAL production surfaces: processHookInvocation → governance admission →
 * durable diagnostician-task enqueue. No test doubles on the production path.
 *
 * A17 pins: only the exact prefix on the current prompt triggers it; quoted /
 * mid-message / model text never does; the same observation key dedups
 * replay to ONE canonical pain; ingestion-flag-off does not block the
 * explicit channel (no transcript content is read either way).
 */
import { afterEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';
import { getDefaultPdConfig } from '@principles/core/runtime-v2';
import { ingestGovernanceObservations, reconcileGovernanceContinuation } from '@principles/host-runtime';
import { processHookInvocation } from '../src/pd-hook.js';
import { parseOwnerStatementPrefix, MAX_OWNER_STATEMENT_CHARS, recordExplicitOwnerStatement } from '../src/ingestion/explicit-owner-statement.js';
import { setCodexTranscriptPortForTest } from '../src/ingestion/ingestion.js';

const FIXTURES = new URL('./fixtures/g1-contract/', import.meta.url);
const ROOT_SESSION = '01a048ae-b2a5-71a1-9faf-0226980f98ff';
const ROOT_ROLLOUT = '01a048ae-b2a5-71a1-9faf-0226980f98ff';
const TURN_1 = '01a048ae-b344-7eb2-804b-a2fa34302fb3';

const dirs: string[] = [];

interface Workspace { root: string; codexHome: string; transcriptPath: string }

function makeWorkspace(ingestionEnabled: boolean): Workspace {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pd-explicit-stmt-'));
  dirs.push(root);
  fs.mkdirSync(path.join(root, '.pd'), { recursive: true });
  fs.mkdirSync(path.join(root, '.state'), { recursive: true });
  const config = getDefaultPdConfig();
  config.features['host.codex'].enabled = true;
  config.features['codex_conversation_ingestion'].enabled = ingestionEnabled;
  // ADR-0029: the shipped default pi-ai profile carries empty placeholders and is
  // deliberately needs_setup, so a workspace that must reach the Diagnostician
  // declares a ready profile — the same thing the installer does.
  (config.runtimeProfiles as Record<string, unknown>)['pd.default'] = {
    type: 'pi-ai', provider: 'test-provider', model: 'test-model',
    apiKeyEnv: 'PD_EXPLICIT_STMT_TEST_KEY', baseUrl: 'http://127.0.0.1:8080/v1',
  };
  process.env.PD_EXPLICIT_STMT_TEST_KEY = 'test-key';
  fs.writeFileSync(path.join(root, '.pd', 'config.yaml'), JSON.stringify(config));
  // Canonical base tables (what `pd runtime init` creates in a real workspace).
  const trajectory = new Database(path.join(root, '.state', 'trajectory.db'));
  trajectory.exec('CREATE TABLE sessions (session_id TEXT PRIMARY KEY, started_at TEXT NOT NULL, updated_at TEXT NOT NULL)');
  trajectory.exec('CREATE TABLE tool_calls (id INTEGER PRIMARY KEY AUTOINCREMENT, session_id TEXT NOT NULL, tool_name TEXT NOT NULL, outcome TEXT NOT NULL, duration_ms INTEGER, exit_code INTEGER, error_type TEXT, error_message TEXT, gfi_before REAL, gfi_after REAL, params_json TEXT NOT NULL, result_preview TEXT, created_at TEXT NOT NULL)');
  trajectory.exec('CREATE TABLE pain_events (id INTEGER PRIMARY KEY AUTOINCREMENT, session_id TEXT NOT NULL, source TEXT NOT NULL, score REAL NOT NULL, reason TEXT, severity TEXT, origin TEXT, confidence REAL, text TEXT, canonical_pain_id TEXT, runtime_task_id TEXT, host_kind TEXT, created_at TEXT NOT NULL)');
  trajectory.exec('CREATE UNIQUE INDEX idx_pain_events_canonical_pain_id ON pain_events(canonical_pain_id) WHERE canonical_pain_id IS NOT NULL');
  trajectory.close();
  const codexHome = fs.mkdtempSync(path.join(os.tmpdir(), 'pd-explicit-home-'));
  dirs.push(codexHome);
  const sessions = path.join(codexHome, 'sessions', '2026', '08', '28');
  fs.mkdirSync(sessions, { recursive: true });
  const transcriptPath = path.join(sessions, `rollout-2026-08-28T22-03-23-${ROOT_ROLLOUT}.jsonl`);
  fs.copyFileSync(new URL('transcripts/normal-tool-final-turn.jsonl', FIXTURES), transcriptPath);
  return { root, codexHome, transcriptPath };
}

function promptPayload(ws: Workspace, prompt: string, turnId = TURN_1): string {
  return JSON.stringify({
    session_id: ROOT_SESSION,
    turn_id: turnId,
    transcript_path: ws.transcriptPath,
    cwd: ws.root,
    model: 'gpt-5.6-sol',
    permission_mode: 'bypassPermissions',
    hook_event_name: 'UserPromptSubmit',
    prompt,
  });
}

afterEach(() => {
  setCodexTranscriptPortForTest(null);
  for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

function trajectoryOf(root: string): Database.Database {
  return new Database(path.join(root, '.state', 'trajectory.db'), { readonly: true });
}

function stateDbTaskIds(root: string): string[] {
  const dbPath = path.join(root, '.pd', 'state.db');
  if (!fs.existsSync(dbPath)) return [];
  const db = new Database(dbPath, { readonly: true });
  try {
    return (db.prepare("SELECT task_id FROM tasks WHERE task_kind = 'diagnostician'").all() as { task_id: string }[]).map((r) => r.task_id);
  } finally {
    db.close();
  }
}

describe('CR-07 prefix parse (deterministic, current-prompt only)', () => {
  it('accepts the exact fullwidth-colon prefix and extracts the statement', () => {
    expect(parseOwnerStatementPrefix('PD记录痛苦：重构前要先看已有实现')).toEqual({ matched: true, text: '重构前要先看已有实现' });
  });
  it('rejects non-prefix, quoted, and mid-message occurrences (A17)', () => {
    expect(parseOwnerStatementPrefix('请帮我修这个 bug')).toEqual({ matched: false });
    expect(parseOwnerStatementPrefix('他说"PD记录痛苦：xxx"')).toEqual({ matched: false });
    expect(parseOwnerStatementPrefix('prefix PD记录痛苦：xxx')).toEqual({ matched: false });
    expect(parseOwnerStatementPrefix(undefined)).toEqual({ matched: false });
  });
  it('rejects empty and over-limit statements without truncation', () => {
    expect(parseOwnerStatementPrefix('PD记录痛苦：')).toEqual({ matched: true, text: null, reason: 'statement_empty' });
    expect(parseOwnerStatementPrefix('PD记录痛苦：   ')).toEqual({ matched: true, text: null, reason: 'statement_empty' });
    expect(parseOwnerStatementPrefix(`PD记录痛苦：${'长'.repeat(MAX_OWNER_STATEMENT_CHARS + 1)}`)).toEqual({ matched: true, text: null, reason: 'statement_too_long' });
  });
});

describe('CR-07 explicit statement through the production hook', () => {
  it('records one pain + one diagnostician task and returns a receipt (A03 entry)', async () => {
    const ws = makeWorkspace(true);
    const result = await processHookInvocation(promptPayload(ws, 'PD记录痛苦：不要在未核对调用方的情况下改公共接口'), { CODEX_HOME: ws.codexHome }, ws.root);
    expect(result.exitCode).toBe(0);
    const receivedLine = result.stderr.find((line) => line.includes('owner_statement_received:'));
    expect(receivedLine).toBeDefined();
    // The observation ingestion runs BEFORE the explicit registration, so the
    // FIRST submission of a fresh rollout promotes its evidence window instead
    // of degrading with rollout_not_found/trigger_not_found.
    expect(receivedLine).not.toContain('promotion_degraded');
    const db = trajectoryOf(ws.root);
    const pains = db.prepare('SELECT canonical_pain_id, source FROM pain_events').all() as { canonical_pain_id: string; source: string }[];
    const markers = db.prepare('SELECT logical_observation_key, diagnostician_task_id FROM governance_signal_admissions').all() as { logical_observation_key: string; diagnostician_task_id: string }[];
    expect(pains).toHaveLength(1);
    expect(pains[0].source).toBe('user_correction');
    expect(markers).toHaveLength(1);
    expect(markers[0].logical_observation_key).toBe(`codex|${ROOT_ROLLOUT}|${TURN_1}|user`);
    expect(markers[0].diagnostician_task_id).toContain(pains[0].canonical_pain_id);
    // The trigger observation was persisted BEFORE promotion and is now part
    // of the promoted evidence window (bounded: trigger + ≤12 preceding turns).
    const trigger = db.prepare('SELECT retention_class, promotion_ref FROM governance_observations WHERE logical_key = ?').get(`codex|${ROOT_ROLLOUT}|${TURN_1}|user`) as { retention_class: string; promotion_ref: string };
    expect(trigger.retention_class).toBe('promoted');
    expect(trigger.promotion_ref).toBe(pains[0].canonical_pain_id);
    // The next-completed-assistant-turn tail is armed as PENDING — the window
    // waits for the Stop transcript replay, never claims completeness early.
    const tails = db.prepare('SELECT state FROM governance_pending_promotion_tails').all() as { state: string }[];
    expect(tails).toHaveLength(1);
    expect(tails[0].state).toBe('pending');
    db.close();
    expect(stateDbTaskIds(ws.root)).toHaveLength(1);
  });

  it('replay of the same turn converges on the SAME canonical pain (A17 idempotency)', async () => {
    const ws = makeWorkspace(true);
    await processHookInvocation(promptPayload(ws, 'PD记录痛苦：同一个反馈'), { CODEX_HOME: ws.codexHome }, ws.root);
    const second = await processHookInvocation(promptPayload(ws, 'PD记录痛苦：同一个反馈'), { CODEX_HOME: ws.codexHome }, ws.root);
    expect(second.exitCode).toBe(0);
    const secondReceived = second.stderr.find((line) => line.includes('owner_statement_received:'));
    expect(secondReceived).toBeDefined();
    // Replay redelivery: already_admitted + no-op promotion replay — no new
    // degradation and no second evidence window.
    expect(secondReceived).not.toContain('promotion_degraded');
    const db = trajectoryOf(ws.root);
    expect((db.prepare('SELECT COUNT(*) AS n FROM pain_events').get() as { n: number }).n).toBe(1);
    expect((db.prepare('SELECT COUNT(*) AS n FROM governance_signal_admissions').get() as { n: number }).n).toBe(1);
    expect((db.prepare('SELECT COUNT(*) AS n FROM governance_observations').get() as { n: number }).n).toBe(1);
    expect((db.prepare('SELECT COUNT(*) AS n FROM governance_pending_promotion_tails').get() as { n: number }).n).toBe(1);
    db.close();
    expect(stateDbTaskIds(ws.root)).toHaveLength(1);
  });

  it('ordinary prompts never take the explicit path (A17)', async () => {
    const ws = makeWorkspace(true);
    const result = await processHookInvocation(promptPayload(ws, '这个做法不对，重新调查后再改'), { CODEX_HOME: ws.codexHome }, ws.root);
    expect(result.exitCode).toBe(0);
    expect(result.stderr.some((line) => line.includes('owner_statement_received'))).toBe(false);
    const db = trajectoryOf(ws.root);
    // The generic STRONG keyword gate stays the only admission path for
    // ordinary text — this fixture text is not a STRONG+high-precision match.
    expect((db.prepare('SELECT COUNT(*) AS n FROM pain_events').get() as { n: number }).n).toBe(0);
    db.close();
  });

  it('works with the conversation-ingestion flag OFF (no transcript content read)', async () => {
    const ws = makeWorkspace(false);
    // Fail-loud port spy: with the flag off, the ingestion module must never
    // be entered, so even one transcript read attempt would surface here.
    let portReads = 0;
    setCodexTranscriptPortForTest({
      read() { portReads += 1; throw new Error('transcript_read_forbidden_under_flag_off'); },
    });
    const result = await processHookInvocation(promptPayload(ws, 'PD记录痛苦：ingestion 关闭时也应记录'), { CODEX_HOME: ws.codexHome }, ws.root);
    expect(result.exitCode).toBe(0);
    expect(portReads).toBe(0);
    const receivedLine = result.stderr.find((line) => line.includes('owner_statement_received:'));
    expect(receivedLine).toBeDefined();
    // Accurate disclosure: promotion was SKIPPED because ingestion is
    // consent-gated off — not a misleading trigger/rollout_not_found.
    expect(receivedLine).toContain('promotion_degraded:conversation_ingestion_disabled');
    const db = trajectoryOf(ws.root);
    expect((db.prepare('SELECT COUNT(*) AS n FROM pain_events').get() as { n: number }).n).toBe(1);
    // Privacy boundary: no session observation, no rollout row, no checkpoint.
    expect((db.prepare('SELECT COUNT(*) AS n FROM governance_observations').get() as { n: number }).n).toBe(0);
    expect((db.prepare('SELECT COUNT(*) AS n FROM governance_rollouts').get() as { n: number }).n).toBe(0);
    expect((db.prepare('SELECT COUNT(*) AS n FROM governance_transcript_checkpoints').get() as { n: number }).n).toBe(0);
    db.close();
    expect(stateDbTaskIds(ws.root)).toHaveLength(1);
  });

  it('missing transcript path rejects explicitly without recording', async () => {
    const ws = makeWorkspace(true);
    const payload = JSON.parse(promptPayload(ws, 'PD记录痛苦：无轨迹不应记录'));
    payload.transcript_path = null;
    const result = await processHookInvocation(JSON.stringify(payload), { CODEX_HOME: ws.codexHome }, ws.root);
    expect(result.exitCode).toBe(0);
    expect(result.stderr.some((line) => line.includes('owner_statement_transcript_unavailable'))).toBe(true);
    const db = trajectoryOf(ws.root);
    expect((db.prepare('SELECT COUNT(*) AS n FROM pain_events').get() as { n: number }).n).toBe(0);
    db.close();
  });

  it('an over-limit statement is rejected, never truncated', async () => {
    const ws = makeWorkspace(true);
    const result = await processHookInvocation(promptPayload(ws, `PD记录痛苦：${'超'.repeat(MAX_OWNER_STATEMENT_CHARS + 5)}`), { CODEX_HOME: ws.codexHome }, ws.root);
    expect(result.exitCode).toBe(0);
    expect(result.stderr.some((line) => line.includes('owner_statement_statement_too_long'))).toBe(true);
    const db = trajectoryOf(ws.root);
    expect((db.prepare('SELECT COUNT(*) AS n FROM pain_events').get() as { n: number }).n).toBe(0);
    db.close();
  });
});

describe('CR-07 promotion ordering, recovery, and version honesty', () => {
  it('concurrent duplicate hook invocations converge on one pain, one task, one evidence window', async () => {
    const ws = makeWorkspace(true);
    const payload = promptPayload(ws, 'PD记录痛苦：并发重放只有一个信号');
    const [a, b] = await Promise.all([
      processHookInvocation(payload, { CODEX_HOME: ws.codexHome }, ws.root),
      processHookInvocation(payload, { CODEX_HOME: ws.codexHome }, ws.root),
    ]);
    expect(a.exitCode).toBe(0);
    expect(b.exitCode).toBe(0);
    // Both receipts are consistent (received, no contradictory degradation)
    // and the durable state stays exactly-once. Scope note: better-sqlite3 is
    // synchronous, so in-process invocations interleave only at await points —
    // this pins the idempotent replay (pre-transaction marker probe →
    // already_admitted) and the task-ensure race; the cross-PROCESS
    // marker-INSERT race is pinned deterministically at the factory seam in
    // governance-signal-admission.test.ts ("loser of a concurrent
    // marker-INSERT race converges").
    for (const result of [a, b]) {
      const receivedLine = result.stderr.find((line) => line.includes('owner_statement_received:'));
      expect(receivedLine).toBeDefined();
    }
    const db = trajectoryOf(ws.root);
    expect((db.prepare('SELECT COUNT(*) AS n FROM pain_events').get() as { n: number }).n).toBe(1);
    expect((db.prepare('SELECT COUNT(*) AS n FROM governance_signal_admissions').get() as { n: number }).n).toBe(1);
    expect((db.prepare('SELECT COUNT(*) AS n FROM governance_observations').get() as { n: number }).n).toBe(1);
    expect((db.prepare('SELECT COUNT(*) AS n FROM governance_pending_promotion_tails').get() as { n: number }).n).toBe(1);
    db.close();
    expect(stateDbTaskIds(ws.root)).toHaveLength(1);
  });

  it('a first promotion failure (trigger not yet ingested) is recovered by the existing reconciliation pass', async () => {
    const ws = makeWorkspace(true);
    // Simulate the pre-fix failure mode at the seam: registration ran with
    // promotion enabled but the live observation ingestion never wrote the
    // trigger (crash or degraded write between the two steps).
    const receipt = await recordExplicitOwnerStatement({
      rawPayload: JSON.parse(promptPayload(ws, 'PD记录痛苦：首次提升失败后要能恢复')),
      workspaceDir: ws.root,
      statementText: '首次提升失败后要能恢复',
      env: { CODEX_HOME: ws.codexHome },
      conversationIngestionEnabled: true,
    });
    expect(receipt.status).toBe('received');
    if (receipt.status !== 'received') return;
    expect(receipt.promotionDegraded).toBeDefined();
    const painId = receipt.painId;

    // The trigger observation arrives later (retry / transcript catch-up).
    const ingested = ingestGovernanceObservations({
      workspaceDir: ws.root,
      rollout: { hostKind: 'codex', rolloutIdentity: ROOT_ROLLOUT, rootSessionId: ROOT_SESSION },
      observations: [{
        hostKind: 'codex',
        rolloutIdentity: ROOT_ROLLOUT,
        rootSessionId: ROOT_SESSION,
        hostTurnId: TURN_1,
        kind: 'user_turn',
        logicalObservationKey: `codex|${ROOT_ROLLOUT}|${TURN_1}|user`,
        visibleText: 'PD记录痛苦：首次提升失败后要能恢复',
        source: 'live_hook',
        completeness: 'complete',
        observedAt: new Date().toISOString(),
      }],
    });
    expect(ingested.ok).toBe(true);

    // Case C recovery through the EXISTING reconciliation mechanism — no new
    // retry system: the marker lacks promotion evidence, so reconcile retries.
    const reconciled = await reconcileGovernanceContinuation({ workspaceDir: ws.root });
    expect(reconciled.degradations.some((entry) => entry.includes(`codex|${ROOT_ROLLOUT}|${TURN_1}|user`))).toBe(false);
    const db = trajectoryOf(ws.root);
    const trigger = db.prepare('SELECT retention_class, promotion_ref FROM governance_observations WHERE logical_key = ?').get(`codex|${ROOT_ROLLOUT}|${TURN_1}|user`) as { retention_class: string; promotion_ref: string };
    expect(trigger.retention_class).toBe('promoted');
    expect(trigger.promotion_ref).toBe(painId);
    expect((db.prepare("SELECT COUNT(*) AS n FROM governance_pending_promotion_tails WHERE state = 'pending'").get() as { n: number }).n).toBe(1);
    // Idempotent recovery: a second pass finds a healthy marker and re-promotes nothing.
    const again = await reconcileGovernanceContinuation({ workspaceDir: ws.root });
    expect(again.pendingTails).toBe(0);
    expect(again.completedTails).toBe(0);
    expect((db.prepare('SELECT COUNT(*) AS n FROM governance_pending_promotion_tails').get() as { n: number }).n).toBe(1);
    db.close();
  });

  it('an unverified Codex version degrades the transcript replay explicitly and never fakes a completed window', async () => {
    const ws = makeWorkspace(true);
    // 0.164.0-alpha.11.1 is above the verified ceiling (0.162.1) and not a
    // plain semver — the classifier must report codex_version_unverified, and
    // the fix must NOT relax the version gate to make this pass.
    const transcript = fs.readFileSync(ws.transcriptPath, 'utf8').replace('"cli_version":"0.150.1"', '"cli_version":"0.164.0-alpha.11.1"');
    fs.writeFileSync(ws.transcriptPath, transcript);
    const registered = await processHookInvocation(promptPayload(ws, 'PD记录痛苦：版本未验证时的登记'), { CODEX_HOME: ws.codexHome }, ws.root);
    expect(registered.exitCode).toBe(0);
    const receivedLine = registered.stderr.find((line) => line.includes('owner_statement_received:'));
    expect(receivedLine).toBeDefined();
    expect(receivedLine).not.toContain('promotion_degraded');
    // Live hook observations come from the validated payload (not the
    // transcript contract), so the trigger itself is real evidence.
    let db = trajectoryOf(ws.root);
    const painId = (db.prepare('SELECT canonical_pain_id FROM pain_events').get() as { canonical_pain_id: string }).canonical_pain_id;
    const trigger = db.prepare('SELECT retention_class, promotion_ref FROM governance_observations WHERE logical_key = ?').get(`codex|${ROOT_ROLLOUT}|${TURN_1}|user`) as { retention_class: string; promotion_ref: string };
    expect(trigger.retention_class).toBe('promoted');
    expect(trigger.promotion_ref).toBe(painId);
    db.close();

    // The Stop transcript replay refuses the unverified version loudly: no
    // transcript-sourced observation, no checkpoint, and the pending tail
    // stays pending — the receipt never claimed a complete trajectory.
    const stop = await processHookInvocation(JSON.stringify({
      session_id: ROOT_SESSION,
      turn_id: TURN_1,
      transcript_path: ws.transcriptPath,
      cwd: ws.root,
      model: 'gpt-5.6-sol',
      permission_mode: 'bypassPermissions',
      hook_event_name: 'Stop',
      stop_hook_active: false,
      last_assistant_message: 'done',
    }), { CODEX_HOME: ws.codexHome }, ws.root);
    expect(stop.exitCode).toBe(0);
    expect(stop.stderr.some((line) => line.includes('codex_version_unverified:0.164.0-alpha.11.1'))).toBe(true);
    db = trajectoryOf(ws.root);
    expect((db.prepare("SELECT COUNT(*) AS n FROM governance_observations WHERE source = 'transcript'").get() as { n: number }).n).toBe(0);
    expect((db.prepare('SELECT COUNT(*) AS n FROM governance_transcript_checkpoints').get() as { n: number }).n).toBe(0);
    const tail = db.prepare('SELECT state FROM governance_pending_promotion_tails').get() as { state: string };
    expect(tail.state).toBe('pending');
    db.close();
  });
});
