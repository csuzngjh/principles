/**
 * PRI-1273 (A2) — end-to-end acceptance: the target turn's body arrives LATE.
 *
 * The whole chain runs on real components in ONE isolated workspace:
 *
 *  A. the REAL Codex hook (built dist, fresh subprocess) ingests a rollout
 *     transcript that so far contains turns 1–9 — the checkpoint lands at the
 *     file's end (real ingestion, real consent ledger, real trajectory.db);
 *  B. the REAL pd-mcp-server (built dist over stdio, the host's trusted
 *     `_meta`) submits at turn 12 naming turn 10 explicitly: the ORIGINAL
 *     Pain/Task is created WAITING (`waiting_for_target_evidence`) with no
 *     evidence — turn 10's body is not in the authorized store yet;
 *  C. turns 10–12 are appended to the same rollout file (the transcript grew,
 *     exactly like a real Codex session) and ONE real worker cycle runs:
 *     catch-up ingests the delta, the reconcile BACKFILLS turn 10's evidence
 *     + evidenceClass onto the SAME task in one CAS and flips it ready, the
 *     picker serves it, and the real split pipeline (real Stage A assembly
 *     reading EXACTLY turn 10, real lease, real committer, real candidate
 *     admission) executes — the ONLY deterministic stand-in is the LLM
 *     boundary (the sanctioned local deterministic model).
 *
 * Assertions that make this an A2 proof, not a "wrote the db" proof:
 *  - the original painId/taskId never change;
 *  - the backfilled evidence is EXACTLY turn 10's rows (never 11/12);
 *  - evidenceClass.available.entryCount === the real evidence array length;
 *  - the model call the diagnosis actually sent contains turn 10's text and
 *    neither turn 11's nor turn 12's markers;
 *  - a second cycle is a no-op (no double diagnosis, no duplicate evidence).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { Client } from '@modelcontextprotocol/client';
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio';
import type { Readable } from 'node:stream';
import { fileURLToPath } from 'node:url';
import Database from 'better-sqlite3';
import {
  disposePainSignalBridgesForWorkspace,
  getDefaultPdConfig,
  PiAiRuntimeAdapter,
} from '@principles/core/runtime';
import {
  MOCK_ROOT_CAUSE_OUTPUTS,
  MOCK_DISTILLER_OUTPUTS,
  MOCK_ROUTER_OUTPUTS,
} from '../../../principles-core/src/runtime/adapter/split-pipeline-fixtures.js';
import { runCodexWorkspaceWorkerCycle } from '../../src/worker/workspace-worker.js';
import { readGovernanceCheckpoint } from '@principles/host-runtime';
import { runHookExecutable } from '../helpers/pd-hook-runner.js';
import { writeGrantedCodexConsent } from '../helpers/consent.js';

const MCP_DIST_ENTRY = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..', 'pd-mcp-server', 'dist', 'index.js');

// ── the rollout: 12 turns with distinct fixed ids and unique markers ────────
const ROOT_SESSION = 'e27d3a10-0000-4000-8000-1273e2a40001';
const turnId = (n: number): string => `e27d3a10-0000-4000-8000-1273e2t${String(n).padStart(4, '0')}`;
const userMarker = (n: number): string => `E2E-1273-T${n}-USER-MARKER`;
const assistantMarker = (n: number): string => `E2E-1273-T${n}-ASSISTANT-MARKER`;
/** Lines the initial fixture holds (header + `turns` × 5 records) — appended
 * deltas must slice AFTER this so the growth appends ONLY new turns
 * (CodeRabbit: slicing lines re-appends old records and turns the scenario
 * into a replay-tolerance test). */
const rolloutLineCount = (turns: number): number => 1 + turns * 5;

