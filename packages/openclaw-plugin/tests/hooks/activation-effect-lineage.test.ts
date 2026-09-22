/**
 * PRI-899: Activation → Effect lineage.
 *
 * REALITY (docs/audit/PRI-836_IMPLEMENTATION_REALITY_MAP.md §M1): the effect
 * receipt already had an `activation_id` column and the ledger writer already
 * accepted it — but every effect write point passed nothing, so 93/93 effect
 * rows were NULL and `principle_applications JOIN activations` returned 0.
 * Presence rows (1085/1085 linked) proved the plumbing worked; only the
 * parameter was missing.
 *
 * This suite pins the CONNECTION, not a new capability. Depth per case:
 *   - real temp workspace + real state.db + real .pd/config flags + real
 *     principle-application ledger rows;
 *   - the RuleHost BOUNDARY is mocked (the established pattern of
 *     gate-receipt-integration / gate-rule-host-pipeline: the production gate
 *     contract is the input, the RuleCode sandbox is not this ticket's subject)
 *     so `report.liveDecisionActivationId` — the value under test — is
 *     supplied exactly as the real RuleHost supplies it;
 *   - the shared-gate deny path and accountSharedDeny take their metadata as a
 *     parameter, so those cases use the REAL functions end to end.
 *
 * The acceptance assertion is the JOIN itself: a receipt whose activation_id
 * resolves to exactly one `activations` row is what the experiment needed.
 * Both directions are pinned — a decision with no attributable activation must
 * still write an UNLINKED receipt rather than invent lineage.
 */
import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import * as yaml from 'js-yaml';
import { SqliteConnection, getDefaultPdConfig } from '@principles/core/runtime-v2';
import { handleBeforeToolCall, accountSharedDeny, handleSharedRuleHostResult } from '../../src/hooks/gate.js';
import type { PluginHookBeforeToolCallResult } from '../../src/openclaw-sdk.js';
import { WorkspaceContext } from '../../src/core/workspace-context.js';
import {
  clearPrincipleApplicationLedgerCache,
  recordSelfReportFromText,
} from '../../src/core/principle-application-ledger.js';
import {
  setInjectedPrincipleIds,
  getInjectedPrincipleIds,
  getInjectedActivationIds,
  listSessions,
  clearSession,
  seedSessionForTest,
} from '../../src/core/session-tracker.js';
import { resetRuleCodeSafetyCircuitsForTests } from '../../src/core/rulecode-safety-circuit.js';

// ── Fixtures ───────────────────────────────────────────────────────────────

const BLOCK_RULE_ID = 'rule-pri899-block';
const BLOCK_ACTIVATION_ID = 'act_code_pri899_block';
const BLOCK_PRINCIPLE_ID = 'principle-pri899-block';

const AUTOCORRECT_RULE_ID = 'rule-pri899-autocorrect';
const AUTOCORRECT_ACTIVATION_ID = 'act_code_pri899_autocorrect';
const AUTOCORRECT_PRINCIPLE_ID = 'principle-pri899-autocorrect';

// PRI-532 shape: the agent's self-report marker line, resolved to a directive id.
const SELF_REPORT_PRINCIPLE_ID = 'principle-pri899-prompt';
const SELF_REPORT_ACTIVATION_ID = 'act_prompt_pri899_prompt';
const SELF_REPORT_TEXT = `📌 应用了你的原则「${SELF_REPORT_PRINCIPLE_ID}」：先取证再下结论`;

// ── RuleHost boundary mock (contract, not sandbox) ─────────────────────────

const mockEventLog = {
  recordRuleHostEvaluated: vi.fn(),
  recordRuleEnforced: vi.fn(),
  recordRuleHostBlocked: vi.fn(),
  recordRuleHostRequireApproval: vi.fn(),
  recordRuleHostAutoCorrectProposed: vi.fn(),
  recordRuleHostAutoCorrectApplied: vi.fn(),
  recordGateBlock: vi.fn(),
};

vi.mock('../../src/core/event-log.js', () => ({
  EventLogService: { get: vi.fn(() => mockEventLog) },
}));

let mockEvaluateDetailed: ReturnType<typeof vi.fn>;

vi.mock('../../src/core/rule-host.js', () => ({
  RuleHost: vi.fn(function (this: unknown) {
    this.evaluate = vi.fn().mockReturnValue(undefined);
  }),
  isCompatibilityGuardBlock: vi.fn(() => false),
}));

