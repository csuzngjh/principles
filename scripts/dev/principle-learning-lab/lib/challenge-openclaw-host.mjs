// SPEC-PD-EXAMINER-001 v0.4 / PRI-1037 (Owner S4, 2026-10-28; S5 hardening) —
// the OpenClaw host adapter for the real-host isolation probe and F2.
//
// What this module is:
//   - a host transport implementing the SAME contract as the Codex adapter in
//     host-actor.mjs ({ complete({taskId,systemPrompt,userPrompt}) ->
//     { payload, hostRound: { sessionId } }, hostSnapshot() }) so the probe
//     engine (challenge-isolation-probe.mjs) runs unchanged;
//   - backed by the OpenClaw headless exec surface: `openclaw agent exec
//     --config <pinned> --state-dir <per-round> --model <id> --json
//     --message-file <file> --cwd <round-dir>` — every exec creates a FRESH
//     explicit session (the CLI generates the session id and reports it in
//     its JSON envelope), so probe-round session independence is a
//     transport-level property, not a caller discipline;
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
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';

export const OPENCLAW_TRAJECTORY_POINTER_SCHEMA = 'openclaw-trajectory-pointer';
export const OPENCLAW_TRAJECTORY_SCHEMA = 'openclaw-trajectory';
export const OPENCLAW_SYSTEM_PROMPT_CHANNEL = 'workspace-agents-md';
/** S7 §四: the AMBIENT OpenClaw state root — where the shared auth store
 *  (existing zai credentials) and the agents' persisted sessions live. The
 *  probe deliberately does NOT repoint this (no --state-dir): repointing
 *  yields an empty auth store (attempt-3 could never authenticate) and an
 *  environment that no real user session resembles. */
export function resolveAmbientStateRoot(env = process.env) {
  const explicit = typeof env.OPENCLAW_STATE_DIR === 'string' && env.OPENCLAW_STATE_DIR.trim().length > 0 ? env.OPENCLAW_STATE_DIR.trim() : null;
  const home = env.OPENCLAW_HOME || env.USERPROFILE || env.HOME;
  if (explicit) return explicit;
  if (home) return path.join(home, '.openclaw');
  throw new Error('resolveAmbientStateRoot: cannot resolve the ambient OpenClaw state root (no OPENCLAW_STATE_DIR / OPENCLAW_HOME / USERPROFILE / HOME)');
}

/** S9 (PRI-1037 runtime repair): child-process TEMP/TMP normalization.
 *
 *  Windows can hand a process an 8.3 short temp path (C:\Users\ADMINI~1\...).
 *  OpenClaw's plugin capture then fails with
 *    FsSafeError: copy path changed during operation
 *  because the same file is addressed by two different spellings during the
 *  copy/verify pass. The fix is scoped to the host child we spawn: resolve the
 *  real (long) directory and hand ONLY that child TEMP/TMP. The parent/user
 *  environment is never mutated.
 *
 *  Fail-closed (rc-3): a temp directory that cannot be resolved, is not a
 *  directory, or is not writable REFUSES the transport — passing the short
 *  path through would reproduce the failure on user machines. */