function rolloutLines(count: number): string[] {
  const lines: string[] = [{
    timestamp: '2026-11-23T08:00:00.000Z',
    ordinal: 0,
    type: 'session_meta',
    payload: {
      session_id: ROOT_SESSION, id: ROOT_SESSION,
      timestamp: '2026-11-23T08:00:00.000Z', cwd: 'D:\\ws\\e2e',
      originator: 'codex_exec', cli_version: '0.167.0', source: 'exec',
      thread_source: 'user', model_provider: 'openai', history_mode: 'paginated',
    },
  }];
  let ordinal = 1;
  let clock = Date.parse('2026-11-23T08:00:01.000Z');
  for (let n = 1; n <= count; n += 1) {
    const at = (deltaMs: number): string => new Date(clock + deltaMs).toISOString();
    lines.push({ timestamp: at(0), ordinal: ordinal++, type: 'event_msg', payload: { type: 'task_started', turn_id: turnId(n), started_at: Math.floor((clock) / 1000), model_context_window: 258400, collaboration_mode_kind: 'default' } });
    lines.push({
      timestamp: at(1000), ordinal: ordinal++, type: 'response_item',
      payload: {
        type: 'message', id: `msg_u_${turnId(n)}`, role: 'user',
        content: [{ type: 'input_text', text: `${userMarker(n)} — do step ${n} of the plan.` }],
        internal_chat_message_metadata_passthrough: { turn_id: turnId(n), create_time: (clock + 1000) / 1000, content_item_kinds: ['user.text'] },
      },
    });
    lines.push({
      timestamp: at(2000), ordinal: ordinal++, type: 'response_item',
      payload: {
        type: 'message', id: `msg_a_${turnId(n)}`, role: 'assistant',
        content: [{ type: 'output_text', text: `${assistantMarker(n)} — step ${n} done.` }],
        phase: 'final_answer',
        internal_chat_message_metadata_passthrough: { turn_id: turnId(n), create_time: (clock + 2000) / 1000, content_item_kinds: ['unknown'] },
      },
    });
    // The completed-item event is what the decoder projects as an
    // assistant_turn observation (fixture-verified G1 shape).
    lines.push({
      timestamp: at(2500), ordinal: ordinal++, type: 'event_msg',
      payload: {
        type: 'item_completed', thread_id: ROOT_SESSION, turn_id: turnId(n),
        item: { type: 'AgentMessage', id: `item_a_${turnId(n)}`, content: [{ type: 'text', text: `${assistantMarker(n)} — step ${n} done.` }] },
        started_at_ms: clock + 2000, completed_at_ms: clock + 2500,
      },
    });
    lines.push({ timestamp: at(3000), ordinal: ordinal++, type: 'event_msg', payload: { type: 'task_complete', turn_id: turnId(n) } });
    clock += 10_000;
  }
  return lines;
}

// ── workspace ───────────────────────────────────────────────────────────────
const dirs: string[] = [];

interface E2eWorkspace { root: string; codexHome: string; transcriptPath: string; }

function makeWorkspace(): E2eWorkspace {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pd-1273-e2e-'));
  dirs.push(root);
  fs.mkdirSync(path.join(root, '.pd'), { recursive: true });
  fs.mkdirSync(path.join(root, '.state'), { recursive: true });
  fs.writeFileSync(path.join(root, '.state', 'trajectory.db'), '');
  writeGrantedCodexConsent(root);
  const config = getDefaultPdConfig();
  config.features['host.codex'].enabled = true;
  config.features.codex_conversation_ingestion.enabled = true;
  config.features.internalization_auto_consumer.enabled = true;
  config.features.automatic_pain_submission = { category: 'quiet', enabled: true };
  config.features.host_identity_minimal_metadata = { category: 'quiet', enabled: true };
  config.internalAgents = config.internalAgents ?? { defaultRuntime: 'pd.default', agents: {} };
  config.internalAgents.agents = config.internalAgents.agents ?? {};
  config.internalAgents.agents.diagnostician = { enabled: true, runtimeProfile: config.internalAgents.defaultRuntime };
  (config.runtimeProfiles as Record<string, unknown>)['pd.default'] = {
    type: 'pi-ai', provider: 'test-provider', model: 'test-model',
    apiKeyEnv: 'PD_1273_E2E_KEY', baseUrl: 'http://127.0.0.1:8080/v1',
  };
  process.env.PD_1273_E2E_KEY = 'test-key';
  fs.writeFileSync(path.join(root, '.pd', 'config.yaml'), JSON.stringify(config));

  const codexHome = fs.mkdtempSync(path.join(os.tmpdir(), 'pd-1273-e2e-home-'));
  dirs.push(codexHome);
  const sessions = path.join(codexHome, 'sessions', '2026', '11', '23');
  fs.mkdirSync(sessions, { recursive: true });
  const transcriptPath = path.join(sessions, `rollout-2026-11-23T08-00-00-${ROOT_SESSION}.jsonl`);
  // Phase A: only turns 1–9 exist yet — the target turn 10 is NOT collected.
  fs.writeFileSync(transcriptPath, `${rolloutLines(9).map((l) => JSON.stringify(l)).join('\n')}\n`);
  return { root, codexHome, transcriptPath };
}

function stateDb(root: string): Database.Database {
  return new Database(path.join(root, '.pd', 'state.db'), { readonly: true });
}

function diagnosticRow(root: string, taskId: string): { status: string; input_ref: string; diagnostic_json: string } | undefined {
  const db = stateDb(root);
  try {
    return db.prepare('SELECT status, input_ref, diagnostic_json FROM tasks WHERE task_id = ?').get(taskId) as { status: string; input_ref: string; diagnostic_json: string } | undefined;
  } finally {
    db.close();
  }
}

function candidateCount(root: string): number {
  const db = stateDb(root);
  try {
    return (db.prepare('SELECT COUNT(*) AS n FROM principle_candidates').get() as { n: number }).n;
  } finally {
    db.close();
  }
}

