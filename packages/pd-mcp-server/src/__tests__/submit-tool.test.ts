/**
 * `pd_submit_pain` contract tests — SPEC-PD-AGENT-PAIN-INGRESS-001 v0.8 §5,
 * acceptance matrix T01–T14b (adapter/protocol slice).
 *
 * Pins the OG-4 registration gate, strict input schema, no-write-on-rejection,
 * identity generation before the write, receipt passthrough, the §5.7 timeout
 * path (bounded read-back; never "not created", never auto-resubmit), and the
 * §5.4.3 transport-budget degradation order.
 *
 * The real persistence path (SQLite, anchor ledger, duplicate semantics) is
 * covered by the Core capability tests; this file proves the MCP surface does
 * not invent a second behaviour on top of it.
 */
import { describe, it, expect } from 'vitest';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Client } from '@modelcontextprotocol/client';
import { InMemoryTransport } from '@modelcontextprotocol/server';
import type { CallToolResult } from '@modelcontextprotocol/client';
import {
  createPdMcpServer,
  createMcpPainId,
  SUBMIT_TOOL_NAME,
  SUBMIT_RECHECK_DEADLINE_MS,
  type SubmitCapabilityCall,
  type SubmitRecheckCall,
  type SubmitToolInput,
} from '../server.js';
import { assembleSubmitResult } from '../envelope.js';
import { assembleSubmitCapability } from '../submit-assembly.js';
import { ingestGovernanceObservations } from '@principles/host-runtime';
import { recordConversationIngestionConsent } from '@principles/host-runtime';

/** PRI-1283 R2 fixture: grant codex conversation-ingestion consent. */
function recordCodexConsent(workspaceDir: string): void {
  const recorded = recordConversationIngestionConsent(workspaceDir, 'codex', {
    decision: 'granted',
    decidedVia: 'pd_codex_setup',
    decidedAt: new Date().toISOString(),
    disclosureVersion: 'g2b-2026-11-12',
  });
  if (!recorded.ok) throw new Error(recorded.reason);
}
import { evaluateAdmission, RuntimeStateManager } from '@principles/core/runtime';
import {
  deriveSubmitTaskId,
  type PainSubmitReceipt,
} from '@principles/core/runtime/pain-submit-capability';

const WORKSPACE = 'C:\\pd-test-workspace';

function receipt(overrides: Partial<PainSubmitReceipt> = {}): PainSubmitReceipt {
  return {
    schemaVersion: 'pd.pain-submit-receipt.v1',
    capability: 'pd_submit_pain',
    status: 'submitted',
    painId: 'mcp_1700000000000_00000000',
    taskId: 'diagnosis_mcp_1700000000000_00000000',
    workspaceDir: WORKSPACE,
    diagnosis: { status: 'pending' },
    anchor: { type: 'established_principle', ref: 'p-1@2' },
    provenance: 'agent_reported_owner_approved',
    warnings: [],
    error: null,
    nextAction: 'Run `pd task show <taskId>` to follow the diagnosis.',
    ...overrides,
  };
}

interface SubmitHarness {
  client: Client;
  calls: { workspaceDir: string; painId: string; taskId: string; submission: SubmitToolInput }[];
  rechecks: { workspaceDir: string; painId: string; taskId: string }[];
  close: () => Promise<void>;
}

async function makeSubmitHarness(options: {
  submit?: SubmitCapabilityCall;
  recheck?: SubmitRecheckCall;
  deadlineMs?: number;
  workspaceDir?: string;
} = {}): Promise<SubmitHarness> {
  const calls: SubmitHarness['calls'] = [];
  const rechecks: SubmitHarness['rechecks'] = [];
  const handle = createPdMcpServer({
    workspaceDir: options.workspaceDir ?? WORKSPACE,
    enableSubmitTool: true,
    deadlineMs: options.deadlineMs ?? 5000,
    callSubmitCapability:
      options.submit ??
      (async (input) => {
        calls.push(input);
        return receipt({ painId: input.painId, taskId: input.taskId });
      }),
    recheckSubmitTask:
      options.recheck ??
      (async (input) => {
        rechecks.push(input);
        return 'not_found';
      }),
    logSink: () => undefined,
  });
  const client = new Client({ name: 'submit-contract-test-client', version: '0.0.0' });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await Promise.all([client.connect(clientTransport), handle.mcpServer.connect(serverTransport)]);
  return {
    client,
    calls,
    rechecks,
    close: async () => {
      await client.close();
      await handle.mcpServer.close();
    },
  };
}