vi.mock('../../src/core/workspace-context.js', () => ({
  WorkspaceContext: {
    fromHookContext: vi.fn((ctx: { workspaceDir?: string }) => ({
      workspaceDir: ctx.workspaceDir,
      stateDir: `${ctx.workspaceDir ?? ''}/.state`,
      getRuleHost: () => ({
        evaluate: vi.fn().mockReturnValue(undefined),
        evaluateDetailed: (...args: unknown[]) => mockEvaluateDetailed(...args),
        dispose: vi.fn(),
      }),
      eventLog: mockEventLog,
      trajectory: { recordGateBlock: vi.fn(), getRuleHostContextRows: vi.fn(() => ({ rows: [], truncated: false })) },
      config: { get: vi.fn().mockReturnValue(undefined) },
      resolve: vi.fn(() => '/mock/PROFILE.json'),
    })),
    clearCache: vi.fn(),
  },
}));

// ── Harness ────────────────────────────────────────────────────────────────

let workspaceDir: string;
let conn: SqliteConnection;
const seededSessions = new Set<string>();

function writeConfig(): void {
  const cfg = getDefaultPdConfig() as unknown as {
    features: Record<string, { category?: string; enabled: boolean }>;
  };
  cfg.features.principle_receipt_ledger = { category: 'quiet', enabled: true };
  cfg.features.principle_receipt_self_report = { category: 'quiet', enabled: true };
  fs.mkdirSync(path.join(workspaceDir, '.pd'), { recursive: true });
  fs.writeFileSync(path.join(workspaceDir, '.pd', 'config.yaml'), yaml.dump(cfg));
}

/** A readable `activations` row (FK satisfied by the paired pi_artifacts row). */
function insertActivation(activationId: string, principleId: string, channel: 'code_tool_hook' | 'prompt'): void {
  const now = new Date().toISOString();
  const artifactId = `art-${activationId}`;
  // affectedTools is REQUIRED: the RuleCode safety circuit isolates fail-open
  // when an active activation declares no approved tool scope, which would
  // suppress enforcement before the ledger write under test is ever reached.
  const contentJson = JSON.stringify({
    ruleId: `rule-${activationId}`,
    affectedTools: ['write'],
    ruleHostGateDecision: 'accepted_shadow',
  });
  conn.getDb().prepare(`
    INSERT INTO pi_artifacts (artifact_id, artifact_kind, source_task_id, source_principle_id,
                              validation_status, content_json, created_at, updated_at)
    VALUES (?, 'rule', ?, ?, 'validated', ?, ?, ?)
  `).run(artifactId, `task-${activationId}`, principleId, contentJson, now, now);
  conn.getDb().prepare(`
    INSERT INTO activations (activation_id, idempotency_key, artifact_id, channel, action, target_ref, activated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `).run(activationId, `${artifactId}::${channel}`, artifactId, channel, `${channel}_activate`, principleId, now);
}

let gateWarnings: string[] = [];

function runGate(params: Record<string, unknown>, sessionId: string): PluginHookBeforeToolCallResult | void {
  return handleBeforeToolCall(
    { toolName: 'write', params },
    {
      workspaceDir,
      sessionId,
      logger: {
        warn: (message: string) => { gateWarnings.push(message); },
        error: vi.fn(),
        info: vi.fn(),
      },
    },
  );
}

function seedSession(sessionId: string): void {
  seedSessionForTest(sessionId, workspaceDir);
  seededSessions.add(sessionId);
}

/** The acceptance query: an effect receipt that resolves to exactly one activation. */
function joinedActivationCount(): number {
  const row = conn.getDb().prepare(`
    SELECT COUNT(*) AS n
    FROM principle_applications pa
    JOIN activations a ON a.activation_id = pa.activation_id
    WHERE pa.level = 'effect'
  `).get() as { n: number };
  return row.n;
}

function effectRow(kind: string) {
  return conn.getDb()
    .prepare('SELECT * FROM principle_applications WHERE kind = ?')
    .get(kind) as { principle_id: string; activation_id: string | null; rule_id: string | null; session_id: string | null } | undefined;
}

function effectRowCount(): number {
  return (conn.getDb()
    .prepare("SELECT COUNT(*) AS n FROM principle_applications WHERE level = 'effect'")
    .get() as { n: number }).n;
}

function blockReport(activationId: string | undefined) {
  return {
    liveDecision: { decision: 'block' as const, matched: true, reason: 'PRI899_BLOCK', ruleId: BLOCK_RULE_ID, principleId: BLOCK_PRINCIPLE_ID },
    ...(activationId !== undefined ? { liveDecisionActivationId: activationId } : {}),
    shadowDecisions: [],
    skippedActivations: [],
    liveRulesLoaded: 1,
    evaluationStatus: 'ok' as const,
  };
}

