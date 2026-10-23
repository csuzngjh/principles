// PRI-966 G2 — Codex HOST transport zero-network rehearsal suite.
//
// Every test drives the transport through a spawn STUB with event fixtures in
// the REAL de-identified host JSONL shapes (verified against local rollout
// files: thread_settings_applied / task_started / item_completed / token_count
// with info.last_token_usage vs info.total_token_usage). NO real model is
// called and NO network socket is opened — a green suite proves the WIRING
// (session lifecycle, resume discipline, budget ledger, usage semantics,
// identity discipline), never connectivity or learning effects.

import { describe, expect, it } from 'vitest';
import { EventEmitter } from 'node:events';
import {
  HostBudgetExhaustedError,
  createCodexHostTransport,
  createHostProcessLedger,
  normalizeSchemaForOpenAiStrict,
  normalizeSchemaForOpenAiStrictFull,
  opportunityIdFromTaskId,
  stripNullFields,
} from '../dev/principle-learning-lab/lib/host-actor.mjs';
import { validateActorAction } from '../dev/principle-learning-lab/lib/actor.mjs';
import { runRealActorOpportunity } from '../dev/principle-learning-lab/lib/actor.mjs';
import { runRealStudy } from '../dev/principle-learning-lab/lib/real-runner.mjs';
import { loadDataset, goldFor } from '../dev/principle-learning-lab/lib/fixture.mjs';
import { deliverPayload } from '../dev/principle-learning-lab/lib/g2.mjs';
import { ACTION_COSTS } from '../dev/principle-learning-lab/lib/oracle.mjs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const FIXTURES = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'dev', 'principle-learning-lab', 'fixtures');
const dataset = loadDataset(FIXTURES);
const MANUAL_TEXT = dataset.worldManual.manualText.join('\n');
const KNOWN_ACTIONS = Object.keys(ACTION_COSTS);

// ── real-shape event fixtures (de-identified; shapes match local rollouts) ──
const SESSION_ID = '0f1e2d3c-4b5a-6978-8000-000000000001';
const TURN_1 = '0f1e2d3c-4b5a-6978-8000-00000000a001';
const TURN_2 = '0f1e2d3c-4b5a-6978-8000-00000000a002';

const settingsApplied = (model: string, threadId: string = SESSION_ID) => ({
  payload: {
    type: 'thread_settings_applied',
    thread_id: threadId,
    thread_settings: { model, model_provider_id: 'openai', approval_policy: 'never', approvals_reviewer: 'user' },
  },
});
const taskStarted = (turnId: string) => ({
  payload: { type: 'task_started', turn_id: turnId, root_turn_id: turnId, started_at: 1, model_context_window: 258400, collaboration_mode_kind: 'default' },
});
const agentMessage = (threadId: string, turnId: string, text: string) => ({
  payload: { type: 'item_completed', thread_id: threadId, turn_id: turnId, item: { type: 'AgentMessage', id: 'msg_1', content: [{ type: 'Text', text }] } },
});
const toolCallItem = (threadId: string, turnId: string) => ({
  payload: { type: 'item_completed', thread_id: threadId, turn_id: turnId, item: { type: 'custom_tool_call', id: 'call_1', name: 'shell' } },
});
// token_count carries BOTH the cumulative session figure (total_token_usage)
// and the per-round delta (last_token_usage) — real shape, both present.
const tokenCount = (threadId: string, turnId: string, last: any, total: any) => ({
  payload: {
    type: 'token_count',
    thread_id: threadId,
    turn_id: turnId,
    info: { total_token_usage: total, last_token_usage: last, model_context_window: 258400 },
    rate_limits: { limit_id: 'codex', limit_name: null },
  },
});
const usage = (input: number, output: number) => ({
  input_tokens: input, cached_input_tokens: 0, cache_write_input_tokens: 0, output_tokens: output, reasoning_output_tokens: 0, total_tokens: input + output,
});

const OK_ACTION = '{"type":"proceed"}';
const OK_PROBE = { stdout: 'codex-cli 0.163.0\n', status: 0 };

type RoundSpec = { events: any[]; rawLines?: string[]; exitCode?: number; chunkEvery?: number; hangMs?: number; emitError?: boolean };

/** Deterministic spawn stub: consumes the CLI args + prompt, emits the
 * scripted stdout in controllable chunks, then closes with the scripted
 * code. Records every invocation for resume/isolation assertions. */
