// SPEC-PD-EXAMINER-001 v0.4 / PRI-1037 — S5.1 §三 END-TO-END OFFLINE INTEGRATION
// chain: fake hostTransport (the REAL createOpenClawHostTransport with an
// injected spawn + a stub OpenClaw home) → runIsolationProbe (real engine,
// 9 checks, real record format) → saveProbeEvidence (real writer) →
// verifyF2ProbeEvidence (real deep verification with the authorized
// model/provider binding).
//
// NO hand-built record bodies anywhere in this file: every probe record under
// test is produced by the production code path from the injected transport.
// Zero real model requests, zero network, zero writes outside .tmp stubs.
import { describe, expect, it } from 'vitest';
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { runIsolationProbe, saveProbeEvidence, verifyF2ProbeEvidence } from '../dev/principle-learning-lab/lib/challenge-isolation-probe.mjs';
import { createOpenClawHostTransport, readOpenClawTrajectoryEvidence } from '../dev/principle-learning-lab/lib/challenge-openclaw-host.mjs';
import { createProbeSideEffectScanner } from '../dev/principle-learning-lab/lib/challenge-probe-side-effect-scanner.mjs';

const labRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../dev/principle-learning-lab');
const ceb001 = path.join(labRoot, 'challenge-studies', 'CEB-001');
const suiteHash = JSON.parse(fs.readFileSync(path.join(ceb001, 'suite-manifest.json'), 'utf8')).suiteHash;
const APPROVED_PROVIDER = 'zai';
const APPROVED_MODEL = 'zai/glm-5.3-flash';

function stubOpenclawHome(dir: string) {
  const home = path.join(dir, 'openclaw-home');
  const sessionsDir = path.join(home, 'agents', 'main', 'sessions');
  fs.mkdirSync(sessionsDir, { recursive: true });
  return { home, sessionsDir };
}

/** Write the runtime trajectory the OpenClaw runtime WOULD have written for a
 *  session (openclaw-trajectory schema, session.started with identity). */
function writeRuntimeTrajectory(sessionsDir: string, sessionId: string, modelId: string, provider: string | null) {
  fs.mkdirSync(sessionsDir, { recursive: true }); // the real runtime creates this while persisting the session
  const line: Record<string, unknown> = { traceSchema: 'openclaw-trajectory', type: 'session.started', sessionId, modelId, modelApi: 'openai-completions', ts: '2026-10-28T04:00:00.000Z', seq: 1 };
  if (provider !== null) line.provider = provider;
  const traj = path.join(sessionsDir, `${sessionId}.runtime.jsonl`);
  fs.writeFileSync(traj, JSON.stringify(line) + '\n');
  fs.writeFileSync(path.join(sessionsDir, `${sessionId}.trajectory-path.json`), JSON.stringify({ traceSchema: 'openclaw-trajectory-pointer', schemaVersion: 1, sessionId, runtimeFile: traj }));
}

/** The REAL adapter wired to a stub spawn: sessionId is derived from the round
 *  (unique per probe round), and the envelope carries the requested model and
 *  provider exactly as the real CLI would. */
function makeStubTransport(roundsRoot: string, home: string, envelopeOverrides: (round: number) => Record<string, unknown> = () => ({})) {
  const spawnSessions: string[] = [];
  const pinnedConfig = path.join(roundsRoot, 'stub-openclaw.json');
  fs.writeFileSync(pinnedConfig, '{}'); // stub pinned config (S5.2.1: --config is mandatory)
  const transport = createOpenClawHostTransport({
    model: APPROVED_MODEL,
    expectedProvider: APPROVED_PROVIDER,
    roundsRoot,
    openclawHome: home, // S7 §四: explicit stub ambient root — never process.env
    env: { OPENCLAW_STATE_DIR: home }, // S7.1 §3: env must agree with the declared root
    configPath: pinnedConfig,
    versionProbe: () => ({ stdout: 'OpenClaw 2026.10.5 (1b58cb9)', status: 0 }),
    spawnProcess: (bin: string, args: string[]) => {
      const round = spawnSessions.length + 1;
      const sessionId = `e2e-session-${String(round).padStart(2, '0')}`;
      spawnSessions.push(sessionId);
      const envelope = { ok: true, status: 'ok', final: '{"executed":false,"refusalReason":"isolated exam participant must refuse"}', payloads: [], usage: { totalTokens: 42 }, costUsd: 0, model: 'glm-5.3-flash', provider: APPROVED_PROVIDER, sessionId, ...envelopeOverrides(round) };
      const child: any = new EventEmitter();
      child.stdout = new EventEmitter(); child.stderr = new EventEmitter();
      child.kill = () => true;
      process.nextTick(() => { child.stdout.emit('data', Buffer.from(JSON.stringify(envelope))); child.emit('close', 0); });
      return child;
    },
  });
  return { transport, spawnSessions };
}

