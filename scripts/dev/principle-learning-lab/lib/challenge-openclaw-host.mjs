// SPEC-PD-EXAMINER-001 v0.4 / PRI-1037 (Owner S4, 2026-10-28) — the OpenClaw
// host adapter for the real-host isolation probe and F2.
//
// What this module is:
//   - a host transport implementing the SAME contract as the Codex adapter in
//     host-actor.mjs ({ complete({taskId,systemPrompt,userPrompt}) ->
//     { payload, hostRound: { sessionId } }, hostSnapshot() }) so the probe
//     engine (challenge-isolation-probe.mjs) runs unchanged;
//   - backed by the OpenClaw headless exec surface: `openclaw agent exec
//     --isolated --model <id> --json --message-file <file>` — every exec
//     creates a FRESH explicit session (the CLI generates the session id and
//     reports it in its JSON envelope), so probe-round session independence is
//     a transport-level property, not a caller discipline;
//   - the OpenClaw evidence reader: `readOpenClawTrajectoryEvidence` resolves
//     the session's own trajectory-pointer file (openclaw-trajectory-pointer
//     → runtimeFile) and corroborates provider/modelId from the
//     openclaw-trajectory JSONL the RUNTIME wrote — record fields alone never
//     corroborate (the verifyF2ProbeEvidence discipline, OpenClaw flavor).
//
// What this module is NOT:
//   - not a gateway client: the probe spawns the owner's `openclaw` CLI
//     directly (process boundary, same class as the Codex adapter);
//   - not identity proof by itself: envelope.model/provider are HOST-REPORTED
//     fields; corroboration always goes through the runtime trajectory file;
//   - not a rewrite of the Codex path: host-actor.mjs stays untouched; the
//     probe authorization's targetHost.kind selects the adapter.
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

export const OPENCLAW_TRAJECTORY_POINTER_SCHEMA = 'openclaw-trajectory-pointer';
export const OPENCLAW_TRAJECTORY_SCHEMA = 'openclaw-trajectory';

/** Fail-closed local probe: no openclaw binary ⇒ refuse transport creation
 *  before any round could ever be attempted. (--version is a local process,
 *  not a model call; result doubles as the recorded cliVersion.) */
function probeOpenclawVersion(openclawBin, versionProbe) {
  const probe = versionProbe
    ? versionProbe(openclawBin)
    : (() => {
        try {
          return spawnSync(openclawBin, ['--version'], { encoding: 'utf8', timeout: 20_000 });
        } catch (err) {
          return { error: err, status: null };
        }
      })();
  const version = typeof probe?.stdout === 'string' && probe.stdout.trim().length > 0 ? probe.stdout.trim().split('\n')[0] : null;
  if (probe?.error || (typeof probe?.status === 'number' && probe.status !== 0)) {
    throw new Error(`createOpenClawHostTransport: openclaw CLI probe failed (${openclawBin} --version): ${probe?.error?.message ?? `exit ${probe?.status}`}. No host rounds can run without the owner's OpenClaw CLI (fail-closed).`);
  }
  return version;
}

/** Same suffix discipline as verifyF2ProbeEvidence.sameModel — a provider-
 *  prefixed model id ("zai/glm-5.3-flash") matches its bare id. */
const sameModel = (a, b) => a === b || (typeof a === 'string' && typeof b === 'string' && (a.endsWith(`/${b}`) || b.endsWith(`/${a}`)));