function textOf(result: CallToolResult): string {
  expect(result.content).toHaveLength(1);
  const [block] = result.content;
  if (block === undefined || block.type !== 'text') throw new Error('expected single text content block');
  return block.text;
}

function parseReceipt(result: CallToolResult): PainSubmitReceipt {
  return JSON.parse(textOf(result)) as PainSubmitReceipt;
}

const VALID_INPUT = {
  reason: 'Anchor: principle p-1@2 requires X. Observed: Y. Deviation: Y contradicts X. Why it matters: it blocks a task the Owner asked for.',
  anchorType: 'established_principle',
  anchorRef: 'p-1@2',
} as const;

describe('OG-4 registration gate (§5.1.1, T43)', () => {
  it('the default server exposes the recall tool only — no pd_submit_pain', async () => {
    const handle = createPdMcpServer({
      workspaceDir: WORKSPACE,
      callCapability: async () => {
        throw new Error('not called');
      },
      logSink: () => undefined,
    });
    const client = new Client({ name: 'gate-test-client', version: '0.0.0' });
    const [ct, st] = InMemoryTransport.createLinkedPair();
    await Promise.all([client.connect(ct), handle.mcpServer.connect(st)]);
    const tools = await client.listTools();
    expect(tools.tools).toHaveLength(1);
    expect(tools.tools[0]?.name).not.toBe(SUBMIT_TOOL_NAME);
    await client.close();
    await handle.mcpServer.close();
  });

  it('opting in exposes both tools with the submit tool NOT marked read-only', async () => {
    const h = await makeSubmitHarness();
    const tools = await h.client.listTools();
    expect(tools.tools.map((tool) => tool.name).sort()).toEqual(
      ['pd_recall_principle_pains', SUBMIT_TOOL_NAME].sort()
    );
    const submit = tools.tools.find((tool) => tool.name === SUBMIT_TOOL_NAME) as
      | { annotations?: { readOnlyHint?: boolean; destructiveHint?: boolean }; inputSchema?: Record<string, unknown> }
      | undefined;
    expect(submit).toBeDefined();
    expect(submit?.annotations?.readOnlyHint).toBe(false);
    expect(submit?.annotations?.destructiveHint).toBe(false);

    const schema = submit?.inputSchema as Record<string, unknown>;
    expect(schema.type).toBe('object');
    expect(schema.additionalProperties).toBe(false);
    expect(schema.required).toEqual(['reason', 'anchorType', 'anchorRef']);
    const props = schema.properties as Record<string, { enum?: string[]; maxLength?: number; minLength?: number }>;
    expect(props.reason?.maxLength).toBe(2000);
    expect(props.reason?.minLength).toBe(1);
    expect(props.anchorRef?.maxLength).toBe(300);
    expect(props.anchorType?.enum).toEqual(['owner_expectation', 'established_principle', 'agent_instruction']);
    expect(props.painType?.enum).toEqual([
      'principle_deviation',
      'tool_failure',
      'subagent_error',
      'user_frustration',
    ]);
    await h.close();
  });

  it('opting in without an injected capability fails closed (no deprecated config fallback)', () => {
    expect(() =>
      createPdMcpServer({
        workspaceDir: WORKSPACE,
        enableSubmitTool: true,
        callCapability: async () => {
          throw new Error('not called');
        },
        logSink: () => undefined,
      })
    ).toThrow(/callSubmitCapability/);
  });
});