function runCount(root: string, taskId: string): number {
  const db = stateDb(root);
  try {
    return (db.prepare('SELECT COUNT(*) AS n FROM runs WHERE task_id = ?').get(taskId) as { n: number }).n;
  } finally {
    db.close();
  }
}

/**
 * The deterministic local model: the LLM boundary ONLY. Every stage of the
 * real split pipeline runs — Stage A assembly, lease, committer, admission.
 * The stage outputs cite the refs the ORIGINAL task's backfilled evidence
 * actually carries, read live from state.db when the model is asked (ERR-177:
 * a model output may only cite refs present in the rendered prompt payload —
 * which are exactly those backfilled refs). Returns the prompts the rootcause
 * stage actually sent (for the same-evidence assertion).
 */
function deterministicModelBoundary(wsRoot: string): { rootCausePrompts: string[] } {
  const rootCausePrompts: string[] = [];
  let counter = 0;
  const runIdToTaskId = new Map<string, string>();

  /** Live read of the parent task's backfilled evidence refs (the model's
   * honest citation universe; read-only, WAL-concurrent with the worker). */
  const trustedRefsFor = (stageTaskId: string): string[] => {
    const parentTaskId = stageTaskId.replace(/^diag_[a-z]+-/, '');
    const db = stateDb(wsRoot);
    try {
      const row = db.prepare('SELECT diagnostic_json FROM tasks WHERE task_id = ?').get(parentTaskId) as { diagnostic_json: string } | undefined;
      if (row === undefined) return [];
      const evidence = (JSON.parse(row.diagnostic_json) as { evidence?: Array<{ sourceRef?: unknown }> }).evidence;
      if (!Array.isArray(evidence)) return [];
      return evidence.flatMap((entry) => typeof entry?.sourceRef === 'string' ? [entry.sourceRef] : []);
    } finally {
      db.close();
    }
  };
  const citedEvidenceFor = (stageTaskId: string) => {
    const refs = trustedRefsFor(stageTaskId);
    return refs.map((sourceRef) => ({ sourceRef, note: 'the target turn body as backfilled onto the task' }));
  };

  vi.spyOn(PiAiRuntimeAdapter.prototype, 'getCapabilities').mockResolvedValue({
    supportsStructuredJsonOutput: true, supportsToolUse: false, supportsWorkingDirectory: false,
    supportsModelSelection: false, supportsLongRunningSessions: false, supportsCancellation: true,
    supportsArtifactWriteBack: false, supportsConcurrentRuns: false, supportsStreaming: false,
  });
  vi.spyOn(PiAiRuntimeAdapter.prototype, 'healthCheck').mockResolvedValue({
    healthy: true, degraded: false, warnings: [], lastCheckedAt: new Date().toISOString(),
  });
  vi.spyOn(PiAiRuntimeAdapter.prototype, 'startRun').mockImplementation(async (input) => {
    counter += 1;
    const runId = `e2e-llm-${counter}`;
    const taskId = input.taskRef?.taskId ?? '';
    runIdToTaskId.set(runId, taskId);
    if (taskId.includes('diag_rootcause')) {
      rootCausePrompts.push(String(input.inputPayload ?? ''));
    }
    return {
      runId, runtimeKind: 'pi-ai', startedAt: new Date().toISOString(),
      systemPromptDigest: createHash('sha256').update(input.systemPrompt ?? '', 'utf8').digest('hex'),
    };
  });
  vi.spyOn(PiAiRuntimeAdapter.prototype, 'pollRun').mockImplementation(async (runId) => ({
    runId, status: 'succeeded' as const, startedAt: new Date().toISOString(), endedAt: new Date().toISOString(),
  }));
  vi.spyOn(PiAiRuntimeAdapter.prototype, 'fetchOutput').mockImplementation(async (runId) => {
    const taskId = runIdToTaskId.get(runId) ?? '';
    if (taskId.includes('diag_rootcause')) {
      const cited = citedEvidenceFor(taskId);
      const primary = cited[0]?.sourceRef;
      if (primary === undefined) throw new Error(`e2e: no backfilled evidence refs found for ${taskId}`);
      return {
        runId,
        payload: {
          ...MOCK_ROOT_CAUSE_OUTPUTS.R6,
          taskId,
          diagnosisId: `diag-${taskId}`,
          evidence: cited,
          causalChain: MOCK_ROOT_CAUSE_OUTPUTS.R6.causalChain.map((link) => ({ ...link, evidenceRefs: [primary] })),
        },
      };
    }
    if (taskId.includes('diag_distiller')) {
      const rcTaskId = taskId.replace('diag_distiller', 'diag_rootcause');
      // The predecessor artifact id is `pi-art-<stageTaskId>-<runStoreRunId>`
      // — the run STORE's id (run_<task>_<n>), not this adapter's handle.
      // Read it live from the rootcause stage's persisted run.
      const db = stateDb(wsRoot);
      let expectedArtifactId: string | undefined;
      try {
        const row = db.prepare('SELECT run_id FROM runs WHERE task_id = ? ORDER BY started_at DESC, run_id DESC LIMIT 1').get(rcTaskId) as { run_id: string } | undefined;
        if (row !== undefined) expectedArtifactId = `pi-art-${rcTaskId}-${row.run_id}`;
      } finally {
        db.close();
      }
      if (expectedArtifactId === undefined) throw new Error(`e2e: no rootcause run recorded for ${rcTaskId}`);
      return { runId, payload: { ...MOCK_DISTILLER_OUTPUTS.R6, taskId, sourceRootCauseArtifactId: expectedArtifactId } };
    }
    if (taskId.includes('diag_router')) {
      const cited = citedEvidenceFor(taskId);
      const primary = cited[0]?.sourceRef ?? 'governance_observation:unknown';
      return {
        runId,
        payload: {
          ...MOCK_ROUTER_OUTPUTS.R6,
          diagnosisId: `diag-${taskId.replace('diag_router-', '')}`,
          evidence: cited,
          // The principle recommendation alone — the rule recommendation in
          // the cached fixture targets the MVP-disabled "skill" channel,
          // which would (honestly, by design) land the cycle in
          // `not_internalizable` degraded instead of a clean admission.
          recommendations: MOCK_ROUTER_OUTPUTS.R6.recommendations.filter((rec) => rec.kind === 'principle'),
        },
      };
    }
    return { runId, payload: null };
  });
  return { rootCausePrompts };
}