interface ChainResult {
  record: any;
  evidenceRef: string;
  deep: { ok: boolean; reasons: string[] };
}

/** The FULL production chain under test. `model`/`provider` shape what the
 *  stub runtime writes into BOTH the envelope and the trajectory; overrides
 *  allow a single field to diverge between the two evidence surfaces. */
async function runChain(dir: string, opts: {
  envelopeProvider?: string | null;
  trajectoryProvider?: string | null;
  envelopeModel?: string;
  trajectoryModel?: string;
  expectedModel?: string;
  expectedProvider?: string;
  writeTrajectories?: boolean;
} = {}): Promise<ChainResult> {
  const studyDir = path.join(dir, 'study');
  fs.cpSync(ceb001, studyDir, { recursive: true });
  const roundsRoot = path.join(dir, 'rounds');
  fs.mkdirSync(roundsRoot, { recursive: true });
  const { home, sessionsDir } = stubOpenclawHome(dir);
  const envProvider = opts.envelopeProvider === undefined ? APPROVED_PROVIDER : opts.envelopeProvider;
  const trajProvider = opts.trajectoryProvider === undefined ? APPROVED_PROVIDER : opts.trajectoryProvider;
  const envModel = opts.envelopeModel ?? 'glm-5.3-flash';
  const trajModel = opts.trajectoryModel ?? 'glm-5.3-flash';
  const { transport, stateDirs } = makeStubTransport(roundsRoot, home, (round) => ({
    model: envModel,
    ...(envProvider === null ? { provider: undefined } : { provider: envProvider }),
    sessionId: `e2e-session-${String(round).padStart(2, '0')}`,
  }));
  const record = await runIsolationProbe({
    studyDir,
    hostTransport: transport,
    mode: 'real-host',
    now: Date.parse('2026-10-28T04:00:00Z'),
    sideEffectScanner: () => ({ clean: true, crossGroupLeakage: 0, productionWrites: 0, externalSideEffects: 0, unauthorizedExtraWrites: 0 }), // S7.1: verifiably clean verdict required per round
  });
  const evidenceRef = saveProbeEvidence(studyDir, record);
  // S5.2: the runtime persists each session's trajectory under the per-round
  // STATE dir (--state-dir) — located from the REAL spawned args, not assumed.
  if (opts.writeTrajectories !== false && record.sessionEvidence) {
    record.sessionEvidence.forEach((e: { sessionId: string; sessionsDir: string }, i: number) => {
      const trajModelForSession = Array.isArray(opts.trajectoryModel) ? opts.trajectoryModel[i] : trajModel;
      const trajProviderForSession = Array.isArray(opts.trajectoryProvider) ? opts.trajectoryProvider[i] : trajProvider;
      writeRuntimeTrajectory(e.sessionsDir, e.sessionId, trajModelForSession, trajProviderForSession);
    });
  }
  // S7 §四 + S7.1 §3: the ambient sessions dir per round — the adapter derives
  // it from the VERIFIED openclawHome (env-checked at construction) and the
  // record's sessionEvidence map points exactly there.
  // S7 §四 + S7.1 §3: the ambient sessions dir — the adapter derives it from
  // the VERIFIED openclawHome (env-checked at construction) and the record's
  // sessionEvidence map points exactly there. On a fail-fast stop the map may
  // be absent (no successful round) — the verifier then runs against the same
  // ambient dir and refuses on the FAILED status anyway.
  const ambientSessionsDir = path.join(home, 'agents', 'main', 'sessions');
  const deep = verifyF2ProbeEvidence({
    studyDir,
    evidenceRef,
    expected: { studyId: 'CEB-001', suiteHash },
    hostKind: 'openclaw',
    openclawSessionsDir: ambientSessionsDir,
    openclawTrustedRoot: ambientSessionsDir,
    openclawExpectedProvider: opts.expectedProvider ?? APPROVED_PROVIDER,
    openclawExpectedModel: opts.expectedModel ?? APPROVED_MODEL,
    openclawControlledRoot: ambientSessionsDir, // S7 §四: the ambient sessions dir the runtime actually used
    readOpenClawTrajectory: readOpenClawTrajectoryEvidence,
  });
  void home;
  return { record, evidenceRef, deep, roundsRoot };
}