describe('input contract (§5.3) — rejected before any write', () => {
  it('rejects undeclared parameters (score/severity/sessionId) without calling the capability', async () => {
    const h = await makeSubmitHarness();
    const result = await h.client.callTool({
      name: SUBMIT_TOOL_NAME,
      arguments: { ...VALID_INPUT, score: 90, severity: 'critical', sessionId: 's-1' },
    });
    expect(result.isError).toBe(true);
    expect(h.calls).toHaveLength(0);
    expect(h.rechecks).toHaveLength(0);
    await h.close();
  });

  it('rejects a missing anchorRef without calling the capability', async () => {
    const h = await makeSubmitHarness();
    const result = await h.client.callTool({
      name: SUBMIT_TOOL_NAME,
      arguments: { reason: VALID_INPUT.reason, anchorType: VALID_INPUT.anchorType },
    });
    expect(result.isError).toBe(true);
    expect(h.calls).toHaveLength(0);
    await h.close();
  });

  it('rejects an over-long reason without calling the capability', async () => {
    const h = await makeSubmitHarness();
    const result = await h.client.callTool({
      name: SUBMIT_TOOL_NAME,
      arguments: { ...VALID_INPUT, reason: 'x'.repeat(2001) },
    });
    expect(result.isError).toBe(true);
    expect(h.calls).toHaveLength(0);
    await h.close();
  });

  // ── PRI-1260: the hostSession claim block ────────────────────────────────

  it('uses Codex request metadata and stores evidence only from the targeted turn in that session', async () => {
    const workspaceDir = await mkdtemp(join(tmpdir(), 'pd-codex-pain-evidence-'));
    const state = new RuntimeStateManager({ workspaceDir });
    try {
      await state.initialize();
      await mkdir(join(workspaceDir, '.state'), { recursive: true });
      // PRI-1283 R2: target-turn evidence reads require granted consent.
      recordCodexConsent(workspaceDir);
      await writeFile(join(workspaceDir, '.state', 'trajectory.db'), '');
      for (const { session, turn, text } of [
        { session: 'thread-a', turn: 'target', text: 'Exact preceding evidence' },
        { session: 'thread-a', turn: 'submit', text: 'Submitting the report' },
        { session: 'thread-b', turn: 'other', text: 'Unrelated session text' },
      ]) {
        const ingested = ingestGovernanceObservations({
          workspaceDir,
          observations: [{
            hostKind: 'codex',
            rolloutIdentity: session,
            rootSessionId: session,
            hostTurnId: turn,
            kind: 'user_turn',
            logicalObservationKey: `${session}|${turn}|user`,
            visibleText: text,
            source: 'live_hook',
            completeness: 'complete',
            observedAt: new Date().toISOString(),
          }],
        });
        if (!ingested.ok) throw new Error(ingested.reason);
      }
      const assembly = assembleSubmitCapability(workspaceDir, 'codex', {});
      if (!assembly.ok || assembly.call === undefined) throw new Error('submit capability unavailable');
      const h = await makeSubmitHarness({ submit: assembly.call, workspaceDir });
      try {
        const args = {
          reason: 'The previous turn did not fulfill the request.',
          anchorType: 'owner_expectation',
          anchorRef: 'Owner request in the preceding turn',
          painType: 'user_frustration',
          hostSession: { threadId: 'thread-b' },
        };
        const meta = { threadId: 'thread-a', 'x-codex-turn-metadata': { turn_id: 'submit' } };
        const result = parseReceipt(await h.client.callTool({
          name: SUBMIT_TOOL_NAME,
          arguments: { ...args, targetTurnId: 'target' },
          _meta: meta,
        }));
        expect(result.status, JSON.stringify(result.error)).toBe('submitted');
        expect(result.sessionAssociation).toEqual({
          status: 'verified', sessionId: 'thread-a', submissionTurnId: 'submit', targetTurnId: 'target',
        });
        if (result.taskId === null) throw new Error('submitted receipt is missing its task ID');
        const task = await state.getTask(result.taskId);
        const diagnostic = JSON.parse(task?.diagnosticJson ?? '{}');
        expect(diagnostic).toMatchObject({
          sessionIdHint: 'thread-a',
          evidence: [{ sourceRef: 'governance_observation:thread-a|target|user', note: 'Exact preceding evidence' }],
        });
        expect(evaluateAdmission({
          recommendationKind: 'principle',
          provenance: 'agent_reported_owner_approved',
          confidence: 0.9,
          evidenceCount: 1,
          inputEvidenceCount: diagnostic.evidence.length,
        }).decision).toBe('admitted');

        for (const [targetTurnId, requestMeta, detail] of [
          ['other', meta, 'codex_target_evidence_unavailable'],
          ['target', undefined, 'codex_host_metadata_missing'],
        ] as const) {
          const unbound = parseReceipt(await h.client.callTool({
            name: SUBMIT_TOOL_NAME, arguments: { ...args, targetTurnId },
            ...(requestMeta === undefined ? {} : { _meta: requestMeta }),
          }));
          expect(unbound.sessionAssociation).toEqual({ status: 'unverified', detail });
          if (unbound.taskId === null) throw new Error('unbound receipt is missing its task ID');
          const unboundTask = await state.getTask(unbound.taskId);
          expect(JSON.parse(unboundTask?.diagnosticJson ?? '{}')).toMatchObject({ sessionIdHint: null, evidence: [] });
        }
      } finally {
        await h.close();
      }
    } finally {
      await state.close();
      await rm(workspaceDir, { recursive: true, force: true });
    }
  });

  it('keeps the LAST 12 turn texts when a turn exceeds the evidence cap', async () => {
    // Review finding: observations come back in capture order; slice(0,12)
    // kept the earliest messages and dropped the turn's final answer.
    const workspaceDir = await mkdtemp(join(tmpdir(), 'pd-codex-pain-evidence-cap-'));
    const state = new RuntimeStateManager({ workspaceDir });
    try {
      await state.initialize();
      await mkdir(join(workspaceDir, '.state'), { recursive: true });
      // PRI-1283 R2: target-turn evidence reads require granted consent.
      recordCodexConsent(workspaceDir);
      await writeFile(join(workspaceDir, '.state', 'trajectory.db'), '');
      const ingested = ingestGovernanceObservations({
        workspaceDir,
        observations: Array.from({ length: 14 }, (_, i) => ({
          hostKind: 'codex',
          rolloutIdentity: 'thread-cap',
          rootSessionId: 'thread-cap',
          hostTurnId: 'big',
          kind: i % 2 === 0 ? 'user_turn' : 'assistant_turn',
          logicalObservationKey: `thread-cap|big|${i}`,
          visibleText: `msg-${String(i + 1).padStart(2, '0')}`,
          source: 'live_hook',
          completeness: 'complete',
          observedAt: new Date().toISOString(),
        })),
      });
      if (!ingested.ok) throw new Error(ingested.reason);
      const assembly = assembleSubmitCapability(workspaceDir, 'codex', {});
      if (!assembly.ok || assembly.call === undefined) throw new Error('submit capability unavailable');
      const h = await makeSubmitHarness({ submit: assembly.call, workspaceDir });
      try {
        const result = parseReceipt(await h.client.callTool({
          name: SUBMIT_TOOL_NAME,
          arguments: {
            reason: 'Late messages were lost from the evidence snapshot.',
            anchorType: 'owner_expectation',
            anchorRef: 'final answer',
            painType: 'user_frustration',
          },
          _meta: { threadId: 'thread-cap', 'x-codex-turn-metadata': { turn_id: 'big' } },
        }));
        expect(result.status, JSON.stringify(result.error)).toBe('submitted');
        if (result.taskId === null) throw new Error('submitted receipt is missing its task ID');
        const task = await state.getTask(result.taskId);
        const evidence = (JSON.parse(task?.diagnosticJson ?? '{}').evidence ?? []) as { note: string }[];
        expect(evidence).toHaveLength(12);
        expect(evidence.map((e) => e.note)).not.toContain('msg-01');
        expect(evidence.map((e) => e.note)).not.toContain('msg-02');
        expect(evidence.at(-1)?.note).toBe('msg-14');
      } finally {
        await h.close();
      }
    } finally {
      await state.close();
      await rm(workspaceDir, { recursive: true, force: true });
    }
  });

  it('PRI-1260: accepts a well-formed hostSession claim and passes it through to the capability', async () => {
    const h = await makeSubmitHarness();
    const hostSession = { threadId: 'thread-abc', sessionId: 'sess-abc', itemId: 'item-9' };
    const result = await h.client.callTool({
      name: SUBMIT_TOOL_NAME,
      arguments: { ...VALID_INPUT, hostSession },
    });
    expect(result.isError).toBeFalsy();
    expect(h.calls).toHaveLength(1);
    expect(h.calls[0]?.submission).toEqual({ ...VALID_INPUT, hostSession });
    await h.close();
  });

  it('PRI-1260: rejects unknown fields INSIDE hostSession (strict block) without calling the capability', async () => {
    const h = await makeSubmitHarness();
    const result = await h.client.callTool({
      name: SUBMIT_TOOL_NAME,
      arguments: { ...VALID_INPUT, hostSession: { threadId: 't', ownerApproved: true } },
    });
    expect(result.isError).toBe(true);
    expect(h.calls).toHaveLength(0);
    await h.close();
  });

  it('PRI-1260: rejects an empty hostSession object (at least one identifier required)', async () => {
    const h = await makeSubmitHarness();
    const result = await h.client.callTool({
      name: SUBMIT_TOOL_NAME,
      arguments: { ...VALID_INPUT, hostSession: {} },
    });
    expect(result.isError).toBe(true);
    expect(h.calls).toHaveLength(0);
    await h.close();
  });
});

