// PRI-1163 round-key run — pure gate logic (offline-testable).
//
// Everything here is a pure function over explicit inputs (paths except the
// byte reader, which takes one path). No spawning, no hosts, no production
// access. The negative fixtures in scripts/__tests__/aa-round-key-run.test.mjs
// exercise exactly these functions.

import { closeSync, fstatSync, openSync, readSync } from 'node:fs';
import { createHash } from 'node:crypto';

const MAX_ROUND_DELTA_BYTES = 8 * 1024 * 1024;

/**
 * Byte-exact incremental read (PRI-1152 pattern). Offsets are BYTE offsets
 * from statSync; the returned text is decoded from exactly the appended
 * Buffer, so multi-byte UTF-8 (e.g. Chinese log lines) can never be split by
 * a string-index slice. Never throws: failures come back as readError with
 * the OS code.
 */
export function readAppendedBytes(path, fromByte = 0, maxBytes = MAX_ROUND_DELTA_BYTES) {
  let fd;
  let size;
  try {
    fd = openSync(path, 'r');
    size = fstatSync(fd).size;
  } catch (error) {
    if (fd !== undefined) closeSync(fd);
    const code = String(error?.code ?? 'E_READ');
    if (code === 'ENOENT' && fromByte === 0) return { text: '', fromByte, bytes: 0, truncated: false, shrunk: false };
    return { text: '', fromByte, bytes: 0, truncated: false, shrunk: fromByte > 0, readError: { code, message: String(error?.message ?? error) } };
  }
  try {
    const shrunk = size < fromByte;
    const start = shrunk ? 0 : fromByte;
    const length = Math.min(size - start, maxBytes);
    if (length <= 0) return { text: '', fromByte: start, bytes: 0, truncated: false, shrunk };
    const buffer = Buffer.alloc(length);
    let total = 0;
    while (total < length) {
      const read = readSync(fd, buffer, total, length - total, start + total);
      if (read <= 0) break;
      total += read;
    }
    return { text: buffer.toString('utf8'), fromByte: start, bytes: total, truncated: size - start > maxBytes, shrunk };
  } catch (error) {
    return { text: '', fromByte, bytes: 0, truncated: false, shrunk: size < fromByte, readError: { code: String(error?.code ?? 'E_READ'), message: String(error?.message ?? error) } };
  } finally {
    closeSync(fd);
  }
}

/**
 * Fail-closed log-evidence audit for one round (PRI-1152 codes). Truncation,
 * shrink or a read failure in the host-log or events delta makes the affected
 * evidence incomplete: each failure is a step with a stable code, and the
 * round gate fails on it.
 */
export function logEvidenceIntegrity({ hostLogDelta, eventFiles = [] }) {
  const steps = [];
  if (hostLogDelta?.shrunk) steps.push({ step: 'host-log-delta', code: 'HOST_LOG_SHRUNK', message: 'the host log shrank below the round baseline; previously-read bytes are gone' });
  if (hostLogDelta?.truncated) steps.push({ step: 'host-log-delta', code: 'HOST_LOG_TRUNCATED', message: 'the host log delta exceeds the read cap; bytes beyond it were not examined' });
  if (hostLogDelta?.readError) steps.push({ step: 'host-log-delta', code: 'HOST_LOG_READ_FAILED', message: `${hostLogDelta.readError.code}: ${hostLogDelta.readError.message}` });
  for (const file of eventFiles) {
    if (file.shrunk) steps.push({ step: `events:${file.name}`, code: 'EVENTS_LOG_SHRUNK', message: 'the event log shrank below the round baseline; previously-read bytes are gone' });
    if (file.truncated) steps.push({ step: `events:${file.name}`, code: 'EVENTS_LOG_TRUNCATED', message: 'the event log delta exceeds the read cap; bytes beyond it were not examined' });
    if (file.readError) steps.push({ step: `events:${file.name}`, code: 'EVENTS_LOG_READ_FAILED', message: `${file.readError.code}: ${file.readError.message}` });
  }
  return { complete: steps.length === 0, steps };
}

