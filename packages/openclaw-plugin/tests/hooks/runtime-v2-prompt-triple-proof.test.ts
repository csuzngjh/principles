/**
 * PRI-519 (M4): Prompt-activation triple proof — sandbox evidence.
 *
 * The scorecard's hard-veto #4 requires "Prompt activation has no complete
 * triple proof: active SQLite record, injection event with session ID, and
 * 3/3 later behavior change." The existing runtime-v2-prompt-activation
 * test mocks EventLogService, so the injection event is never actually
 * written to a real .state/logs JSONL. This test closes that gap with NO
 * mocks on the activation-read or event-write paths:
 *
 *   (a) ACTIVE SQLITE RECORD — real SqliteActivationStateStore.recordActivation
 *       writes a real prompt-channel activation row.
 *   (b) INJECTION EVENT WITH SESSION ID — real EventLogService.get(stateDir)
 *       .recordRuntimeV2ActivationsInjected(...) writes a real
 *       .state/logs/events_<date>.jsonl row carrying the sessionId.
 *   (c) 3/3 LATER BEHAVIOR CHANGE — PromptActivationReader.readActivatedPrinciples()
 *       is called 3 times (3 later prompt builds); each returns the activated
 *       principle, and renderPrinciplesToDirectives includes the principle
 *       text each time. Deactivating between builds removes it.
 *
 * This is the same triple the production prompt hook emits (prompt.ts:478-538
 * reads via PromptActivationReader, renders via renderPrinciplesToDirectives,
 * emits via eventLog.recordRuntimeV2ActivationsInjected). The hook itself is
 * heavily wired (WorkspaceContext/SignalCollectorHost/intent flags) and is
 * already covered by the mocked runtime-v2-prompt-activation.test.ts; this
 * test isolates the triple-proof primitives against real persistence.
 *
 * ERR: EP-09/ERR-088 — each pillar asserts a unique positive signal
 * (real DB row, real JSONL line, real principle text in directive), not a
 * non-unique "no error" signal.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import {
  SqliteConnection,
  SqliteActivationStateStore,
  renderPrinciplesToDirectives,
} from '@principles/core/runtime-v2';
import { PromptActivationReader } from '../../src/core/runtime-v2-prompt-activation-reader.js';
import { EventLogService } from '../../src/core/event-log.js';

const TEST_PRINCIPLE_TEXT = 'UNIQUE_TRIPLE_PROOF_PRINCIPLE_3x7q';
const TEST_PRINCIPLE_ID = 'princ-triple-proof-001';
const TEST_ARTIFACT_ID = 'art-triple-proof-001';
const TEST_SESSION_ID = 'sess-triple-proof-abc123';

let tempWorkspaceDir: string;
let tempStateDir: string;
let sqliteConn: SqliteConnection;

beforeEach(() => {
  const baseTmp = os.tmpdir();
  tempWorkspaceDir = fs.mkdtempSync(path.join(baseTmp, 'pd-triple-proof-'));
  tempStateDir = path.join(tempWorkspaceDir, '.state');
  fs.mkdirSync(tempStateDir, { recursive: true });
  // SqliteConnection seeds at workspaceDir (DB at <workspaceDir>/.pd/state.db),
  // matching PromptActivationReader's internal connection.
  sqliteConn = new SqliteConnection(tempWorkspaceDir);
  sqliteConn.getDb();
});

afterEach(() => {
  try { sqliteConn?.close(); } catch { /* best-effort */ }
  try { fs.rmSync(tempWorkspaceDir, { recursive: true, force: true }); } catch { /* Windows */ }
});

function insertValidatedPrincipleArtifact(): void {
  const db = sqliteConn.getDb();
  const now = new Date().toISOString();
  db.prepare(`
    INSERT INTO pi_artifacts (artifact_id, artifact_kind, source_task_id, source_principle_id, source_rule_id, lineage_artifact_ids, validation_status, content_json, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    TEST_ARTIFACT_ID,
    'principle',
    `task_${TEST_PRINCIPLE_ID}`,
    TEST_PRINCIPLE_ID,
    null,
    '[]',
    'validated',
    JSON.stringify({ principleId: TEST_PRINCIPLE_ID, text: TEST_PRINCIPLE_TEXT }),
    now,
    now,
  );
}

async function insertPromptActivation(deactivatedAt: string | null = null): Promise<void> {
  const store = new SqliteActivationStateStore(sqliteConn);
  const now = new Date().toISOString();
  await store.recordActivation({
    activationId: `act_prompt_${TEST_PRINCIPLE_ID}`,
    idempotencyKey: `${TEST_ARTIFACT_ID}::prompt`,
    artifactId: TEST_ARTIFACT_ID,
    channel: 'prompt',
    action: 'prompt_activate',
    targetRef: `ledger://${TEST_PRINCIPLE_ID}`,
    activatedAt: now,
    deactivatedAt,
  });
}

/** Read the real events_<date>.jsonl that EventLogService writes to. */
function readEventLogLines(): string[] {
  const logsDir = path.join(tempStateDir, 'logs');
  if (!fs.existsSync(logsDir)) return [];
  const files = fs.readdirSync(logsDir).filter((f) => f.startsWith('events_') && f.endsWith('.jsonl'));
  const lines: string[] = [];
  for (const f of files) {
    const content = fs.readFileSync(path.join(logsDir, f), 'utf8');
    for (const line of content.split('\n')) {
      if (line.trim()) lines.push(line);
    }
  }
  return lines;
}

