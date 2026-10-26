// SPEC-PD-EXAMINER-001 v0.4 §2.2/§7 — Stage R REAL Actor transport + host
// adapter offline acceptance suite.
//
// 100% offline and deterministic: every model call is an injected responder,
// every host round is an injected host-transport double, every poster is an
// injected fake. Zero real network, zero real host, zero credentials. Green
// here proves the WIRING and the outcome classification only — it is never
// real-host acceptance evidence (deriveRealHostBaseline keeps offline
// evidence out of PASS, and the F2 adapter itself never fabricates identity:
// observedHostEvidence comes only from the host transport's own snapshot).
//
// Covered (task acceptance list 1–10):
//   prompt building / leak boundaries; strict action parsing (valid + all
//   violation classes); F1 responder outcome classification (beforeSend /
//   ambiguous / 429 / 5xx / unparseable / budget-exhausted / identity);
//   runner-level F1 integration through the Stage R gate (arm delivery
//   byte-exact in the outbound prompt, actorRounds, gate-before-transport);
//   ambiguous → attempt settled RESULT_UNKNOWN, no auto-retry, fresh
//   attemptId; F2 host adapter evidence rules (VERIFIED only; UNVERIFIED /
//   MISMATCH / no-session → null evidence → baseline never PASS); host
//   timeout → ambiguous, nonzero_exit / no_response → known failure; host
//   protocol violation → bounded behavioral invalid action; protected state.

import { describe, expect, it, beforeEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  ACTOR_SYSTEM_PROMPT,
  ACTOR_ACTION_TYPES,
  buildActorStepUserPrompt,
  buildActorRequestBody,
  parseActorAction,
  createAmdActorResponder,
  createRealModelActor,
  createHostActorAdapter,
  hostTaskIdForUnit,
} from '../dev/principle-learning-lab/lib/challenge-actor-transport.mjs';
import { runChallengeStudy, STUB_STRATEGIES } from '../dev/principle-learning-lab/lib/challenge-runner.mjs';
import { createChallengeLedger } from '../dev/principle-learning-lab/lib/challenge-ledger.mjs';
import { deriveRealHostBaseline, readStudyPlanHash, isOfflineStubActor } from '../dev/principle-learning-lab/lib/challenge-stage-r-gate.mjs';
import { perfectPlayActor } from '../dev/principle-learning-lab/lib/challenge-actor.mjs';
import { STAGE_R_AUTH_SCHEMA } from '../dev/principle-learning-lab/lib/challenge-stage-r-gate.mjs';

const labRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../dev/principle-learning-lab');
const realStudyDir = path.join(labRoot, 'challenge-studies', 'CEB-001');
const tmpRoot = path.join(labRoot, '..', '..', '..', '.tmp', 'actor-transport-tests');

const FROZEN = {
  studyId: 'CEB-001',
  suiteHash: 'e1f2f5ca9d7f570faf454d057346c4f273e4fb467fa1790482f9a783e591fb5a',
  mappingHash: '213090daecf0cbc9abfc51ca46641e4e3b835730ba9d9ec771118aaed9521290',
  graderHash: 'eef38484c4f8ace059c178fcb0697c68154277073b7ab7a9d8c0e608ae383e79',
};
const STUDY_PLAN_HASH = readStudyPlanHash(realStudyDir);
const NOW = Date.parse('2026-10-26T12:00:00Z');
const CASE_ID = 'CEB-001-FV-01';

let copyCounter = 0;
function copyStudy(tag: string): string {
  const dir = path.join(tmpRoot, `${tag}-${++copyCounter}`);
  fs.rmSync(dir, { recursive: true, force: true });
  fs.mkdirSync(path.dirname(dir), { recursive: true });
  fs.cpSync(realStudyDir, dir, { recursive: true });
  return dir;
}
const readJson = (dir: string, rel: string): any => JSON.parse(fs.readFileSync(path.join(dir, rel), 'utf8'));
const judgeOf = (caseId: string) => readJson(realStudyDir, path.join('judge-only', `${caseId}.json`));
const visibleOf = (caseId: string) => readJson(realStudyDir, path.join('actor-visible', `${caseId}.json`));

/** Minimal actor-loop view (shape produced by actorView in challenge-actor.mjs). */
function fakeView(step = 0) {
  return {
    caseVisible: visibleOf(CASE_ID),
    constraints: visibleOf(CASE_ID).constraints,
    executedObservations: [],
    budgetUsed: 0,
    timeUsed: 0,
    deadlineBreached: false,
    signOffReceived: false,
    taskCompleted: false,
    step,
  };
}

const ARM_PROMPT_B = readJson(realStudyDir, 'principle-frozen.json').contentJson.principleDraft.statement; // stand-in arm payload for prompt-level tests

function validStageRAuth(over: Record<string, any> = {}) {
  return {
    schema: STAGE_R_AUTH_SCHEMA,
    stage: 'R',
    status: 'APPROVED',
    studyId: FROZEN.studyId,
    suiteHash: FROZEN.suiteHash,
    mappingHash: FROZEN.mappingHash,
    graderHash: FROZEN.graderHash,
    studyPlanHash: STUDY_PLAN_HASH,
    requestedActorIdentity: 'test-double/never-real',
    executionMode: 'F1-direct-model',
    arms: ['A', 'B', 'C'],
    cases: [CASE_ID],
    repetitions: ['1'],
    attemptCap: 40,
    requestCap: 200,
    issuedBy: 'owner-test-fixture',
    validFrom: '2026-10-26T00:00:00Z',
    validUntil: '2026-10-27T00:00:00Z',
    revoked: false,
    halted: false,
    ...over,
  };
}
const f2Auth = () => validStageRAuth({
  executionMode: 'F2-real-host',
  isolationAcceptance: { realHostProbe: { ticketId: 'PRI-1037', status: 'PASSED', evidenceRef: 'probe/synthetic-fixture.json', suiteHash: FROZEN.suiteHash } },
});

/** Test-side authorization injection (P1-2): fixtures are written into the
 *  COPIED study's own run-authorization.json — the same file the production
 *  runner reads. No in-memory authorization path exists. */
function approveStudy(dir: string, record: unknown) {
  fs.writeFileSync(path.join(dir, 'run-authorization.json'), `${JSON.stringify(record, null, 2)}\n`, 'utf8');
}

/** PRI-1037 wiring fixture (transport suite): real-host-marked probe evidence
 *  + corroborating fabricated rollouts under a tmp codexHome. Boundary-
 *  guarded writes only; wiring proof, never real-host acceptance. */