function fakeSpawn(script: (args: string[], prompt: string) => RoundSpec | RoundSpec[]) {
  const calls: { args: string[]; prompt: string }[] = [];
  const fn = script as (args: string[], prompt: string) => RoundSpec | RoundSpec[];
  const spawnFn = (_bin: string, args: string[], _opts: any) => {
    const child = new EventEmitter() as any;
    child.stdout = new EventEmitter();
    child.stderr = new EventEmitter();
    child.killed = false;
    child.kill = () => {
      child.killed = true;
      queueMicrotask(() => child.emit('close', null));
      return true;
    };
    // prompt arrives via stdin (multi-line argv is unreliable on Windows);
    // the scripted round only starts once the prompt stream closes.
    const chunks: Buffer[] = [];
    child.stdin = new EventEmitter() as any;
    child.stdin.write = (chunk: any) => { chunks.push(Buffer.from(chunk)); return true; };
    child.stdin.end = () => {
      const prompt = Buffer.concat(chunks).toString('utf8');
      calls.push({ args, prompt });
      const spec = (Array.isArray(fn) ? (fn as any)[calls.length - 1] : fn(args, prompt)) as RoundSpec;
      const text = [
        ...spec.events.map((e) => JSON.stringify(e)),
        ...(spec.rawLines ?? []),
      ].join('\n') + (spec.exitCode !== undefined && spec.exitCode !== 0 ? '' : '\n');
      queueMicrotask(() => {
        if (spec.emitError) {
          child.emit('error', new Error('simulated spawn error'));
          return;
        }
        const step = spec.chunkEvery ?? 7; // small odd chunks force reassembly
        for (let i = 0; i < text.length; i += step) child.stdout.emit('data', Buffer.from(text.slice(i, i + step), 'utf8'));
        if (spec.exitCode !== undefined && spec.exitCode !== 0) child.stderr.emit('data', Buffer.from('simulated failure', 'utf8'));
        if (spec.hangMs !== undefined) {
          // never closes within the test window — the timeout must kill it
        } else {
          child.exitCode = spec.exitCode ?? 0;
          child.emit('close', spec.exitCode ?? 0);
        }
      });
    };
    return child;
  };
  return { spawnFn, calls };
}

function makeTransport(overrides: any = {}, script: any = () => ({ events: [settingsApplied('gpt-6-luna'), agentMessage(SESSION_ID, TURN_1, OK_ACTION), tokenCount(SESSION_ID, TURN_1, usage(41, 19), usage(41, 19))] })) {
  const { spawnFn, calls } = fakeSpawn(script);
  const transport = createCodexHostTransport({
    model: 'gpt-6-luna',
    scratchRoot: '/tmp/fake-scratch',
    timeoutMsPerCall: 5_000,
    versionProbe: () => OK_PROBE,
    spawnProcess: spawnFn,
    ...overrides,
  });
  return { transport, calls };
}

const requestId = (opp: string, turn: number) => ({ taskId: `EA:REAL_ACTOR_I0#${opp}#turn${turn}`, systemPrompt: 'SYS', userPrompt: 'USER', maxTokens: 512 });