describe('identity + receipt passthrough (§5.4, T10/T11)', () => {
  it('generates the painId and derives taskId BEFORE the capability call', async () => {
    const h = await makeSubmitHarness();
    await h.client.callTool({ name: SUBMIT_TOOL_NAME, arguments: VALID_INPUT });
    expect(h.calls).toHaveLength(1);
    const [call] = h.calls;
    expect(call?.workspaceDir).toBe(WORKSPACE);
    expect(call?.painId).toMatch(/^mcp_\d+_[0-9a-f]{8}$/u);
    expect(call?.taskId).toBe(deriveSubmitTaskId(call?.painId ?? ''));
    expect(call?.submission).toEqual(VALID_INPUT);
    await h.close();
  });

  it('passes a submitted receipt through verbatim without isError', async () => {
    const h = await makeSubmitHarness();
    const result = await h.client.callTool({ name: SUBMIT_TOOL_NAME, arguments: VALID_INPUT });
    expect(result.isError).toBeFalsy();
    const parsed = parseReceipt(result);
    expect(parsed.status).toBe('submitted');
    expect(parsed.provenance).toBe('agent_reported_owner_approved');
    expect(parsed.diagnosis).toEqual({ status: 'pending' });
    expect(parsed).not.toHaveProperty('mode');
    await h.close();
  });

  it('passes a refused receipt through without isError (structured reason preserved)', async () => {
    const h = await makeSubmitHarness({
      submit: async (input) =>
        receipt({
          status: 'refused',
          painId: input.painId,
          taskId: input.taskId,
          diagnosis: null,
          error: { code: 'anchor_not_found', message: 'principle not found in the ledger' },
          nextAction: 'Do not submit; clarify with the Owner.',
        }),
    });
    const result = await h.client.callTool({ name: SUBMIT_TOOL_NAME, arguments: VALID_INPUT });
    expect(result.isError).toBeFalsy();
    const parsed = parseReceipt(result);
    expect(parsed.status).toBe('refused');
    expect(parsed.error?.code).toBe('anchor_not_found');
    expect(parsed.painId).toMatch(/^mcp_/u);
    await h.close();
  });

  it('maps a failed receipt to isError:true with the structured reason', async () => {
    const h = await makeSubmitHarness({
      submit: async (input) =>
        receipt({
          status: 'failed',
          painId: input.painId,
          taskId: input.taskId,
          diagnosis: null,
          error: { code: 'config_missing', message: 'no runtime profile' },
        }),
    });
    const result = await h.client.callTool({ name: SUBMIT_TOOL_NAME, arguments: VALID_INPUT });
    expect(result.isError).toBe(true);
    expect(parseReceipt(result).error?.code).toBe('config_missing');
    await h.close();
  });
});