function lastMatch(text, regex) {
  const all = [...text.matchAll(regex)];
  return all.length > 0 ? all[all.length - 1] : null;
}
function normalizePath(p) {
  return process.platform === 'win32' ? String(p).replace(/\//g, '\\').toLowerCase() : String(p);
}

/**
 * Pure round gate. Inputs are already-collected facts; the driver only reads
 * bytes and spawns. Violations are {step, code, message} triples.
 */
export function judgeRound({
  roundId, previous,
  hostExitCode, timedOut, envelope, endpointServed, endpointRefused, endpointPath, expectedEndpointPath,
  hostLogDeltaText, events, trajectoryIndexes, candidateBundleOk,
  candidateRoot, workspaceDir, session, fixtureIds,
}) {
  const violations = [];
  const add = (code, message) => violations.push({ step: `round:${roundId}`, code, message });
  if (hostExitCode !== 0 || timedOut) add('host-exit', `code=${hostExitCode} timedOut=${timedOut}`);
  if (!envelope || envelope.ok !== true) add('host-envelope', 'ok=true missing from the agent --json envelope');
  if (envelope?.sessionId && envelope.sessionId !== session) add('host-envelope-session', `sessionId mismatch: ${envelope.sessionId}`);
  if (endpointServed !== 1 || endpointRefused !== 0) add('endpoint-one-request', `served=${endpointServed} refused=${endpointRefused}`);
  if (endpointPath !== undefined && endpointPath !== expectedEndpointPath) add('endpoint-api-path', `path=${endpointPath}`);

  const registration = lastMatch(hostLogDeltaText ?? '', /Principles Disciple Plugin registered\. \(Path: ([^)]+)\)/g);
  if (!registration) add('candidate-registration-source', 'no registration line in this round\'s host-log delta');
  else if (!normalizePath(registration[1]).startsWith(normalizePath(candidateRoot))) add('candidate-registration-source', `registration root outside the candidate: ${registration[1]}`);

  const explicit = lastMatch(hostLogDeltaText ?? '', /PD explicit workspace \((\w+): ([^)]+)\)/g);
  if (!explicit) add('explicit-workspace-line', 'no explicit-workspace resolution line in this round\'s host-log delta');
  else if (!normalizePath(explicit[2]).startsWith(normalizePath(workspaceDir))) add('explicit-workspace-line', `resolved explicit workspace outside the pack: ${explicit[2]}`);

  const trigger = lastMatch(hostLogDeltaText ?? '', /handleBeforePromptBuild called: workspaceDir=(true|false), trigger=([^,]+),/g);
  if (!trigger) add('trigger-line', 'no trigger line in this round\'s host-log delta');
  else {
    if (trigger[1] !== 'true') add('trigger-workspace', `hook ctx workspaceDir=${trigger[1]}`);
    else if (!['user', 'undefined'].includes(trigger[2])) add('trigger-not-user-round', `trigger=${trigger[2]} (heartbeat/cron rounds must NOT advance ordinals)`);
  }

  if (events.length !== 1) add('events-exactly-one', `${events.length} injected events in this round's delta (expected exactly 1)`);
  const payload = events[0]?.data ?? {};
  if (events.length === 1) {
    if (payload.selectionPolicy !== 'fair_rotation_v1') add('policy', `selectionPolicy=${payload.selectionPolicy}`);
    if (!Number.isInteger(payload.selectionRoundOrdinal)) add('ordinal-missing', `selectionRoundOrdinal=${payload.selectionRoundOrdinal}`);
    if ((payload.principleIds ?? []).some((id) => !fixtureIds.includes(id))) add('payload-fixture-set', 'payload principle outside the frozen fixture set');
  }

  const expectedRows = roundId === 'R1' ? 1 : 2;
  if (trajectoryIndexes.length !== expectedRows) add('user-turns-rows', `session rows=${trajectoryIndexes.length} (expected ${expectedRows})`);
  for (let i = 1; i < trajectoryIndexes.length; i++) {
    if (trajectoryIndexes[i] !== trajectoryIndexes[i - 1] + 1) add('user-turns-consecutive', `indexes=${JSON.stringify(trajectoryIndexes)}`);
  }
  if (roundId === 'R2' && previous) {
    if (previous.ordinal === null || payload.selectionRoundOrdinal !== previous.ordinal + 1) {
      add('ordinal-advance', `R1=${previous.ordinal} R2=${payload.selectionRoundOrdinal}`);
    }
    if (Number.isInteger(previous.rotStart) && Number.isInteger(payload.rotationStartIndex)) {
      const n = fixtureIds.length;
      const expected = (previous.rotStart + 1) % n;
      if (payload.rotationStartIndex !== expected) add('rotation-advance', `R1=${previous.rotStart} R2=${payload.rotationStartIndex} (expected ${expected})`);
    }
  }
  if (!candidateBundleOk) add('candidate-code-unchanged', 'candidate bundle bytes drifted during the round');

  return { ok: violations.length === 0, violations, ordinal: Number.isInteger(payload.selectionRoundOrdinal) ? payload.selectionRoundOrdinal : null, rotStart: Number.isInteger(payload.rotationStartIndex) ? payload.rotationStartIndex : null, policy: payload.selectionPolicy ?? null, triggerObserved: trigger ? trigger[2] : null };
}