function autoCorrectReport(activationId: string | undefined) {
  return {
    liveDecision: {
      decision: 'auto_correct' as const,
      matched: true,
      reason: 'PRI899_AUTOCORRECT',
      ruleId: AUTOCORRECT_RULE_ID,
      principleId: AUTOCORRECT_PRINCIPLE_ID,
      correctionProposal: {
        ruleId: AUTOCORRECT_RULE_ID,
        principleId: AUTOCORRECT_PRINCIPLE_ID,
        confidence: 0.9,
        applicationMode: 'live' as const,
        notifyAgent: false,
        correctedFields: [{ field: 'content', reason: 'PRI899 correction' }],
        proposedParams: { path: path.join(workspaceDir, 'src', 'target.ts'), content: 'corrected' },
      },
    },
    ...(activationId !== undefined ? { liveDecisionActivationId: activationId } : {}),
    shadowDecisions: [],
    skippedActivations: [],
    liveRulesLoaded: 1,
    evaluationStatus: 'ok' as const,
  };
}

beforeEach(() => {
  clearPrincipleApplicationLedgerCache();
  // The safety circuit keeps module-level state per workspace×activation; the
  // file's fixtures reuse activation ids across temp workspaces.
  resetRuleCodeSafetyCircuitsForTests();
  vi.clearAllMocks();
  workspaceDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pd-pri899-lineage-'));
  conn = new SqliteConnection(workspaceDir);
  conn.getDb();
  writeConfig();
  mockEvaluateDetailed = vi.fn().mockReturnValue(blockReport(undefined));
  gateWarnings = [];
});

afterEach(() => {
  for (const sessionId of seededSessions) {
    try { clearSession(sessionId); } catch { /* best-effort */ }
  }
  seededSessions.clear();
  clearPrincipleApplicationLedgerCache();
  try { conn.close(); } catch { /* Windows */ }
  try { fs.rmSync(workspaceDir, { recursive: true, force: true }); } catch { /* Windows */ }
});

// ── code_tool_hook channel ─────────────────────────────────────────────────

