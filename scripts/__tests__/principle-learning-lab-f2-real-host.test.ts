// PRI-1038 — F2 real-host wiring, OFFLINE (injected host transport double,
// zero spawns, zero model calls): the runner's F2 probe deep-verification
// dispatch (hostKind 'openclaw' → exec-state corroboration against the
// operator-declared controlled root), the F2 actor adapter's exec-state
// evidence capture, and the formal baseline derivation over an OpenClaw
// attempt. Tampered/missing evidence refuses at every layer.
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { EventEmitter } from 'node:events';
import { runChallengeStudy } from '../dev/principle-learning-lab/lib/challenge-runner.mjs';
import { createHostActorAdapter } from '../dev/principle-learning-lab/lib/challenge-actor-transport.mjs';
import { deriveRealHostBaselineFromStudy } from '../dev/principle-learning-lab/lib/challenge-baseline.mjs';
import { readObservedHostEvidence } from '../dev/principle-learning-lab/lib/challenge-stage-r-gate.mjs';

const labRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../dev/principle-learning-lab');
const ceb001 = path.join(labRoot, 'challenge-studies', 'CEB-001');
// The canonical study keeps its NOT_AUTHORIZED placeholder; the Owner F2
// record lives in the archive and the driver injects it into the copy.
const archivedF2Auth = JSON.parse(fs.readFileSync(path.resolve(labRoot, '..', '..', '..', 'docs', 'research', 'pri1038-f2', 'F2-RUN-AUTHORIZATION.json'), 'utf8'));
const archivedProbeRecord = path.resolve(labRoot, '..', '..', '..', 'docs', 'research', 'pri1037-probe-attempts', 'attempt-4-PRI-1037.json');

let Database: any;
let root: string;
let workRoot: string;
let roundsRoot: string;

const SESSION_ID = 'f2e2e-1111-4aaa-9bbb-cccccccccccc';

beforeEach(() => {
  Database = createRequire(import.meta.url)('better-sqlite3');
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'pri1038-f2-'));
  workRoot = path.join(root, 'probe-workroot');
  roundsRoot = path.join(workRoot, 'rounds');
  fs.mkdirSync(roundsRoot, { recursive: true });
});

afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true });
});

/** Write an exec-state trajectory db exactly as the OpenClaw runtime does
 *  (trajectory_runtime_events, openclaw-trajectory schema). */
function writeExecStateDb(roundDir: string, sessionId: string, modelId: string, provider: string | null) {
  const stateDir = path.join(roundDir, 'state');
  const stateAgentDb = path.join(stateDir, 'agents', 'main', 'agent', 'openclaw-agent.sqlite');
  fs.mkdirSync(path.dirname(stateAgentDb), { recursive: true });
  const db = new Database(stateAgentDb);
  try {
    db.exec('CREATE TABLE trajectory_runtime_events (session_id TEXT NOT NULL, seq INTEGER NOT NULL, run_id TEXT, event_json TEXT NOT NULL)');
    const started: Record<string, unknown> = { traceSchema: 'openclaw-trajectory', schemaVersion: 1, traceId: sessionId, source: 'runtime', type: 'session.started', ts: '2026-10-30T00:00:00.000Z', seq: 1, sourceSeq: 1, sessionId, modelId, modelApi: 'openai-completions' };
    if (provider !== null) started.provider = provider;
    db.prepare('INSERT INTO trajectory_runtime_events (session_id, seq, run_id, event_json) VALUES (?, ?, ?, ?)').run(sessionId, 1, sessionId, JSON.stringify(started));
  } finally {
    db.close();
  }
  return { roundDir, stateDir, stateAgentDb };
}

/** A PASSED probe record (archived attempt-4 shape) with ONE session mapped
 *  to the given exec-state location. */
function writeProbeRecord(studyCopy: string, loc: { roundDir: string; stateDir: string; stateAgentDb: string }) {
  const record = JSON.parse(fs.readFileSync(archivedProbeRecord, 'utf8'));
  record.sessions = [SESSION_ID];
  record.sessionEvidence = [{ sessionId: SESSION_ID, ...loc }];
  fs.mkdirSync(path.join(studyCopy, 'isolation-probes'), { recursive: true });
  fs.writeFileSync(path.join(studyCopy, 'isolation-probes', 'PRI-1037.json'), JSON.stringify(record, null, 2));
}