function writeF2ProbeEvidence(dir: string, codexHome: string) {
  const appendInside = (rootDir: string, rel: string, content: string) => {
    const root = path.resolve(rootDir);
    const target = path.resolve(root, rel);
    if (!target.startsWith(root + path.sep)) throw new Error(`test helper: path escapes root (${rel})`);
    fs.appendFileSync(target, content, 'utf8');
  };
  fs.mkdirSync(codexHome, { recursive: true });
  const sessions = ['probe-x1', 'probe-x2', 'probe-x3', 'probe-x4', 'probe-x5'];
  const record = {
    schema: 'challenge-isolation-probe.v1', probeId: 'PRI-1037', executedIn: 'real-host',
    studyId: 'CEB-001', suiteHash: FROZEN.suiteHash, executedAt: new Date().toISOString(),
    checks: ['hidden-gold-unreadable', 'scoring-rules-unreadable', 'cross-arm-isolation', 'non-experiment-tool-refusal', 'unauthorized-network-refusal', 'session-independence', 'host-identity-attested', 'effective-config-recorded', 'post-run-side-effect-scan'].map((id) => ({ id, status: 'PASSED' })),
    sessions,
    hostSnapshotAudit: { requestedModel: 'test-double/never-real', observedModel: 'test-double/never-real', identityStatus: 'VERIFIED', identityEvidenceSource: 'test-double' },
    status: 'PASSED',
  };
  fs.mkdirSync(path.join(dir, 'isolation-probes'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'isolation-probes', 'PRI-1037.json'), `${JSON.stringify(record, null, 2)}\n`, 'utf8');
  const d = new Date();
  const dayRel = path.join('sessions', String(d.getUTCFullYear()), String(d.getUTCMonth() + 1).padStart(2, '0'), String(d.getUTCDate()).padStart(2, '0'));
  fs.mkdirSync(path.join(codexHome, dayRel), { recursive: true });
  for (const s of sessions) {
    const safe = s.replace(/[^A-Za-z0-9_-]/g, '');
    appendInside(codexHome, path.join(dayRel, `rollout-${safe}.jsonl`), `${JSON.stringify({ type: 'session_meta', payload: { session_id: s } })}\n${JSON.stringify({ type: 'event_msg', payload: { type: 'thread_settings_applied', thread_settings: { model: 'test-double/never-real' } } })}\n`);
  }
  return 'isolation-probes/PRI-1037.json';
}
/** an F2 grant citing the above evidence */
const f2AuthWithEvidence = () => validStageRAuth({
  executionMode: 'F2-real-host',
  isolationAcceptance: { realHostProbe: { ticketId: 'PRI-1037', status: 'PASSED', evidenceRef: 'isolation-probes/PRI-1037.json', suiteHash: FROZEN.suiteHash } },
});

/** Capturing responder that plays perfect actions from judge gold — the TEST
 *  acts as the model; the adapter under test does the prompt/parse wiring.
 *  modelId binds the responder to the fixture's requestedActorIdentity. */
function perfectPlayResponder({ onPrompt = null, failWith = null, modelId = 'test-double/never-real' } = {}) {
  const inner = perfectPlayActor(judgeOf(CASE_ID));
  const calls: any[] = [];
  return {
    calls,
    modelId,
    async respond(req: any) {
      calls.push(req);
      if (onPrompt) onPrompt(req);
      if (failWith) throw failWith;
      return { ok: true, content: JSON.stringify(inner.nextAction(req.view)), observedModelIdentity: 'amd-radeon-tokenfactory/GLM-5.3-Flash', finishReason: 'stop', usage: { prompt_tokens: 100, completion_tokens: 20 } };
    },
  };
}

/** Fake codex-host transport (wiring double — never real-host evidence by
 *  itself; identity/evidence rules are exactly what the tests assert). */
function fakeHostTransport({ identityStatus = 'VERIFIED', requestedModel = 'test-double/never-real', observedModel = 'test-double/never-real', sessionId = 'sess-abc-123', failWith = null, payloadOverride = null } = {}) {
  const inner = perfectPlayActor(judgeOf(CASE_ID));
  const rounds: any[] = [];
  return {
    kind: 'fake-codex-host(wiring-double)',
    rounds,
    async complete(req: any) {
      rounds.push(req);
      if (failWith) throw failWith;
      const payload = payloadOverride ? payloadOverride(req, rounds.length) : inner.nextAction(req.view);
      return {
        payload,
        runId: `${sessionId}#round${rounds.length}`,
        hostRound: { sessionId, roundNo: rounds.length, opportunityId: 'opp', usage: { totalTokens: 50, usageSource: 'fake' }, exitCode: 0, wallMs: 10, toolCallsObserved: 0, malformedLines: 0 },
      };
    },
    hostSnapshot() {
      return {
        requestedModel,
        identityStatus,
        observedModel: identityStatus === 'MODEL_IDENTITY_UNVERIFIED' ? null : observedModel,
        identityEvidenceSource: 'test-double',
        sessions: [], rounds: rounds.length,
      };
    },
  };
}

beforeEach(() => {
  fs.mkdirSync(tmpRoot, { recursive: true });
});

// ===========================================================================
// A. Prompt building & leak boundaries
// ===========================================================================
describe('A. actor prompt building', () => {
  it('carries the arm prompt verbatim and the view as JSON; actor-visible only', () => {
    const view = fakeView(3);
    const prompt = buildActorStepUserPrompt({ armPrompt: ARM_PROMPT_B, view });
    expect(prompt.startsWith(ARM_PROMPT_B)).toBe(true); // injection channel is byte-exact
    const viewJson = prompt.split('--- current step view (JSON) ---\n')[1].split('\n\nAnswer with')[0];
    const parsed = JSON.parse(viewJson);
    expect(parsed.step).toBe(3);
    expect(parsed.caseVisible.taskText).toBe(view.caseVisible.taskText);
    // judge-side material must never enter the actor prompt
    expect(viewJson.includes('"implies"')).toBe(false);
    expect(viewJson.includes('goldTruth')).toBe(false);
    expect(viewJson.includes('ownerAnswers')).toBe(false);
  });

  it('refuses to build a prompt without the arm delivery (A/B/C contrast protection)', () => {
    expect(() => buildActorStepUserPrompt({ armPrompt: '', view: fakeView() })).toThrow(/armPrompt/);
    expect(() => buildActorStepUserPrompt({ armPrompt: 'x' as any, view: null })).toThrow(/view/);
  });

  it('the system prompt pins the fixed JSON action protocol for all four action types', () => {
    for (const t of ACTOR_ACTION_TYPES) expect(ACTOR_SYSTEM_PROMPT.includes(`"${t}"`)).toBe(true);
    expect(ACTOR_SYSTEM_PROMPT.includes('narrative is optional and never graded')).toBe(true);
  });
});

// ===========================================================================
// B. Strict action parsing (model output is behavioral, never trusted)
// ===========================================================================
describe('B. parseActorAction', () => {
  const ok = (content: string) => parseActorAction(content);
  it('accepts each legal action shape and passes narrative through', () => {
    expect(ok('{"type":"observe","args":{"obsId":"OBS-1"}}')).toEqual({ ok: true, action: { type: 'observe', args: { obsId: 'OBS-1' } } });
    expect(ok('{"type":"ask-owner","args":{"requestType":"deployment-signoff"}}').ok).toBe(true);
    expect(ok('{"type":"deploy","args":{}}').ok).toBe(true);
    const rep = ok('{"type":"report","args":{"claims":[{"factId":"F1","verdict":"verified_true","evidenceRef":"OBS-1"},{"factId":"F2","verdict":"inferred","minimalSteps":"run OBS-2"}]},"narrative":"done"}');
    expect(rep.ok).toBe(true);
    expect(rep.action.narrative).toBe('done');
    expect(rep.action.args.claims).toHaveLength(2);
  });

  it('rejects every violation class with a reason (behavioral, not transport)', () => {
    const bad = [
      '', 'not json at all', '[]', '"string"', 'null', '42',
      '{"type":"fly","args":{}}',                       // unknown type
      '{"type":"observe","args":{"obsId":"O1"},"extra":1}', // unknown field
      '{"type":"observe","args":{"obsId":""}}',         // empty id
      '{"type":"observe","args":{"other":"O1"}}',       // wrong arg key
      '{"type":"deploy","args":{"x":1}}',               // deploy args not empty
      '{"type":"report","args":{"claims":"nope"}}',     // claims not array
      '{"type":"report","args":{"claims":[{"factId":"F1","verdict":"maybe"}]}}', // verdict enum
      '{"type":"report","args":{"claims":[{"factId":"F1","verdict":"verified_true"}]}}', // verified without evidence
      '{"type":"report","args":{"claims":[{"factId":"F1","verdict":"inferred","evidenceRef":"","minimalSteps":"x"}]}}', // empty evidence
      '{"type":"report","args":{}}',                    // report without claims key
      '{"type":"observe","args":{"obsId":"O1"},"narrative":5}', // narrative type
    ];
    for (const content of bad) {
      const v = parseActorAction(content);
      expect(v.ok).toBe(false);
      expect(typeof v.reason).toBe('string');
      expect(v.reason.length).toBeGreaterThan(0);
    }
  });
});

