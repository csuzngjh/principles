// SPEC-PD-EXAMINER-001 v0.4 / PRI-1037 (Owner S4, 2026-10-28; S5 hardening) —
// the OpenClaw host adapter for the real-host isolation probe and F2.
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
// System-prompt channel (S5 P1-1, honest semantics): `openclaw agent exec`
// has NO standalone system-prompt CLI flag (verified against the 2026.10.5
// source: the exec request carries message/model/cwd/... but no systemPrompt
// field). The host's OFFICIAL channel for per-workspace instruction content
// is the workspace AGENTS.md file, which the runtime loads into its system
// prompt composition (loadWorkspaceBootstrapFiles → prompt-composition). This
// adapter therefore writes the probe's system instructions to
// `<round-dir>/AGENTS.md` and points `--cwd` at that round directory — the
// host genuinely loads them as system context. This is NOT claimed to be a
// provider-level `system` role message; the evidence record carries
// `systemPromptChannel: 'workspace-agents-md'` so no report can upgrade it.
//
// Workspace isolation (S5 P1-3): every round gets its OWN directory under the
// caller-provided roundsRoot (inside the runner's controlled workRoot) and
// `--cwd` points there — no probe round ever runs inside the configured
// OpenClaw agent workspace, and no round directory is shared with the next.
// `--isolated` isolates session/state; the per-round cwd isolates the FILE
// system workspace; both facts are recorded as such. Runtime trajectories
// under openclawHome are RESEARCH EVIDENCE and are never cleaned by this
// adapter; round dirs live under the runner's .tmp workRoot and are governed
// by the runner's cleanup policy.
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
export const OPENCLAW_SYSTEM_PROMPT_CHANNEL = 'workspace-agents-md';
export const OPENCLAW_PROBE_AGENTS_HEADER = '<!-- PRI-1037 isolation-probe system instructions (loaded by the OpenClaw runtime as workspace instruction context; NOT a provider-level system role message) -->\n\n';

/** Fail-closed local probe: no openclaw binary ⇒ refuse transport creation
 *  before any round could ever be attempted. (--version is a local process,
 *  not a model call; result doubles as the recorded cliVersion.) */