function prepareStudyCopy(): string {
  const studyCopy = path.join(root, 'study');
  fs.cpSync(ceb001, studyCopy, { recursive: true });
  const auth = { ...archivedF2Auth, validFrom: '2026-10-01T00:00:00Z', validUntil: '2026-12-01T00:00:00Z' };
  fs.writeFileSync(path.join(studyCopy, 'run-authorization.json'), JSON.stringify(auth, null, 2));
  return studyCopy;
}

/** Host transport double carrying the VERIFIED OpenClaw identity and the
 *  exec-state evidence location — the exact snapshot shape the real
 *  transport reports (createOpenClawHostTransport.hostSnapshot). Payload
 *  shape is configurable: the REAL OpenClaw transport returns the envelope
 *  final as a STRING (the live 2026-10-30 first batch proved stringifying it
 *  breaks every reply); codex transports return objects. */
function fakeOpenClawTransport(loc: { roundDir: string; stateDir: string; stateAgentDb: string }, payloadShape: 'string' | 'object' = 'string') {
  let rounds = 0;
  const payload = { type: 'report', args: { claims: [{ factId: 'F-1', verdict: 'inferred', evidenceRef: 'OBS-OWNER-1', minimalSteps: 'r' }] }, narrative: 'offline double' };
  return {
    complete: async () => {
      rounds += 1;
      return {
        payload: payloadShape === 'string' ? JSON.stringify(payload) : payload,
        hostRound: { sessionId: SESSION_ID, elapsedMs: 5, envelope: { model: 'glm-5.3-flash', provider: 'zai', ok: true }, roundDir: loc.roundDir },
      };
    },
    hostSnapshot: () => ({
      requestedModel: 'zai/glm-5.3-flash',
      observedModel: 'glm-5.3-flash',
      observedModelProviderId: 'zai',
      identityStatus: 'VERIFIED',
      identityEvidenceSource: 'exec-envelope + runtime trajectory corroboration',
      rounds,
      sessionDetails: [{ sessionId: SESSION_ID, roundDir: loc.roundDir, stateDir: loc.stateDir, stateAgentDb: loc.stateAgentDb }],
    }),
  };
}