describe('session lifecycle and resume discipline', () => {
  it('first round creates a session; later rounds resume the SAME session id from the host stream; a new opportunity starts a NEW session', async () => {
    let sessionCounter = 0;
    const ids = [SESSION_ID, '0f1e2d3c-4b5a-6978-8000-000000000002'];
    const { transport, calls } = makeTransport({}, (args: string[], prompt: string) => {
      const resuming = args.includes('resume');
      const sessionId = resuming ? ids[0] : ids[sessionCounter++];
      const turn = resuming ? TURN_2 : TURN_1;
      return {
        events: [
          settingsApplied('gpt-6-luna', sessionId),
          taskStarted(turn),
          agentMessage(sessionId, turn, OK_ACTION),
          tokenCount(sessionId, turn, usage(41, 19), usage(41, 19)),
        ],
      };
    });
    // opportunity 1: two rounds share one session
    await transport.complete(requestId('P1', 1));
    await transport.complete(requestId('P1', 2));
    // opportunity 2: first round must be a fresh exec (new session)
    await transport.complete(requestId('P2', 1));
    expect(calls).toHaveLength(3);
    expect(calls[0].args[0]).toBe('exec'); // first round: plain exec
    expect(calls[0].args).not.toContain('resume');
    expect(calls[0].args[calls[0].args.length - 1]).toBe('-'); // prompt rides stdin, argv marker only
    expect(calls[1].args.slice(0, 3)).toEqual(['exec', 'resume', SESSION_ID]); // same session id
    expect(calls[1].args[calls[1].args.length - 1]).toBe('-');
    expect(calls[2].args[0]).toBe('exec'); // new opportunity → NEW session
    expect(calls[2].args).not.toContain('resume');
    const snap = transport.hostSnapshot();
    expect(snap.sessions.map((s: any) => s.sessionId)).toEqual([SESSION_ID, ids[1]]);
    expect(snap.execProcesses).toBe(3);
    expect(snap.identityStatus).toBe('VERIFIED');
  });

  it('round prompts carry system+task+delivery and the observation transcript (observation-reactive protocol preserved)', async () => {
    const { transport, calls } = makeTransport();
    await transport.complete(requestId('P1', 1));
    expect(calls[0].prompt).toContain('SYS');
    expect(calls[0].prompt).toContain('USER');
    // the transport never splits agent autonomy from the lab loop: ONE
    // complete() call == exactly ONE exec process == one action JSON
    expect(calls).toHaveLength(1);
    // and the loop-level integration still holds with the host transport:
    const loop = await runRealActorOpportunity({
      transport,
      environment: dataset.probes.P2.environment,
      knownActionNames: KNOWN_ACTIONS,
      manualText: MANUAL_TEXT,
      taskText: dataset.probes.P2.taskInstructions.join('\n'),
      delivery: deliverPayload({ armId: 'EA:REAL_ACTOR_I0', content: 'policy text' }),
      goldRecord: goldFor(dataset, 'P2', 'P2'),
      opportunityId: 'P2',
    });
    expect(loop.outcome.terminalAction).toBe('proceed');
    expect(loop.usage.httpRequests).toBeNull(); // host path: no HTTP ledger, never zero-by-assumption
  });

  it('missing session/thread id in the host stream fails LOUDLY (never resume --last)', async () => {
    // stream without thread_ids: settings event without id, agent message without id
    const { transport } = makeTransport({}, () => ({
      events: [
        { payload: { type: 'thread_settings_applied', thread_settings: { model: 'gpt-6-luna' } } },
        { payload: { type: 'item_completed', item: { type: 'AgentMessage', content: [{ type: 'Text', text: OK_ACTION }] } } },
      ],
    }));
    await expect(transport.complete(requestId('P1', 1))).rejects.toMatchObject({ code: 'host_session_unavailable' });
  });
});

describe('JSONL robustness and action extraction', () => {
  it('chunked stdout, empty lines and non-JSON lines are handled; the action payload is parsed and validated against the lab contract', async () => {
    const { transport } = makeTransport({}, () => ({
      events: [
        settingsApplied('gpt-6-luna'),
        { not: 'an-event' }, // unexpected event — tolerated, counted nowhere as truth
        agentMessage(SESSION_ID, TURN_1, `${OK_ACTION}`),
        tokenCount(SESSION_ID, TURN_1, usage(10, 5), usage(10, 5)),
      ],
      chunkEvery: 5, // tears JSON objects across chunks
    }));
    const out = await transport.complete(requestId('P1', 1));
    expect(out.payload).toEqual({ type: 'proceed' });
    const snap = transport.hostSnapshot();
    expect(snap.malformedLines).toBe(0);
    expect(snap.identityStatus).toBe('VERIFIED');
  });

  it('invalid final JSON and missing agent message are labeled failures (bounded re-prompt upstream, never fabricated actions)', async () => {
    const badJson = makeTransport({}, () => ({ events: [settingsApplied('gpt-6-luna'), agentMessage(SESSION_ID, TURN_1, 'not json at all')] }));
    await expect(badJson.transport.complete(requestId('P1', 1))).rejects.toMatchObject({ code: 'invalid_output' });
    const noMsg = makeTransport({}, () => ({ events: [settingsApplied('gpt-6-luna'), taskStarted(TURN_1)] }));
    await expect(noMsg.transport.complete(requestId('P1', 1))).rejects.toMatchObject({ code: 'no_response' });
  });

  it('host tool-call attempts and malformed lines are RECORDED, never silent (protocol deviation visibility)', async () => {
    const { transport } = makeTransport({}, () => ({
      events: [
        settingsApplied('gpt-6-luna'),
        toolCallItem(SESSION_ID, TURN_1),
        agentMessage(SESSION_ID, TURN_1, OK_ACTION),
      ],
      rawLines: ['this is not json at all'], // torn/non-JSON stdout line
      chunkEvery: 11,
    }));
    const out = await transport.complete(requestId('P1', 1));
    expect(out.hostRound.toolCallsObserved).toBe(1); // host tried to run a tool — recorded
    expect(transport.hostSnapshot().malformedLines).toBe(1);
  });
});