function probeOpenclawVersion(openclawBin, openclawPrefixArgs, versionProbe) {
  const probe = versionProbe
    ? versionProbe(openclawBin, openclawPrefixArgs)
    : (() => {
        try {
          return spawnSync(openclawBin, [...openclawPrefixArgs, '--version'], { encoding: 'utf8', timeout: 20_000 });
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
  expectedProvider = null, // S5 P1-2: the approved provider id (e.g. 'zai'); envelope.provider must match EXACTLY
  agent = 'main',
  openclawBin = 'openclaw',
  openclawPrefixArgs = [], // S5.2 env fix: e.g. [<node>, <openclaw.mjs>] when the npm shim is not directly spawnable on Windows
  configPath, // S5.2.1: the config file pinned via --config (owner's openclaw.json — zai provider + credentials)
  roundsRoot, // S5 P1-3: controlled root for per-round directories (inside the runner's workRoot)
  timeoutMsPerCall = 180_000,
  spawnProcess = spawn,
  versionProbe = null,
  now = () => Date.now(),
} = {}) {
  if (typeof model !== 'string' || model.trim().length === 0) {
    throw new Error('createOpenClawHostTransport: model (requested model id, e.g. zai/glm-5.3-flash) is required');
  }
  if (typeof roundsRoot !== 'string' || roundsRoot.trim().length === 0) {
    throw new Error('createOpenClawHostTransport: roundsRoot (controlled root for per-round dirs, S5 P1-3) is required');
  }
  if (typeof configPath !== 'string' || configPath.trim().length === 0) {
    throw new Error('createOpenClawHostTransport: configPath (--config pin, S5.2.1 — the approved provider lives in the owner config) is required');
  }
  if (!fs.existsSync(configPath)) {
    throw new Error(`createOpenClawHostTransport: pinned config not found: ${configPath} (fail-closed)`);
  }
  if (!Number.isFinite(timeoutMsPerCall) || timeoutMsPerCall <= 0) {
    throw new Error('createOpenClawHostTransport: timeoutMsPerCall must be a positive finite number');
  }
  const cliVersion = probeOpenclawVersion(openclawBin, openclawPrefixArgs, versionProbe);
  fs.mkdirSync(roundsRoot, { recursive: true });

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

  async function complete({ taskId, systemPrompt, userPrompt }) {
    if (typeof taskId !== 'string' || taskId.length === 0) throw new Error('openclaw transport: taskId is required (opportunity segment → fresh session)');
    if (typeof userPrompt !== 'string' || userPrompt.length === 0) throw new Error('openclaw transport: userPrompt is required');
    if (typeof systemPrompt !== 'string' || systemPrompt.length === 0) throw new Error('openclaw transport: systemPrompt is required (S5 P1-1: the probe must always declare its instructions)');
    rounds += 1;
    // Per-round directory: fresh file-system workspace per probe round; never
    // shared with another round; never the configured agent workspace.
    const roundDir = fs.mkdtempSync(path.join(roundsRoot, `round-${String(rounds).padStart(2, '0')}-`));
    const messageFile = path.join(roundDir, 'probe-message.txt');
    const agentsFile = path.join(roundDir, 'AGENTS.md');
    fs.writeFileSync(messageFile, userPrompt, 'utf8');
    fs.writeFileSync(agentsFile, OPENCLAW_PROBE_AGENTS_HEADER + systemPrompt + '\n', 'utf8');
    // S5.2 §四: a per-round, caller-owned state dir. Without --state-dir the
    // CLI creates an mkdtemp state under os.tmpdir() and DELETES it on exit
    // (agent-exec.ts: temporaryStateDir) — the session trajectory would vanish
    // with it. With --state-dir the session store, trajectory JSONL and
    // pointer persist inside our controlled round dir. Config/provider
    // resolution happens BEFORE the state-dir repoint (agent-exec.ts), so the
    // approved zai channel and credentials are unaffected.
    //
    // S5.2.1 probe-round fix (real-execution evidence): the CLI option surface
    // is `agent exec --help` (2026.10.5) — there is NO --agent flag (the agent
    // resolves from config), and --isolated means "read NO config" (skips all
    // authored config and its credential surfaces), which would make the
    // approved zai provider unavailable. The probe therefore pins the OWNER'S
    // config file via --config (read-only reference, reproducible, credentials
    // loaded) and gets state/workspace isolation from --state-dir + --cwd —
    // which are orthogonal to config resolution. Session isolation comes from
    // exec itself (fresh explicit session per invocation).
    const stateDir = path.join(roundDir, 'state');
    fs.mkdirSync(stateDir, { recursive: true }); // S5.2.1 probe-round fix: --state-dir requires an EXISTING dir (real-execution evidence: ENOENT otherwise)
    const sessionsDir = path.join(stateDir, 'agents', agent, 'sessions');
    const args = [
      'agent', 'exec',
      '--state-dir', stateDir,            // S5.2: persist the trajectory evidence inside the controlled round dir
      '--config', configPath,             // pin the owner's config (zai provider + credentials); never the ambient runtime snapshot
      '--model', model,
      '--cwd', roundDir,                  // S5 P1-3: the round dir IS the workspace for this round
      '--timeout', String(Math.ceil(timeoutMsPerCall / 1000)),
      '--json',
      '--message-file', messageFile,
    ];
    const t0 = now();
    const stdout = await new Promise((resolve, reject) => {
      const child = spawnProcess(openclawBin, [...openclawPrefixArgs, ...args], { cwd: roundDir, stdio: ['pipe', 'pipe', 'pipe'] });
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
    // host-reported identity → snapshot (S5 P1-2: BOTH model and provider must
    // match; a model-name match with a provider mismatch is a REFUSAL, and a
    // missing provider field cannot verify anything).
    let roundIdentityStatus = 'MODEL_IDENTITY_UNVERIFIED';
    if (typeof envelope.model === 'string' && envelope.model.length > 0) {
      identity.observedModel = envelope.model;
      identity.observedModelProviderId = typeof envelope.provider === 'string' && envelope.provider.length > 0 ? envelope.provider : null;
      identity.evidenceSource = `exec-envelope(round ${rounds}, sessionId ${envelope.sessionId}) + runtime trajectory corroboration`;
      if (identity.observedModelProviderId === null) {
        roundIdentityStatus = 'PROVIDER_UNREPORTED';
      } else if (expectedProvider !== null && envelope.provider !== expectedProvider) {
        roundIdentityStatus = 'PROVIDER_MISMATCH';
      } else if (!sameModel(envelope.model, model)) {
        roundIdentityStatus = 'MODEL_IDENTITY_MISMATCH';
      } else {
        roundIdentityStatus = 'VERIFIED';
      }
    }
    identity.status = roundIdentityStatus;
    if (roundIdentityStatus !== 'VERIFIED') {
      throw new Error(`openclaw exec round ${rounds} identity not VERIFIED (status=${roundIdentityStatus}, envelope model=${JSON.stringify(envelope.model ?? null)}, provider=${JSON.stringify(envelope.provider ?? null)}, expected provider=${JSON.stringify(expectedProvider)}) — refusing (S5 P1-2: provider mismatch is a hard refusal, never normalized)`);
    }
    sessionRecords.push({ taskId, sessionId: envelope.sessionId, rounds: 1, elapsedMs, model: envelope.model ?? null, provider: envelope.provider ?? null, roundDir, stateDir, sessionsDir, systemPromptChannel: OPENCLAW_SYSTEM_PROMPT_CHANNEL });

    const payloadText = typeof envelope.final === 'string' && envelope.final.length > 0
      ? envelope.final
      : (envelope.payloads || []).filter((p) => p.isError !== true).map((p) => p.text || '').join('\n');
    return { payload: payloadText, hostRound: { sessionId: envelope.sessionId, elapsedMs, envelope, roundDir } };
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
      systemPromptChannel: OPENCLAW_SYSTEM_PROMPT_CHANNEL,
      roundsRoot,
      sessions: sessionRecords.map((s) => s.sessionId),
      sessionDetails: sessionRecords.map((s) => ({ sessionId: s.sessionId, stateDir: s.stateDir, sessionsDir: s.sessionsDir })),
    };
  }

  return { complete, hostSnapshot, identity, sessionRecords, cliVersion };
}

/** Corroborate one OpenClaw session against the RUNTIME's own trajectory.
 *  Resolution is id-exact (the pointer file names the session id; the runtime
 *  file is read from the pointer, never guessed by timestamp/cwd).
 *
 *  S5 P1-4 evidence trustworthiness: `trustedRoot` (the OpenClaw runtime
 *  evidence root, e.g. <openclawHome>/agents/<agent>/sessions) is MANDATORY —
 *  the runtime file must resolve INSIDE it (realpath comparison defeats `..`
 *  and symlink escapes); a corrupt trajectory line, or more than one
 *  session.started for the session, is refused (never "a similar line
 *  somewhere" as identity). */
export function readOpenClawTrajectoryEvidence({ sessionsDir, sessionId, trustedRoot = null }) {
  if (typeof sessionId !== 'string' || sessionId.length === 0) {
    return { found: false, ambiguous: false, reason: 'empty session id' };
  }
  if (typeof sessionsDir !== 'string' || sessionsDir.length === 0) {
    return { found: false, ambiguous: false, reason: 'sessionsDir not provided' };
  }
  if (typeof trustedRoot !== 'string' || trustedRoot.length === 0) {
    return { found: false, ambiguous: false, reason: 'trustedRoot not provided — runtime files outside a verified evidence root are never accepted (S5 P1-4, fail-closed)' };
  }
  if (sessionId.includes('/') || sessionId.includes('\\') || sessionId.includes('..')) {
    return { found: false, ambiguous: false, reason: 'session id must be a bare id (no path separators)' };
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
  // Containment: the runtime file must live inside the trusted evidence root
  // (realpath on both sides defeats `..` segments and symlink escapes).
  let runtimeReal = null;
  let trustedReal = null;
  try {
    runtimeReal = fs.realpathSync(pointer.runtimeFile);
    trustedReal = fs.realpathSync(trustedRoot);
  } catch (e) {
    return { found: false, ambiguous: false, reason: `runtime trajectory path unresolvable: ${e.message}` };
  }
  if (!(runtimeReal === trustedReal || runtimeReal.startsWith(trustedReal + path.sep))) {
    return { found: false, ambiguous: false, reason: `runtime trajectory file escapes the trusted evidence root (${pointer.runtimeFile}) — refusing (S5 P1-4)` };
  }
  let rawLines = null;
  try {
    rawLines = fs.readFileSync(pointer.runtimeFile, 'utf8').split('\n').filter((l) => l.trim());
  } catch (e) {
    return { found: false, ambiguous: false, reason: `runtime trajectory unreadable: ${e.message}` };
  }
  let lines = null;
  try {
    lines = rawLines.map((l) => JSON.parse(l));
  } catch (e) {
    return { found: false, ambiguous: false, reason: `runtime trajectory corrupt (unparseable line): ${e.message}` };
  }
  // S5.1 §五: every event line must declare the openclaw-trajectory schema —
  // a file that merely CONTAINS a similar line is not host evidence.
  const badSchema = lines.findIndex((l) => !l || l.traceSchema !== OPENCLAW_TRAJECTORY_SCHEMA);
  if (badSchema >= 0) {
    return { found: false, ambiguous: false, reason: `runtime trajectory line ${badSchema + 1} does not declare traceSchema '${OPENCLAW_TRAJECTORY_SCHEMA}' — not host evidence (S5.1)` };
  }
  const starteds = lines.filter((l) => l && l.type === 'session.started' && l.sessionId === sessionId);
  if (starteds.length === 0) {
    return { found: false, ambiguous: false, reason: `trajectory carries no session.started for ${sessionId}` };
  }
  if (starteds.length > 1) {
    return { found: false, ambiguous: true, reason: `trajectory carries ${starteds.length} session.started records for ${sessionId} — cannot uniquely locate (S5 P1-4)` };
  }
  const started = starteds[0];
  const model = typeof started.modelId === 'string' && started.modelId.length > 0 ? started.modelId : (typeof started.model === 'string' && started.model.length > 0 ? started.model : null);
  const provider = typeof started.provider === 'string' && started.provider.length > 0 ? started.provider : null;
  if (!model || !provider) {
    return { found: false, ambiguous: false, reason: 'trajectory session.started carries no model or provider identity — cannot corroborate (S5 P1-2: both are required)' };
  }
  return {
    found: true,
    ambiguous: false,
    sessionId,
    model,
    provider,
    modelApi: typeof started.modelApi === 'string' ? started.modelApi : null,
    workspaceDir: started.workspaceDir ?? null,
    trajectoryFile: pointer.runtimeFile,
    source: 'openclaw-runtime-trajectory',
  };
}