describe('PRI-899 — code_tool_hook effect receipts carry the winning activation id', () => {
  it('rule_blocked receipt links to the activation that produced the block', () => {
    seedSession('sess-pri899-block');
    insertActivation(BLOCK_ACTIVATION_ID, BLOCK_PRINCIPLE_ID, 'code_tool_hook');
    mockEvaluateDetailed = vi.fn().mockReturnValue(blockReport(BLOCK_ACTIVATION_ID));

    const result = runGate({ path: 'src/target.ts', content: 'x' }, 'sess-pri899-block') as PluginHookBeforeToolCallResult;

    expect(result.block).toBe(true);
    const row = effectRow('rule_blocked');
    expect(row).toBeDefined();
    expect(row?.activation_id).toBe(BLOCK_ACTIVATION_ID);
    expect(row?.rule_id).toBe(BLOCK_RULE_ID);
    // The point of the whole ticket: the JOIN is no longer empty.
    expect(joinedActivationCount()).toBe(1);
  });

  it('auto_correct_applied receipt links to the activation that produced the correction', () => {
    seedSession('sess-pri899-ac');
    insertActivation(AUTOCORRECT_ACTIVATION_ID, AUTOCORRECT_PRINCIPLE_ID, 'code_tool_hook');
    mockEvaluateDetailed = vi.fn().mockReturnValue(autoCorrectReport(AUTOCORRECT_ACTIVATION_ID));

    runGate({ path: path.join(workspaceDir, 'src', 'target.ts'), content: 'original' }, 'sess-pri899-ac');

    const row = effectRow('auto_correct_applied');
    expect(row, gateWarnings.join(' | ')).toBeDefined();
    expect(row?.activation_id).toBe(AUTOCORRECT_ACTIVATION_ID);
    expect(joinedActivationCount()).toBe(1);
  });

  it('BEFORE shape (no attributable activation): the receipt is still written, unlinked', () => {
    seedSession('sess-pri899-noact');
    insertActivation(BLOCK_ACTIVATION_ID, BLOCK_PRINCIPLE_ID, 'code_tool_hook');
    // A decision with no winner activation — RuleHost leaves the id undefined.
    mockEvaluateDetailed = vi.fn().mockReturnValue(blockReport(undefined));

    const result = runGate({ path: 'src/target.ts', content: 'x' }, 'sess-pri899-noact') as PluginHookBeforeToolCallResult;

    // Enforcement is unaffected by lineage…
    expect(result.block).toBe(true);
    // …and the receipt is NOT fabricated a lineage it cannot prove (rc-9).
    const row = effectRow('rule_blocked');
    expect(row).toBeDefined();
    expect(row?.activation_id).toBeNull();
    expect(joinedActivationCount()).toBe(0);
  });

  it('prompt-channel self-report receipt links to the activation that carried the principle', () => {
    const sessionId = 'sess-pri899-selfreport';
    seedSession(sessionId);
    insertActivation(SELF_REPORT_ACTIVATION_ID, SELF_REPORT_PRINCIPLE_ID, 'prompt');

    // Exactly what prompt.ts does per build: track the injected set AND the
    // activation array the presence writer consumes (index-aligned).
    setInjectedPrincipleIds(
      sessionId,
      [SELF_REPORT_PRINCIPLE_ID, 'principle-other'],
      workspaceDir,
      [SELF_REPORT_ACTIVATION_ID, ''],
    );

    const written = recordSelfReportFromText(workspaceDir, SELF_REPORT_TEXT, sessionId);

    expect(written).toBe(1);
    const row = effectRow('self_reported');
    expect(row?.principle_id).toBe(SELF_REPORT_PRINCIPLE_ID);
    expect(row?.activation_id).toBe(SELF_REPORT_ACTIVATION_ID);
    expect(joinedActivationCount()).toBe(1);
  });

  it('legacy caller without a pairing array still records the receipt (unlinked, unchanged)', () => {
    const sessionId = 'sess-pri899-legacy';
    seedSession(sessionId);
    insertActivation(SELF_REPORT_ACTIVATION_ID, SELF_REPORT_PRINCIPLE_ID, 'prompt');
    // 3-arg call — the pre-PRI-899 signature used by older callers.
    setInjectedPrincipleIds(sessionId, [SELF_REPORT_PRINCIPLE_ID], workspaceDir);

    const written = recordSelfReportFromText(workspaceDir, SELF_REPORT_TEXT, sessionId);

    expect(written).toBe(1);
    expect(effectRow('self_reported')?.activation_id).toBeNull();
    expect(joinedActivationCount()).toBe(0);
  });

  it('the tracked activation pairing is index-aligned, tri-state, and never handed out by reference', () => {
    const sessionId = 'sess-pri899-pairing';
    seedSession(sessionId);

    setInjectedPrincipleIds(
      sessionId,
      ['principle-a', 'principle-b'],
      workspaceDir,
      [SELF_REPORT_ACTIVATION_ID, ''],
    );

    const ids = getInjectedPrincipleIds(sessionId);
    const pairing = getInjectedActivationIds(sessionId);
    expect(ids).toEqual(['principle-a', 'principle-b']);
    // Same index order, so a consumer can resolve a reported principle to its
    // own activation — and an empty entry stays empty rather than shifting.
    expect(pairing).toEqual([SELF_REPORT_ACTIVATION_ID, '']);

    // Callers get copies: mutating what they were handed must not corrupt the
    // session's recorded pairing.
    (pairing as string[]).push('act-injected-by-caller');
    expect(getInjectedActivationIds(sessionId)).toEqual([SELF_REPORT_ACTIVATION_ID, '']);
    const listed = listSessions(workspaceDir).find((s) => s.sessionId === sessionId);
    (listed?.injectedActivationIds as string[] | undefined)?.push('act-injected-by-listener');
    expect(getInjectedActivationIds(sessionId)).toEqual([SELF_REPORT_ACTIVATION_ID, '']);

    // Known session with a known, empty pairing ⇒ [] (NOT undefined): an
    // unknown session is the only thing that may report undefined.
    setInjectedPrincipleIds(sessionId, ['principle-a'], workspaceDir);
    expect(getInjectedActivationIds(sessionId)).toEqual([]);
    expect(getInjectedActivationIds('sess-never-seen')).toBeUndefined();
  });
});

// ── shared-gate deny path ──────────────────────────────────────────────────