export function resolveChildTempEnv({ sourceEnv = process.env, platform = process.platform } = {}) {
  if (platform !== 'win32') return {};
  const declared = [sourceEnv.TEMP, sourceEnv.TMP].find((value) => typeof value === 'string' && value.trim().length > 0);
  const candidate = declared ? declared.trim() : os.tmpdir();
  let resolved;
  try {
    // realpathSync.native resolves 8.3 short names to their long form on Windows.
    resolved = fs.realpathSync.native(candidate);
  } catch (err) {
    throw new Error(`openclaw transport: cannot resolve a real temporary directory for the child process (${candidate}): ${err instanceof Error ? err.message : String(err)}. Refusing to spawn with an unusable TEMP.`);
  }
  // Keep drive roots intact (C:\ must not become C:).
  const normalized = /^[A-Za-z]:\\$/.test(resolved) ? resolved : resolved.replace(/[\\/]+$/, '');
  let stats;
  try {
    stats = fs.statSync(normalized);
  } catch (err) {
    throw new Error(`openclaw transport: resolved temporary directory is not accessible (${normalized}): ${err instanceof Error ? err.message : String(err)}`);
  }
  if (!stats.isDirectory()) {
    throw new Error(`openclaw transport: temporary directory path is not a directory (${normalized}) — the child would receive an unusable TEMP/TMP.`);
  }
  let probeDir;
  try {
    // accessSync(W_OK) is unreliable for directories on Windows; a real
    // create/remove proves the child can use the directory.
    probeDir = fs.mkdtempSync(path.join(normalized, 'pd-child-temp-probe-'));
  } catch (err) {
    throw new Error(`openclaw transport: temporary directory is not writable (${normalized}): ${err instanceof Error ? err.message : String(err)}`);
  }
  fs.rmSync(probeDir, { recursive: true, force: true });
  return { TEMP: normalized, TMP: normalized };
}

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

/** Extract the exec's JSON envelope from raw stdout. OpenClaw 2026.10.x
 *  prints the envelope through writeRuntimeJson, which PRETTY-PRINTS it
 *  (JSON.stringify(value, undefined, 2)) — a multi-line document whose only
 *  line starting with '{' is the bare opening brace. A single-line scan
 *  therefore feeds JSON.parse a lone '{' and always fails: on 2026-10-29 this
 *  made the exit-code contract unable to observe a REAL cleanup-kind envelope
 *  (probe cycle-2 round-1) and would have broken the success path the same
 *  way. Ordered extraction, most-specific first:
 *    1. the whole trimmed output IS the envelope (production --json shape);
 *    2. the span from the first '{' to the last '}' (envelope embedded in
 *       other stdout text);
 *    3. the last single-line JSON value (compact variant).
 *  Only objects are returned; anything else is treated as no envelope. */
function extractExecEnvelope(stdoutText) {
  const tryParseObject = (text) => {
    try {
      const value = JSON.parse(text);
      return typeof value === 'object' && value !== null && !Array.isArray(value) ? value : null;
    } catch {
      return null;
    }
  };
  const trimmed = stdoutText.trim();
  if (trimmed.length === 0) return null;
  const whole = tryParseObject(trimmed);
  if (whole !== null) return whole;
  const first = trimmed.indexOf('{');
  const last = trimmed.lastIndexOf('}');
  if (first >= 0 && last > first) {
    const spanned = tryParseObject(trimmed.slice(first, last + 1));
    if (spanned !== null) return spanned;
  }
  const line = trimmed.split('\n').map((l) => l.trim()).filter((l) => l.startsWith('{')).pop();
  if (line !== undefined) {
    const single = tryParseObject(line);
    if (single !== null) return single;
  }
  return null;
}

