/**
 * SPEC-PD-AGENT-PAIN-INGRESS-001 v0.8 §5 — the Core submit capability behind
 * the `pd_submit_pain` MCP tool.
 *
 * These tests exercise the REAL admission gate, the REAL ledger read and the
 * REAL async persistence path; only the failure/unconfirmed cases use a stub,
 * because they are about how the capability reports an outcome it cannot
 * prove, not about the store itself.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import Database from 'better-sqlite3';
import {
  submitPainCapability,
  validateSubmissionAnchor,
  buildMcpIngressReport,
  SUBMIT_PAIN_CAPABILITY_ID,
} from '../pain-submit-capability.js';
import { evaluatePainIngress } from '../pain-ingress.js';
import { parsePainIngressReport } from '../pain-ingress-payload.js';
import { createDiagnosticianTaskId } from '../pain-signal-bridge.js';
import { RuntimeStateManager } from '../store/runtime-state-manager.js';
import { computeEffectivePdConfig, getDefaultPdConfig, type PdConfig } from '../config/index.js';

let tmpDir: string;
let stateDir: string;

/**
 * A workspace whose diagnostician runtime profile is resolvable. The async
 * path never calls the provider, but the bridge factory resolves the profile
 * eagerly, so a submission into a workspace without any runtime profile
 * legitimately fails with `config_missing` — which is NOT what these tests
 * are about.
 */
const TEST_CONFIG = (() => {
  const base: PdConfig = getDefaultPdConfig();
  const config: PdConfig = {
    ...base,
    runtimeProfiles: {
      ...base.runtimeProfiles,
      'submit-test-profile': {
        type: 'pi-ai',
        provider: 'anthropic',
        model: 'claude-test-model',
        apiKeyEnv: 'SUBMIT_TEST_API_KEY',
      },
    },
    internalAgents: {
      defaultRuntime: 'submit-test-profile',
      agents: {
        ...base.internalAgents.agents,
        diagnostician: { enabled: true, runtimeProfile: 'submit-test-profile' },
      },
    },
  };
  return computeEffectivePdConfig(config);
})();

const SUBMIT_DEPS = {
  effectiveConfig: TEST_CONFIG,
  getEnvVar: (name: string) => (name === 'SUBMIT_TEST_API_KEY' ? 'test-key' : undefined),
};

const deps = () => ({ workspaceDir: tmpDir, stateDir, ...SUBMIT_DEPS });

function writeLedger(principles: { id: string; version?: number; status?: string }[]): void {
  const tree = {
    principles: Object.fromEntries(principles.map((p) => [
      p.id,
      {
        id: p.id,
        version: p.version ?? 1,
        text: `principle ${p.id}`,
        triggerPattern: 'when in doubt',
        action: 'verify first',
        status: p.status ?? 'active',
        derivedFromPainIds: [],
        createdAt: '2026-01-01T00:00:00.000Z',
        updatedAt: '2026-01-01T00:00:00.000Z',
      },
    ])),
    rules: {},
    implementations: {},
    metrics: {},
    lastUpdated: '2026-01-01T00:00:00.000Z',
  };
  fs.writeFileSync(path.join(stateDir, 'principle_training_state.json'), JSON.stringify({ _tree: tree }, null, 2));
}

const BASE_INPUT = {
  reason: 'Agent skipped the mandated verification step before claiming success.',
  anchorType: 'established_principle' as const,
  anchorRef: 'P-42@1',
};

function freshPainId(suffix = 'a1b2c3d4'): string {
  return `mcp_${Date.now()}_${suffix}`;
}

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pd-submit-'));
  stateDir = path.join(tmpDir, '.state');
  fs.mkdirSync(stateDir, { recursive: true });
});