describe('token usage semantics', () => {
  it('per-round usage uses last_token_usage (the delta) and NEVER double-counts the cumulative total', async () => {
    const arm = createHostProcessLedger({ scope: 'arm', caps: {} });
    const { transport } = makeTransport({ hostLedger: arm }, () => ({
      events: [
        settingsApplied('gpt-6-luna'),
        // two token_count events for the turn: last-wins; totals must not sum
        tokenCount(SESSION_ID, TURN_1, usage(30, 10), usage(30, 10)),
        tokenCount(SESSION_ID, TURN_1, usage(41, 19), usage(41, 19)),
        agentMessage(SESSION_ID, TURN_1, OK_ACTION),
      ],
    }));
    const out = await transport.complete(requestId('P1', 1));
    expect(out.hostRound.usage.totalTokens).toBe(60); // 41+19 delta, not 2× totals
    const snap = transport.hostSnapshot();
    expect(snap.tokens.totalTokens).toBe(60);
    expect(snap.tokens.roundsWithUsage).toBe(1);
    expect(snap.ledger.used.tokensObserved).toBe(60); // arm-level observed total (child levels roll up)
  });

  it('missing usage is UNAVAILABLE, never zero; totals flag partial availability', async () => {
    const { transport } = makeTransport({}, () => ({
      events: [settingsApplied('gpt-6-luna'), agentMessage(SESSION_ID, TURN_1, OK_ACTION)], // no token_count at all
    }));
    await transport.complete(requestId('P1', 1));
    const snap = transport.hostSnapshot();
    expect(snap.tokens.totalTokens).toBe(0); // nothing counted
    expect(snap.tokens.roundsWithoutUsage).toBe(1); // the absence is explicit
    expect(snap.tokens.totalsAvailable).toBe(false);
  });
});

describe('model identity discipline', () => {
  it('mismatch between requested and host-reported model is MODEL_IDENTITY_MISMATCH and rows are excluded from formal results', async () => {
    const { spawnFn } = fakeSpawn(() => ({
      events: [settingsApplied('gpt-6-astra'), agentMessage(SESSION_ID, TURN_1, OK_ACTION)], // host reports a DIFFERENT model
    }));
    const hostBudgets = {
      model: 'gpt-6-luna',
      maxExecProcessesPerStudy: 100, maxExecProcessesPerArm: 50, maxExecProcessesPerOpportunity: 10,
      maxSessionsPerArm: 10, maxTokensPerOpportunity: null, maxTokensPerStudy: null,
      wallMsPerOpportunity: null, wallMsPerStudy: null,
    };
    const run = await runRealStudy({
      dataset,
      studyId: 'HOST-IDENTITY-TEST',
      armSpecs: [{ historyId: 'EA', contentMode: 'policy' }],
      hostTransportFactory: ({ hostLedger }: any) => createCodexHostTransport({
        model: 'gpt-6-luna', scratchRoot: '/tmp/fake-scratch', timeoutMsPerCall: 5_000,
        versionProbe: () => OK_PROBE, spawnProcess: spawnFn, hostLedger,
      }),
      hostBudgets,
    });
    expect(run.arms[0].usage.hostProcessBudget.identityStatus).toBe('MODEL_IDENTITY_MISMATCH');
    expect(run.adjudications.every((r: any) => r.dataQualityFlag === 'UNCERTAIN')).toBe(true);
    expect(run.adjudications[0].dataQualityReasons.some((reason: string) => reason.includes('MODEL_IDENTITY_MISMATCH'))).toBe(true);
  });

  it('absent host identity evidence stays MODEL_IDENTITY_UNVERIFIED — never claimed as verified', async () => {
    const { spawnFn } = fakeSpawn(() => ({
      events: [agentMessage(SESSION_ID, TURN_1, OK_ACTION)], // no settings event at all
    }));
    const transport = createCodexHostTransport({
      model: 'gpt-6-luna', scratchRoot: '/tmp/fake-scratch', timeoutMsPerCall: 5_000,
      versionProbe: () => OK_PROBE, spawnProcess: spawnFn,
    });
    await transport.complete(requestId('P1', 1));
    expect(transport.hostSnapshot().identityStatus).toBe('MODEL_IDENTITY_UNVERIFIED');
  });
});