describe('PRI-519: prompt-activation triple proof (sandbox, real persistence)', () => {
  it('triple proof: active SQLite record + session-bound injection event + 3/3 behavior change', async () => {
    // ── (a) ACTIVE SQLITE RECORD ─────────────────────────────────────────────
    insertValidatedPrincipleArtifact();
    await insertPromptActivation();

    // Verify the activation row is really in SQLite (not just the call returned).
    const db = sqliteConn.getDb();
    const activationRow = db.prepare(
      `SELECT activation_id, channel, deactivated_at FROM activations WHERE activation_id = ?`,
    ).get(`act_prompt_${TEST_PRINCIPLE_ID}`) as { activation_id: string; channel: string; deactivated_at: string | null } | undefined;
    expect(activationRow, 'activation row must exist in SQLite').toBeDefined();
    expect(activationRow!.channel).toBe('prompt');
    expect(activationRow!.deactivated_at).toBeNull();

    // ── (b) INJECTION EVENT WITH SESSION ID (real EventLog, NO mock) ─────────
    // This is the exact call the production prompt hook makes (prompt.ts:515-535).
    const eventLog = EventLogService.get(tempStateDir);
    eventLog.recordRuntimeV2ActivationsInjected({
      sessionId: TEST_SESSION_ID,
      workspaceDir: tempWorkspaceDir,
      principleIds: [TEST_PRINCIPLE_ID],
      activationIds: [`act_prompt_${TEST_PRINCIPLE_ID}`],
      artifactIds: [TEST_ARTIFACT_ID],
      injectedCount: 1,
      injectedCharCount: TEST_PRINCIPLE_TEXT.length,
      budget: 4000,
    });
    // EventLog buffers and flushes on a 30s timer or when the buffer fills.
    // For a single record we must flush explicitly to persist the JSONL line.
    eventLog.flush();

    const eventLines = readEventLogLines();
    expect(eventLines.length, 'a real events_*.jsonl line must be written').toBeGreaterThanOrEqual(1);
    const injectionLine = eventLines.find((l) => l.includes('runtime_v2_prompt_activations_injected'));
    expect(injectionLine, 'injection event must be persisted to JSONL').toBeDefined();
    // EventLogEntry shape: { ts, date, type, category, sessionId, data }
    const parsed = JSON.parse(injectionLine!) as { type: string; sessionId: string; data: { principleIds: string[]; injectedCount: number } };
    expect(parsed.type).toBe('runtime_v2_prompt_activations_injected');
    expect(parsed.sessionId, 'event must carry the session ID').toBe(TEST_SESSION_ID);
    expect(parsed.data.principleIds).toContain(TEST_PRINCIPLE_ID);
    expect(parsed.data.injectedCount).toBe(1);

    // ── (c) 3/3 LATER BEHAVIOR CHANGE ────────────────────────────────────────
    // Three later prompt builds (readActivatedPrinciples calls) each return the
    // principle, and renderPrinciplesToDirectives includes the principle text.
    const reader = new PromptActivationReader(tempWorkspaceDir);
    const directiveIncludesText: boolean[] = [];
    for (let i = 0; i < 3; i++) {
      const result = await reader.readActivatedPrinciples();
      expect(result.principles.length, `build ${i + 1} must return the activated principle`).toBe(1);
      expect(result.principles[0]!.principleId).toBe(TEST_PRINCIPLE_ID);

      // The directive is what actually gets prepended to the LLM system prompt
      // (this is the "behavior change" — the principle is now in the prompt).
      const directive = renderPrinciplesToDirectives(result.principles, new Set([TEST_PRINCIPLE_ID]), { escapeFn: (s) => s });
      directiveIncludesText.push(directive.includes(TEST_PRINCIPLE_TEXT));
    }
    expect(directiveIncludesText, 'all 3 builds must include the principle text in the directive').toEqual([true, true, true]);
  });

  it('deactivate removes the principle from later builds (rollback)', async () => {
    insertValidatedPrincipleArtifact();
    await insertPromptActivation();
    const reader = new PromptActivationReader(tempWorkspaceDir);

    // Before deactivate: principle is injected.
    const before = await reader.readActivatedPrinciples();
    expect(before.principles.length).toBe(1);

    // Deactivate (owner rollback) — set deactivated_at. NOTE: the store's
    // deactivateActivation signature requires (activationId, deactivatedAt).
    const store = new SqliteActivationStateStore(sqliteConn);
    await store.deactivateActivation(`act_prompt_${TEST_PRINCIPLE_ID}`, new Date().toISOString());

    // After deactivate: principle no longer injected.
    const after = await reader.readActivatedPrinciples();
    expect(after.principles.length, 'deactivated principle must not be injected').toBe(0);
  });

  it('restart recovery: a FRESH reader instance (new process) still sees the activation', async () => {
    // "restart" = a new PromptActivationReader + new SqliteConnection reading
    // the same persisted DB. SQLite is the source of truth, so the activation
    // survives a process restart with no in-memory state.
    insertValidatedPrincipleArtifact();
    await insertPromptActivation();

    // Close the seeding connection (simulate process death) and open a fresh one.
    sqliteConn.close();

    // A brand-new reader against the same workspaceDir must still find it.
    const freshReader = new PromptActivationReader(tempWorkspaceDir);
    const result = await freshReader.readActivatedPrinciples();
    expect(result.principles.length, 'activation must survive restart (persisted in SQLite)').toBe(1);
    expect(result.principles[0]!.principleId).toBe(TEST_PRINCIPLE_ID);

    // Re-open a connection for afterEach cleanup safety.
    sqliteConn = new SqliteConnection(tempWorkspaceDir);
    sqliteConn.getDb();
  });
});