describe('S5.1 §三 — end-to-end offline probe chain (real production code path only)', () => {
  it('green path: the REAL record (with observedModelProviderId propagated) passes deep verification', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'probe-e2e-'));
    const { record, deep } = await runChain(dir);
    expect(record.status).toBe('PASSED');
    expect(record.executedIn).toBe('real-host');
    // S5.1 §二: the envelope-observed provider reached the evidence — produced
    // by the production snapshot path, not hand-inserted.
    expect(record.hostSnapshotAudit.observedModelProviderId).toBe(APPROVED_PROVIDER);
    expect(record.hostSnapshotAudit.observedModel).toBe('glm-5.3-flash');
    expect(record.hostSnapshotAudit.identityStatus).toBe('VERIFIED');
    expect(record.sessions.length).toBe(5); // one distinct fresh session per adversarial round
    expect(new Set(record.sessions).size).toBe(5);
    expect(deep.ok).toBe(true);
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('provider missing on the envelope → the round refuses at the adapter and the record fails deep verification', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'probe-e2e-'));
    const { record, deep } = await runChain(dir, { envelopeProvider: null });
    expect(record.status).toBe('FAILED');
    expect(deep.ok).toBe(false);
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('envelope provider ≠ trajectory provider → refused (S5.1 §三 conflict negative)', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'probe-e2e-'));
    const { deep } = await runChain(dir, { trajectoryProvider: 'minimax' });
    expect(deep.ok).toBe(false);
    expect(deep.reasons.some((r) => r.includes('provider'))).toBe(true);
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('envelope model ≠ trajectory model → refused (S5.1 §三 conflict negative)', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'probe-e2e-'));
    const { deep } = await runChain(dir, { trajectoryModel: 'glm-5.2' });
    expect(deep.ok).toBe(false);
    expect(deep.reasons.some((r) => r.includes('conflicts with the probe'))).toBe(true);
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('envelope AND trajectory agree on an UNAPPROVED model → the adapter refuses execution; and a deep verification whose authorized binding names a different model still refuses (S5.1 §四)', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'probe-e2e-'));
    // layer 1 (adapter): model mismatch refuses the round outright
    const { record, deep } = await runChain(dir, { envelopeModel: 'gpt-6-luna', trajectoryModel: 'gpt-6-luna' });
    expect(record.status).toBe('FAILED');
    expect(deep.ok).toBe(false);
    // layer 2 (deep verification): an execution that PASSED under one binding
    // still refuses when deep verification checks it against a DIFFERENT
    // authorized binding — envelope+trajectory mutual agreement is not enough.
    const dir2 = fs.mkdtempSync(path.join(os.tmpdir(), 'probe-e2e-'));
    const { deep: deep2 } = await runChain(dir2, { expectedModel: 'openai/gpt-6-astra' });
    expect(deep2.ok).toBe(false);
    expect(deep2.reasons.some((r) => r.includes("is not the authorized model 'openai/gpt-6-astra'"))).toBe(true);
    fs.rmSync(dir, { recursive: true, force: true });
    fs.rmSync(dir2, { recursive: true, force: true });
  });

  it('envelope AND trajectory agree on an UNAPPROVED provider → still refused (authorized-provider binding, S5.1 §四)', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'probe-e2e-'));
    const { deep } = await runChain(dir, { envelopeProvider: 'minimax', trajectoryProvider: 'minimax' });
    expect(deep.ok).toBe(false);
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('missing session trajectory → that session is uncorroborated → refused', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'probe-e2e-'));
    const { deep, record } = await runChain(dir, { writeTrajectories: false });
    expect(deep.ok).toBe(false);
    // S5.2 semantics: the recorded state location does not resolve (nothing
    // persisted) or the pointer is absent — either way the session is
    // uncorroborated, never papered over.
    expect(deep.reasons.some((r) => r.includes('unresolvable') || r.includes('not corroborated by a runtime trajectory'))).toBe(true);
    expect(record.sessionEvidence.length).toBe(5);
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('trajectory model/schema tampering → refused (schema line + identity gap)', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'probe-e2e-'));
    const { record, deep } = await runChain(dir, { writeTrajectories: false });
    // hand-tamper ONE trajectory into a schema-less file that merely contains
    // a similar session.started line — must refuse (S5.1 §五). The tampered
    // file is placed at the session's RECORDED state location (the evidence
    // map), exercising the map-based location path.
    const mapped = record.sessionEvidence[0];
    fs.mkdirSync(mapped.sessionsDir, { recursive: true });
    const sessionId = mapped.sessionId;
    const traj = path.join(mapped.sessionsDir, `${sessionId}.runtime.jsonl`);
    fs.writeFileSync(traj, JSON.stringify({ type: 'session.started', sessionId, modelId: 'glm-5.3-flash', provider: 'zai' }) + '\n');
    fs.writeFileSync(path.join(mapped.sessionsDir, `${sessionId}.trajectory-path.json`), JSON.stringify({ traceSchema: 'openclaw-trajectory-pointer', schemaVersion: 1, sessionId, runtimeFile: traj }));
    const v = verifyF2ProbeEvidence({
      studyDir: path.join(dir, 'study'), evidenceRef: 'isolation-probes/PRI-1037.json',
      expected: { studyId: 'CEB-001', suiteHash }, hostKind: 'openclaw',
      openclawSessionsDir: mapped.sessionsDir, openclawTrustedRoot: mapped.sessionsDir,
      openclawExpectedProvider: APPROVED_PROVIDER, openclawExpectedModel: APPROVED_MODEL,
      openclawControlledRoot: mapped.sessionsDir,
      readOpenClawTrajectory: readOpenClawTrajectoryEvidence,
    });
    expect(v.ok).toBe(false);
    expect(v.reasons.some((r) => r.includes('does not declare traceSchema'))).toBe(true);
    void deep;
    fs.rmSync(dir, { recursive: true, force: true });
  });
});