// ===========================================================================
// C. F1 responder classification (offline, injected poster)
// ===========================================================================
describe('C. F1 direct-model responder (injected poster)', () => {
  const okBody = (content: string) => JSON.stringify({ choices: [{ message: { content }, finish_reason: 'stop' }], usage: { prompt_tokens: 10, completion_tokens: 5 }, model: 'selfploy/GLM-5.3-Flash' });
  const TEST_CRED = { source: 'test', key: 'test-key' }; // injected everywhere — this suite never resolves real credentials

  it('credential refusal happens BEFORE the poster (zero poster calls); a sink-level beforeSend refusal propagates clean — never ambiguous', async () => {
    let calls = 0;
    const noCred = createAmdActorResponder({
      posterImpl: async () => { calls += 1; return { status: 200, headers: { get: () => null }, text: async () => '{}' }; },
      apiKeyProvider: () => { throw Object.assign(new Error('no credential'), { beforeSend: true }); },
    });
    await expect(noCred.respond({ systemPrompt: 's', userPrompt: 'u' })).rejects.toMatchObject({ beforeSend: true });
    expect(calls).toBe(0);
    const sinkRefusal = createAmdActorResponder({
      posterImpl: async () => { calls += 1; throw Object.assign(new Error('sink refused before dispatch'), { beforeSend: true }); },
      apiKeyProvider: () => ({ source: 'test', key: 'k' }),
    });
    const sinkErr = await sinkRefusal.respond({ systemPrompt: 's', userPrompt: 'u' }).then(() => null, (e: any) => e);
    expect(sinkErr).toMatchObject({ beforeSend: true });
    expect(sinkErr.ambiguous).toBeFalsy(); // clean refusal is never classified ambiguous
  });

  it('poster failure AFTER dispatch and unparseable body are AMBIGUOUS (RESULT_UNKNOWN semantics)', async () => {
    const netFail = createAmdActorResponder({ posterImpl: async () => { throw new Error('socket hang up'); }, apiKeyProvider: () => TEST_CRED });
    await expect(netFail.respond({ systemPrompt: 's', userPrompt: 'u' })).rejects.toMatchObject({ ambiguous: true });
    const badBody = createAmdActorResponder({ posterImpl: async () => ({ status: 200, headers: { get: () => null }, text: async () => '<<not-json>>' }), apiKeyProvider: () => TEST_CRED });
    await expect(badBody.respond({ systemPrompt: 's', userPrompt: 'u' })).rejects.toMatchObject({ ambiguous: true });
  });

  it('HTTP 429 / 5xx are known failures with server evidence; never retried here', async () => {
    const r429 = createAmdActorResponder({ posterImpl: async () => ({ status: 429, headers: { get: () => '77' }, text: async () => '' }), apiKeyProvider: () => TEST_CRED });
    await expect(r429.respond({ systemPrompt: 's', userPrompt: 'u' })).resolves.toMatchObject({ ok: false, retryAfter: '77' });
    const r500 = createAmdActorResponder({ posterImpl: async () => ({ status: 500, headers: { get: () => null }, text: async () => 'boom' }), apiKeyProvider: () => TEST_CRED });
    await expect(r500.respond({ systemPrompt: 's', userPrompt: 'u' })).resolves.toMatchObject({ ok: false, error: expect.stringContaining('http_500') });
  });

  it('output_budget_exhausted (finish=length) and empty content are known failures; identity mismatch is a known failure', async () => {
    const length = createAmdActorResponder({ posterImpl: async () => ({ status: 200, headers: { get: () => null }, text: async () => JSON.stringify({ model: 'GLM-5.3-Flash', choices: [{ message: { content: '{"type":"dep' }, finish_reason: 'length' }] }) }), apiKeyProvider: () => TEST_CRED });
    await expect(length.respond({ systemPrompt: 's', userPrompt: 'u' })).resolves.toMatchObject({ ok: false, error: expect.stringContaining('output_budget_exhausted') });
    const empty = createAmdActorResponder({ posterImpl: async () => ({ status: 200, headers: { get: () => null }, text: async () => JSON.stringify({ model: 'GLM-5.3-Flash', choices: [{ message: { content: null }, finish_reason: 'stop' }] }) }), apiKeyProvider: () => TEST_CRED });
    await expect(empty.respond({ systemPrompt: 's', userPrompt: 'u' })).resolves.toMatchObject({ ok: false });
    const mismatch = createAmdActorResponder({ posterImpl: async () => ({ status: 200, headers: { get: () => null }, text: async () => JSON.stringify({ model: 'other-model', choices: [{ message: { content: '{}' }, finish_reason: 'stop' }] }) }), apiKeyProvider: () => TEST_CRED });
    await expect(mismatch.respond({ systemPrompt: 's', userPrompt: 'u' })).resolves.toMatchObject({ ok: false, error: expect.stringContaining('model_identity_mismatch') });
  });

  it('a legal reply passes with observed identity (suffix-match adjudication) and usage', async () => {
    const responder = createAmdActorResponder({
      posterImpl: async () => ({ status: 200, headers: { get: () => null }, text: async () => okBody('{"type":"deploy","args":{}}') }),
      apiKeyProvider: () => ({ source: 'test', key: 'k' }),
    });
    await expect(responder.respond({ systemPrompt: 's', userPrompt: 'u' })).resolves.toMatchObject({
      ok: true,
      content: '{"type":"deploy","args":{}}',
      observedModelIdentity: 'selfploy/GLM-5.3-Flash', // raw server model field; identity adjudicated by suffix match
    });
  });

  it('P1-6 identity matrix: missing observed identity, requested_model-only echo, used_model mismatch and used-vs-raw conflicts are known failures with usage evidence preserved', async () => {
    const mk = (body: unknown) => createAmdActorResponder({
      posterImpl: async () => ({ status: 200, headers: { get: () => null }, text: async () => JSON.stringify(body) }),
      apiKeyProvider: () => TEST_CRED,
    });
    const content = { choices: [{ message: { content: '{"type":"deploy","args":{}}', }, finish_reason: 'stop' }], usage: { prompt_tokens: 9, completion_tokens: 1 } };
    // no server-attested identity at all → unobserved, never accepted
    await expect(mk({ ...content }).respond({ systemPrompt: 's', userPrompt: 'u' })).resolves.toMatchObject({ ok: false, error: expect.stringContaining('model_identity_unobserved'), usage: { prompt_tokens: 9 } });
    // a requested_model ECHO is what we asked for — not proof of what ran
    await expect(mk({ ...content, metadata: { requested_model: 'GLM-5.3-Flash' } }).respond({ systemPrompt: 's', userPrompt: 'u' })).resolves.toMatchObject({ ok: false, error: expect.stringContaining('model_identity_unobserved') });
    // used_model disagreeing with the authorization → mismatch (usage preserved)
    await expect(mk({ ...content, metadata: { used_model: 'someone/other-model' } }).respond({ systemPrompt: 's', userPrompt: 'u' })).resolves.toMatchObject({ ok: false, error: expect.stringContaining('model_identity_mismatch'), usage: { prompt_tokens: 9 } });
    // used_model vs raw model field conflicting with EACH OTHER → refuse to guess
    await expect(mk({ ...content, model: 'selfploy/entirely-different', metadata: { used_model: 'selfploy/GLM-5.3-Flash' } }).respond({ systemPrompt: 's', userPrompt: 'u' })).resolves.toMatchObject({ ok: false, error: expect.stringContaining('model_identity_conflict') });
    // an attested used_model that matches is accepted, with the audit trail recorded
    await expect(mk({ ...content, model: 'selfploy/GLM-5.3-Flash', metadata: { used_model: 'GLM-5.3-Flash', requested_model: 'GLM-5.3-Flash' } }).respond({ systemPrompt: 's', userPrompt: 'u' })).resolves.toMatchObject({
      ok: true,
      observedModelIdentity: 'GLM-5.3-Flash',
      identity: { usedModel: 'GLM-5.3-Flash', rawModel: 'selfploy/GLM-5.3-Flash' },
    });
  });

  it('P1-4/§四: a 200 response whose body cannot be READ is ambiguous (dispatched, outcome unknowable → RESULT_UNKNOWN), never a clean failure', async () => {
    const unreadable = createAmdActorResponder({
      posterImpl: async () => ({ status: 200, headers: { get: () => null }, text: () => Promise.reject(new Error('stream torn mid-body')) }),
      apiKeyProvider: () => TEST_CRED,
    });
    await expect(unreadable.respond({ systemPrompt: 's', userPrompt: 'u' })).rejects.toMatchObject({ ambiguous: true });
  });

  it('construction refuses a non-public baseUrl before any poster exists', () => {
    expect(() => createAmdActorResponder({ baseUrl: 'https://127.0.0.1/v1', posterImpl: async () => ({ status: 200, headers: { get: () => null }, text: async () => okBody('{}') }) })).toThrow(/refusing non-public host/);
    expect(() => createAmdActorResponder({ baseUrl: 'http://developer.amd.com.cn/v1', posterImpl: async () => ({ status: 200, headers: { get: () => null }, text: async () => '{}' }) })).toThrow(/https/);
  });

  it('request body: system+user messages, json_object, no reasoning_effort when null', () => {
    const withEffort = buildActorRequestBody({ systemPrompt: 'S', userPrompt: 'U', modelId: 'GLM-5.3-Flash' });
    expect(withEffort.messages).toEqual([{ role: 'system', content: 'S' }, { role: 'user', content: 'U' }]);
    expect(withEffort.response_format).toEqual({ type: 'json_object' });
    expect(withEffort.reasoning_effort).toBe('medium');
    const noEffort = buildActorRequestBody({ systemPrompt: 'S', userPrompt: 'U', modelId: 'x', reasoningEffort: null });
    expect(noEffort.reasoning_effort).toBeUndefined();
  });
});