describe('process-level budget protection', () => {
  const baseCaps = { maxExecProcessesPerStudy: 100, maxSessionsPerArm: 10, maxTokensPerOpportunity: null, maxTokensPerStudy: null, wallMsPerOpportunity: null, wallMsPerStudy: null };

  it('exec cap refuses the NEXT spawn BEFORE the child exists (chain: opportunity → arm → study)', () => {
    const arm = createHostProcessLedger({ scope: 'arm', caps: { maxExecProcesses: 2 } });
    arm.reserveExec({});
    arm.reserveExec({});
    expect(() => arm.reserveExec({ reason: 'third' })).toThrow(HostBudgetExhaustedError);
    // session cap is separate and only consumed on new sessions
    const arm2 = createHostProcessLedger({ scope: 'arm2', caps: { maxExecProcesses: 5, maxSessions: 1 } });
    arm2.reserveExec({ isNewSession: true });
    expect(() => arm2.reserveExec({ isNewSession: true })).toThrow(/sessions/);
    arm2.reserveExec({}); // resume does not need a session slot
    // unknown caps are refused at creation (fail-closed, no silently useless budget)
    expect(() => createHostProcessLedger({ scope: 'x', caps: { maxHttp: 5 } as any })).toThrow(/unknown cap/);
  });

  it('observed token totals gate the NEXT spawn and are recorded as feedback — never a pre-send USD claim', async () => {
    const arm = createHostProcessLedger({ scope: 'arm', caps: { maxTokens: 100 } });
    const { transport } = makeTransport({ hostLedger: arm }, () => ({
      events: [settingsApplied('gpt-6-luna'), agentMessage(SESSION_ID, TURN_1, OK_ACTION), tokenCount(SESSION_ID, TURN_1, usage(60, 40), usage(60, 40))],
    }));
    await transport.complete(requestId('P1', 1));
    expect(arm.used().tokensObserved).toBe(100);
    await expect(transport.complete(requestId('P1', 2))).rejects.toMatchObject({ code: 'host_budget_exhausted' });
    const snap = transport.hostSnapshot();
    expect(snap.budgetSemantics).toContain('OBSERVED host feedback');
    // the semantics line explicitly disclaims any pre-send USD/HTTP guarantee
    expect(snap.budgetSemantics).toContain('not a pre-send USD/HTTP limit');
  });

  it('timeout and nonzero exit are labeled failures; the spent process slot and wall-clock stay on the record', async () => {
    const hanging = makeTransport({ timeoutMsPerCall: 60 }, () => ({ events: [settingsApplied('gpt-6-luna')], hangMs: 5_000 }));
    await expect(hanging.transport.complete(requestId('P1', 1))).rejects.toMatchObject({ code: 'timeout' });
    expect(hanging.transport.hostSnapshot().roundRecords[0].error).toContain('timed out');
    const failing = makeTransport({}, () => ({ events: [], exitCode: 3 }));
    await expect(failing.transport.complete(requestId('P1', 1))).rejects.toMatchObject({ code: 'nonzero_exit' });
    expect(failing.transport.hostSnapshot().execProcesses).toBe(1);
    const crashing = makeTransport({}, () => ({ events: [], emitError: true }));
    await expect(crashing.transport.complete(requestId('P1', 1))).rejects.toMatchObject({ code: 'spawn_failed' });
  });
});