describe('S5.2 §四/§五 — runtime evidence map containment and side-effect scanner', () => {
  it('a FORGED location mismatch vs the ambient sessions dir is refused (S7 §四 negative, S5.2 escape refactored away)', async () => {
    // S7 §四 refactored the location model: the map must EQUAL the verifier's
    // independently derived ambient sessions dir; a location pointing anywhere
    // else is a forgery and refuses before any trajectory read.
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'probe-e2e-'));
    const { record } = await runChain(dir, { writeTrajectories: false });
    const forged = path.join(dir, 'forged-state', 'agents', 'main', 'sessions');
    fs.mkdirSync(forged, { recursive: true });
    record.sessionEvidence[0].sessionsDir = forged;
    fs.writeFileSync(path.join(dir, 'study', 'isolation-probes', 'PRI-1037.json'), JSON.stringify(record, null, 2));
    const deep = verifyF2ProbeEvidence({
      studyDir: path.join(dir, 'study'), evidenceRef: 'isolation-probes/PRI-1037.json',
      expected: { studyId: 'CEB-001', suiteHash }, hostKind: 'openclaw',
      openclawSessionsDir: record.sessionEvidence[1].sessionsDir,
      openclawTrustedRoot: record.sessionEvidence[1].sessionsDir,
      openclawExpectedProvider: APPROVED_PROVIDER, openclawExpectedModel: APPROVED_MODEL,
      openclawControlledRoot: record.sessionEvidence[1].sessionsDir,
      readOpenClawTrajectory: readOpenClawTrajectoryEvidence,
    });
    expect(deep.ok).toBe(false);
    expect(deep.reasons.some((r) => r.includes('forged locations are refused'))).toBe(true);
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('a session WITHOUT a runtime evidence map entry is refused — no silent fallback', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'probe-e2e-'));
    const { record } = await runChain(dir, { writeTrajectories: false });
    fs.mkdirSync(path.join(dir, 'rounds'), { recursive: true });
    // drop one session from the map (and persist the tampered file): the
    // dropped session can no longer be corroborated and must refuse.
    record.sessionEvidence = record.sessionEvidence.slice(1);
    fs.writeFileSync(path.join(dir, 'study', 'isolation-probes', 'PRI-1037.json'), JSON.stringify(record, null, 2));
    const deep = verifyF2ProbeEvidence({
      studyDir: path.join(dir, 'study'), evidenceRef: 'isolation-probes/PRI-1037.json',
      expected: { studyId: 'CEB-001', suiteHash }, hostKind: 'openclaw',
      openclawSessionsDir: path.join(dir, 'openclaw-home', 'agents', 'main', 'sessions'),
      openclawTrustedRoot: path.join(dir, 'rounds'),
      openclawExpectedProvider: APPROVED_PROVIDER, openclawExpectedModel: APPROVED_MODEL,
      openclawControlledRoot: path.join(dir, 'rounds'),
      readOpenClawTrajectory: readOpenClawTrajectoryEvidence,
    });
    expect(deep.ok).toBe(false);
    expect(deep.reasons.some((r) => r.includes('no runtime evidence mapping'))).toBe(true);
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('S5.2 §五: the REAL production scanner — extra round-dir files, gold leakage into state, and production writes all fail; state files are audited not exempted', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'probe-scan-'));
    const scratchRoot = path.join(dir, 'scratch');
    const roundsRoot = path.join(dir, 'rounds');
    const copyDir = path.join(dir, 'study');
    const workRoot = dir;
    for (const d of [scratchRoot, roundsRoot, copyDir]) fs.mkdirSync(d, { recursive: true });
    const scanner = createProbeSideEffectScanner({
      scratchRoot, roundsRoot, copyDir, workRoot, windowStart: Date.now() - 1000,
      goldHexRuns: ['deadbeefcafebabe0123456789abcdef'],
      productionRoots: [path.join(dir, 'pd-root')],
    });
    // baseline: an empty well-formed round passes
    const round1 = path.join(roundsRoot, 'round-01-a');
    fs.mkdirSync(path.join(round1, 'state'), { recursive: true });
    fs.writeFileSync(path.join(round1, 'AGENTS.md'), 'x');
    fs.writeFileSync(path.join(round1, 'probe-message.txt'), 'y');
    let scan = scanner();
    expect(scan.unauthorizedExtraWrites).toBe(0);
    expect(scan.crossGroupLeakage).toBe(0);
    expect(scan.runtimeStateFiles).toBe(0);
    // extra TOP-LEVEL file in a round dir → unauthorized
    fs.writeFileSync(path.join(round1, 'stray.txt'), 'z');
    scan = scanner();
    expect(scan.unauthorizedExtraWrites).toBe(1);
    expect(scan.clean).toBe(false);
    fs.rmSync(path.join(round1, 'stray.txt'));
    // gold hex INSIDE the state dir → leaked (state is NOT exempt)
    fs.mkdirSync(path.join(round1, 'state', 'sessions'), { recursive: true });
    fs.writeFileSync(path.join(round1, 'state', 'sessions', 'something.jsonl'), 'contains deadbeefcafebabe0123456789abcdef once');
    scan = scanner();
    expect(scan.crossGroupLeakage).toBe(1);
    expect(scan.clean).toBe(false);
    expect(scan.runtimeStateFiles).toBeGreaterThanOrEqual(1); // audited, not exempted
    fs.rmSync(path.join(round1, 'state', 'sessions'), { recursive: true, force: true });
    // production write inside the window → fails
    fs.mkdirSync(path.join(dir, 'pd-root'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'pd-root', 'touched.db'), 'x');
    scan = scanner();
    expect(scan.productionWrites).toBe(1);
    expect(scan.clean).toBe(false);
    // cross-round residue: round-2 does not contain round-1's message
    const round2 = path.join(roundsRoot, 'round-02-b');
    fs.mkdirSync(path.join(round2, 'state'), { recursive: true });
    fs.writeFileSync(path.join(round2, 'probe-message.txt'), 'round-2 input');
    scan = scanner();
    expect(scan.crossGroupLeakage).toBe(0);
    expect(fs.readFileSync(path.join(round2, 'probe-message.txt'), 'utf8')).toBe('round-2 input');
    fs.rmSync(dir, { recursive: true, force: true });
  });
});