afterEach(() => {
  // Windows keeps the SQLite handle briefly after close(); retry instead of
  // turning a cleanup race into a test failure.
  fs.rmSync(tmpDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
});

describe('validateSubmissionAnchor (§5.6.1)', () => {
  it('accepts an active principle at the exact version', () => {
    writeLedger([{ id: 'P-42' }]);
    expect(validateSubmissionAnchor({ stateDir, anchorType: 'established_principle', anchorRef: 'P-42@1' })).toMatchObject({ ok: true });
  });

  it('accepts probation with a visible warning', () => {
    writeLedger([{ id: 'P-42', status: 'probation' }]);
    const result = validateSubmissionAnchor({ stateDir, anchorType: 'established_principle', anchorRef: 'P-42@1' });
    expect(result.ok).toBe(true);
    expect(result.warnings?.join(' ')).toMatch(/anchor_probation/);
  });

  it.each(['candidate', 'archived', 'deprecated'])('rejects %s as not currently valid', (status) => {
    writeLedger([{ id: 'P-42', status }]);
    expect(validateSubmissionAnchor({ stateDir, anchorType: 'established_principle', anchorRef: 'P-42@1' }))
      .toMatchObject({ ok: false, code: 'anchor_not_currently_valid' });
  });

  it('maps missing principle and version mismatch to anchor_not_found', () => {
    writeLedger([{ id: 'P-42', version: 3 }]);
    expect(validateSubmissionAnchor({ stateDir, anchorType: 'established_principle', anchorRef: 'P-99@1' }))
      .toMatchObject({ ok: false, code: 'anchor_not_found' });
    expect(validateSubmissionAnchor({ stateDir, anchorType: 'established_principle', anchorRef: 'P-42@1' }))
      .toMatchObject({ ok: false, code: 'anchor_not_found' });
  });

  it('rejects a malformed anchor reference', () => {
    writeLedger([{ id: 'P-42' }]);
    expect(validateSubmissionAnchor({ stateDir, anchorType: 'established_principle', anchorRef: 'P-42' }))
      .toMatchObject({ ok: false, code: 'anchor_invalid' });
  });

  it('reports an unreadable ledger as unverifiable, never as not-found', () => {
    fs.writeFileSync(path.join(stateDir, 'principle_training_state.json'), '{ not json');
    expect(validateSubmissionAnchor({ stateDir, anchorType: 'established_principle', anchorRef: 'P-42@1' }))
      .toMatchObject({ ok: false, code: 'anchor_unverifiable' });
  });

  it('keeps owner_expectation and agent_instruction free of ledger reads', () => {
    expect(validateSubmissionAnchor({ stateDir, anchorType: 'owner_expectation', anchorRef: 'Owner said so at 14:02' })).toMatchObject({ ok: true });
    expect(validateSubmissionAnchor({ stateDir, anchorType: 'agent_instruction', anchorRef: 'docs/AGENTS.md#verification' })).toMatchObject({ ok: true });
    expect(validateSubmissionAnchor({ stateDir, anchorType: 'agent_instruction', anchorRef: 'just some words' }))
      .toMatchObject({ ok: false, code: 'anchor_invalid' });
  });
});

describe('MCP ingress report and admission (§6.6)', () => {
  it('is always unbound, evidence-free, and submitted — never degrade/refuse', () => {
    const report = buildMcpIngressReport({
      painId: 'mcp_1',
      input: BASE_INPUT,
      anchor: { principleId: 'P-42', principleVersion: '1' },
    });
    expect('error' in report).toBe(false);
    if ('error' in report) return;

    const decision = evaluatePainIngress(report);
    expect(decision.action).toBe('submit');
    if (decision.action !== 'submit') return;
    expect(decision.legacy.provenance).toBe('agent_reported_owner_approved');
    expect(decision.legacy.sessionId).toBeUndefined();
    expect(decision.legacy.evidence).toEqual([]);
    // The CLI's "re-run with --session" hint must NOT reach an MCP agent:
    // there is no session it could ever supply.
    expect(decision.warnings.join(' ')).not.toMatch(/--session/);
    expect(decision.warnings.join(' ')).toMatch(/context_unbound/);
  });

  // The MCP branch sits BEFORE the generic unbound branch. Proving that needs
  // two reports that differ in ONE fact — the channel — and still produce
  // different decisions. Identical facts declared as `external_cli_unbound`
  // get the generic "re-run with --session" advice; `mcp_agent_assisted` is
  // recognised earlier and must never see it. If the ordering regressed, the
  // MCP report would fall through to the generic branch and this test fails.
  it('matches the MCP branch before the generic unbound branch — channel alone decides', () => {
    const generic = parsePainIngressReport({
      identity: { kind: 'manual_pain_id', painId: 'mcp_3' },
      painType: 'principle_deviation',
      source: 'external_cli_unbound',
      reason: BASE_INPUT.reason,
      origin: { kind: 'owner_manual', channel: 'external_cli_unbound' },
      correlation: { status: 'unbound', reason: 'missing_host_session' },
      evidence: { status: 'unavailable', reason: 'not_applicable_unbound' },
      deviationAnchor: { principleId: 'P-42', principleVersion: '1' },
    });
    expect(generic.ok).toBe(true);
    if (!generic.ok) return;

    const genericDecision = evaluatePainIngress(generic.report);
    expect(genericDecision.action).toBe('submit');
    if (genericDecision.action !== 'submit') return;
    expect(genericDecision.legacy.provenance).toBe('owner_reported_no_host_trace');
    expect(genericDecision.warnings.join(' ')).toMatch(/--session/);

    const mcp = buildMcpIngressReport({
      painId: 'mcp_3',
      input: BASE_INPUT,
      anchor: { principleId: 'P-42', principleVersion: '1' },
    });
    if ('error' in mcp) throw new Error(mcp.message);

    const mcpDecision = evaluatePainIngress(mcp);
    expect(mcpDecision.action).toBe('submit');
    if (mcpDecision.action !== 'submit') return;
    expect(mcpDecision.legacy.provenance).toBe('agent_reported_owner_approved');
    expect(mcpDecision.warnings.join(' ')).not.toMatch(/--session/);
    expect(mcpDecision.warnings).not.toEqual(genericDecision.warnings);
  });

  it('refuses an MCP report that claims a host-bound correlation', () => {
    const parsed = parsePainIngressReport({
      identity: { kind: 'manual_pain_id', painId: 'mcp_4' },
      painType: 'principle_deviation',
      source: 'mcp_agent_assisted',
      reason: BASE_INPUT.reason,
      origin: { kind: 'owner_manual', channel: 'mcp_agent_assisted' },
      correlation: { status: 'bound', hostKind: 'openclaw', sessionId: 'session-123' },
      evidence: { status: 'unavailable', reason: 'not_applicable_unbound' },
      deviationAnchor: { principleId: 'P-42', principleVersion: '1' },
    });
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;

    const decision = evaluatePainIngress(parsed.report);
    expect(decision.action).toBe('refuse');
    if (decision.action !== 'refuse') return;
    expect(decision.reasonCode).toBe('origin_correlation_mismatch');
    expect(decision.warning).toMatch(/MCP agent-assisted/);
  });

  it('refuses a principle_deviation with no anchor at the parser level', () => {
    const report = buildMcpIngressReport({ painId: 'mcp_2', input: { ...BASE_INPUT }, anchor: undefined });
    expect(report).toMatchObject({ error: 'anchor_invalid' });
  });
});

describe('submitPainCapability (§5.5–§5.7)', () => {
  it('persists an accepted submission and returns the handler identity', async () => {
    writeLedger([{ id: 'P-42' }]);
    const painId = freshPainId();
    const receipt = await submitPainCapability({ ...deps(), painId }, BASE_INPUT);

    expect(receipt.status).toBe('submitted');
    expect(receipt.capability).toBe(SUBMIT_PAIN_CAPABILITY_ID);
    expect(receipt.painId).toBe(painId);
    expect(receipt.taskId).toBe(createDiagnosticianTaskId(painId));
    expect(receipt.provenance).toBe('agent_reported_owner_approved');
    expect(receipt.diagnosis).toEqual({ status: 'pending' });
    expect(receipt.error).toBeNull();

    const manager = new RuntimeStateManager({ workspaceDir: tmpDir });
    await manager.initialize();
    const task = await manager.getTask(receipt.taskId as string);
    expect(task).not.toBeNull();
    expect(task?.status).toBe('pending');
    expect(task?.taskKind).toBe('diagnostician');
    const diagnostic = JSON.parse(String(task?.diagnosticJson)) as Record<string, unknown>;
    expect(diagnostic?.deviationAnchor).toEqual({ principleId: 'P-42', principleVersion: '1' });
    expect(diagnostic?.provenance).toBe('agent_reported_owner_approved');
    // T07: no self-assessed score — severity lands on the shared default.
    expect(diagnostic?.severity).toBe('moderate');
    await manager.close();

    // T07 observability read-back: the MCP path never supplies a score, so the
    // persisted trajectory row must carry DEFAULT_PAIN_SCORE (40), not 80.
    const db = new Database(path.join(stateDir, 'trajectory.db'), { readonly: true });
    try {
      const painRow = db.prepare('SELECT score, severity FROM pain_events').get() as {
        score: number;
        severity: string;
      };
      expect(painRow.score).toBe(40);
      expect(painRow.severity).toBe('moderate');
    } finally {
      db.close();
    }
  });

  it('persists the structured anchor for every anchor type (§11/T03)', async () => {
    writeLedger([{ id: 'P-42' }]);
    const cases = [
      { anchorType: 'established_principle', anchorRef: 'P-42@1', painType: undefined },
      { anchorType: 'owner_expectation', anchorRef: '本次对话 Owner: "先验证再宣布完成"', painType: 'tool_failure' as const },
      { anchorType: 'agent_instruction', anchorRef: 'AGENTS.md#verification', painType: 'subagent_error' as const },
    ] as const;

    for (const [index, anchor] of cases.entries()) {
      const painId = freshPainId(`anc0000${index}`);
      const receipt = await submitPainCapability(
        { ...deps(), painId },
        { ...BASE_INPUT, ...anchor, ...(anchor.painType ? { painType: anchor.painType } : {}) },
      );
      expect(receipt.status, JSON.stringify(receipt)).toBe('submitted');

      const manager = new RuntimeStateManager({ workspaceDir: tmpDir });
      await manager.initialize();
      const task = await manager.getTask(receipt.taskId as string);
      const diagnostic = JSON.parse(String(task?.diagnosticJson)) as Record<string, unknown>;
      expect(diagnostic.anchor).toEqual({ type: anchor.anchorType, ref: anchor.anchorRef });
      await manager.close();
    }
  });

  it('refuses without a handler-generated painId and writes nothing', async () => {
    writeLedger([{ id: 'P-42' }]);
    const receipt = await submitPainCapability({ ...deps(), painId: '' }, BASE_INPUT);
    expect(receipt.status).toBe('refused');
    expect(receipt.error?.code).toBe('invalid_call');
    expect(receipt.taskId).toBeNull();
  });

  it('refuses a taskId that contradicts the painId', async () => {
    writeLedger([{ id: 'P-42' }]);
    const receipt = await submitPainCapability(
      { ...deps(), painId: freshPainId(), taskId: 'diagnosis_something_else' },
      BASE_INPUT,
    );
    expect(receipt.status).toBe('refused');
    expect(receipt.error?.code).toBe('invalid_call');
  });

  it('refuses an anchor that is not currently valid, before any write', async () => {
    writeLedger([{ id: 'P-42', status: 'candidate' }]);
    const receipt = await submitPainCapability({ ...deps(), painId: freshPainId() }, BASE_INPUT);
    expect(receipt.status).toBe('refused');
    expect(receipt.error?.code).toBe('anchor_not_currently_valid');
  });

  it('reports a duplicate as duplicate, not as a write failure', async () => {
    writeLedger([{ id: 'P-42' }]);
    const painId = freshPainId('dup11111');
    const first = await submitPainCapability({ ...deps(), painId }, BASE_INPUT);
    expect(first.status).toBe('submitted');
    const second = await submitPainCapability({ ...deps(), painId }, BASE_INPUT);
    expect(second.status).toBe('refused');
    expect(second.error?.code).toBe('task_duplicate');
    expect(second.taskId).toBe(first.taskId);
  });

  it('reports an unconfirmed outcome when the write throws, keeping the identity', async () => {
    writeLedger([{ id: 'P-42' }]);
    const painId = freshPainId('throw111');
    const receipt = await submitPainCapability(
      {
        ...deps(),
        painId,
        serviceFactory: () => ({ recordPain: async () => { throw new Error('connection reset'); } }),
      },
      BASE_INPUT,
    );
    expect(receipt.status).toBe('submit_unconfirmed');
    expect(receipt.painId).toBe(painId);
    expect(receipt.taskId).toBe(createDiagnosticianTaskId(painId));
    expect(receipt.nextAction).toMatch(/pd task show/);
  });
});