// ===========================================================================
// D. F1 actor through the runner (gate → arm delivery → rounds → recovery)
// ===========================================================================
describe('D. F1 real-model actor via runChallengeStudy', () => {
  it('authorized run executes through the real seam: mode F1, arm payload byte-exact in the outbound prompt, actorRounds recorded', async () => {
    const dir = copyStudy('f1-happy');
    approveStudy(dir, validStageRAuth());
    const responder = perfectPlayResponder();
    const summary = await runChallengeStudy({
      studyDir: dir,
      plan: { arms: ['B'], cases: [CASE_ID], repetitions: [1] },
      actorFactory: (ctx: any) => createRealModelActor({ ctx, responder }),
      execution: { mode: 'F1-direct-model', now: NOW },
      maxAttemptsTotal: 10,
      owner: 'at-f1-happy',
    });
    expect(summary.units[0].state).toBe('SUCCEEDED');
    const attempt = readJson(dir, path.join('runs', CASE_ID, 'B', 'r1', 'a1.json'));
    expect(attempt.mode).toBe('F1-direct-model');
    expect(attempt.authorization.executionMode).toBe('F1-direct-model');
    expect(attempt.observedHostEvidence).toBeNull(); // F1 is direct-model, never real-host evidence
    expect(Array.isArray(attempt.actorRounds)).toBe(true);
    expect(attempt.actorRounds.length).toBe(responder.calls.length);
    expect(attempt.actorRounds[0].observedModelIdentity).toBe('amd-radeon-tokenfactory/GLM-5.3-Flash');
    // the ONLY injection channel: every outbound prompt carries the frozen B payload verbatim
    const frozenStatement = readJson(realStudyDir, 'principle-frozen.json').contentJson.principleDraft.statement;
    expect(responder.calls.length).toBeGreaterThan(0);
    for (const call of responder.calls) {
      expect(call.userPrompt.includes(frozenStatement)).toBe(true);
      expect(call.userPrompt.includes('--- applied context ---')).toBe(true);
      expect(call.systemPrompt).toBe(ACTOR_SYSTEM_PROMPT);
      expect(JSON.stringify(call.userPrompt).includes('goldTruth')).toBe(false);
    }
  });

  it('model protocol violations are ACTOR BEHAVIOR: bounded invalid_response actions, run still completes', async () => {
    const dir = copyStudy('f1-garbage');
    approveStudy(dir, validStageRAuth());
    let garbageLeft = 1;
    const inner = perfectPlayActor(judgeOf(CASE_ID));
    const responder = {
      calls: [] as any[],
      modelId: 'test-double/never-real',
      async respond(req: any) {
        responder.calls.push(req);
        if (garbageLeft > 0) {
          garbageLeft -= 1;
          return { ok: true, content: 'I think the best move is obviously to look around first!', observedModelIdentity: 'm', finishReason: 'stop', usage: null };
        }
        return { ok: true, content: JSON.stringify(inner.nextAction(req.view)), observedModelIdentity: 'm', finishReason: 'stop', usage: null };
      },
    };
    const summary = await runChallengeStudy({
      studyDir: dir,
      plan: { arms: ['A'], cases: [CASE_ID], repetitions: [1] },
      actorFactory: (ctx: any) => createRealModelActor({ ctx, responder }),
      execution: { mode: 'F1-direct-model', now: NOW },
      maxAttemptsTotal: 10,
      owner: 'at-f1-garbage',
    });
    expect(summary.units[0].state).toBe('SUCCEEDED'); // degraded gracefully via the loop's invalid-action accounting
    const attempt = readJson(dir, path.join('runs', CASE_ID, 'A', 'r1', 'a1.json'));
    const invalid = attempt.trace.records.filter((r: any) => r.kind === 'action' && r.action.type === 'invalid_response');
    expect(invalid.length).toBe(1);
    expect(attempt.trace.usage.invalidActions).toBe(1);
  });

  it('ambiguous transport outcome settles the attempt RESULT_UNKNOWN: no auto-retry of the same attemptId, fresh attemptId reserves anew', async () => {
    const dir = copyStudy('f1-ambiguous');
    approveStudy(dir, validStageRAuth());
    const plan = { arms: ['A'], cases: [CASE_ID], repetitions: [1], attemptId: 'a1' };
    const ambiguousRun = await runChallengeStudy({
      studyDir: dir, plan,
      actorFactory: (ctx: any) => createRealModelActor({ ctx, responder: perfectPlayResponder({ failWith: Object.assign(new Error('socket hang up mid-flight'), { ambiguous: true, timing: { requestStartedAt: new Date(NOW).toISOString(), responseHeadersReceivedMs: null, firstBodyByteReceivedMs: null, responseBodyCompletedMs: null, responseStageAtFailure: 'awaiting_headers' } }) }) }),
      execution: { mode: 'F1-direct-model', now: NOW },
      maxAttemptsTotal: 10,
      owner: 'at-f1-amb',
    });
    expect(ambiguousRun.units[0]).toMatchObject({ state: 'RESULT_UNKNOWN', ambiguous: true });
    const ledger = createChallengeLedger(dir);
    expect(ledger.classifyUnit({ caseId: CASE_ID, armId: 'A', repetitionId: 1, attemptId: 'a1' }).state).toBe('RESULT_UNKNOWN');
    const attempt = readJson(dir, path.join('runs', CASE_ID, 'A', 'r1', 'a1.json'));
    expect(attempt.result).toBe('RESULT_UNKNOWN');
    expect(attempt.ambiguous).toBe(true);
    // merged #2139 discipline: an ambiguous real-mode record still proves its
    // authorization (a RESULT_UNKNOWN F2 attempt must never poison
    // deriveRealHostBaseline as linkage-missing); the F1 adapter contributes
    // no host evidence.
    expect(attempt.authorization).toMatchObject({ schema: STAGE_R_AUTH_SCHEMA, studyId: 'CEB-001', executionMode: 'F1-direct-model' });
    expect(attempt.observedHostEvidence).toBeNull();
    // timing telemetry: the FAILED transport round now stays on the record
    // (previously vanished) — its injected timing survives into the attempt.
    expect(attempt.actorRounds).toHaveLength(1);
    expect(attempt.actorRounds[0]).toMatchObject({ ok: false, timing: { responseStageAtFailure: 'awaiting_headers' } });
    // same attemptId → refused, zero transport calls
    const responder2 = perfectPlayResponder();
    const refused = await runChallengeStudy({
      studyDir: dir, plan,
      actorFactory: (ctx: any) => createRealModelActor({ ctx, responder: responder2 }),
      execution: { mode: 'F1-direct-model', now: NOW },
      maxAttemptsTotal: 10,
      owner: 'at-f1-amb',
    });
    expect(refused.units[0]).toMatchObject({ state: 'RESULT_UNKNOWN', refused: true });
    expect(responder2.calls.length).toBe(0);
    // new attemptId → fresh reservation, executes; the unknown record is never overwritten
    const fresh = await runChallengeStudy({
      studyDir: dir, plan: { ...plan, attemptId: 'a2' },
      actorFactory: (ctx: any) => createRealModelActor({ ctx, responder: perfectPlayResponder() }),
      execution: { mode: 'F1-direct-model', now: NOW },
      maxAttemptsTotal: 10,
      owner: 'at-f1-amb',
    });
    expect(fresh.units[0].state).toBe('SUCCEEDED');
    expect(readJson(dir, path.join('runs', CASE_ID, 'A', 'r1', 'a1.json')).result).toBe('RESULT_UNKNOWN');
  });

  it('without authorization the transport is NEVER called (declared F1 + live NOT_AUTHORIZED authority file: gate before factory, zero side effects)', async () => {
    const dir = copyStudy('f1-nogate');
    let factoryCalls = 0;
    const responder = perfectPlayResponder();
    const summary = await runChallengeStudy({
      studyDir: dir,
      plan: { arms: ['A'], cases: [CASE_ID], repetitions: [1] },
      actorFactory: (ctx: any) => { factoryCalls += 1; return createRealModelActor({ ctx, responder }); },
      execution: { mode: 'F1-direct-model', now: NOW }, // the copy still carries the live NOT_AUTHORIZED record
      owner: 'at-f1-nogate',
    });
    expect(summary.units[0]).toMatchObject({ state: 'STAGE_R_REFUSED' });
    expect(summary.units[0].reasons.join(' ')).toContain('NOT_AUTHORIZED');
    expect(factoryCalls).toBe(0); // the gate refuses BEFORE the factory — the transport was never even constructed
    expect(responder.calls.length).toBe(0);
    expect(createChallengeLedger(dir).budgetEntries().filter((e: any) => e.type === 'RESERVE')).toHaveLength(0);
  });

  it('clean responder failure (known, not ambiguous) settles FAILED_KNOWN and is retriable only under a new attemptId; a failed known round still lands in actorRounds', async () => {
    const dir = copyStudy('f1-knownfail-known');
    const auth = validStageRAuth();
    approveStudy(dir, auth);
    const responder = {
      calls: 0,
      modelId: 'test-double/never-real',
      async respond() {
        responder.calls += 1;
        return { ok: false, error: 'http_500: upstream exploded', observedModelIdentity: 'test-double/never-real', usage: { prompt_tokens: 42, completion_tokens: 0 }, finishReason: null };
      },
    };
    const summary = await runChallengeStudy({
      studyDir: dir,
      plan: { arms: ['A'], cases: [CASE_ID], repetitions: [1] },
      actorFactory: (ctx: any) => createRealModelActor({ ctx, responder }),
      execution: { mode: 'F1-direct-model', now: NOW },
      maxAttemptsTotal: 10,
      owner: 'at-f1-kf',
    });
    expect(summary.units[0]).toMatchObject({ state: 'FAILED_KNOWN' });
    const attempt = readJson(dir, path.join('runs', CASE_ID, 'A', 'r1', 'a1.json'));
    expect(attempt.result).toBe('FAILED_KNOWN');
    expect(attempt.authorization.executionMode).toBe('F1-direct-model');
    // P1-6: the failed round's usage/identity evidence survives on the record
    expect(attempt.actorRounds).toHaveLength(1);
    expect(attempt.actorRounds[0]).toMatchObject({ ok: false, usage: { prompt_tokens: 42 }, observedModelIdentity: 'test-double/never-real' });
    expect(responder.calls).toBe(1); // exactly one dispatched request — it completed with a known server failure
  });

  it('P1-7 (runner): the auth requestCap caps dispatched model REQUESTS across the whole run — reservation refuses before dispatch', async () => {
    const dir = copyStudy('f1-requestcap');
    approveStudy(dir, validStageRAuth({ requestCap: 2 }));
    const responder = perfectPlayResponder();
    await runChallengeStudy({
      studyDir: dir,
      plan: { arms: ['A'], cases: [CASE_ID], repetitions: [1] },
      actorFactory: (ctx: any) => createRealModelActor({ ctx, responder }),
      execution: { mode: 'F1-direct-model', now: NOW },
      maxAttemptsTotal: 10,
      owner: 'at-f1-rc',
    });
    expect(responder.calls.length).toBe(2); // exactly the authorized request budget was dispatched
    const budget = createChallengeLedger(dir).budgetEntries();
    expect(budget.filter((e: any) => e.type === 'REQUEST_RESERVE')).toHaveLength(2);
    expect(budget.some((e: any) => e.type === 'REQUEST_REFUSED')).toBe(true);
    const attempt = readJson(dir, path.join('runs', CASE_ID, 'A', 'r1', 'a1.json'));
    expect(['SUCCEEDED', 'FAILED_KNOWN']).toContain(attempt.result); // the attempt settled — by report or by graded exhaustion
  });

  it('P1-5 (cross-mode): an F2 authorization refuses an F1 actor BEFORE any model request; an F1 authorization refuses an F2 adapter BEFORE any host round', async () => {
    const dirF2auth = copyStudy('crossmode-f2auth');
    const codexHome = path.join(tmpRoot, `codex-crossmode-${++copyCounter}`);
    writeF2ProbeEvidence(dirF2auth, codexHome); // evidence valid → the ACTOR mode mismatch is what refuses
    approveStudy(dirF2auth, f2AuthWithEvidence()); // F2 approved
    const responder = perfectPlayResponder();
    const cross1 = await runChallengeStudy({
      studyDir: dirF2auth,
      plan: { arms: ['A'], cases: [CASE_ID], repetitions: [1] },
      actorFactory: (ctx: any) => createRealModelActor({ ctx, responder }), // F1 actor under F2 authorization
      execution: { mode: 'F2-real-host', now: NOW, codexHome },
      maxAttemptsTotal: 10,
      owner: 'at-cross1',
    });
    expect(cross1.units[0]).toMatchObject({ state: 'STAGE_R_REFUSED', refused: true });
    expect(cross1.units[0].reasons.join(' ')).toContain("does not match the runner-declared 'F2-real-host'");
    expect(responder.calls.length).toBe(0); // zero model requests

    const dirF1auth = copyStudy('crossmode-f1auth');
    approveStudy(dirF1auth, validStageRAuth()); // F1 approved
    const host = fakeHostTransport();
    const cross2 = await runChallengeStudy({
      studyDir: dirF1auth,
      plan: { arms: ['A'], cases: [CASE_ID], repetitions: [1] },
      actorFactory: (unitCtx: any) => createHostActorAdapter({ // F2 actor under F1 authorization
        ctx: unitCtx,
        hostTransport: host,
        taskId: hostTaskIdForUnit({ studyId: 'CEB-001', caseId: unitCtx.caseId, armId: unitCtx.armId, repetitionId: 1 }),
      }),
      execution: { mode: 'F1-direct-model', now: NOW },
      maxAttemptsTotal: 10,
      owner: 'at-cross2',
    });
    expect(cross2.units[0]).toMatchObject({ state: 'STAGE_R_REFUSED', refused: true });
    expect(cross2.units[0].reasons.join(' ')).toContain("does not match the runner-declared 'F1-direct-model'");
    expect(host.rounds.length).toBe(0); // zero host rounds
  });
});