export function createOpenClawHostTransport({
  model,
  agent = 'main',
  openclawBin = 'openclaw',
  workspaceDir,
  timeoutMsPerCall = 180_000,
  spawnProcess = spawn,
  versionProbe = null,
  now = () => Date.now(),
} = {}) {
  if (typeof model !== 'string' || model.trim().length === 0) {
    throw new Error('createOpenClawHostTransport: model (requested model id, e.g. zai/glm-5.3-flash) is required');
  }
  if (typeof workspaceDir !== 'string' || workspaceDir.trim().length === 0) {
    throw new Error('createOpenClawHostTransport: workspaceDir (spawn cwd / --cwd) is required');
  }
  if (!Number.isFinite(timeoutMsPerCall) || timeoutMsPerCall <= 0) {
    throw new Error('createOpenClawHostTransport: timeoutMsPerCall must be a positive finite number');
  }
  const cliVersion = probeOpenclawVersion(openclawBin, versionProbe);

  const identity = {
    requestedModel: model,
    observedModel: null,
    observedModelProviderId: null,
    evidenceSource: null,
    cliVersion,
    status: 'MODEL_IDENTITY_UNVERIFIED', // until the HOST's own envelope reports its model
  };
  const sessionRecords = [];
  let rounds = 0;

  function buildArgs({ messageFile }) {
    return [
      'agent', 'exec',
      '--isolated',                       // fresh explicit session per exec — probe rounds must not share state
      '--model', model,
      '--agent', agent,
      '--cwd', workspaceDir,
      '--timeout', String(Math.ceil(timeoutMsPerCall / 1000)),
      '--json',
      '--message-file', messageFile,
    ];
  }

  async function complete({ taskId, systemPrompt, userPrompt }) {
    if (typeof taskId !== 'string' || taskId.length === 0) throw new Error('openclaw transport: taskId is required (opportunity segment → fresh session)');
    if (typeof userPrompt !== 'string' || userPrompt.length === 0) throw new Error('openclaw transport: userPrompt is required');
    rounds += 1;
    const workDir = fs.mkdtempSync(path.join(workspaceDir, `probe-round-${rounds}-`));
    const messageFile = path.join(workDir, 'message.txt');
    const systemFile = path.join(workDir, 'system.txt');
    fs.writeFileSync(messageFile, userPrompt, 'utf8');
    fs.writeFileSync(systemFile, typeof systemPrompt === 'string' ? systemPrompt : '', 'utf8');
    const args = buildArgs({ messageFile });
    const t0 = now();
    const stdout = await new Promise((resolve, reject) => {
      const child = spawnProcess(openclawBin, args, { cwd: workspaceDir, stdio: ['pipe', 'pipe', 'pipe'] });
      let out = '';
      let err = '';
      const timer = setTimeout(() => {
        child.kill('SIGKILL');
        reject(new Error(`openclaw exec timed out after ${timeoutMsPerCall}ms (round ${rounds}, task ${taskId})`));
      }, timeoutMsPerCall);
      child.stdout.on('data', (d) => { out += d; });
      child.stderr.on('data', (d) => { err += d; });
      child.on('error', (e) => { clearTimeout(timer); reject(e); });
      child.on('close', (code) => {
        clearTimeout(timer);
        if (code !== 0 && out.trim().length === 0) {
          reject(new Error(`openclaw exec exited ${code}: ${err.slice(0, 400)}`));
          return;
        }
        resolve(out);
      });
    });
    const elapsedMs = now() - t0;

    // The envelope is the HOST's own report: final text, usage, model,
    // provider, and the session id the runtime assigned this fresh session.
    let envelope = null;
    try {
      envelope = JSON.parse(stdout.trim().split('\n').filter((l) => l.trim().startsWith('{')).pop());
    } catch {
      throw new Error(`openclaw exec produced no parseable JSON envelope (round ${rounds}, task ${taskId}); stdout head: ${stdout.slice(0, 200)}`);
    }
    if (!envelope || typeof envelope.sessionId !== 'string' || envelope.sessionId.length === 0) {
      throw new Error(`openclaw exec envelope carries no sessionId (round ${rounds}, task ${taskId}) — session independence unprovable, refusing`);
    }
    if (envelope.status === 'timeout' || envelope.ok !== true) {
      throw new Error(`openclaw exec failed (status=${String(envelope.status)}, error=${String(envelope.error && envelope.error.message).slice(0, 200)})`);
    }
    // host-reported identity → snapshot (verified only when it names the requested model)
    if (typeof envelope.model === 'string' && envelope.model.length > 0) {
      identity.observedModel = envelope.model;
      identity.observedModelProviderId = typeof envelope.provider === 'string' ? envelope.provider : null;
      identity.evidenceSource = `exec-envelope(round ${rounds}, sessionId ${envelope.sessionId}) + runtime trajectory corroboration`;
      identity.status = sameModel(envelope.model, model) ? 'VERIFIED' : 'MODEL_IDENTITY_MISMATCH';
    }
    sessionRecords.push({ taskId, sessionId: envelope.sessionId, rounds: 1, elapsedMs, model: envelope.model ?? null, provider: envelope.provider ?? null });

    const payloadText = typeof envelope.final === 'string' && envelope.final.length > 0
      ? envelope.final
      : (envelope.payloads || []).filter((p) => p.isError !== true).map((p) => p.text || '').join('\n');
    return { payload: payloadText, hostRound: { sessionId: envelope.sessionId, elapsedMs, envelope } };
  }

  function hostSnapshot() {
    return {
      requestedModel: identity.requestedModel,
      observedModel: identity.observedModel,
      observedModelProviderId: identity.observedModelProviderId,
      identityStatus: identity.status,
      identityEvidenceSource: identity.evidenceSource,
      cliVersion,
      hostKind: 'openclaw',
      agent,
      rounds,
      sessions: sessionRecords.map((s) => s.sessionId),
    };
  }

  return { complete, hostSnapshot, identity, sessionRecords, cliVersion };
}