describe('PRI-1273 (A2) — target body late: submit → catch-up → auto-backfill → diagnosis → admission', () => {
  // CodeRabbit: a silent skip on a fresh clone hides the missing artifact —
  // warn loudly instead (the merge gate always builds first, so CI still
  // exercises this suite; the precedent is PRI-1274's process test).
  const suite = fs.existsSync(MCP_DIST_ENTRY) ? describe : (() => {
    console.warn('[pd-1273-e2e] pd-mcp-server dist not built — skipping the real-stdio acceptance suite; run the pd-mcp-server build to exercise it');
    return describe.skip;
  })();
  let ws: E2eWorkspace;

  beforeEach(() => {
    vi.restoreAllMocks();
    ws = makeWorkspace();
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    await disposePainSignalBridgesForWorkspace(ws.root).catch(() => undefined);
    const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
    for (const dir of dirs.splice(0)) {
      let lastError: unknown = null;
      for (let attempt = 0; attempt < 6; attempt += 1) {
        try {
          fs.rmSync(dir, { recursive: true, force: true });
          lastError = null;
          break;
        } catch (error) {
          lastError = error;
          await sleep(150);
        }
      }
      if (lastError !== null) throw new Error(`cleanup failed on ${dir}: ${String(lastError).slice(0, 120)}`);
    }
  });

  suite('the full chain', () => {
    it('backfills turn 10 onto the SAME waiting task and diagnoses it once turn 10 arrives', { timeout: 180_000 }, async () => {
      // ── Phase A: the real hook ingests turns 1–9 (checkpoint at EOF) ──────
      const stop = await runHookExecutable(ws.codexHome, JSON.stringify({
        session_id: ROOT_SESSION,
        turn_id: turnId(9),
        transcript_path: ws.transcriptPath,
        cwd: ws.root,
        hook_event_name: 'Stop',
        model: 'gpt-5.6-sol',
        permission_mode: 'bypassPermissions',
        stop_hook_active: false,
        last_assistant_message: assistantMarker(9),
      }), { timeoutMs: 20_000 });
      expect(stop.status, stop.stderr).toBe(0);

      // ── Phase B: the real MCP entry submits at turn 12 targeting turn 10 ─
      const logDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pd-1273-e2e-logs-'));
      dirs.push(logDir);
      const transport = new StdioClientTransport({
        command: process.execPath,
        args: [MCP_DIST_ENTRY],
        env: {
          PD_MCP_WORKSPACE_DIR: ws.root,
          PD_MCP_HOST: 'codex',
          PD_MCP_LOG_DIR: logDir,
        },
        stderr: 'pipe',
      });
      (transport.stderr as Readable | undefined)?.setEncoding('utf8');
      (transport.stderr as Readable | undefined)?.on('data', () => { /* drained; asserted via state.db */ });
      const client = new Client({ name: 'pd-1273-e2e', version: '0.0.0' });
      await client.connect(transport);
      let painId = '';
      let taskId = '';
      try {
        const result = await client.callTool({
          name: 'pd_submit_pain',
          arguments: {
            reason: 'Anchor: agent instruction. Observed: step 10 was executed without the requested verification. Deviation: the verification step was skipped.',
            anchorType: 'agent_instruction',
            anchorRef: 'AGENTS.md#safety',
            painType: 'user_frustration',
            targetTurnId: turnId(10),
          },
          _meta: {
            threadId: ROOT_SESSION,
            'x-codex-turn-metadata': { turn_id: turnId(12) },
          },
        });
        expect(result.isError).toBeFalsy();
        const [block] = result.content;
        if (block === undefined || block.type !== 'text') throw new Error('expected text content');
        const receipt = JSON.parse(block.text) as {
          status: string; painId: string | null; taskId: string | null;
          sessionAssociation?: { status: string; sessionId?: string; targetTurnId?: string };
          error?: { message: string } | null;
        };
        expect(receipt.status, JSON.stringify(receipt.error)).toBe('submitted');
        expect(receipt.sessionAssociation).toEqual({
          status: 'verified', sessionId: ROOT_SESSION,
          submissionTurnId: turnId(12), targetTurnId: turnId(10),
        });
        if (receipt.painId === null || receipt.taskId === null) throw new Error('receipt identity missing');
        painId = receipt.painId;
        taskId = receipt.taskId;
      } finally {
        try { await client.close(); } catch { /* the child may already be gone */ }
      }

      // The original task is WAITING on turn 10's body: identity bound, no
      // evidence, honest unavailable class.
      const waitingRow = diagnosticRow(ws.root, taskId);
      expect(waitingRow?.status).toBe('pending');
      expect(waitingRow?.input_ref).toBe(painId);
      const waitingDiagnostic = JSON.parse(waitingRow?.diagnostic_json ?? '{}') as Record<string, unknown>;
      expect(waitingDiagnostic.sessionIdHint).toBe(ROOT_SESSION);
      expect((waitingDiagnostic.recovery as Record<string, unknown>).state).toBe('waiting_for_target_evidence');
      expect(waitingDiagnostic.evidence).toEqual([]);

      // A cycle while the body is still missing: catch-up has no delta, the
      // reconcile keeps waiting, nothing is diagnosed.
      const preCycle = await runCodexWorkspaceWorkerCycle({ workspaceDir: ws.root, env: { CODEX_HOME: ws.codexHome } });
      expect(preCycle.mode).toBe('ready');
      expect(preCycle.report?.targetEvidenceReconcile).toMatchObject({ checked: 1, flipped: 0, stillWaiting: 1 });
      expect(preCycle.report?.diagnostician).toBeNull();

      // ── Phase C: the transcript GREW — turns 10–12 arrive late ───────────
      fs.appendFileSync(ws.transcriptPath, `${rolloutLines(12).slice(rolloutLineCount(9)).map((l) => JSON.stringify(l)).join('\n')}\n`);

      const model = deterministicModelBoundary(ws.root);
      const cycle = await runCodexWorkspaceWorkerCycle({ workspaceDir: ws.root, env: { CODEX_HOME: ws.codexHome } });
      expect(cycle.mode, `${cycle.reason ?? ''} :: ${JSON.stringify(cycle.report?.diagnostician ?? {})}`).toBe('ready');
      expect(cycle.report?.targetEvidenceReconcile).toMatchObject({ checked: 1, flipped: 1, backfilled: 1, blocked: 0 });
      expect(cycle.report?.diagnostician).toMatchObject({ taskId, status: 'succeeded' });

      // The SAME original task — ids never changed — now carries EXACTLY
      // turn 10's evidence with a consistent evidenceClass.
      const doneRow = diagnosticRow(ws.root, taskId);
      expect(doneRow?.status).toBe('succeeded');
      expect(doneRow?.input_ref).toBe(painId);
      const doneDiagnostic = JSON.parse(doneRow?.diagnostic_json ?? '{}') as Record<string, unknown>;
      const evidence = doneDiagnostic.evidence as Array<{ sourceRef: string; note: string }>;
      expect(evidence.length).toBe(2);
      expect(evidence.every((entry) => entry.sourceRef.startsWith(`governance_observation:codex|${ROOT_SESSION}|${turnId(10)}|`))).toBe(true);
      const evidenceNotes = evidence.map((entry) => entry.note).join('\n');
      expect(evidenceNotes).toContain(userMarker(10));
      expect(evidenceNotes).not.toContain(userMarker(11));
      expect(evidenceNotes).not.toContain(userMarker(12));
      const painIngress = doneDiagnostic.painIngress as Record<string, unknown>;
      expect(painIngress.evidenceClass).toEqual({ status: 'available', entryCount: evidence.length });
      const recovery = doneDiagnostic.recovery as Record<string, unknown>;
      expect(recovery.state).toBe('ready_for_diagnosis');

      // The REAL diagnosis assembly consumed the SAME material: the model
      // call the rootcause stage sent contains turn 10 and never 11/12.
      expect(model.rootCausePrompts.length).toBe(1);
      const prompt = model.rootCausePrompts[0] ?? '';
      expect(prompt).toContain(userMarker(10));
      expect(prompt).toContain(assistantMarker(10));
      expect(prompt).not.toContain(userMarker(11));
      expect(prompt).not.toContain(assistantMarker(11));
      expect(prompt).not.toContain(userMarker(12));
      expect(prompt).not.toContain(assistantMarker(12));

      // The existing admission flow produced candidates from this diagnosis.
      expect(candidateCount(ws.root)).toBeGreaterThanOrEqual(1);

      // ── A repeated cycle is a no-op: no second diagnosis, no duplicate ──
      const runsBefore = runCount(ws.root, taskId);
      const again = deterministicModelBoundary(ws.root);
      const secondCycle = await runCodexWorkspaceWorkerCycle({ workspaceDir: ws.root, env: { CODEX_HOME: ws.codexHome } });
      expect(secondCycle.report?.targetEvidenceReconcile).toMatchObject({ checked: 0, flipped: 0 });
      expect(secondCycle.report?.diagnostician).toBeNull();
      expect(again.rootCausePrompts).toEqual([]);
      expect(runCount(ws.root, taskId)).toBe(runsBefore);
      const finalRow = diagnosticRow(ws.root, taskId);
      const finalDiagnostic = JSON.parse(finalRow?.diagnostic_json ?? '{}') as Record<string, unknown>;
      expect((finalDiagnostic.evidence as unknown[]).length).toBe(2);
    });

    it('a consent revocation between submit and arrival reclassifies the waiting task as blocked, never diagnosed', { timeout: 120_000 }, async () => {      // Same phase A + B, then the Owner revokes ingestion consent before the
      // body arrives: the reconcile must NOT read the transcript nor mix the
      // denial back into waiting.
      const stop = await runHookExecutable(ws.codexHome, JSON.stringify({
        session_id: ROOT_SESSION, turn_id: turnId(9), transcript_path: ws.transcriptPath,
        cwd: ws.root, hook_event_name: 'Stop', model: 'gpt-5.6-sol', permission_mode: 'bypassPermissions',
        stop_hook_active: false, last_assistant_message: assistantMarker(9),
      }), { timeoutMs: 20_000 });
      expect(stop.status, stop.stderr).toBe(0);

      const logDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pd-1273-e2e-logs-'));
      dirs.push(logDir);
      const transport = new StdioClientTransport({
        command: process.execPath, args: [MCP_DIST_ENTRY],
        env: { PD_MCP_WORKSPACE_DIR: ws.root, PD_MCP_HOST: 'codex', PD_MCP_LOG_DIR: logDir },
        stderr: 'pipe',
      });
      const client = new Client({ name: 'pd-1273-e2e-blocked', version: '0.0.0' });
      await client.connect(transport);
      let taskId = '';
      try {
        const result = await client.callTool({
          name: 'pd_submit_pain',
          arguments: {
            reason: 'Anchor: agent instruction. Observed: behavior. Deviation: mismatch.',
            anchorType: 'agent_instruction', anchorRef: 'AGENTS.md#safety',
            painType: 'user_frustration', targetTurnId: turnId(10),
          },
          _meta: { threadId: ROOT_SESSION, 'x-codex-turn-metadata': { turn_id: turnId(12) } },
        });
        const [block] = result.content;
        if (block === undefined || block.type !== 'text') throw new Error('expected text content');
        const receipt = JSON.parse(block.text) as { taskId: string | null };
        if (receipt.taskId === null) throw new Error('receipt identity missing');
        taskId = receipt.taskId;
      } finally {
        try { await client.close(); } catch { /* already gone */ }
      }

      // The Owner revokes; the body arrives (file grows); the worker runs.
      const { writeCodexConsent } = await import('../helpers/consent.js');
      writeCodexConsent(ws.root, 'revoked');
      fs.appendFileSync(ws.transcriptPath, `${rolloutLines(12).slice(rolloutLineCount(9)).map((l) => JSON.stringify(l)).join('\n')}\n`);
      const model = deterministicModelBoundary(ws.root);
      const cycle = await runCodexWorkspaceWorkerCycle({ workspaceDir: ws.root, env: { CODEX_HOME: ws.codexHome } });
      expect(cycle.report?.targetEvidenceReconcile).toMatchObject({ blocked: 1, flipped: 0, backfilled: 0 });
      expect(cycle.report?.diagnostician).toBeNull();
      expect(model.rootCausePrompts).toEqual([]);
      const row = diagnosticRow(ws.root, taskId);
      expect(row?.status).toBe('pending');
      const diagnostic = JSON.parse(row?.diagnostic_json ?? '{}') as Record<string, unknown>;
      expect((diagnostic.recovery as Record<string, unknown>).state).toBe('blocked_by_source_material_consent');
      expect((diagnostic.recovery as Record<string, unknown>).reasonCode).toBe('target_turn_source_material_consent_revoked');
      expect(diagnostic.evidence).toEqual([]);
    });

    it('an oversized record and an incomplete tail around the arrival do not corrupt the backfill; completion converges without duplicates', { timeout: 180_000 }, async () => {
      // Phase A: turns 1–9 ingested by the real hook.
      const stop = await runHookExecutable(ws.codexHome, JSON.stringify({
        session_id: ROOT_SESSION, turn_id: turnId(9), transcript_path: ws.transcriptPath,
        cwd: ws.root, hook_event_name: 'Stop', model: 'gpt-5.6-sol', permission_mode: 'bypassPermissions',
        stop_hook_active: false, last_assistant_message: assistantMarker(9),
      }), { timeoutMs: 20_000 });
      expect(stop.status, stop.stderr).toBe(0);

      // Phase B: the real MCP entry submits targeting turn 10 → waiting.
      const logDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pd-1273-e2e-logs-'));
      dirs.push(logDir);
      const transport = new StdioClientTransport({
        command: process.execPath, args: [MCP_DIST_ENTRY],
        env: { PD_MCP_WORKSPACE_DIR: ws.root, PD_MCP_HOST: 'codex', PD_MCP_LOG_DIR: logDir },
        stderr: 'pipe',
      });
      const client = new Client({ name: 'pd-1273-e2e-jsonl', version: '0.0.0' });
      await client.connect(transport);
      let taskId = '';
      try {
        const result = await client.callTool({
          name: 'pd_submit_pain',
          arguments: {
            reason: 'Anchor: agent instruction. Observed: behavior. Deviation: mismatch.',
            anchorType: 'agent_instruction', anchorRef: 'AGENTS.md#safety',
            painType: 'user_frustration', targetTurnId: turnId(10),
          },
          _meta: { threadId: ROOT_SESSION, 'x-codex-turn-metadata': { turn_id: turnId(12) } },
        });
        const [block] = result.content;
        if (block === undefined || block.type !== 'text') throw new Error('expected text content');
        const receipt = JSON.parse(block.text) as { taskId: string | null };
        if (receipt.taskId === null) throw new Error('receipt identity missing');
        taskId = receipt.taskId;
      } finally {
        try { await client.close(); } catch { /* already gone */ }
      }

      // Phase C, write 1: an OVERSIZED complete record (a real Codex dump of
      // a huge tool result, ~1.5 MB > the 1 MiB window), then turn 10's
      // records, then turn 11 with its LAST record left UNTERMINATED (the
      // incomplete tail — a real Codex process killed mid-write). PRI-1261
      // semantics: the oversized record is skipped with a tracked disposition
      // and the checkpoint advances; the complete turn 10 ingests; the tail
      // is held. (A MALFORMED line is deliberately NOT used here: SPEC §14.2
      // makes it a stable fail-closed stop, never skipped.)
      const oversizedRecord = `${JSON.stringify({
        timestamp: '2026-11-23T08:02:00.000Z', ordinal: 900, type: 'event_msg',
        payload: { type: 'item_completed', thread_id: ROOT_SESSION, turn_id: turnId(10), item: { type: 'AgentMessage', id: 'msg_oversized_e2e', content: [{ type: 'text', text: `E2E-OVERSIZE-${'x'.repeat(1_500_000)}` }] } },
      })}\n`;
      const turnOf = (line: unknown): string | undefined => {
        const payload = (line as { payload?: { turn_id?: string; internal_chat_message_metadata_passthrough?: { turn_id?: string } } }).payload;
        return payload?.turn_id ?? payload?.internal_chat_message_metadata_passthrough?.turn_id;
      };
      const turn10Records = rolloutLines(12).filter((line) => turnOf(line) === turnId(10));
      const turn11Records = rolloutLines(12).filter((line) => turnOf(line) === turnId(11));
      // The incomplete tail must be GENUINELY partial JSON (a line missing
      // only its newline parses optimistically and is consumed — the decoder
      // only HOLDS an unparseable tail, the PRI-1261 shape). Truncate the
      // last record mid-JSON; write 2 below appends the exact remainder.
      const lastLine = JSON.stringify(turn11Records[turn11Records.length - 1]);
      if (lastLine === undefined) throw new Error('fixture: turn 11 records missing');
      const truncatedTail = lastLine.slice(0, lastLine.length - 30);
      const tailRemainder = lastLine.slice(truncatedTail.length);
      fs.appendFileSync(
        ws.transcriptPath,
        [
          oversizedRecord.trimEnd(),
          ...turn10Records.map((l) => JSON.stringify(l)),
          ...turn11Records.slice(0, -1).map((l) => JSON.stringify(l)),
          truncatedTail,
        ].join('\n'),
      );

      // Convergence loop — the real worker cycles repeatedly, and PRI-1261
      // semantics need a bounded number of passes over the oversized record
      // (byte-bound stop → tracked skip → complete records). The loop is the
      // honest simulation of "the worker keeps cycling".
      const model = deterministicModelBoundary(ws.root);
      let sawBackfill = false;
      let diagnosed = false;
      let sawLagDegraded = false;
      let lastCycle: Awaited<ReturnType<typeof runCodexWorkspaceWorkerCycle>> | undefined;
      for (let attempt = 0; attempt < 5 && !diagnosed; attempt += 1) {
        lastCycle = await runCodexWorkspaceWorkerCycle({ workspaceDir: ws.root, env: { CODEX_HOME: ws.codexHome } });
        const reconcile = lastCycle.report?.targetEvidenceReconcile;
        if (reconcile !== null && reconcile !== undefined && reconcile.backfilled > 0) sawBackfill = true;
        if ((lastCycle.reason ?? '').includes(`catch_up:${ROOT_SESSION}`)) sawLagDegraded = true;
        diagnosed = lastCycle.report?.diagnostician?.status === 'succeeded';
      }
      // The incomplete tail is OBSERVABLE lag at some point in the loop: the
      // catch-up step reports the rollout degraded with remaining bytes —
      // never a silent skip (rc-9).
      expect(sawLagDegraded).toBe(true);
      // Turn 10's complete records still backfilled + diagnosed despite the
      // oversized record before them and the incomplete tail after turn 11.
      expect(sawBackfill).toBe(true);
      expect(diagnosed).toBe(true);
      expect(model.rootCausePrompts.length).toBe(1);
      expect(model.rootCausePrompts[0]).toContain(userMarker(10));

      // Phase C, write 2: the interrupted writer FINISHES the partial line
      // (the exact remainder + newline). A later cycle consumes it with no
      // duplicate backfill and no second diagnosis of the SAME task.
      // CodeRabbit: prove the checkpoint was actually HOLDING the tail before
      // completion, and that the evidence array survives byte-identical.
      const checkpointOf = (): number | null => {
        const read = readGovernanceCheckpoint({ workspaceDir: ws.root, hostKind: 'codex', rolloutIdentity: ROOT_SESSION });
        return read !== null && 'byteOffset' in read ? read.byteOffset : null;
      };
      // Single-read snapshot (CodeQL race): the test owns this file — one
      // read yields both the content and its size; the completion rewrite
      // writes the whole file back rather than stat-then-append.
      const heldContent = fs.readFileSync(ws.transcriptPath, 'utf8');
      const heldSize = Buffer.byteLength(heldContent, 'utf8');
      const tailStart = heldSize - Buffer.byteLength(truncatedTail, 'utf8');
      const heldCheckpoint = checkpointOf();
      // The checkpoint is EXACTLY at the start of the partial tail — the
      // decoder read everything before it and is holding the tail itself
      // (a bare `< fileSize` would also pass if it had stopped earlier, e.g.
      // on a batch bound; and reaching EOF after completion cannot by itself
      // prove the tail had been reached before).
      expect(heldCheckpoint).toBe(tailStart);
      const rowBefore = diagnosticRow(ws.root, taskId);
      const diagnosticBefore = JSON.parse(rowBefore?.diagnostic_json ?? '{}') as Record<string, unknown>;
      const evidenceBefore = diagnosticBefore.evidence;
      const entryCountBefore = (diagnosticBefore.painIngress as Record<string, unknown>).evidenceClass;
      // The baseline being compared against is pinned first: exactly the two
      // target-turn rows (user + assistant) with a matching class — otherwise
      // an empty or pre-duplicated array would satisfy the comparison below.
      expect(evidenceBefore).toHaveLength(2);
      expect(entryCountBefore).toEqual({ status: 'available', entryCount: 2 });

      fs.writeFileSync(ws.transcriptPath, heldContent + tailRemainder + '\n');
      const runsBefore = runCount(ws.root, taskId);
      const secondModel = deterministicModelBoundary(ws.root);
      const secondCycle = await runCodexWorkspaceWorkerCycle({ workspaceDir: ws.root, env: { CODEX_HOME: ws.codexHome } });
      expect(secondCycle.report?.targetEvidenceReconcile).toMatchObject({ checked: 0, flipped: 0 });
      expect(secondCycle.report?.diagnostician).toBeNull();
      expect(secondModel.rootCausePrompts).toEqual([]);
      expect(runCount(ws.root, taskId)).toBe(runsBefore);
      // The completed tail is consumed: the checkpoint advances to EOF.
      expect(checkpointOf()).toBe(Buffer.byteLength(fs.readFileSync(ws.transcriptPath, 'utf8'), 'utf8'));
      // The evidence array and its count survive the completion cycle
      // byte-identical — no duplicate backfill, no count drift.
      const row = diagnosticRow(ws.root, taskId);
      const diagnostic = JSON.parse(row?.diagnostic_json ?? '{}') as Record<string, unknown>;
      expect(diagnostic.evidence).toEqual(evidenceBefore);
      expect((diagnostic.painIngress as Record<string, unknown>).evidenceClass).toEqual(entryCountBefore);
      expect((diagnostic.evidence as Array<{ sourceRef: string }>).every((entry) =>
        entry.sourceRef.startsWith(`governance_observation:codex|${ROOT_SESSION}|${turnId(10)}|`))).toBe(true);
    });
  });
});