export function createOpenClawHostTransport({
  model,
  expectedProvider = null, // S5 P1-2: the approved provider id (e.g. 'zai'); envelope.provider must match EXACTLY
  agent = 'main',
  openclawBin = 'openclaw',
  openclawPrefixArgs = [], // S5.2 env fix: e.g. [<node>, <openclaw.mjs>] when the npm shim is not directly spawnable on Windows
  openclawHome, // S7 §四: the ambient OpenClaw state root (explicit — never silently derived from process.env)
  env = process.env, // S7.1 §3: injectable environment — the ACTUAL state root is derived from THIS, then checked against openclawHome
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
  // S9: resolve once, before any process exists — a temp dir the host child
  // cannot use is a refusal, not a round-level failure.
  const childTempEnv = resolveChildTempEnv({ sourceEnv: env });
  const cliVersion = probeOpenclawVersion(openclawBin, openclawPrefixArgs, versionProbe);
  // S7.1 §3 — ambient state root contract: the sessions evidence dir is
  // derived from the DECLARED openclawHome, and the ACTUAL state root (from
  // the injected env: OPENCLAW_STATE_DIR, else the home directory) must be
  // the same directory. A declared root that disagrees with the environment
  // (e.g. OPENCLAW_STATE_DIR redirected elsewhere) is refused BEFORE any
  // spawn — the openclawHome string alone is never treated as evidence that
  // the runtime will actually use it. Comparison is normalized-resolved and
  // case-insensitive (Windows drive casing).
  const actualStateRoot = resolveAmbientStateRoot(env);
  const norm = (p) => path.resolve(String(p)).replace(/[\\/]+$/, '').toLowerCase();
  if (norm(actualStateRoot) !== norm(openclawHome)) {
    throw new Error(`createOpenClawHostTransport: ambient state root mismatch — the environment resolves to '${actualStateRoot}' but the authorization declares '${openclawHome}'. Refusing before any spawn (S7.1 §3: a declared openclawHome is not evidence of the actual runtime root).`);
  }
  // S7 §四/S9 cycle-2: the ambient root above remains the AUTH anchor (the
  // zai credentials live there and agent-exec bridges them regardless of
  // --state-dir). Per-round session EVIDENCE now lives in each round's own
  // state dir (see complete()) — the ambient sessions dir is never read.
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
    // S9 cycle-2 (2026-10-29 mechanism-verified): every round runs with its OWN
    // `--state-dir` under the controlled round directory. Two facts verified
    // against the 2026.10.5 source and a real exec make this strictly better
    // than the S7 ambient-state posture:
    //   1. AUTH is NOT repointed: agent-exec resolves the auth-profile store
    //      dirs (storedAuthAgentDir/storedAuthStateDir) from the AMBIENT root
    //      BEFORE setAgentExecEnvironment repoints the state dir, and bridges
    //      them via withAuthProfileStoreAgentDir — the zai credentials stay
    //      reachable (re-run of the attempt-3 scenario; the S7 "repointing
    //      empties the auth store" diagnosis was a misattribution: the real
    //      attempt-3 killer was per-round plugin installation).
    //   2. A user-provided state dir is NEVER temporary: temporaryStateDir is
    //      undefined, so the post-run `fs.rm` that fails EBUSY on Windows (the
    //      exec's own still-open agent sqlite) NEVER RUNS — rounds exit 0 with
    //      clean ok:true envelopes instead of depending on the cleanup-kind
    //      contract, AND the session's runtime trajectory persists in
    //      <stateDir>/agents/<agent>/agent/openclaw-agent.sqlite
    //      (trajectory_runtime_events) as durable corroboration evidence.
    //     (Exec sessions NEVER write the gateway-era sessions/*.jsonl + pointer
    //      files — verified 2026-10-29: ambient sessions dir untouched by exec
    //      rounds; the S5.2 pointer-file reader remains for gateway-era
    //      evidence but cannot corroborate exec sessions.)
    // Session isolation does NOT depend on the state dir: every exec creates a
    // fresh explicit session (own sessionId); workspace isolation comes from
    // the per-round --cwd; state isolation now comes from the per-round
    // --state-dir (real per-round state separation, stronger than ambient).
    //
    // S5.2.1 probe-round fix (real-execution evidence): the CLI option surface
    // is `agent exec --help` (2026.10.5) — there is NO --agent flag, and
    // --isolated means "read NO config". The owner's config file is pinned via
    // --config (read-only reference; reproducible; credentials loaded).
    const roundStateDir = path.join(roundDir, 'state');
    fs.mkdirSync(roundStateDir, { recursive: true }); // --state-dir requires an EXISTING directory (2026.10.5 CLI)
    const args = [
      'agent', 'exec',
      '--config', configPath,             // pin the owner's config (zai provider + credentials); never the ambient runtime snapshot
      '--state-dir', roundStateDir,       // S9 cycle-2: per-round state — trajectories persist here as evidence; no temp rm ⇒ no EBUSY
      '--model', model,
      '--cwd', roundDir,                  // S5 P1-3: the round dir IS the workspace for this round
      '--timeout', String(Math.ceil(timeoutMsPerCall / 1000)),
      '--json',
      '--message-file', messageFile,
    ];
    const t0 = now();
    const stdout = await new Promise((resolve, reject) => {
      // S9: the child alone gets the normalized long-form TEMP/TMP; everything
      // else stays exactly the inherited environment.
      const child = spawnProcess(openclawBin, [...openclawPrefixArgs, ...args], { cwd: roundDir, stdio: ['pipe', 'pipe', 'pipe'], env: { ...process.env, ...childTempEnv } });
      let out = '';
      let err = '';
      const timer = setTimeout(() => {
        child.kill('SIGKILL');
        // code:'timeout' — the adapter-classified ambiguity marker (createHostActorAdapter
        // rethrows it as ambiguous: the exec was dispatched and killed at the wall
        // clock, so whether the model ran is unknowable → RESULT_UNKNOWN, never
        // a clean failure).
        reject(Object.assign(new Error(`openclaw exec timed out after ${timeoutMsPerCall}ms (round ${rounds}, task ${taskId})`), { code: 'timeout' }));
      }, timeoutMsPerCall);
      child.stdout.on('data', (d) => { out += d; });
      child.stderr.on('data', (d) => { err += d; });
      child.on('error', (e) => { clearTimeout(timer); reject(e); });
      child.on('close', (code) => {
        clearTimeout(timer);
        // Exit-code contract (S9.1, task E): OpenClaw stamps POST-RUN cleanup
        // failures with a dedicated error kind ("cleanup") and OVERWRITES an
        // otherwise-successful envelope (ok flipped false, exit 1) while the
        // round data (final/payloads/usage/model/provider/sessionId) stays
        // intact — observed on Windows where the exec's own agent owner.sqlite
        // stays locked until process exit. A non-zero exit therefore refuses
        // ONLY when no complete successful-round envelope is present; a
        // cleanup-kind envelope with full round data resolves and carries the
        // anomaly in the evidence (rc-9, never silent). Every other non-zero
        // exit (model failure, no output, timeout kill) still rejects.
        const envelopeHint = extractExecEnvelope(out);
        if (code !== 0) {
          let cleanupRound = false;
          if (envelopeHint) {
            cleanupRound = Boolean(envelopeHint.error) && envelopeHint.error.kind === 'cleanup'
              && typeof envelopeHint.sessionId === 'string' && envelopeHint.sessionId.length > 0
              && typeof envelopeHint.model === 'string' && envelopeHint.model.length > 0
              && typeof envelopeHint.final === 'string' && envelopeHint.final.length > 0;
          }
          if (!cleanupRound) {
            // rc-9 diagnostic priority: when the host printed a structured
            // envelope, ITS error is the truth — 2026.10.x stderr leads with
            // multi-line config warnings that bury the actual failure line
            // (observed 2026-10-29: 400-char head was 100% config warnings).
            // A success-shaped envelope without an error field carries no
            // explanation, so stderr keeps priority there.
            const envelopeDiagnostic = envelopeHint && envelopeHint.error
              ? `envelope(status=${JSON.stringify(envelopeHint.status ?? null)}, error.kind=${JSON.stringify(envelopeHint.error.kind ?? null)}, error.message=${String(envelopeHint.error.message ?? '').slice(0, 200)})`
              : null;
            const hostDiagnostic = (envelopeDiagnostic ?? (err.trim().length > 0 ? err.trim() : 'no host diagnostic')).slice(0, 400);
            reject(new Error(`openclaw exec exited ${code}: ${hostDiagnostic}`));
            return;
          }
          // fall through: the cleanup-failed round's envelope is the evidence.
        }
        resolve(out);
      });
    });
    const elapsedMs = now() - t0;

    // The envelope is the HOST's own report: final text, usage, model,
    // provider, and the session id the runtime assigned this fresh session.
    // 2026.10.x pretty-prints it (writeRuntimeJson, space=2) — extraction is
    // shape-agnostic (extractExecEnvelope), never single-line.
    const envelope = extractExecEnvelope(stdout);
    if (!envelope) {
      throw new Error(`openclaw exec produced no parseable JSON envelope (round ${rounds}, task ${taskId}); stdout head: ${stdout.slice(0, 200)}`);
    }
    if (!envelope || typeof envelope.sessionId !== 'string' || envelope.sessionId.length === 0) {
      throw new Error(`openclaw exec envelope carries no sessionId (round ${rounds}, task ${taskId}) — session independence unprovable, refusing`);
    }
    // S9.1 task E: a cleanup-kind envelope reached here only through the
    // exit-code contract above (round data complete). The envelope's ok=false
    // reflects POST-RUN cleanup only; the round itself is classified below by
    // its model/provider identity and final text. Any non-cleanup error still
    // refuses here.
    const cleanupKind = envelope.error && envelope.error.kind === 'cleanup';
    if (envelope.status === 'timeout' || (envelope.ok !== true && !cleanupKind)) {
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
    sessionRecords.push({ taskId, sessionId: envelope.sessionId, rounds: 1, elapsedMs, model: envelope.model ?? null, provider: envelope.provider ?? null, roundDir, stateDir: roundStateDir, stateAgentDb: path.join(roundStateDir, 'agents', agent, 'agent', 'openclaw-agent.sqlite'), systemPromptChannel: OPENCLAW_SYSTEM_PROMPT_CHANNEL, hostCleanupAnomaly: envelope.ok !== true && envelope.error && envelope.error.kind === 'cleanup' ? String(envelope.error.message).slice(0, 200) : null });

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
      childTempDir: childTempEnv.TEMP ?? null,
      rounds,
      systemPromptChannel: OPENCLAW_SYSTEM_PROMPT_CHANNEL,
      roundsRoot,
      sessions: sessionRecords.map((s) => s.sessionId),
      sessionDetails: sessionRecords.map((s) => ({ sessionId: s.sessionId, roundDir: s.roundDir, stateDir: s.stateDir, stateAgentDb: s.stateAgentDb, hostCleanupAnomaly: s.hostCleanupAnomaly ?? null })),
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

/** Corroborate one OpenClaw EXEC session against the runtime's own trajectory
 *  inside the exec's per-round state database. `agent exec` (2026.10.x)
 *  persists trajectories in
 *  <stateDir>/agents/<agent>/agent/openclaw-agent.sqlite (table
 *  trajectory_runtime_events, one JSON line per event) — it NEVER writes the
 *  gateway-era sessions/*.jsonl + pointer files (verified 2026-10-29: a real
 *  exec leaves the ambient sessions dir untouched; the trajectory only ever
 *  existed in the temp state db, which a clean run deletes — the per-round
 *  --state-dir posture is what makes the evidence durable at all).
 *
 *  Same fail-closed discipline as readOpenClawTrajectoryEvidence: the db must
 *  resolve INSIDE trustedRoot (the round's controlled state dir), every event
 *  line must declare the openclaw-trajectory schema, exactly one
 *  session.started may carry the session id, and BOTH model and provider are
 *  required. */
export function readOpenClawExecStateTrajectory({ stateAgentDb, sessionId, trustedRoot = null }) {
  if (typeof sessionId !== 'string' || sessionId.length === 0) {
    return { found: false, ambiguous: false, reason: 'empty session id' };
  }
  if (typeof stateAgentDb !== 'string' || stateAgentDb.length === 0) {
    return { found: false, ambiguous: false, reason: 'stateAgentDb not provided' };
  }
  if (typeof trustedRoot !== 'string' || trustedRoot.length === 0) {
    return { found: false, ambiguous: false, reason: 'trustedRoot not provided — runtime evidence outside a verified root is never accepted (S5 P1-4, fail-closed)' };
  }
  if (sessionId.includes('/') || sessionId.includes('\\') || sessionId.includes('..')) {
    return { found: false, ambiguous: false, reason: 'session id must be a bare id (no path separators)' };
  }
  if (!fs.existsSync(stateAgentDb)) {
    return { found: false, ambiguous: false, reason: `exec state database does not exist: ${stateAgentDb}` };
  }
  // Containment: the db must live inside the round's controlled state root
  // (realpath on both sides defeats `..` segments and symlink escapes).
  let dbReal = null;
  let trustedReal = null;
  try {
    dbReal = fs.realpathSync(stateAgentDb);
    trustedReal = fs.realpathSync(trustedRoot);
  } catch (e) {
    return { found: false, ambiguous: false, reason: `exec state path unresolvable: ${e.message}` };
  }
  if (!(dbReal === trustedReal || dbReal.startsWith(trustedReal + path.sep))) {
    return { found: false, ambiguous: false, reason: `exec state database escapes the controlled state root (${stateAgentDb}) — refusing (S5 P1-4)` };
  }
  let Database = null;
  try {
    // Lazy + synchronous (better-sqlite3 is CJS): the native module is a
    // repository dependency of the dev lab, not a runtime contract of this
    // transport's spawn path.
    Database = createRequire(import.meta.url)('better-sqlite3');
  } catch (e) {
    return { found: false, ambiguous: false, reason: `cannot load better-sqlite3 for exec-state corroboration: ${e.message}` };
  }
  let db = null;
  let rows = null;
  try {
    db = new Database(dbReal, { readonly: true, fileMustExist: true });
    rows = db.prepare('SELECT seq, event_json FROM trajectory_runtime_events WHERE session_id = ? ORDER BY seq').all(sessionId);
  } catch (e) {
    return { found: false, ambiguous: false, reason: `exec state database unreadable: ${e.message}` };
  } finally {
    if (db !== null) db.close();
  }
  if (rows.length === 0) {
    return { found: false, ambiguous: false, reason: `no trajectory events for session ${sessionId} in the exec state database` };
  }
  let lines = null;
  try {
    lines = rows.map((r) => JSON.parse(r.event_json));
  } catch (e) {
    return { found: false, ambiguous: false, reason: `exec state trajectory corrupt (unparseable event): ${e.message}` };
  }
  // S5.1 §五: every event line must declare the openclaw-trajectory schema —
  // a database that merely CONTAINS a similar line is not host evidence.
  const badSchema = lines.findIndex((l) => !l || l.traceSchema !== OPENCLAW_TRAJECTORY_SCHEMA);
  if (badSchema >= 0) {
    return { found: false, ambiguous: false, reason: `exec state trajectory event ${badSchema + 1} does not declare traceSchema '${OPENCLAW_TRAJECTORY_SCHEMA}' — not host evidence (S5.1)` };
  }
  const starteds = lines.filter((l) => l && l.type === 'session.started' && l.sessionId === sessionId);
  if (starteds.length === 0) {
    return { found: false, ambiguous: false, reason: `exec state trajectory carries no session.started for ${sessionId}` };
  }
  if (starteds.length > 1) {
    return { found: false, ambiguous: true, reason: `exec state trajectory carries ${starteds.length} session.started records for ${sessionId} — cannot uniquely locate (S5 P1-4)` };
  }
  const started = starteds[0];
  const model = typeof started.modelId === 'string' && started.modelId.length > 0 ? started.modelId : (typeof started.model === 'string' && started.model.length > 0 ? started.model : null);
  const provider = typeof started.provider === 'string' && started.provider.length > 0 ? started.provider : null;
  if (!model || !provider) {
    return { found: false, ambiguous: false, reason: 'exec state trajectory session.started carries no model or provider identity — cannot corroborate (S5 P1-2: both are required)' };
  }
  return {
    found: true,
    ambiguous: false,
    sessionId,
    model,
    provider,
    modelApi: typeof started.modelApi === 'string' ? started.modelApi : null,
    stateAgentDb: dbReal,
    source: 'openclaw-exec-state-trajectory',
  };
}