describe('runner dispatch and isolation', () => {
  const hostBudgets = {
    model: 'gpt-6-luna',
    maxExecProcessesPerStudy: 1000, maxExecProcessesPerArm: 500, maxExecProcessesPerOpportunity: 100,
    maxSessionsPerArm: 100,
    maxTokensPerOpportunity: null, maxTokensPerStudy: null, wallMsPerOpportunity: null, wallMsPerStudy: null,
  };

  it('host-mode study runs end-to-end offline: per-arm scratch dirs, null HTTP budget, host snapshot attached, sidecar-shaped arm', async () => {
    const { spawnFn } = fakeSpawn((args: string[]) => {
      const sessionId = args.includes('resume') ? SESSION_ID : '0f1e2d3c-4b5a-6978-8000-00000000000a';
      const turn = args.includes('resume') ? TURN_2 : TURN_1;
      return { events: [settingsApplied('gpt-6-luna', sessionId), agentMessage(sessionId, turn, OK_ACTION), tokenCount(sessionId, turn, usage(5, 2), usage(5, 2))] };
    });
    const scratchRoots: string[] = [];
    const run = await runRealStudy({
      dataset,
      studyId: 'HOST-OFFLINE-REHEARSAL',
      armSpecs: [{ historyId: 'E0', contentMode: 'policy' }, { historyId: 'EA', contentMode: 'policy' }],
      hostTransportFactory: ({ armId, scratchRoot, hostLedger }: any) => {
        scratchRoots.push(scratchRoot);
        return createCodexHostTransport({
          model: 'gpt-6-luna', scratchRoot, timeoutMsPerCall: 5_000,
          versionProbe: () => OK_PROBE, spawnProcess: spawnFn, hostLedger,
        });
      },
      hostBudgets,
    });
    expect(run.stopped).toBeNull();
    expect(run.budget).toBeNull(); // no HTTP ledger on the host path — none invented
    expect(run.hostBudget.levels[0].scope).toBe('study:HOST-OFFLINE-REHEARSAL:host');
    expect(run.hostBudget.used.execCount).toBeGreaterThan(0);
    expect(scratchRoots[0]).not.toEqual(scratchRoots[1]); // per-arm scratch isolation
    for (const arm of run.arms) {
      expect(arm.usage.budget).toBeNull();
      expect(arm.usage.hostProcessBudget.identityStatus).toBe('VERIFIED');
      expect(arm.usage.hostProcessBudget.requestedModel).toBe('gpt-6-luna');
      expect(arm.usage.hostProcessBudget.tokens.roundsWithUsage).toBeGreaterThan(0);
    }
    expect(run.adjudications.every((r: any) => r.actorRunStatus === 'COMPLETED')).toBe(true);
  });

  it('host mode without hostBudgets, or with HTTP budgets, is refused (mutually exclusive, never defaulted)', async () => {
    await expect(runRealStudy({
      dataset, studyId: 'S', armSpecs: [{ historyId: 'EA', contentMode: 'policy' }],
      hostTransportFactory: () => { throw new Error('should not be built'); },
      hostBudgets: null,
    })).rejects.toThrow(/hostBudgets/);
    await expect(runRealStudy({
      dataset, studyId: 'S', armSpecs: [{ historyId: 'EA', contentMode: 'policy' }],
      hostTransportFactory: () => { throw new Error('should not be built'); },
      hostBudgets, budgets: { httpRequestsPerStudy: 10 },
    } as any)).rejects.toThrow(/mutually exclusive/);
  });

  it('missing CLI or invalid configuration fails CLOSED at transport creation', () => {
    expect(() => createCodexHostTransport({
      model: 'gpt-6-luna', scratchRoot: '/tmp/x', versionProbe: () => ({ error: new Error('ENOENT'), status: null }),
    })).toThrow(/probe failed.*fail-closed/);
    expect(() => createCodexHostTransport({ model: ' ', scratchRoot: '/tmp/x', versionProbe: () => OK_PROBE })).toThrow(/model/);
    expect(() => createCodexHostTransport({ model: 'gpt-6-luna', scratchRoot: '', versionProbe: () => OK_PROBE })).toThrow(/scratchRoot/);
    expect(() => createCodexHostTransport({ model: 'gpt-6-luna', scratchRoot: '/tmp/x', timeoutMsPerCall: -1, versionProbe: () => OK_PROBE })).toThrow(/timeoutMsPerCall/);
  });

  it('no automatic retry and no host autonomy: one complete() == one exec; requester-driven rounds only', async () => {
    const { transport, calls } = makeTransport();
    await transport.complete(requestId('P1', 1));
    await transport.complete(requestId('P1', 2));
    expect(calls).toHaveLength(2); // no hidden extra spawns
    expect(opportunityIdFromTaskId('EA:REAL_ACTOR_I0#P4:phase-a#turn3')).toBe('P4:phase-a');
    expect(opportunityIdFromTaskId('bad-format')).toBeNull();
  });
});