/**
 * Per-round production fence (PRI-1152 pollution-audit pattern, narrowed to
 * the two facts this run can falsify). `before`/`after` are
 * {total, runSessionRows} snapshots of the production user_turns table.
 * Failure means R2 must not start; every violation is a stable-code step.
 */
export function perRoundProductionFence({ roundId, before, after }) {
  const violations = [];
  if (!after || typeof after.total !== 'number') {
    violations.push({ step: `production-fence:${roundId}`, code: 'PRODUCTION_FENCE_INCOMPLETE', message: 'production snapshot unreadable' });
    return { ok: false, violations };
  }
  if (after.total < before.total) {
    violations.push({ step: `production-fence:${roundId}`, code: 'PRODUCTION_FENCE_TOTAL_DECREASED', message: `production user_turns total DECREASED: ${before.total} -> ${after.total}` });
  }
  if (after.runSessionRows !== 0) {
    violations.push({ step: `production-fence:${roundId}`, code: 'PRODUCTION_FENCE_RUN_SESSION_ROWS', message: `production has ${after.runSessionRows} rows for the run session ${'(per-session isolation broken)'}` });
  }
  return { ok: violations.length === 0, violations };
}

/** Exclusive claim: a pack executes exactly once; the claim file is created 'wx'. */
export function refuseRerun({ runDirExists, ledgerExists, claimExists }) {
  if (runDirExists || ledgerExists || claimExists) {
    return { refused: true, code: 'PACK_ALREADY_CLAIMED', message: 'run/, the budget ledger or the claim file already exists; budgets never reset and a pack executes once' };
  }
  return { refused: false };
}

/**
 * Approval binding (PRI-1152 validateApproval pattern): the approval binds the
 * card version, the manifest file sha256, the frozen budgets AND the frozen
 * execution code (the launcher scripts) — so an executor change invalidates
 * every existing approval until the card is re-frozen.
 */
export function validateApprovalBinding({ approval, manifest, manifestSha256, executionCodeNow }) {
  const violations = [];
  if (approval?.schemaVersion !== 'pd-round-key-run-approval/v1') violations.push({ step: 'approval', code: 'APPROVAL_SCHEMA', message: `schemaVersion=${approval?.schemaVersion}` });
  if (approval?.cardVersion !== manifest.cardVersion) violations.push({ step: 'approval', code: 'APPROVAL_CARD_VERSION', message: `${approval?.cardVersion} != ${manifest.cardVersion}` });
  if (approval?.manifestSha256 !== manifestSha256) violations.push({ step: 'approval', code: 'APPROVAL_MANIFEST_SHA', message: `approval binds ${approval?.manifestSha256}, file is ${manifestSha256} (re-prepare invalidates)` });
  if (JSON.stringify(approval?.budgets) !== JSON.stringify(manifest.budgets)) violations.push({ step: 'approval', code: 'APPROVAL_BUDGETS', message: 'approval budgets differ from the frozen manifest budgets' });
  if (!approval?.approvedBy || !approval?.approvedAt) violations.push({ step: 'approval', code: 'APPROVAL_UNSIGNED', message: 'approvedBy/approvedAt missing' });
  if (JSON.stringify(approval?.executionCode) !== JSON.stringify(manifest.executionCode)) {
    violations.push({ step: 'approval', code: 'APPROVAL_EXECUTION_CODE', message: 'approval does not bind the manifest execution code' });
  }
  if (executionCodeNow !== undefined && JSON.stringify(executionCodeNow) !== JSON.stringify(manifest.executionCode)) {
    violations.push({ step: 'execution-code', code: 'EXECUTION_CODE_DRIFT', message: 'the executing scripts changed after prepare — re-freeze the card and manifest before running' });
  }
  return violations;
}

/** sha256 over the sorted key=value pairs of an env object (parity check). */
export function envFingerprint(env) {
  const lines = Object.keys(env ?? {}).sort().map((key) => `${key}=${env[key]}`);
  return createHash('sha256').update(lines.join('\n'), 'utf8').digest('hex');
}