describe('PRI-899 — shared-gate deny path carries the recovered live activation id', () => {
  const SHARED_SESSION = 'sess-pri899-shared';

  function liveEvaluation(activationId: string | undefined, activationMode: 'live' | 'shadow') {
    return {
      toolName: 'write',
      filePath: 'src/target.ts',
      matched: true,
      decision: 'block' as const,
      ruleId: BLOCK_RULE_ID,
      ...(activationId !== undefined ? { activationId } : {}),
      activationMode,
    };
  }

  beforeEach(() => {
    seedSession(SHARED_SESSION);
    insertActivation(BLOCK_ACTIVATION_ID, BLOCK_PRINCIPLE_ID, 'code_tool_hook');
  });

  it('BEFORE shape: an unattributable deny writes the receipt unlinked (no false lineage)', () => {
    const wctx = WorkspaceContext.fromHookContext({ workspaceDir, logger: { warn: vi.fn() } });
    accountSharedDeny(wctx, {
      sessionId: SHARED_SESSION,
      toolName: 'write',
      filePath: 'src/target.ts',
      reason: 'PRI899_SHARED_DENY',
      ruleId: BLOCK_RULE_ID,
      principleId: BLOCK_PRINCIPLE_ID,
    }, { warn: vi.fn() });

    const row = effectRow('rule_blocked');
    expect(row).toBeDefined();
    expect(row?.activation_id).toBeNull();
    expect(joinedActivationCount()).toBe(0);
  });

  it('AFTER shape: the same deny with the recovered activation id joins to exactly one activation', () => {
    const wctx = WorkspaceContext.fromHookContext({ workspaceDir, logger: { warn: vi.fn() } });
    accountSharedDeny(wctx, {
      sessionId: SHARED_SESSION,
      toolName: 'write',
      filePath: 'src/target.ts',
      reason: 'PRI899_SHARED_DENY',
      ruleId: BLOCK_RULE_ID,
      principleId: BLOCK_PRINCIPLE_ID,
      activationId: BLOCK_ACTIVATION_ID,
    }, { warn: vi.fn() });

    const row = effectRow('rule_blocked');
    expect(row?.activation_id).toBe(BLOCK_ACTIVATION_ID);
    expect(joinedActivationCount()).toBe(1);
  });

  it('handleSharedRuleHostResult recovers the id from metadata.evaluations (live entry)', () => {
    handleSharedRuleHostResult(
      { toolName: 'write', params: { path: 'src/target.ts', content: 'x' } } as never,
      { workspaceDir, sessionId: SHARED_SESSION, logger: { warn: vi.fn(), error: vi.fn(), info: vi.fn() } } as never,
      {
        decision: 'deny',
        reason: 'PRI899_SHARED_DENY',
        source: 'openclaw',
        metadata: {
          evaluatedLiveRules: 1,
          ruleId: BLOCK_RULE_ID,
          principleId: BLOCK_PRINCIPLE_ID,
          evaluations: [liveEvaluation(BLOCK_ACTIVATION_ID, 'live')],
        },
      } as never,
    );

    const row = effectRow('rule_blocked');
    expect(row).toBeDefined();
    expect(row?.activation_id).toBe(BLOCK_ACTIVATION_ID);
    expect(joinedActivationCount()).toBe(1);
    // Still exactly one receipt per deny — no duplicate accounting.
    expect(effectRowCount()).toBe(1);
  });

  it('a shadow-only evaluation yields no live lineage (shadow ids are never promoted)', () => {
    handleSharedRuleHostResult(
      { toolName: 'write', params: { path: 'src/target.ts', content: 'x' } } as never,
      { workspaceDir, sessionId: SHARED_SESSION, logger: { warn: vi.fn(), error: vi.fn(), info: vi.fn() } } as never,
      {
        decision: 'deny',
        reason: 'PRI899_SHARED_DENY',
        source: 'openclaw',
        metadata: {
          evaluatedLiveRules: 0,
          ruleId: BLOCK_RULE_ID,
          principleId: BLOCK_PRINCIPLE_ID,
          evaluations: [liveEvaluation('act_shadow_other', 'shadow')],
        },
      } as never,
    );

    const row = effectRow('rule_blocked');
    expect(row).toBeDefined();
    expect(row?.activation_id).toBeNull();
    expect(joinedActivationCount()).toBe(0);
  });

  it('a live entry with no activationId (unattributable aggregate) stays unlinked', () => {
    handleSharedRuleHostResult(
      { toolName: 'write', params: { path: 'src/target.ts', content: 'x' } } as never,
      { workspaceDir, sessionId: SHARED_SESSION, logger: { warn: vi.fn(), error: vi.fn(), info: vi.fn() } } as never,
      {
        decision: 'deny',
        reason: 'PRI899_SHARED_DENY',
        source: 'openclaw',
        metadata: {
          evaluatedLiveRules: 1,
          ruleId: BLOCK_RULE_ID,
          principleId: BLOCK_PRINCIPLE_ID,
          evaluations: [liveEvaluation(undefined, 'live')],
        },
      } as never,
    );

    expect(effectRow('rule_blocked')?.activation_id).toBeNull();
    expect(joinedActivationCount()).toBe(0);
  });
});