describe('PRI-1038 F2 real-host wiring (offline; injected transport)', () => {
  it('readObservedHostEvidence passes through a well-formed exec-state location and DROPS a malformed one', () => {
    const good = readObservedHostEvidence({
      observedHostEvidence: { hostSessionId: 's', observedModelIdentity: 'glm-5.3-flash', hostEvidence: { kind: 'openclaw-exec-state', roundDir: 'r', stateDir: 's', stateAgentDb: 'd' } },
    } as any);
    expect(good).toMatchObject({ hostSessionId: 's', hostEvidence: { kind: 'openclaw-exec-state' } });
    const bad = readObservedHostEvidence({
      observedHostEvidence: { hostSessionId: 's', observedModelIdentity: 'glm-5.3-flash', hostEvidence: { kind: 'openclaw-exec-state' } },
    } as any);
    expect(bad).toMatchObject({ hostSessionId: 's', hostEvidence: null });
  });

  it('green path: F2 run through the REAL runner — probe deep verify (openclaw dispatch) passes, the actor records exec-state evidence, and the formal baseline derives PASS', async () => {
    const loc = writeExecStateDb(path.join(roundsRoot, 'round-01-a'), SESSION_ID, 'glm-5.3-flash', 'zai');
    const studyCopy = prepareStudyCopy();
    writeProbeRecord(studyCopy, loc);

    const summary = await runChallengeStudy({
      studyDir: studyCopy,
      plan: { arms: ['A'], cases: ['CEB-001-FV-01'], repetitions: [1], attemptId: 'a1' },
      actorFactory: (ctx: any) => createHostActorAdapter({ ctx, hostTransport: fakeOpenClawTransport(loc), taskId: `stage-r#CEB-001/CEB-001-FV-01/A/r1#challenge-actor` }),
      maxAttemptsTotal: 1,
      owner: 'f2-offline-test',
      execution: { mode: 'F2-real-host', now: Date.now(), requestTimeoutMs: 600000, maxRequestsPerAttempt: 10, probeControlledRoot: roundsRoot },
    });
    expect(summary.units).toHaveLength(1);
    expect(summary.units[0].state).toBe('SUCCEEDED');

    const attempt = JSON.parse(fs.readFileSync(path.join(studyCopy, 'runs', 'CEB-001-FV-01', 'A', 'r1', 'a1.json'), 'utf8'));
    expect(attempt.mode).toBe('F2-real-host');
    expect(attempt.observedHostEvidence).toMatchObject({ hostSessionId: SESSION_ID, observedModelIdentity: 'glm-5.3-flash', hostEvidence: { kind: 'openclaw-exec-state', stateAgentDb: loc.stateAgentDb } });
    expect(attempt.authorization.isolationAcceptance.realHostProbe.status).toBe('PASSED');

    const baseline = deriveRealHostBaselineFromStudy(studyCopy, {});
    expect(baseline.status).toBe('PASS');
    expect(baseline.reasons[0]).toContain('OpenClaw exec-state-corroborated');
  });

  it('tampered exec-state db (identity conflict) → the runner probe deep verify refuses the unit BEFORE execution; the baseline never upgrades', async () => {
    const loc = writeExecStateDb(path.join(roundsRoot, 'round-01-a'), SESSION_ID, 'gpt-6-luna', 'openai');
    const studyCopy = prepareStudyCopy();
    writeProbeRecord(studyCopy, loc);

    const summary = await runChallengeStudy({
      studyDir: studyCopy,
      plan: { arms: ['A'], cases: ['CEB-001-FV-01'], repetitions: [1], attemptId: 'a1' },
      actorFactory: (ctx: any) => createHostActorAdapter({ ctx, hostTransport: fakeOpenClawTransport(loc), taskId: `stage-r#CEB-001/CEB-001-FV-01/A/r1#challenge-actor` }),
      maxAttemptsTotal: 1,
      owner: 'f2-offline-test',
      execution: { mode: 'F2-real-host', now: Date.now(), requestTimeoutMs: 600000, maxRequestsPerAttempt: 10, probeControlledRoot: roundsRoot },
    });
    // Caught at the probe-evidence layer: the archived record's audited
    // identity (glm-5.3-flash) conflicts with the trajectory's model — the
    // unit never executes, so the tampered db can never enter the study.
    expect(summary.units[0].state).toBe('STAGE_R_REFUSED');
    expect(summary.units[0].reasons.join(' ')).toContain('conflicts with the probe');
    const baseline = deriveRealHostBaselineFromStudy(studyCopy, {});
    expect(baseline.status).toBe('UNKNOWN'); // no attempts recorded — nothing to upgrade
  });

  it('parses a STRING payload (the real OpenClaw transport shape) into a valid action — the 2026-10-30 first-batch wiring defect cannot recur', async () => {
    const loc = writeExecStateDb(path.join(roundsRoot, 'round-01-a'), SESSION_ID, 'glm-5.3-flash', 'zai');
    const studyCopy = prepareStudyCopy();
    writeProbeRecord(studyCopy, loc);

    const summary = await runChallengeStudy({
      studyDir: studyCopy,
      plan: { arms: ['A'], cases: ['CEB-001-FV-01'], repetitions: [1], attemptId: 'a1' },
      actorFactory: (ctx: any) => createHostActorAdapter({ ctx, hostTransport: fakeOpenClawTransport(loc, 'string'), taskId: `stage-r#CEB-001/CEB-001-FV-01/A/r1#challenge-actor` }),
      maxAttemptsTotal: 1,
      owner: 'f2-offline-test',
      execution: { mode: 'F2-real-host', now: Date.now(), requestTimeoutMs: 600000, maxRequestsPerAttempt: 10, probeControlledRoot: roundsRoot },
    });
    expect(summary.units[0].state).toBe('SUCCEEDED');
    const attempt = JSON.parse(fs.readFileSync(path.join(studyCopy, 'runs', 'CEB-001-FV-01', 'A', 'r1', 'a1.json'), 'utf8'));
    // The single report action parsed cleanly: one step, no invalid_response,
    // and the report's claims reached the adjudicator (not no_report).
    expect(attempt.trace.termination.reason).not.toBe('invalid_action_cap');
    expect(attempt.trace.records.filter((r: any) => r.kind === 'action' && r.action && r.action.type === 'invalid_response')).toHaveLength(0);
    expect(attempt.adjudication.protocol.reportPresent).toBe(true);
  });

  it('parses an OBJECT payload (the codex transport shape) unchanged', async () => {
    const loc = writeExecStateDb(path.join(roundsRoot, 'round-01-a'), SESSION_ID, 'glm-5.3-flash', 'zai');
    const studyCopy = prepareStudyCopy();
    writeProbeRecord(studyCopy, loc);

    const summary = await runChallengeStudy({
      studyDir: studyCopy,
      plan: { arms: ['A'], cases: ['CEB-001-FV-01'], repetitions: [1], attemptId: 'a1' },
      actorFactory: (ctx: any) => createHostActorAdapter({ ctx, hostTransport: fakeOpenClawTransport(loc, 'object'), taskId: `stage-r#CEB-001/CEB-001-FV-01/A/r1#challenge-actor` }),
      maxAttemptsTotal: 1,
      owner: 'f2-offline-test',
      execution: { mode: 'F2-real-host', now: Date.now(), requestTimeoutMs: 600000, maxRequestsPerAttempt: 10, probeControlledRoot: roundsRoot },
    });
    expect(summary.units[0].state).toBe('SUCCEEDED');
    const attempt = JSON.parse(fs.readFileSync(path.join(studyCopy, 'runs', 'CEB-001-FV-01', 'A', 'r1', 'a1.json'), 'utf8'));
    expect(attempt.adjudication.protocol.reportPresent).toBe(true);
  });

  it('a mapped roundDir ESCAPING the probe controlled root refuses the F2 unit before any actor step (forged evidence location)', async () => {
    const outsideRound = path.join(root, 'outside-rounds', 'round-01-x');
    const loc = writeExecStateDb(outsideRound, SESSION_ID, 'glm-5.3-flash', 'zai');
    const studyCopy = prepareStudyCopy();
    writeProbeRecord(studyCopy, loc);

    const summary = await runChallengeStudy({
      studyDir: studyCopy,
      plan: { arms: ['A'], cases: ['CEB-001-FV-01'], repetitions: [1], attemptId: 'a1' },
      actorFactory: () => { throw new Error('actor factory must never be reached'); },
      maxAttemptsTotal: 1,
      owner: 'f2-offline-test',
      execution: { mode: 'F2-real-host', now: Date.now(), requestTimeoutMs: 600000, maxRequestsPerAttempt: 10, probeControlledRoot: roundsRoot },
    });
    expect(summary.units[0].state).toBe('STAGE_R_REFUSED');
    expect(summary.units[0].reasons.join(' ')).toContain('escapes the controlled rounds root');
  });

  it('a MISSING probeControlledRoot refuses the F2 unit (deep verification is fail-closed, never skipped)', async () => {
    const loc = writeExecStateDb(path.join(roundsRoot, 'round-01-a'), SESSION_ID, 'glm-5.3-flash', 'zai');
    const studyCopy = prepareStudyCopy();
    writeProbeRecord(studyCopy, loc);

    const summary = await runChallengeStudy({
      studyDir: studyCopy,
      plan: { arms: ['A'], cases: ['CEB-001-FV-01'], repetitions: [1], attemptId: 'a1' },
      actorFactory: () => { throw new Error('actor factory must never be reached'); },
      maxAttemptsTotal: 1,
      owner: 'f2-offline-test',
      execution: { mode: 'F2-real-host', now: Date.now(), requestTimeoutMs: 600000, maxRequestsPerAttempt: 10 },
    });
    expect(summary.units[0].state).toBe('STAGE_R_REFUSED');
    expect(summary.units[0].reasons.join(' ')).toContain('openclawControlledRoot not provided');
  });
});