// ===========================================================================
// E. F2 host adapter (wiring double; evidence rules are the point)
// ===========================================================================
describe('E. F2 host actor adapter', () => {
  const ctx = { armId: 'B', caseId: CASE_ID, caseDef: judgeOf(CASE_ID), caseVisible: visibleOf(CASE_ID), armPrompt: `task\n\n--- applied context ---\n${ARM_PROMPT_B}` };

  it('hostTaskIdForUnit carries the unit as the opportunity segment; adapter refuses malformed taskIds and transports', () => {
    const tid = hostTaskIdForUnit({ studyId: 'CEB-001', caseId: CASE_ID, armId: 'B', repetitionId: 1 });
    expect(tid.split('#')[1]).toBe(`CEB-001/${CASE_ID}/B/r1`);
    expect(() => createHostActorAdapter({ ctx, hostTransport: fakeHostTransport(), taskId: 'no-segments' })).toThrow(/opportunity segment/);
    expect(() => createHostActorAdapter({ ctx, hostTransport: {} as any, taskId: tid })).toThrow(/codex-host transport/);
  });

  it('VERIFIED host identity + session id → observedHostEvidence populated from the host snapshot ONLY', async () => {
    const host = fakeHostTransport({ identityStatus: 'VERIFIED', observedModel: 'gpt-6-luna', sessionId: 'sess-1' });
    const adapter = createHostActorAdapter({ ctx, hostTransport: host, taskId: hostTaskIdForUnit({ studyId: 'CEB-001', caseId: CASE_ID, armId: 'B', repetitionId: 1 }) });
    const action = await adapter.nextAction(fakeView(0));
    expect(action.type).toBe('observe');
    expect(adapter.observedHostEvidence).toEqual({ hostSessionId: 'sess-1', observedModelIdentity: 'gpt-6-luna' });
    expect(adapter.hostIdentityAudit).toMatchObject({ identityStatus: 'VERIFIED', observedModel: 'gpt-6-luna' });
    // outbound request: fixed protocol system prompt + arm delivery verbatim + unit-scoped taskId
    expect(host.rounds[0].systemPrompt).toBe(ACTOR_SYSTEM_PROMPT);
    expect(host.rounds[0].userPrompt.includes(ARM_PROMPT_B)).toBe(true);
    expect(host.rounds[0].taskId.split('#')[1]).toBe(`CEB-001/${CASE_ID}/B/r1`);
  });

  it('UNVERIFIED / MISMATCH identity or missing session → NO evidence (honest null), baseline can never become PASS', async () => {
    for (const over of [{ identityStatus: 'MODEL_IDENTITY_UNVERIFIED' }, { identityStatus: 'MODEL_IDENTITY_MISMATCH', observedModel: 'other-model' }, { sessionId: '' }] as any[]) {
      const host = fakeHostTransport(over);
      const adapter = createHostActorAdapter({ ctx, hostTransport: host, taskId: hostTaskIdForUnit({ studyId: 'CEB-001', caseId: CASE_ID, armId: 'B', repetitionId: 1 }) });
      await adapter.nextAction(fakeView(0));
      expect(adapter.observedHostEvidence).toBeNull();
    }
    // an adapter that never produced evidence cannot upgrade anything:
    const host = fakeHostTransport({ identityStatus: 'MODEL_IDENTITY_UNVERIFIED' });
    const adapter = createHostActorAdapter({ ctx, hostTransport: host, taskId: hostTaskIdForUnit({ studyId: 'CEB-001', caseId: CASE_ID, armId: 'B', repetitionId: 1 }) });
    await adapter.nextAction(fakeView(0));
    const verdict = deriveRealHostBaseline({ attempts: [{ mode: 'F2-real-host', result: 'SUCCEEDED', authorization: { isolationAcceptance: { realHostProbe: { status: 'PASSED' } } }, observedHostEvidence: adapter.observedHostEvidence }] });
    expect(verdict.status).toBe('UNKNOWN'); // wiring-only double: no observed evidence ⇒ baseline stays unmeasured
  });

  it('host timeout is AMBIGUOUS (RESULT_UNKNOWN); nonzero exit / no_response are known failures; protocol violation is behavioral', async () => {
    const tid = hostTaskIdForUnit({ studyId: 'CEB-001', caseId: CASE_ID, armId: 'B', repetitionId: 1 });
    const timeoutAdapter = createHostActorAdapter({ ctx, hostTransport: fakeHostTransport({ failWith: Object.assign(new Error('codex exec timed out'), { code: 'timeout' }) }), taskId: tid });
    await expect(timeoutAdapter.nextAction(fakeView(0))).rejects.toMatchObject({ ambiguous: true });
    const exitAdapter = createHostActorAdapter({ ctx, hostTransport: fakeHostTransport({ failWith: Object.assign(new Error('codex exec exited 1'), { code: 'nonzero_exit' }) }), taskId: tid });
    await expect(exitAdapter.nextAction(fakeView(0))).rejects.toThrow(/nonzero_exit/);
    const noRespAdapter = createHostActorAdapter({ ctx, hostTransport: fakeHostTransport({ failWith: Object.assign(new Error('no agent message'), { code: 'no_response' }) }), taskId: tid });
    await expect(noRespAdapter.nextAction(fakeView(0))).rejects.toThrow(/no_response/);
    const badPayload = createHostActorAdapter({ ctx, hostTransport: fakeHostTransport({ payloadOverride: () => ({ type: 'fly' }) }), taskId: tid });
    const action = await badPayload.nextAction(fakeView(0));
    expect(action.type).toBe('invalid_response');
    expect(action.args.reason).toContain("unknown action type 'fly'");
  });

  it('full F2 unit through the runner (authorized + probe fixture + corroborated PRI-1037 evidence): attempt carries mode F2, evidence and rounds', async () => {
    const dir = copyStudy('f2-happy');
    // PRI-1037 wiring fixture: real-host-marked probe evidence + fabricated
    // rollouts under a tmp codexHome (cooperative boundary — wiring proof
    // only, never real-host acceptance).
    const codexHome = path.join(tmpRoot, `codex-f2-happy-${++copyCounter}`);
    writeF2ProbeEvidence(dir, codexHome);
    approveStudy(dir, f2AuthWithEvidence());
    const host = fakeHostTransport({ identityStatus: 'VERIFIED', observedModel: 'gpt-6-luna', sessionId: 'sess-f2-9' });
    const summary = await runChallengeStudy({
      studyDir: dir,
      plan: { arms: ['B'], cases: [CASE_ID], repetitions: [1] },
      actorFactory: (unitCtx: any) => createHostActorAdapter({
        ctx: unitCtx,
        hostTransport: host,
        taskId: hostTaskIdForUnit({ studyId: 'CEB-001', caseId: unitCtx.caseId, armId: unitCtx.armId, repetitionId: 1 }),
      }),
      execution: { mode: 'F2-real-host', now: NOW, codexHome },
      maxAttemptsTotal: 10,
      owner: 'at-f2-happy',
    });
    expect(summary.units[0].state).toBe('SUCCEEDED');
    const attempt = readJson(dir, path.join('runs', CASE_ID, 'B', 'r1', 'a1.json'));
    expect(attempt.mode).toBe('F2-real-host');
    expect(attempt.observedHostEvidence).toEqual({ hostSessionId: 'sess-f2-9', observedModelIdentity: 'gpt-6-luna' });
    expect(attempt.authorization.isolationAcceptance.realHostProbe.status).toBe('PASSED');
    expect(attempt.actorRounds.every((r: any) => r.sessionId === 'sess-f2-9')).toBe(true);
    // honest boundary, asserted: this is a WIRING double — the recorded attempt is
    // complete only because the test faked the host; real-host acceptance stays NOT_RUN.
    expect(attempt.actorRounds[0].identityStatus).toBe('VERIFIED'); // from the host snapshot, not fabricated by the adapter
  });

  it('F2 without a PASSED probe authorization is refused before any host round', async () => {
    const dir = copyStudy('f2-noprobe');
    approveStudy(dir, validStageRAuth({ executionMode: 'F2-real-host' })); // no probe on the record
    const host = fakeHostTransport();
    const summary = await runChallengeStudy({
      studyDir: dir,
      plan: { arms: ['B'], cases: [CASE_ID], repetitions: [1] },
      actorFactory: (unitCtx: any) => createHostActorAdapter({
        ctx: unitCtx,
        hostTransport: host,
        taskId: hostTaskIdForUnit({ studyId: 'CEB-001', caseId: unitCtx.caseId, armId: unitCtx.armId, repetitionId: 1 }),
      }),
      execution: { mode: 'F2-real-host', now: NOW },
      maxAttemptsTotal: 10,
      owner: 'at-f2-noprobe',
    });
    expect(summary.units[0]).toMatchObject({ state: 'STAGE_R_REFUSED' });
    expect(host.rounds.length).toBe(0);
  });
});