describe('timeout reconciliation (§5.7, T14/T14a/T14b)', () => {
  it('a write that outlives the deadline but is found by read-back is reported as submitted', async () => {
    const rechecks: SubmitHarness['rechecks'] = [];
    const submitted: SubmitHarness['calls'] = [];
    const h = await makeSubmitHarness({
      deadlineMs: 30,
      submit: (input) => {
        submitted.push(input);
        return new Promise<PainSubmitReceipt>(() => undefined);
      },
      recheck: async (input) => {
        rechecks.push(input);
        return 'found';
      },
    });
    const result = await h.client.callTool({ name: SUBMIT_TOOL_NAME, arguments: VALID_INPUT });
    expect(result.isError).toBeFalsy();
    const parsed = parseReceipt(result);
    expect(parsed.status).toBe('submitted');
    expect(parsed.warnings.join(' ')).toContain('reconciled_after_timeout');
    // Same identity on both sides — the reconciliation could not have guessed.
    expect(rechecks).toHaveLength(1);
    expect(rechecks[0]?.painId).toBe(submitted[0]?.painId);
    expect(rechecks[0]?.taskId).toBe(submitted[0]?.taskId);
    await h.close();
  });

  it('a timed-out write with no visible row is submit_unconfirmed — never "not created"', async () => {
    const h = await makeSubmitHarness({
      deadlineMs: 30,
      submit: () => new Promise<PainSubmitReceipt>(() => undefined),
      recheck: async () => 'not_found',
    });
    const result = await h.client.callTool({ name: SUBMIT_TOOL_NAME, arguments: VALID_INPUT });
    expect(result.isError).toBeFalsy();
    const parsed = parseReceipt(result);
    expect(parsed.status).toBe('submit_unconfirmed');
    expect(parsed.painId).toMatch(/^mcp_/u);
    expect(parsed.taskId).toMatch(/^diagnosis_/u);
    expect(parsed.nextAction).toContain('pd task show');
    const text = textOf(result);
    expect(text).not.toContain('was not created');
    expect(text).not.toContain('no task was created');
    await h.close();
  });

  it('an unreadable read-back is still unknown, not a failure', async () => {
    const h = await makeSubmitHarness({
      deadlineMs: 30,
      submit: () => new Promise<PainSubmitReceipt>(() => undefined),
      recheck: async () => 'unreadable',
    });
    const result = await h.client.callTool({ name: SUBMIT_TOOL_NAME, arguments: VALID_INPUT });
    expect(result.isError).toBeFalsy();
    expect(parseReceipt(result).status).toBe('submit_unconfirmed');
    await h.close();
  });

  it('the read-back itself is bounded (never blocks the tool call)', async () => {
    const h = await makeSubmitHarness({
      deadlineMs: 20,
      submit: () => new Promise<PainSubmitReceipt>(() => undefined),
      recheck: () => new Promise<never>(() => undefined),
    });
    const startedAt = Date.now();
    const result = await h.client.callTool({ name: SUBMIT_TOOL_NAME, arguments: VALID_INPUT });
    const elapsed = Date.now() - startedAt;
    expect(parseReceipt(result).status).toBe('submit_unconfirmed');
    expect(elapsed).toBeLessThan(SUBMIT_RECHECK_DEADLINE_MS + 1500);
    await h.close();
  }, 10000);

  it('never resubmits after a timeout (T41 ⑩)', async () => {
    let submitCalls = 0;
    let recheckCalls = 0;
    const h = await makeSubmitHarness({
      deadlineMs: 30,
      submit: () => {
        submitCalls += 1;
        return new Promise<PainSubmitReceipt>(() => undefined);
      },
      recheck: async () => {
        recheckCalls += 1;
        return 'not_found';
      },
    });
    await h.client.callTool({ name: SUBMIT_TOOL_NAME, arguments: VALID_INPUT });
    expect(submitCalls).toBe(1);
    expect(recheckCalls).toBe(1);
    await h.close();
  });

  it('keeps the unconfirmed identity usable for a later reconciliation (T41 ⑧)', async () => {
    let written = false;
    const recheck: SubmitRecheckCall = async (input) => {
      expect(input.workspaceDir).toBe(WORKSPACE);
      return written ? 'found' : 'not_found';
    };
    const h = await makeSubmitHarness({
      deadlineMs: 30,
      submit: (input) => new Promise<PainSubmitReceipt>((resolve) => {
        // The underlying write finishes AFTER the deadline: the receipt must
        // still be unconfirmed, and the task then becomes visible.
        setTimeout(() => {
          written = true;
          resolve(receipt({ painId: input.painId, taskId: input.taskId }));
        }, 200);
      }),
      recheck,
    });
    const result = await h.client.callTool({ name: SUBMIT_TOOL_NAME, arguments: VALID_INPUT });
    const parsed = parseReceipt(result);
    expect(parsed.status).toBe('submit_unconfirmed');
    const { painId, taskId } = parsed;
    if (painId === null || taskId === null) throw new Error('an unconfirmed receipt must still carry its identity');

    await new Promise((resolve) => setTimeout(resolve, 250));
    // The exact ids the receipt carried now resolve: the write was late, not lost.
    expect(await recheck({ workspaceDir: WORKSPACE, painId, taskId })).toBe('found');
    await h.close();
  });

  it('gives concurrent submissions distinct identities (T41 ⑨, T15/T16)', async () => {
    const seen: string[] = [];
    const h = await makeSubmitHarness({
      submit: (input) =>
        new Promise<PainSubmitReceipt>((resolve) => {
          seen.push(input.painId);
          setTimeout(() => resolve(receipt({ painId: input.painId, taskId: input.taskId })), 20);
        }),
    });
    const [a, b] = await Promise.all([
      h.client.callTool({ name: SUBMIT_TOOL_NAME, arguments: VALID_INPUT }),
      h.client.callTool({ name: SUBMIT_TOOL_NAME, arguments: VALID_INPUT }),
    ]);
    expect(parseReceipt(a).status).toBe('submitted');
    expect(parseReceipt(b).status).toBe('submitted');
    expect(new Set(seen).size).toBe(2);
    expect(parseReceipt(a).painId).not.toBe(parseReceipt(b).painId);
    await h.close();
  });

  it('an unexpected throw after identity assignment is unknown, never failed', async () => {
    const h = await makeSubmitHarness({
      submit: async () => {
        throw new Error('database is locked at C:\\secret\\state.db');
      },
    });
    const result = await h.client.callTool({ name: SUBMIT_TOOL_NAME, arguments: VALID_INPUT });
    expect(result.isError).toBeFalsy();
    const parsed = parseReceipt(result);
    expect(parsed.status).toBe('submit_unconfirmed');
    const text = textOf(result);
    expect(text).not.toContain('C:\\secret');
    await h.close();
  });
});