describe('OpenAI strict schema normalization (official rules, live 400 root-caused)', () => {
  // shape mirrors learning-lab-actor-action-v1: root object with a required
  // anyOf-const action union, an OPTIONAL args object node, and an OPTIONAL
  // narrative string — exactly the tree OpenAI rejected live.
  const labSchema = () => JSON.parse(JSON.stringify({
    additionalProperties: false,
    type: 'object',
    required: ['type'],
    properties: {
      type: { anyOf: [{ const: 'proceed', type: 'string' }, { const: 'compat-shim', type: 'string' }] },
      args: { type: 'object', properties: { key: { type: 'string' }, consumer: { type: 'string' } } },
      narrative: { type: 'string' },
    },
  }));

  it('rewrite pass: const → single-value enum; missing required/additionalProperties made explicit; input tree untouched', () => {
    const input = labSchema();
    const out = normalizeSchemaForOpenAiStrict(input);
    // const is outside the supported keyword set — enum is its exact equivalent
    expect(out.properties.type.anyOf[0]).toEqual({ type: 'string', enum: ['proceed'] });
    expect(out.properties.type.anyOf[0].const).toBeUndefined();
    // rewrite pass alone does NOT widen required (documented behavior)
    expect(out.required).toEqual(['type']);
    expect(out.properties.args.required).toEqual([]);
    expect(out.properties.args.additionalProperties).toBe(false);
    expect(input.properties.type.anyOf[0].const).toBe('proceed'); // input never mutated
  });

  it('FULL pass (used for real host rounds): every object lists ALL properties in required; originally-optional ones are nullable per the official null-union forms', () => {
    const out = normalizeSchemaForOpenAiStrictFull(labSchema());
    // strict rule "all fields must be required"
    expect(out.required).toEqual(['type', 'args', 'narrative']);
    expect(out.properties.args.required).toEqual(['key', 'consumer']);
    expect(out.properties.args.additionalProperties).toBe(false);
    // optionality via the documented null unions — root args/narrative
    expect(out.properties.narrative.type).toEqual(['string', 'null']);
    expect(out.properties.args.type).toEqual(['object', 'null']);
    // nested args properties were optional too → nullable each
    expect(out.properties.args.properties.key.type).toEqual(['string', 'null']);
    // originally-REQUIRED type union stays non-null; const became enum
    expect(out.properties.type.anyOf).toEqual([{ type: 'string', enum: ['proceed'] }, { type: 'string', enum: ['compat-shim'] }]);
    // idempotent
    expect(normalizeSchemaForOpenAiStrictFull(out)).toEqual(out);
  });

  it('strict round-trip preserves the action contract: null-filled wire forms strip back to the omitted-semantics the validator knows', () => {
    // a model obeying the strict schema emits every property; unneeded
    // optional parameters arrive as explicit null
    const wireAction = {
      type: 'compat-shim',
      args: { key: null, consumer: 'svc-b', narrative: null },
      narrative: null,
    };
    const action = stripNullFields(wireAction);
    // restored to EXACTLY the omitted-semantics contract
    expect(action).toEqual({ type: 'compat-shim', args: { consumer: 'svc-b' } });
    expect(validateActorAction(action, ['compat-shim', 'proceed']).ok).toBe(true);
    // the model may also send the truly-minimal form
    expect(validateActorAction(stripNullFields({ type: 'proceed', args: null, narrative: null }), ['compat-shim', 'proceed'])).toMatchObject({ ok: true });
  });

  it('illegal actions are still rejected after stripping; stripNullFields is pure and neutral on non-objects', () => {
    // unknown action type still fails
    expect(validateActorAction(stripNullFields({ type: 'teleport', args: null }), ['proceed']).ok).toBe(false);
    // null-typed arg VALUES (not just absent fields) would violate the
    // string-values contract — stripping removes only the null-optional
    // fields the strict schema forced; a non-null contract field keeps its
    // type checking
    expect(validateActorAction(stripNullFields({ type: 'proceed', args: { key: 42 } }), ['proceed']).ok).toBe(false);
    // helpers stay neutral where they must
    expect(stripNullFields('plain')).toBe('plain');
    expect(stripNullFields(null)).toBeNull();
    // array ELEMENTS are values, not optional properties — null stays
    expect(stripNullFields([1, null, { a: null, b: 2 }])).toEqual([1, null, { b: 2 }]);
  });
});