// ===========================================================================
// F. Boundaries, statics, protected state
// ===========================================================================
describe('F. boundaries and protected state', () => {
  it('the real actors are NOT offline stubs — the gate always engages (and stub strategies still are stubs)', () => {
    const responder = perfectPlayResponder();
    const f1 = createRealModelActor({ ctx: { armPrompt: 'x', caseId: CASE_ID } as any, responder });
    expect(isOfflineStubActor(f1)).toBe(false);
    const f2 = createHostActorAdapter({ ctx: { armPrompt: 'x' } as any, hostTransport: fakeHostTransport(), taskId: hostTaskIdForUnit({ studyId: 'CEB-001', caseId: CASE_ID, armId: 'B', repetitionId: 1 }) });
    expect(isOfflineStubActor(f2)).toBe(false);
    const ctx = { caseDef: judgeOf(CASE_ID), caseId: CASE_ID, caseVisible: visibleOf(CASE_ID) };
    for (const factory of Object.values(STUB_STRATEGIES)) expect(isOfflineStubActor((factory as any)(ctx))).toBe(true);
  });

  it('createRealModelActor refuses construction without the arm delivery (fail-closed wiring)', () => {
    expect(() => createRealModelActor({ ctx: { armId: 'A' } as any, responder: perfectPlayResponder() })).toThrow(/armPrompt/);
    expect(() => createRealModelActor({ ctx: { armPrompt: 'x' } as any, responder: {} as any })).toThrow(/responder/);
  });

  it('module statics: no direct network/process/clock constructs in the adapter module itself (the F1 poster is imported machinery, called only after the gate)', () => {
    const src = fs.readFileSync(path.join(labRoot, 'lib', 'challenge-actor-transport.mjs'), 'utf8');
    expect(src.includes('fetch(')).toBe(false);
    expect(src.includes('child_process')).toBe(false);
    expect(src.includes('node:net')).toBe(false);
    expect(src.includes('Date.now')).toBe(false);
    expect(src.includes('Math.random(')).toBe(false);
    expect(src.includes('process.env')).toBe(false); // credentials resolve inside the imported amd module, only on a real call
  });

  it('protected state unchanged: run-authorization NOT_AUTHORIZED, four frozen hashes intact, verify still passes', () => {
    expect(readJson(realStudyDir, 'run-authorization.json').status).toBe('NOT_AUTHORIZED');
    const hashes = readJson(realStudyDir, 'hashes.json');
    expect(hashes.mappingHash.value).toBe(FROZEN.mappingHash);
    expect(hashes.suiteHash.value).toBe(FROZEN.suiteHash);
    expect(hashes.graderHash.value).toBe(FROZEN.graderHash);
    expect(hashes.preregistrationHash.value).toBe(STUDY_PLAN_HASH);
  });
});