describe('createMcpPainId (§5.4.1)', () => {
  it('formats mcp_<epoch_ms>_<8-hex> from its own inputs only', () => {
    expect(createMcpPainId(1700000000000, () => 'deadbeef')).toBe('mcp_1700000000000_deadbeef');
  });

  it('uses 4 random bytes (8 hex chars) by default', () => {
    expect(createMcpPainId()).toMatch(/^mcp_\d+_[0-9a-f]{8}$/u);
  });
});

describe('transport budget degradation (§5.4.3, T14b)', () => {
  it('keeps the full receipt when it fits', () => {
    const { result, degraded } = assembleSubmitResult(receipt(), 4096);
    expect(degraded).toBe('none');
    expect(result.isError).toBeFalsy();
    expect(JSON.parse(textOf(result)).status).toBe('submitted');
  });

  it('falls back to the minimal receipt before losing status/taskId', () => {
    const longWarnings = Array.from({ length: 60 }, () => 'w'.repeat(80));
    const big = receipt({ warnings: longWarnings });
    const { result, degraded } = assembleSubmitResult(big, 300);
    expect(degraded).toBe('minimal');
    const parsed = JSON.parse(textOf(result)) as Record<string, unknown>;
    expect(parsed.status).toBe('submitted');
    expect(parsed.taskId).toBe(big.taskId);
    expect(parsed.workspaceDir).toBe(WORKSPACE);
    expect(parsed).not.toHaveProperty('warnings');
    expect(result.isError).toBeFalsy();
  });

  it('keeps a written + taskId statement even when even the minimal receipt is too large', () => {
    const big = receipt({ workspaceDir: `C:\\${'x'.repeat(500)}` });
    // Minimal JSON carries the huge workspaceDir (>300 B); the short statement
    // (status + taskId) still fits, so the caller is not told isError.
    const { result, degraded } = assembleSubmitResult(big, 300);
    expect(degraded).toBe('untransportable');
    expect(result.isError).toBeFalsy();
    expect(textOf(result)).toContain(big.taskId ?? '');
  });

  it('is explicit (and isError) only when nothing can be expressed', () => {
    const big = receipt({ workspaceDir: `C:\\${'x'.repeat(5000)}` });
    const { result, degraded } = assembleSubmitResult(big, 10);
    expect(degraded).toBe('untransportable');
    expect(result.isError).toBe(true);
    const parsed = JSON.parse(textOf(result)) as { status: string; error?: { code?: string } };
    expect(parsed.status).toBe('unavailable');
    expect(parsed.error?.code).toBe('response_budget_exceeded');
  });
});