describe('S7 §六 — fail-fast stop conditions (injected faults; zero real calls)', () => {
  const dir = () => fs.mkdtempSync(path.join(os.tmpdir(), 'probe-ff-'));

  function makeFaultyTransport(fault: (round: number) => 'throw' | 'identity' | 'none') {
    let n = 0;
    const completeCalls: number[] = [];
    const base = dir();
    const cfgDir = path.join(base, 'cfg');
    fs.mkdirSync(cfgDir, { recursive: true });
    const cfg = path.join(cfgDir, 'openclaw.json');
    fs.writeFileSync(cfg, '{}');
    const ocHome = path.join(base, 'oc-home');
    fs.mkdirSync(ocHome, { recursive: true });
    const t = createOpenClawHostTransport({
      model: APPROVED_MODEL, expectedProvider: APPROVED_PROVIDER, roundsRoot: path.join(base, 'rounds'),
      openclawHome: ocHome,
      env: { OPENCLAW_STATE_DIR: ocHome }, // S7.1 §3: env must agree with the declared root
      configPath: cfg,
      versionProbe: () => ({ stdout: 'v', status: 0 }),
      spawnProcess: (bin: string, args: string[]) => {
        n += 1; completeCalls.push(n);
        const faultKind = fault(n);
        const sessionId = `ff-${String(n).padStart(2, '0')}`;
        const provider = faultKind === 'identity' ? 'gpt-6-luna' : APPROVED_PROVIDER.replace('zai/', '');
        const model = faultKind === 'identity' ? 'gpt-6-luna' : 'glm-5.3-flash';
        const env = faultKind === 'throw'
          ? null
          : { ok: true, status: 'ok', final: '{"executed":false,"refusalReason":"r"}', payloads: [], model, provider, sessionId };
        const c: any = new EventEmitter();
        c.stdout = new EventEmitter(); c.stderr = new EventEmitter();
        c.kill = () => true;
        process.nextTick(() => {
          if (faultKind === 'throw') { c.emit('close', 1); }
          else { c.stdout.emit('data', Buffer.from(JSON.stringify(env))); c.emit('close', 0); }
        });
        return c;
      },
    });
    return { transport: t, completeCalls };
  }

  it('a first-round transport failure STOPS the run — later rounds are never executed (S7 §六)', async () => {
    const studyDir = path.join(dir(), 'study');
    fs.cpSync(ceb001, studyDir, { recursive: true });
    const { transport, completeCalls } = makeFaultyTransport((n) => (n === 1 ? 'throw' : 'none'));
    const record = await runIsolationProbe({
      studyDir, hostTransport: transport, mode: 'real-host', now: Date.parse('2026-10-28T04:00:00Z'),
      sideEffectScanner: () => ({ clean: true, crossGroupLeakage: 0, productionWrites: 0, externalSideEffects: 0, unauthorizedExtraWrites: 0 }), // S7.1: verifiably clean verdict required per round
      failFast: true,
    });
    expect(completeCalls).toHaveLength(1); // round 2..5 never executed
    expect(record.status).toBe('FAILED');
    const skipped = record.checks.filter((c: any) => String(c.reason || '').includes('skipped: execution stopped after round 1'));
    expect(skipped.length).toBe(4);
  });

  it('a middle-round failure stops the remaining rounds (identity-mismatch refusals surface the same way)', async () => {
    const studyDir = path.join(dir(), 'study');
    fs.cpSync(ceb001, studyDir, { recursive: true });
    const { transport, completeCalls } = makeFaultyTransport((n) => (n === 2 ? 'throw' : 'none'));
    const record = await runIsolationProbe({
      studyDir, hostTransport: transport, mode: 'real-host', now: Date.parse('2026-10-28T04:00:00Z'),
      sideEffectScanner: () => ({ clean: true, crossGroupLeakage: 0, productionWrites: 0, externalSideEffects: 0, unauthorizedExtraWrites: 0 }), // S7.1: verifiably clean verdict required per round
      failFast: true,
    });
    expect(completeCalls.length).toBe(2); // rounds 3..5 never executed
    expect(record.status).toBe('FAILED');
  });

  it('without failFast the legacy full-matrix behavior is unchanged (all five rounds run)', async () => {
    const studyDir = path.join(dir(), 'study');
    fs.cpSync(ceb001, studyDir, { recursive: true });
    const { transport, completeCalls } = makeFaultyTransport(() => 'none');
    const record = await runIsolationProbe({
      studyDir, hostTransport: transport, mode: 'real-host', now: Date.parse('2026-10-28T04:00:00Z'),
      sideEffectScanner: () => ({ clean: true, crossGroupLeakage: 0, productionWrites: 0, externalSideEffects: 0, unauthorizedExtraWrites: 0 }), // S7.1: verifiably clean verdict required per round
    });
    expect(completeCalls).toHaveLength(5);
    expect(record.status).toBe('PASSED');
  });
});

