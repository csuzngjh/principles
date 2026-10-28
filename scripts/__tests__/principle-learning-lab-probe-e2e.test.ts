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
  const line: Record<string, unknown> = { traceSchema: 'openclaw-trajectory', type: 'session.started', sessionId, modelId, modelApi: 'openai-completions', ts: '2026-10-28T04:00:00.000Z', seq: 1 };
  if (provider !== null) line.provider = provider;
  const traj = path.join(sessionsDir, `${sessionId}.runtime.jsonl`);
  fs.writeFileSync(traj, JSON.stringify(line) + '\n');
  fs.writeFileSync(path.join(sessionsDir, `${sessionId}.trajectory-path.json`), JSON.stringify({ traceSchema: 'openclaw-trajectory-pointer', schemaVersion: 1, sessionId, runtimeFile: traj }));
}

/** The REAL adapter wired to a stub spawn: sessionId is derived from the round
 *  (unique per probe round), and the envelope carries the requested model and
 *  provider exactly as the real CLI would. */
function makeStubTransport(roundsRoot: string, envelopeOverrides: (round: number) => Record<string, unknown> = () => ({})) {
  const spawnSessions: string[] = [];
  const transport = createOpenClawHostTransport({
    model: APPROVED_MODEL,
    expectedProvider: APPROVED_PROVIDER,
    roundsRoot,
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
  const { transport } = makeStubTransport(roundsRoot, (round) => ({
    model: envModel,
    ...(envProvider === null ? { provider: undefined } : { provider: envProvider }),
    sessionId: `e2e-session-${String(round).padStart(2, '0')}`,
  }));
  const record = await runIsolationProbe({
    studyDir,
    hostTransport: transport,
    mode: 'real-host',
    now: Date.parse('2026-10-28T04:00:00Z'),
    sideEffectScanner: () => ({ crossGroupLeakage: 0, productionWrites: 0, externalSideEffects: 0, unauthorizedExtraWrites: 0 }),
  });
  const evidenceRef = saveProbeEvidence(studyDir, record);
  if (opts.writeTrajectories !== false) {
    for (const sessionId of record.sessions.filter((s: unknown) => typeof s === 'string')) {
      writeRuntimeTrajectory(sessionsDir, sessionId as string, trajModel, trajProvider);
    }
  }
  const deep = verifyF2ProbeEvidence({
    studyDir,
    evidenceRef,
    expected: { studyId: 'CEB-001', suiteHash },
    hostKind: 'openclaw',
    openclawSessionsDir: sessionsDir,
    openclawTrustedRoot: sessionsDir,
    openclawExpectedProvider: opts.expectedProvider ?? APPROVED_PROVIDER,
    openclawExpectedModel: opts.expectedModel ?? APPROVED_MODEL,
    readOpenClawTrajectory: readOpenClawTrajectoryEvidence,
  });
  void home;
  return { record, evidenceRef, deep };
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
    const { deep } = await runChain(dir, { writeTrajectories: false });
    expect(deep.ok).toBe(false);
    expect(deep.reasons.some((r) => r.includes('not corroborated by a runtime trajectory'))).toBe(true);
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('trajectory model/schema tampering → refused (schema line + identity gap)', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'probe-e2e-'));
    const { record, deep } = await runChain(dir, { writeTrajectories: false });
    // hand-tamper ONE trajectory into a schema-less file that merely contains
    // a similar session.started line — must refuse (S5.1 §五).
    const sessionsDir = path.join(dir, 'openclaw-home', 'agents', 'main', 'sessions');
    fs.mkdirSync(sessionsDir, { recursive: true });
    const sessionId = record.sessions[0];
    const traj = path.join(sessionsDir, `${sessionId}.runtime.jsonl`);
    fs.writeFileSync(traj, JSON.stringify({ type: 'session.started', sessionId, modelId: 'glm-5.3-flash', provider: 'zai' }) + '\n');
    fs.writeFileSync(path.join(sessionsDir, `${sessionId}.trajectory-path.json`), JSON.stringify({ traceSchema: 'openclaw-trajectory-pointer', schemaVersion: 1, sessionId, runtimeFile: traj }));
    const v = verifyF2ProbeEvidence({
      studyDir: path.join(dir, 'study'), evidenceRef: 'isolation-probes/PRI-1037.json',
      expected: { studyId: 'CEB-001', suiteHash }, hostKind: 'openclaw',
      openclawSessionsDir: sessionsDir, openclawTrustedRoot: sessionsDir,
      openclawExpectedProvider: APPROVED_PROVIDER, openclawExpectedModel: APPROVED_MODEL,
      readOpenClawTrajectory: readOpenClawTrajectoryEvidence,
    });
    expect(v.ok).toBe(false);
    expect(v.reasons.some((r) => r.includes('does not declare traceSchema'))).toBe(true);
    void deep;
    fs.rmSync(dir, { recursive: true, force: true });
  });
});