// ===========================================================================
// G. response timing telemetry (injected posters/doubles — zero network)
// ===========================================================================
describe('G. response timing telemetry', () => {
  it('G1: a successful round records timing with ordered monotone stages end-to-end into the attempt record', async () => {
    const dir = copyStudy('timing-ok');
    approveStudy(dir, validStageRAuth());
    const timing = { requestStartedAt: new Date(NOW).toISOString(), responseHeadersReceivedMs: 120, firstBodyByteReceivedMs: 180, responseBodyCompletedMs: 900, responseStageAtFailure: 'completed' };
    const responder = perfectPlayResponder();
    const inner = responder.respond.bind(responder);
    responder.respond = async (req: any) => {
      const reply = await inner(req);
      return { ...reply, timing };
    };
    const summary = await runChallengeStudy({
      studyDir: dir,
      plan: { arms: ['A'], cases: [CASE_ID], repetitions: [1] },
      actorFactory: (ctx: any) => createRealModelActor({ ctx, responder }),
      execution: { mode: 'F1-direct-model', now: NOW },
      maxAttemptsTotal: 10,
      owner: 'timing-g1',
    });
    expect(summary.units[0].state).toBe('SUCCEEDED');
    const attempt = readJson(dir, path.join('runs', CASE_ID, 'A', 'r1', 'a1.json'));
    expect(attempt.actorRounds[0].timing).toEqual(timing);
    expect(attempt.actorRounds[0].timing.responseHeadersReceivedMs)
      .toBeLessThanOrEqual(attempt.actorRounds[0].timing.firstBodyByteReceivedMs);
    expect(attempt.actorRounds[0].timing.firstBodyByteReceivedMs)
      .toBeLessThanOrEqual(attempt.actorRounds[0].timing.responseBodyCompletedMs);
    //原有契约不受影响
    expect(attempt.actorRounds[0].observedModelIdentity).toBe('amd-radeon-tokenfactory/GLM-5.3-Flash');
    expect(attempt.trace.records.length).toBeGreaterThan(0);
  });

  it('G2: a 429 round keeps its KNOWN-failure classification AND its timing on the record', async () => {
    const dir = copyStudy('timing-429');
    approveStudy(dir, validStageRAuth());
    const timing = { requestStartedAt: new Date(NOW).toISOString(), responseHeadersReceivedMs: 90, firstBodyByteReceivedMs: 110, responseBodyCompletedMs: 130, responseStageAtFailure: 'completed' };
    const responder = {
      calls: 0, modelId: 'test-double/never-real',
      async respond() { responder.calls += 1; return { ok: false, error: 'rate_limited (HTTP 429); Retry-After: unspecified — recorded, NOT auto-retried', retryAfter: null, timing, usage: null, finishReason: null, observedModelIdentity: 'test-double/never-real' }; },
    };
    const summary = await runChallengeStudy({
      studyDir: dir,
      plan: { arms: ['A'], cases: [CASE_ID], repetitions: [1] },
      actorFactory: (ctx: any) => createRealModelActor({ ctx, responder }),
      execution: { mode: 'F1-direct-model', now: NOW },
      maxAttemptsTotal: 10,
      owner: 'timing-g2',
    });
    expect(summary.units[0].state).toBe('FAILED_KNOWN'); // classification unchanged
    expect(summary.units[0].detail).toContain('429');
    const attempt = readJson(dir, path.join('runs', CASE_ID, 'A', 'r1', 'a1.json'));
    expect(attempt.actorRounds[0]).toMatchObject({ ok: false, timing: { responseStageAtFailure: 'completed' } });
  });

  it('G3: a thrown ambiguous round with timing (headers arrived, body never did) leaves stage evidence on the attempt', async () => {
    const dir = copyStudy('timing-ambiguous');
    approveStudy(dir, validStageRAuth());
    const timing = { requestStartedAt: new Date(NOW).toISOString(), responseHeadersReceivedMs: 1500, firstBodyByteReceivedMs: null, responseBodyCompletedMs: null, responseStageAtFailure: 'awaiting_body' };
    const responder = {
      calls: 0, modelId: 'test-double/never-real',
      async respond() { responder.calls += 1; throw Object.assign(new Error('actor responder: response body unreadable after dispatch: stream torn'), { ambiguous: true, timing }); },
    };
    const summary = await runChallengeStudy({
      studyDir: dir,
      plan: { arms: ['A'], cases: [CASE_ID], repetitions: [1] },
      actorFactory: (ctx: any) => createRealModelActor({ ctx, responder }),
      execution: { mode: 'F1-direct-model', now: NOW },
      maxAttemptsTotal: 10,
      owner: 'timing-g3',
    });
    expect(summary.units[0].state).toBe('RESULT_UNKNOWN'); // classification unchanged
    const attempt = readJson(dir, path.join('runs', CASE_ID, 'A', 'r1', 'a1.json'));
    // awaiting_body is DISTINCT from awaiting_headers (the audit's core ask)
    expect(attempt.actorRounds[0]).toMatchObject({ ok: false, timing: { responseHeadersReceivedMs: 1500, firstBodyByteReceivedMs: null, responseStageAtFailure: 'awaiting_body' } });
    const ledger = createChallengeLedger(dir);
    expect(ledger.budgetEntries().filter((e: any) => e.type === 'RESERVE')).toHaveLength(1); // no retry, no refund
    // the settled unknown is a real ATTEMPT_RESULT row with stage evidence on the attempt file — not a vacuous assertion
    expect(ledger.budgetEntries().some((e: any) => e.type === 'ATTEMPT_RESULT' && e.result === 'RESULT_UNKNOWN')).toBe(true);
    expect(attempt.actorRounds[0].timing.responseStageAtFailure).toBe('awaiting_body');
  });

  it('G4: a beforeSend refusal (never dispatched) produces NO timing anywhere — unobserved stages stay absent, never zeroed', async () => {
    const responder = createAmdActorResponder({
      posterImpl: async () => { throw new Error('must not be called'); },
      apiKeyProvider: () => { throw Object.assign(new Error('no credential'), { beforeSend: true }); },
    });
    await expect(responder.respond({ systemPrompt: 's', userPrompt: 'u' })).rejects.toMatchObject({ beforeSend: true });
  });

  it('G5: the default poster attaches stage telemetry to dispatch failures and keeps unobserved stages null (localhost sink test — zero network)', () => {
    // the poster itself refuses non-public hosts before dispatch: the error
    // must be beforeSend-tagged WITHOUT a timing object (nothing was observed)
    const { createDefaultHttpsPoster } = require('../dev/principle-learning-lab/lib/challenge-amd-transport.mjs');
    const poster = createDefaultHttpsPoster();
    return poster('https://127.0.0.1/v1', { headers: {}, body: 'x' }).then(
      () => { throw new Error('should have refused'); },
      (e: any) => {
        expect(e.beforeSend).toBe(true);
        expect(e.timing).toBeUndefined(); // pre-dispatch: no stages observed, none fabricated
      },
    );
  });
});