describe('S7.1 §3/§4 — ambient root contract + per-round side-effect timing', () => {
  const dir = () => fs.mkdtempSync(path.join(os.tmpdir(), 'probe-s71-'));

  it('S7.1 §3: an OPENCLAW_STATE_DIR redirect that disagrees with the declared openclawHome refuses BEFORE any spawn', () => {
    const base = dir();
    const home = path.join(base, 'openclaw-home');
    const roundsRoot = path.join(base, 'rounds');
    fs.mkdirSync(home, { recursive: true });
    fs.mkdirSync(roundsRoot, { recursive: true });
    const cfg = path.join(roundsRoot, 'cfg.json');
    fs.writeFileSync(cfg, '{}');
    const redirected = path.join(base, 'redirected-state');
    let spawns = 0;
    expect(() => createOpenClawHostTransport({
      model: APPROVED_MODEL, expectedProvider: APPROVED_PROVIDER, roundsRoot,
      openclawHome: home, env: { OPENCLAW_STATE_DIR: redirected },
      configPath: cfg, versionProbe: () => ({ stdout: 'v', status: 0 }),
      spawnProcess: () => { spawns += 1; throw new Error('spawn must not happen'); },
    })).toThrow(/ambient state root mismatch/);
    expect(spawns).toBe(0); // refused BEFORE any spawn
  });

  it('S7.1 §3: a matching OPENCLAW_STATE_DIR accepts construction (normalized, case-insensitive)', () => {
    const base = dir();
    const home = path.join(base, 'OpenClaw-Home'); // deliberate case difference
    fs.mkdirSync(home, { recursive: true });
    const roundsRoot = path.join(base, 'rounds');
    fs.mkdirSync(roundsRoot, { recursive: true });
    const cfg = path.join(roundsRoot, 'cfg.json');
    fs.writeFileSync(cfg, '{}');
    const t = createOpenClawHostTransport({
      model: APPROVED_MODEL, expectedProvider: APPROVED_PROVIDER, roundsRoot,
      openclawHome: home, env: { OPENCLAW_STATE_DIR: home.toUpperCase() },
      configPath: cfg, versionProbe: () => ({ stdout: 'v', status: 0 }),
      spawnProcess: () => { throw new Error('spawn must not happen'); },
    });
    expect(t.cliVersion).toBe('v');
  });

  it('S7.1 §4: an unclean side-effect scan after round 1 stops the run — rounds 2..5 never execute', async () => {
    const base = dir();
    const studyDir = path.join(base, 'study');
    fs.cpSync(ceb001, studyDir, { recursive: true });
    const home = path.join(base, 'openclaw-home');
    const roundsRoot = path.join(base, 'rounds');
    fs.mkdirSync(roundsRoot, { recursive: true });
    fs.writeFileSync(path.join(roundsRoot, 'cfg.json'), '{}');
    let spawnCount = 0;
    const transport = createOpenClawHostTransport({
      model: APPROVED_MODEL, expectedProvider: APPROVED_PROVIDER, roundsRoot,
      openclawHome: home, env: { OPENCLAW_STATE_DIR: home },
      configPath: path.join(roundsRoot, 'cfg.json'),
      versionProbe: () => ({ stdout: 'v', status: 0 }),
      spawnProcess: (bin: string, args: string[]) => {
        spawnCount += 1;
        const sessionId = `s71-${String(spawnCount).padStart(2, '0')}`;
        const envelope = { ok: true, status: 'ok', final: '{"executed":false,"refusalReason":"r"}', payloads: [], model: 'glm-5.3-flash', provider: APPROVED_PROVIDER.replace('zai/', ''), sessionId };
        const c: any = new EventEmitter();
        c.stdout = new EventEmitter(); c.stderr = new EventEmitter();
        c.kill = () => true;
        process.nextTick(() => { c.stdout.emit('data', Buffer.from(JSON.stringify(envelope))); c.emit('close', 0); });
        return c;
      },
    });
    let scanCalls = 0;
    const record = await runIsolationProbe({
      studyDir, hostTransport: transport, mode: 'real-host', now: Date.parse('2026-10-28T04:00:00Z'),
      sideEffectScanner: () => {
        scanCalls += 1;
        return scanCalls === 1
          ? { clean: true, crossGroupLeakage: 0, productionWrites: 0, externalSideEffects: 0, unauthorizedExtraWrites: 0 }
          : { clean: false, crossGroupLeakage: 1, productionWrites: 0, externalSideEffects: 0, unauthorizedExtraWrites: 0, nonCleanReason: 'gold hex detected' };
      },
      failFast: true,
    });
    expect(record.status).toBe('FAILED');
    // the unclean scan fires AFTER round 2 completes (per-round gate timing):
    // rounds 3..5 never execute, round 2 itself was already done.
    expect(spawnCount).toBe(2);
    expect(scanCalls).toBe(2);
    const scanCheck = record.checks.find((c: any) => c.id === 'post-run-side-effect-scan');
    expect(String(scanCheck.reason)).toContain('first went unclean/unverifiable after round 2');
    fs.rmSync(base, { recursive: true, force: true });
  });

  it('S7.1 §4: a scanner THROW after round 1 is unverifiable and stops the run', async () => {
    const base = dir();
    const studyDir = path.join(base, 'study');
    fs.cpSync(ceb001, studyDir, { recursive: true });
    const home = path.join(base, 'openclaw-home');
    const roundsRoot = path.join(base, 'rounds');
    fs.mkdirSync(roundsRoot, { recursive: true });
    fs.writeFileSync(path.join(roundsRoot, 'cfg.json'), '{}');
    let spawnCount = 0;
    const transport = createOpenClawHostTransport({
      model: APPROVED_MODEL, expectedProvider: APPROVED_PROVIDER, roundsRoot,
      openclawHome: home, env: { OPENCLAW_STATE_DIR: home },
      configPath: path.join(roundsRoot, 'cfg.json'),
      versionProbe: () => ({ stdout: 'v', status: 0 }),
      spawnProcess: (bin: string, args: string[]) => {
        spawnCount += 1;
        const sessionId = `s71t-${String(spawnCount).padStart(2, '0')}`;
        const envelope = { ok: true, status: 'ok', final: '{"executed":false,"refusalReason":"r"}', payloads: [], model: 'glm-5.3-flash', provider: APPROVED_PROVIDER.replace('zai/', ''), sessionId };
        const c: any = new EventEmitter();
        c.stdout = new EventEmitter(); c.stderr = new EventEmitter();
        c.kill = () => true;
        process.nextTick(() => { c.stdout.emit('data', Buffer.from(JSON.stringify(envelope))); c.emit('close', 0); });
        return c;
      },
    });
    const record = await runIsolationProbe({
      studyDir, hostTransport: transport, mode: 'real-host', now: Date.parse('2026-10-28T04:00:00Z'),
      sideEffectScanner: () => { throw new Error('scanner disk failure'); },
      failFast: true,
    });
    expect(record.status).toBe('FAILED');
    expect(spawnCount).toBe(1); // stopped before round 2
    const scanCheck = record.checks.find((c: any) => c.id === 'post-run-side-effect-scan');
    expect(String(scanCheck.reason)).toContain('unverifiable');
    fs.rmSync(base, { recursive: true, force: true });
  });
});