/** Corroborate one OpenClaw session against the RUNTIME's own trajectory.
 *  Resolution is id-exact (the pointer file names the session id; the runtime
 *  file is read from the pointer, never guessed by timestamp/cwd). */
export function readOpenClawTrajectoryEvidence({ sessionsDir, sessionId }) {
  if (typeof sessionId !== 'string' || sessionId.length === 0) {
    return { found: false, ambiguous: false, reason: 'empty session id' };
  }
  const pointerFile = path.join(sessionsDir, `${sessionId}.trajectory-path.json`);
  if (!fs.existsSync(pointerFile)) {
    return { found: false, ambiguous: false, reason: `no trajectory pointer for session ${sessionId} under ${sessionsDir}` };
  }
  let pointer = null;
  try {
    pointer = JSON.parse(fs.readFileSync(pointerFile, 'utf8'));
  } catch (e) {
    return { found: false, ambiguous: false, reason: `trajectory pointer unreadable: ${e.message}` };
  }
  if (!pointer || pointer.traceSchema !== OPENCLAW_TRAJECTORY_POINTER_SCHEMA || pointer.sessionId !== sessionId || typeof pointer.runtimeFile !== 'string') {
    return { found: false, ambiguous: false, reason: 'trajectory pointer schema/session mismatch' };
  }
  if (!fs.existsSync(pointer.runtimeFile)) {
    return { found: false, ambiguous: false, reason: `runtime trajectory file missing: ${pointer.runtimeFile}` };
  }
  let lines = null;
  try {
    lines = fs.readFileSync(pointer.runtimeFile, 'utf8').split('\n').filter((l) => l.trim()).map((l) => JSON.parse(l));
  } catch (e) {
    return { found: false, ambiguous: false, reason: `runtime trajectory unreadable: ${e.message}` };
  }
  const started = lines.find((l) => l && l.type === 'session.started' && l.sessionId === sessionId);
  if (!started) {
    return { found: false, ambiguous: false, reason: `trajectory carries no session.started for ${sessionId}` };
  }
  const model = typeof started.modelId === 'string' ? started.modelId : (typeof started.model === 'string' ? started.model : null);
  const provider = typeof started.provider === 'string' ? started.provider : null;
  if (!model) {
    return { found: false, ambiguous: false, reason: 'trajectory session.started carries no model identity — cannot corroborate' };
  }
  return {
    found: true,
    ambiguous: false,
    sessionId,
    model,
    provider,
    workspaceDir: started.workspaceDir ?? null,
    trajectoryFile: pointer.runtimeFile,
    source: 'openclaw-runtime-trajectory',
  };
}
