// PRI-1152 Path A isolated-host run — launcher.
//
//   --prepare   freeze a NEW execution pack (stages the official host copy, the
//               candidate plugin, the fixture, configs, inputs; writes
//               manifest.json, run-card.md and approval.template.json). Starts
//               no host and sends no request.
//   --verify    offline re-verification of a frozen pack; `--full` re-hashes the
//               staged host tree; `--selftest` runs the accounted loopback
//               protocol self-test against the staged official transports. Exit 0
//               only when every required check passed (READY): both flags are
//               needed for that.
//   --execute   the approved run ONLY: requires an approval file bound to the
//               manifest sha256 and card version. Re-runs every required check
//               (stored preflight reports are never trusted), then runs R1 and —
//               only if R1 passed — R2, each as ONE host start with ONE provider
//               request, under the shared fail-closed ledger. The production
//               pollution audit runs after each round and decides whether the
//               next round starts and whether the run can be `completed`.
//
// Budget semantics: reaching a cap is not over budget; the NEXT attempt is
// refused before it is issued (host start: before spawn; provider HTTP: before
// the body is read). A failed host start is still charged. No retry, no
// fallback, no second execute of the same pack (the ledger file is never reset).

import { spawn, spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { closeSync, existsSync, mkdirSync, openSync, readdirSync, readFileSync, readSync, statSync, writeFileSync } from 'node:fs';
import { connect } from 'node:net';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { isDeepStrictEqual } from 'node:util';
import { BudgetExceededError, createExperimentLedger } from './lib/ledger.mjs';
import { isInsideRoot, isSamePath } from './lib/env-isolation.mjs';
import { selectLoopbackPort } from './lib/host-config.mjs';
import { startPresenceEndpoint, PRESENCE_ANSWER } from './lib/presence-endpoint.mjs';
import { PRESENCE_MODEL_ID } from './lib/presence-config.mjs';
import { PRESENCE_FIXTURE } from './lib/presence-fixture.mjs';
import { runProtocolSelftest } from './lib/protocol-selftest.mjs';
import {
  CARD_VERSION, PRESENCE_CODE_ROOT, PRESENCE_EVENT_TYPE, buildRoundEnv, candidateCodeDrift, classifyPollution, comparePollution, packLayout,
  pollutionSnapshotGaps, preflightCheck, preparePack, roundArgv, sha256FileSync, snapshotTargets, summarizePreflight, verifyPack,
} from './lib/presence-pack.mjs';
import { escapeXml } from '@principles/core/prompt-builder';

export const APPROVAL_SCHEMA = 'pd-presence-run-approval/v1';
const EXPECTED_HOST_VERSION = '2026.11.1';
const EXPECTED_HOST_COMMIT = '4ffdd2047d192dd65554de3c8c46c0e0197c6e2a';

function writeJson(path, value, flag = 'w') {
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`, { encoding: 'utf8', flag });
}

function git(repoRoot, args) {
  const result = spawnSync('git', args, { cwd: repoRoot, encoding: 'utf8', windowsHide: true, timeout: 20_000 });
  return result.status === 0 ? result.stdout.trim() : null;
}

function sourceFacts(repoRoot) {
  const status = git(repoRoot, ['status', '--porcelain', '--untracked-files=no']);
  return {
    repoRoot,
    headSha: git(repoRoot, ['rev-parse', 'HEAD']),
    branch: git(repoRoot, ['rev-parse', '--abbrev-ref', 'HEAD']),
    trackedTreeClean: status === '',
    trackedChanges: status ? status.split('\n').slice(0, 20) : [],
  };
}

/** Bind the frozen port briefly and connect over raw TCP (no HTTP request). A free port now is not a reservation. */
async function probePort(port) {
  const { createServer } = await import('node:net');
  const server = createServer((socket) => socket.destroy());
  try {
    await new Promise((resolvePromise, reject) => {
      server.once('error', reject);
      server.listen(port, '127.0.0.1', () => { server.off('error', reject); resolvePromise(); });
    });
    const reachable = await new Promise((resolvePromise) => {
      const socket = connect({ host: '127.0.0.1', port }, () => { socket.destroy(); resolvePromise(true); });
      socket.setTimeout(3000, () => { socket.destroy(); resolvePromise(false); });
      socket.on('error', () => resolvePromise(false));
    });
    return { ok: reachable, port };
  } catch (error) {
    return { ok: false, port, reason: String(error?.message ?? error) };
  } finally {
    await new Promise((resolvePromise) => server.close(() => resolvePromise()));
  }
}

async function portRefusesConnections(port) {
  return new Promise((resolvePromise) => {
    const socket = connect({ host: '127.0.0.1', port }, () => { socket.destroy(); resolvePromise(false); });
    socket.setTimeout(3000, () => { socket.destroy(); resolvePromise(false); });
    socket.on('error', () => resolvePromise(true));
  });
}

/**
 * The launcher and the shells that started it can carry the pack path on their
 * own command lines. They are never sweep targets: killing one would take the
 * launcher down mid-run and lose its cleanup and evidence.
 */
function withoutLauncherAncestry(rows) {
  const byPid = new Map(rows.map((row) => [row.pid, row]));
  const ancestry = new Set([process.pid]);
  for (let pid = process.ppid; byPid.has(pid) && !ancestry.has(pid); pid = byPid.get(pid).ppid) ancestry.add(pid);
  return rows.filter((row) => !ancestry.has(row.pid));
}

/** Processes whose command line references `fragment` (the pack root), excluding the launcher's own ancestry. */
export function findProcessesReferencing(fragment) {
  if (process.platform === 'win32') {
    const escaped = fragment.replaceAll("'", "''");
    // $PID excludes this PowerShell query itself (its own command line contains the fragment).
    const script = `Get-CimInstance Win32_Process | Where-Object { $_.ProcessId -ne $PID -and $_.CommandLine -and $_.CommandLine.Contains('${escaped}') } | Select-Object ProcessId,ParentProcessId,Name | ConvertTo-Json -Compress`;
    const result = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], { encoding: 'utf8', windowsHide: true, timeout: 30_000 });
    if (result.status !== 0) return { ok: false, reason: (result.stderr || String(result.error ?? 'process query failed')).slice(0, 300), processes: [] };
    const text = (result.stdout || '').trim();
    if (!text) return { ok: true, processes: [] };
    let parsed;
    try { parsed = JSON.parse(text); } catch { return { ok: false, reason: 'process query returned unparseable output', processes: [] }; }
    const rows = Array.isArray(parsed) ? parsed : [parsed];
    return { ok: true, processes: withoutLauncherAncestry(rows.map((row) => ({ pid: row.ProcessId, ppid: row.ParentProcessId, name: row.Name }))) };
  }
  const result = spawnSync('ps', ['-eo', 'pid=,ppid=,args='], { encoding: 'utf8', timeout: 30_000 });
  if (result.status !== 0) return { ok: false, reason: 'ps failed', processes: [] };
  const processes = [];
  for (const line of result.stdout.split('\n')) {
    const match = line.trim().match(/^(\d+)\s+(\d+)\s+(.*)$/);
    if (match && match[3].includes(fragment)) processes.push({ pid: Number(match[1]), ppid: Number(match[2]), name: match[3].slice(0, 80) });
  }
  return { ok: true, processes: withoutLauncherAncestry(processes) };
}

function killTree(pid) {
  if (process.platform === 'win32') {
    const result = spawnSync('taskkill', ['/PID', String(pid), '/T', '/F'], { windowsHide: true, encoding: 'utf8', timeout: 30_000 });
    return { pid, method: 'taskkill-tree', status: result.status };
  }
  try { process.kill(pid, 'SIGKILL'); return { pid, method: 'sigkill', status: 0 }; } catch (error) { return { pid, method: 'sigkill', status: String(error?.code ?? error) }; }
}

/**
 * Kill every process still referencing the pack and report it. Fail-closed:
 * a round is clean only when nothing referenced the pack after the host
 * exited; anything found is killed AND recorded as a stop condition.
 */
export function sweepPackProcesses(packRoot) {
  const before = findProcessesReferencing(packRoot);
  const killed = before.processes.map((row) => killTree(row.pid));
  const after = findProcessesReferencing(packRoot);
  return {
    found: before.processes,
    killed,
    remaining: after.processes,
    queryOk: before.ok && after.ok,
    ok: before.ok && after.ok && before.processes.length === 0 && after.processes.length === 0,
  };
}

function eventsLogsDir(workspaceDir) {
  return join(workspaceDir, '.state', 'logs');
}

/** Byte size of every event log before a round starts; only bytes appended after it count as that round's evidence. */
export function eventLogSizes(workspaceDir) {
  const logsDir = eventsLogsDir(workspaceDir);
  const sizes = new Map();
  if (!existsSync(logsDir)) return sizes;
  for (const name of readdirSync(logsDir).filter((file) => file.startsWith('events_') && file.endsWith('.jsonl'))) {
    sizes.set(name, statSync(join(logsDir, name)).size);
  }
  return sizes;
}

const MAX_ROUND_DELTA_BYTES = 32 * 1024 * 1024;

/** The bytes appended to `path` after `fromByte` (bounded). A shrunken file is read whole and flagged. */
export function readAppended(path, fromByte = 0, maxBytes = MAX_ROUND_DELTA_BYTES) {
  if (!existsSync(path)) return { text: '', fromByte, bytes: 0, truncated: false, shrunk: false };
  const size = statSync(path).size;
  const shrunk = size < fromByte;
  const start = shrunk ? 0 : fromByte;
  const length = Math.min(size - start, maxBytes);
  if (length <= 0) return { text: '', fromByte, bytes: 0, truncated: false, shrunk };
  const buffer = Buffer.alloc(length);
  const fd = openSync(path, 'r');
  try {
    readSync(fd, buffer, 0, length, start);
  } finally {
    closeSync(fd);
  }
  return { text: buffer.toString('utf8'), fromByte: start, bytes: length, truncated: size - start > maxBytes, shrunk };
}

/** Presence events appended to the isolated workspace's event logs since `baseline` was taken. */
export function readPresenceEventsSince(workspaceDir, baseline = new Map()) {
  const logsDir = eventsLogsDir(workspaceDir);
  const events = [];
  const files = [];
  if (!existsSync(logsDir)) return { logsDir, files, events };
  for (const name of readdirSync(logsDir).filter((file) => file.startsWith('events_') && file.endsWith('.jsonl')).sort()) {
    const delta = readAppended(join(logsDir, name), baseline.get(name) ?? 0);
    files.push({ name, fromByte: delta.fromByte, bytes: delta.bytes, shrunk: delta.shrunk, truncated: delta.truncated });
    for (const line of delta.text.split('\n')) {
      if (!line.trim()) continue;
      try {
        const entry = JSON.parse(line);
        if (entry?.type === PRESENCE_EVENT_TYPE) events.push({ file: name, line, entry });
      } catch { /* a torn line is not an event */ }
    }
  }
  return { logsDir, files, events };
}

const REGISTRATION_MARKER = 'Principles Disciple Plugin registered';
// The path runs to the first ")" that ends the message, so a root such as
// "C:\Program Files (x86)\..." keeps its inner parentheses.
const REGISTRATION_MESSAGE = /Principles Disciple Plugin registered\. \(Path: ([^\r\n]*?)\)(?=\s*$|\s|["',}\]])/;
const ANSI_SEQUENCE = /\u001b\[[0-9;]*[A-Za-z]/g;
const MAX_REGISTRATION_LINES = 50_000;

function collectStrings(value, out, depth = 0) {
  if (depth > 6 || out.length > 200) return;
  if (typeof value === 'string') out.push(value);
  else if (Array.isArray(value)) for (const item of value) collectStrings(item, out, depth + 1);
  else if (value && typeof value === 'object') for (const item of Object.values(value)) collectStrings(item, out, depth + 1);
}

/** Registration lines in host output: plain console text, ANSI-coloured text or JSON log records. */
export function extractRegistrationPaths(text, source) {
  const found = [];
  if (typeof text !== 'string' || !text.includes(REGISTRATION_MARKER)) return found;
  for (const raw of text.split(/\r?\n/).slice(0, MAX_REGISTRATION_LINES)) {
    if (!raw.includes(REGISTRATION_MARKER)) continue;
    const line = raw.replace(ANSI_SEQUENCE, '');
    let candidates = [line];
    const trimmed = line.trim();
    if (trimmed.startsWith('{') || trimmed.startsWith('[')) {
      try {
        const strings = [];
        collectStrings(JSON.parse(trimmed), strings);
        candidates = strings;
      } catch { /* not a JSON record: scan the text itself */ }
    }
    for (const value of candidates) {
      const match = value.match(REGISTRATION_MESSAGE);
      if (match) found.push({ source, path: match[1].trim() });
    }
  }
  return found;
}

/**
 * Which plugin copy actually registered in this round. OpenClaw passes the
 * discovered candidate's realpath'd root as `api.rootDir` (4ffdd2047d1
 * registry-api.ts / discovery.ts), and the plugin logs it from register(). Only
 * this round's process output and the bytes appended to the pinned host log
 * during the round are read. Missing, unknown, outside or conflicting sources
 * never confirm the candidate, and a presence event cannot stand in for them.
 */
export function candidateRegistrationVerdict({ sources, candidateRoot }) {
  const found = sources.flatMap((row) => extractRegistrationPaths(row.text, row.source));
  const base = {
    candidateRoot,
    lineCount: found.length,
    lines: found.slice(0, 20),
    sourcesWithLines: [...new Set(found.map((row) => row.source))],
  };
  if (found.length === 0) return { ...base, status: 'missing', reason: 'no registration line in this round\'s host output or host log delta' };
  if (found.some((row) => row.path === '' || row.path === '(unknown)')) return { ...base, status: 'unknown', reason: 'the host passed no plugin rootDir' };
  const distinct = [];
  for (const row of found) {
    if (!distinct.some((path) => isSamePath(path, row.path))) distinct.push(row.path);
  }
  if (distinct.length > 1) return { ...base, status: 'conflict', distinctPaths: distinct, reason: 'registration lines name different plugin roots' };
  const [path] = distinct;
  if (isSamePath(path, candidateRoot)) return { ...base, status: 'confirmed', relation: 'equal', path };
  if (isInsideRoot(candidateRoot, path)) return { ...base, status: 'confirmed', relation: 'inside', path };
  return { ...base, status: 'outside', path, reason: 'the registered plugin root is not the frozen candidate root' };
}

const FORBIDDEN_REASONS = new Set(['missing_expectations', 'expectations_expired', 'history_incomplete', 'ambiguous_binding', 'empty_snapshot',
  'snapshot_over_limit', 'observation_over_limit', 'unparseable_observation', 'check_failed', 'shared_field_absent', 'target_removed_by_fallback',
  'generation_failed', 'workspace_unresolved', 'missing_identity']);

/**
 * Gate one round from evidence only. The presence event carries no API field,
 * so the API path is proven by the endpoint record, never by the event. The
 * candidate is proven by its own registration source, never by the event.
 */
export function evaluatePresenceRound({ round, hostResult, endpointRecords, presenceEvents, registration, window, candidateCode }) {
  const checks = [];
  const add = (id, ok, detail, evidence = {}) => checks.push({ id, ok, detail, evidence });

  add('host-exit', hostResult.exitCode === 0 && !hostResult.timedOut && !hostResult.spawnError,
    'the host process exited 0 within the outer timeout', { exitCode: hostResult.exitCode, timedOut: hostResult.timedOut, spawnError: hostResult.spawnError });
  let envelope = null;
  try { envelope = JSON.parse(hostResult.stdout.trim()); } catch { envelope = null; }
  const hostSessionId = typeof envelope?.sessionId === 'string' && envelope.sessionId.trim().length > 0 ? envelope.sessionId : null;
  add('host-envelope', envelope?.ok === true && envelope?.status === 'ok' && typeof envelope?.final === 'string' && envelope.final.includes(PRESENCE_ANSWER),
    'agent exec --json reports ok with the endpoint answer (an empty [DONE]-only reply cannot pass)', {
      ok: envelope?.ok ?? null, status: envelope?.status ?? null, provider: envelope?.provider ?? null, model: envelope?.model ?? null, sessionId: hostSessionId,
    });

  add('candidate-registration-source', registration?.status === 'confirmed',
    'this round\'s own plugin registration line names the frozen candidate root (missing, unknown, outside or conflicting sources fail)', registration ?? { status: 'not_collected' });
  add('candidate-code-unchanged', candidateCode?.ok === true,
    'the candidate\'s entry, bundle, manifests and external dependency are still the frozen bytes after the round', candidateCode ?? { ok: false, reason: 'not_checked' });

  const served = endpointRecords.filter((row) => row.decision === 'served');
  const refused = endpointRecords.filter((row) => row.decision === 'refused');
  add('endpoint-one-request', served.length === 1 && refused.length === 0,
    'exactly one provider request reached the endpoint in this round and nothing was refused', { served: served.length, refused: refused.map((row) => row.refusal?.kind) });
  const request = served[0] ?? null;
  add('endpoint-api-path', request?.path === round.endpointPath && request?.api === round.api,
    `the request used ${round.endpointPath} (${round.api})`, { path: request?.path ?? null, api: request?.api ?? null });
  add('endpoint-fake-key', request?.authMatchesFakeKey === true, 'the request carried the frozen generated fake key, not an inherited credential');
  add('endpoint-model', request?.model === PRESENCE_MODEL_ID, `the request named ${PRESENCE_MODEL_ID}`, { model: request?.model ?? null });

  // Only events appended during this round (the caller reads the log delta),
  // for this round's provider/model, the host-reported session and the round window.
  const startMs = Date.parse(window?.startedAt ?? '');
  const endMs = Date.parse(window?.endedAt ?? '');
  const excluded = { otherProviderOrModel: 0, otherSession: 0, outsideWindow: 0 };
  const roundEvents = presenceEvents.filter((row) => {
    const eventData = row.entry?.data;
    if (eventData?.provider !== round.provider || eventData?.model !== PRESENCE_MODEL_ID) { excluded.otherProviderOrModel += 1; return false; }
    if (hostSessionId === null || eventData?.sessionId !== hostSessionId) { excluded.otherSession += 1; return false; }
    const ts = Date.parse(row.entry?.ts ?? '');
    if (!Number.isFinite(ts) || !Number.isFinite(startMs) || !Number.isFinite(endMs) || ts < startMs || ts > endMs) { excluded.outsideWindow += 1; return false; }
    return true;
  });
  add('presence-event', hostSessionId !== null && roundEvents.length === 1,
    'exactly one presence event appended during this round, for this round\'s provider/model and the host-reported session', {
      count: roundEvents.length, hostSessionId, excluded, appendedPresenceEvents: presenceEvents.length,
    });
  const data = roundEvents[0]?.entry?.data ?? null;
  add('presence-boundary', data?.boundary === 'post_assembly_system_prompt_via_llm_input', 'boundary is post_assembly_system_prompt_via_llm_input', { boundary: data?.boundary ?? null });
  add('presence-binding', data?.binding === 'unique' && data?.checked === true && (data?.reason === undefined || !FORBIDDEN_REASONS.has(data.reason)),
    'binding=unique, checked=true, no degraded reason', { binding: data?.binding ?? null, checked: data?.checked ?? null, reason: data?.reason ?? null });
  const fixtureResult = Array.isArray(data?.results) ? data.results.find((row) => row?.activationId === PRESENCE_FIXTURE.activationId) : null;
  add('presence-fixture-full-hit', fixtureResult?.outcome === 'full_hit', 'the fixture activation is a full_hit', { outcome: fixtureResult?.outcome ?? null });
  const escaped = escapeXml(PRESENCE_FIXTURE.text);
  const leaked = roundEvents.some((row) => row.line.includes(PRESENCE_FIXTURE.text) || row.line.includes(escaped));
  add('presence-no-body', roundEvents.length > 0 && !leaked, 'the event line contains neither the raw nor the escaped principle body', { leaked });
  return { round: round.id, ok: checks.every((row) => row.ok), checks };
}

async function runHostRound({ manifest, round, env }) {
  const argv = roundArgv({ manifest, round });
  const startedAt = new Date().toISOString();
  let child;
  try {
    child = spawn(manifest.node.path, argv, { cwd: manifest.paths.workspaceDir, env, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
  } catch (error) {
    return { argv, startedAt, endedAt: new Date().toISOString(), exitCode: null, signal: null, spawnError: String(error?.message ?? error), timedOut: false, stdout: '', stderr: '', killed: null };
  }
  const stdout = [];
  const stderr = [];
  child.stdout.on('data', (chunk) => stdout.push(chunk));
  child.stderr.on('data', (chunk) => stderr.push(chunk));
  let timedOut = false;
  let killed = null;
  const timer = setTimeout(() => {
    timedOut = true;
    killed = killTree(child.pid);
  }, round.outerTimeoutMs);
  // 'close' waits for every holder of the stdio pipes; if a killed host left a
  // descendant holding them, settle on 'exit' after a short grace period.
  const outcome = await new Promise((resolvePromise) => {
    let exitTimer = null;
    child.on('error', (error) => resolvePromise({ code: null, signal: null, error: String(error?.message ?? error) }));
    child.on('exit', (code, signal) => {
      exitTimer = setTimeout(() => {
        child.stdout.destroy();
        child.stderr.destroy();
        resolvePromise({ code, signal, error: null, settledOn: 'exit-grace' });
      }, 5000);
    });
    child.on('close', (code, signal) => {
      if (exitTimer) clearTimeout(exitTimer);
      resolvePromise({ code, signal, error: null, settledOn: 'close' });
    });
  });
  clearTimeout(timer);
  return {
    argv,
    pid: child.pid,
    startedAt,
    endedAt: new Date().toISOString(),
    exitCode: outcome.code,
    signal: outcome.signal,
    spawnError: outcome.error,
    settledOn: outcome.settledOn ?? null,
    timedOut,
    killed,
    stdout: Buffer.concat(stdout).toString('utf8'),
    stderr: Buffer.concat(stderr).toString('utf8'),
  };
}

function terminationCapability() {
  if (process.platform !== 'win32') return { tool: 'process.kill', available: true };
  return { tool: 'taskkill', available: spawnSync('where.exe', ['taskkill'], { windowsHide: true }).status === 0 };
}

const DEFAULT_PROBES = Object.freeze({ port: probePort, termination: terminationCapability, processSweep: findProcessesReferencing });

/** A fresh evidence file name: two runs in the same second must not collide. */
function preflightFileName(prefix) {
  return `${prefix}-${new Date().toISOString().replace(/[-:]/g, '').replace(/\.\d{3}Z$/, 'Z')}-${randomBytes(4).toString('hex')}.json`;
}

async function protocolSelftestCheck({ packRoot, manifest, requested, hostTreeVerified }) {
  if (!requested) return preflightCheck('protocol-selftest', 'NOT_RUN', 'run --verify --selftest (--execute always runs it)');
  if (!hostTreeVerified) return preflightCheck('protocol-selftest', 'NOT_RUN', 'the staged host tree is not verified, so its transports are not imported (add --full)');
  try {
    const fakeApiKey = JSON.parse(readFileSync(manifest.paths.configPath, 'utf8')).models.providers[manifest.rounds[0].provider].apiKey;
    const report = await runProtocolSelftest({
      aiPackageDir: join(manifest.host.packageDir, 'node_modules', '@openclaw', 'ai'),
      ledgerPersistPath: join(packRoot, 'preflight', preflightFileName('selftest-ledger')),
      fakeApiKey,
    });
    return preflightCheck('protocol-selftest', report.pass ? 'PASS' : 'FAIL',
      'the official transports accept both terminal responses and reject the negative controls (loopback, own ledger, not run budget)', {
        pass: report.pass,
        cases: report.cases.map(({ arm, expected, outcome, pass, errorMessage }) => ({ arm, expected, outcome, pass, errorMessage })),
        ledger: report.ledger,
      });
  } catch (error) {
    return preflightCheck('protocol-selftest', 'FAIL', 'the protocol self-test could not complete', { reason: String(error?.message ?? error) });
  }
}

/**
 * The single preflight: every check `--verify` reports and `--execute` requires.
 * Nothing here starts a host or charges the run budget.
 */
export async function preflightPack({
  packRoot, full = true, selftest = true, operatorEnv = process.env, realHome = homedir(), codeRoot = PRESENCE_CODE_ROOT, probes = {},
}) {
  const verification = await verifyPack({ packRoot, full, operatorEnv, realHome, codeRoot });
  const checks = [...verification.checks];
  if (verification.manifestSha256 !== null) {
    const probe = { ...DEFAULT_PROBES, ...probes };
    const manifest = JSON.parse(readFileSync(packLayout(packRoot).manifestPath, 'utf8'));
    const port = await probe.port(manifest.endpoint.port);
    checks.push(preflightCheck('endpoint-port', port.ok ? 'PASS' : 'FAIL',
      'the frozen loopback port could be bound and reached just now; this is not a reservation and the bind at --execute stays authoritative', port));
    const termination = probe.termination();
    checks.push(preflightCheck('termination-tool', termination.available ? 'PASS' : 'FAIL', 'the process-tree termination tool used on timeout is available', termination));
    const sweep = probe.processSweep(packRoot);
    checks.push(preflightCheck('process-sweep', sweep.ok && sweep.processes.length === 0 ? 'PASS' : 'FAIL',
      'the process query works and nothing other than the launcher and its ancestors references the pack', { queryOk: sweep.ok, reason: sweep.reason ?? null, processes: sweep.processes }));
    const hostTreeVerified = checks.some((row) => row.id === 'host-tree' && row.status === 'PASS');
    checks.push(await protocolSelftestCheck({ packRoot, manifest, requested: selftest, hostTreeVerified }));
  }
  return { ...verification, selftest, ...summarizePreflight(checks) };
}

export function validateApproval({ approval, manifestSha256, manifest }) {
  const violations = [];
  if (approval?.schemaVersion !== APPROVAL_SCHEMA) violations.push('approval schemaVersion mismatch');
  if (typeof approval?.approvedBy !== 'string' || !approval.approvedBy.trim()) violations.push('approvedBy is required');
  if (typeof approval?.approvedAt !== 'string' || !Number.isFinite(Date.parse(approval.approvedAt))) violations.push('approvedAt must be an ISO timestamp');
  if (typeof approval?.approvalEvidence !== 'string' || !approval.approvalEvidence.trim()) violations.push('approvalEvidence (where the Owner approved this exact card) is required');
  if (approval?.manifestSha256 !== manifestSha256) violations.push('approval is not bound to this manifest sha256');
  if (approval?.cardVersion !== manifest.cardVersion) violations.push('approval is not bound to this card version');
  if (!Array.isArray(approval?.rounds) || approval.rounds.join(',') !== manifest.rounds.map((round) => round.id).join(',')) violations.push('approval must name exactly the frozen rounds');
  if (!isDeepStrictEqual(approval?.budgets, manifest.budget)) violations.push('approval budgets differ from the frozen manifest budgets');
  return violations;
}

const POLLUTION_STOP_REASON = Object.freeze({
  attributed: 'pollution_attributed',
  'review-required': 'pollution_review_required',
  incomplete: 'pollution_audit_incomplete',
});

/** Read-only comparison against the pre-run baseline. Never throws; an unfinished audit reports itself as incomplete. */
function auditProduction({ baseline, manifest }) {
  try {
    const comparison = comparePollution(baseline, snapshotTargets(manifest.pollution.targets), manifest.pollution.markers);
    return { comparison, summary: classifyPollution(comparison) };
  } catch (error) {
    const incomplete = [{ id: 'pollution-audit', reason: String(error?.message ?? error) }];
    return { comparison: null, summary: classifyPollution({ attributed: [], reviewRequired: [], unattributed: [], incomplete }) };
  }
}

/**
 * The approved run. Every refusal before the first host start leaves the
 * budget untouched (no ledger file is created). Evidence is never deleted, and
 * production data is only ever read: it is never removed, rewritten or rolled back.
 */
export async function execute({
  packRoot, approvalPath, operatorEnv = process.env, realHome = homedir(), codeRoot = PRESENCE_CODE_ROOT, probes = {},
}) {
  const layout = packLayout(packRoot);
  const manifestSha256 = sha256FileSync(layout.manifestPath);
  const manifest = JSON.parse(readFileSync(layout.manifestPath, 'utf8'));
  const approval = JSON.parse(readFileSync(approvalPath, 'utf8'));
  const approvalViolations = validateApproval({ approval, manifestSha256, manifest });
  if (approvalViolations.length > 0) {
    return { status: 'refused-before-any-start', reason: 'approval', violations: approvalViolations };
  }
  if (existsSync(layout.budgetLedgerPath) || existsSync(layout.runDir)) {
    return { status: 'refused-before-any-start', reason: 'pack_already_executed', violations: ['run/ exists; budgets never reset and a pack executes once'] };
  }
  const verification = await preflightPack({ packRoot, full: true, selftest: true, operatorEnv, realHome, codeRoot, probes });
  if (!verification.ready) {
    return { status: 'refused-before-any-start', reason: 'verification', violations: verification.failing.map((row) => `${row.id}:${row.status}`), verification };
  }
  const pollutionBefore = snapshotTargets(manifest.pollution.targets);
  const baselineGaps = pollutionSnapshotGaps(pollutionBefore);
  if (baselineGaps.length > 0) {
    return { status: 'refused-before-any-start', reason: 'pollution_baseline_incomplete', violations: baselineGaps.map((row) => `${row.id}: ${row.reason}`) };
  }

  mkdirSync(join(layout.runDir, 'evidence'), { recursive: true });
  writeJson(join(layout.runDir, 'verification-before-run.json'), verification, 'wx');
  writeJson(join(layout.runDir, 'approval-used.json'), { ...approval, approvalFileSha256: sha256FileSync(approvalPath) }, 'wx');
  writeJson(join(layout.runDir, 'pollution-before.json'), pollutionBefore, 'wx');

  // The frozen budgets, not the current code constants: the approval names these.
  const ledger = createExperimentLedger({
    runId: manifest.packId,
    fixtureId: PRESENCE_FIXTURE.activationId,
    budget: manifest.budget.run,
    armBudgets: manifest.budget.rounds,
    persistPath: layout.budgetLedgerPath,
  });
  const fakeApiKey = JSON.parse(readFileSync(manifest.paths.configPath, 'utf8')).models.providers[manifest.rounds[0].provider].apiKey;
  const record = { schemaVersion: 'pd-presence-run-record/v2', packId: manifest.packId, manifestSha256, cardVersion: manifest.cardVersion, rounds: [], stoppedAt: null, stopReasons: [] };
  let endpoint = null;
  try {
    try {
      endpoint = await startPresenceEndpoint({ ledger, port: manifest.endpoint.port, fakeApiKey });
    } catch (error) {
      // The port check was not a reservation. Nothing has been started or charged.
      record.stoppedAt = 'endpoint-bind';
      record.stopReasons.push('endpoint_bind_failed');
      record.endpointBindError = String(error?.message ?? error);
    }
    for (const round of endpoint ? manifest.rounds : []) {
      const roundRecord = { id: round.id, started: false };
      record.rounds.push(roundRecord);
      // The environment is rebuilt and proven inside the pack BEFORE the host
      // start is charged: an escape refuses without spending a start.
      const env = buildRoundEnv({ layout, roundId: round.id, baseEnv: operatorEnv });
      writeJson(join(layout.runDir, 'evidence', `${round.id}.environment.json`), {
        explicit: env.resolved.env, inheritedKeys: env.inheritedFromParent, removedFromParent: env.removedFromParent, resolved: { ...env.resolved, env: undefined },
      }, 'wx');
      try {
        ledger.hostTurn(round.id, { purpose: `${round.id}-host-start` });
      } catch (error) {
        if (!(error instanceof BudgetExceededError)) throw error;
        roundRecord.refused = { counter: error.counter, scope: error.scope, cap: error.cap };
        record.stoppedAt = round.id;
        record.stopReasons.push('budget_refused');
        break;
      }
      endpoint.openRound({ arm: round.id, api: round.api });
      roundRecord.started = true;
      const eventLogsBefore = eventLogSizes(manifest.paths.workspaceDir);
      const hostLogBefore = existsSync(manifest.paths.hostLogPath) ? statSync(manifest.paths.hostLogPath).size : 0;
      const startedAt = new Date().toISOString();
      const hostResult = await runHostRound({ manifest, round, env: env.env });
      const endedAt = new Date().toISOString();
      endpoint.closeRound();
      const sweep = sweepPackProcesses(packRoot);
      writeFileSync(join(layout.runDir, 'evidence', `${round.id}.host.stdout.txt`), hostResult.stdout, { encoding: 'utf8', flag: 'wx' });
      writeFileSync(join(layout.runDir, 'evidence', `${round.id}.host.stderr.txt`), hostResult.stderr, { encoding: 'utf8', flag: 'wx' });
      const endpointRecords = endpoint.roundObservations(round.id);
      writeJson(join(layout.runDir, 'evidence', `${round.id}.endpoint.json`), endpointRecords, 'wx');
      // Candidate identity: this round's own registration lines from the host
      // process output and the bytes the host appended to its pinned log.
      const hostLogDelta = readAppended(manifest.paths.hostLogPath, hostLogBefore);
      const registration = candidateRegistrationVerdict({
        sources: [
          { source: 'host-stdout', text: hostResult.stdout },
          { source: 'host-stderr', text: hostResult.stderr },
          { source: 'host-log', text: hostLogDelta.text },
        ],
        candidateRoot: manifest.candidate.root,
      });
      writeJson(join(layout.runDir, 'evidence', `${round.id}.registration-source.json`), {
        ...registration,
        hostLogBytesRead: hostLogDelta.bytes,
        hostLogTruncated: hostLogDelta.truncated,
        hostLogShrunk: hostLogDelta.shrunk,
      }, 'wx');
      const presence = readPresenceEventsSince(manifest.paths.workspaceDir, eventLogsBefore);
      writeJson(join(layout.runDir, 'evidence', `${round.id}.presence-events.json`), {
        window: { startedAt, endedAt },
        appendedFiles: presence.files,
        events: presence.events.map((row) => ({ file: row.file, entry: row.entry })),
      }, 'wx');
      const candidateCode = candidateCodeDrift(manifest);
      writeJson(join(layout.runDir, 'evidence', `${round.id}.candidate-code.json`), candidateCode, 'wx');
      const gate = evaluatePresenceRound({
        round, hostResult, endpointRecords, presenceEvents: presence.events, registration, candidateCode,
        window: { startedAt, endedAt },
      });
      writeJson(join(layout.runDir, 'evidence', `${round.id}.gate.json`), gate, 'wx');
      const audit = auditProduction({ baseline: pollutionBefore, manifest });
      writeJson(join(layout.runDir, 'evidence', `${round.id}.pollution.json`), audit, 'wx');
      Object.assign(roundRecord, {
        argv: hostResult.argv, pid: hostResult.pid, exitCode: hostResult.exitCode, timedOut: hostResult.timedOut, killed: hostResult.killed,
        sweep, gateOk: gate.ok, failedChecks: gate.checks.filter((row) => !row.ok).map((row) => row.id), pollution: audit.summary,
      });
      const stopReasons = [!gate.ok && 'round_gate_failed', !sweep.ok && 'residual_process', audit.summary.stop && POLLUTION_STOP_REASON[audit.summary.verdict]].filter(Boolean);
      if (stopReasons.length > 0) {
        record.stoppedAt = round.id;
        record.stopReasons.push(...stopReasons);
        break;
      }
    }
  } catch (error) {
    record.error = String(error?.stack ?? error);
    record.stoppedAt ??= 'error';
    record.stopReasons.push('error');
  } finally {
    try {
      if (endpoint) await endpoint.close();
    } catch (error) {
      record.endpointCloseError = String(error?.message ?? error);
    }
    record.unexpectedOutsideRounds = endpoint ? endpoint.observations().filter((row) => row.arm === null) : [];
    record.endpointBound = endpoint !== null;
    record.endpointClosed = endpoint ? await portRefusesConnections(manifest.endpoint.port) : null;
    record.finalSweep = sweepPackProcesses(packRoot);
    record.ledger = ledger.snapshot();
    const finalAudit = auditProduction({ baseline: pollutionBefore, manifest });
    record.pollution = finalAudit.comparison;
    record.pollutionAudit = finalAudit.summary;
    if (finalAudit.summary.stop) {
      const reason = POLLUTION_STOP_REASON[finalAudit.summary.verdict];
      if (!record.stopReasons.includes(reason)) record.stopReasons.push(reason);
      record.stoppedAt ??= 'final-pollution-audit';
    }
    const allRoundsPassed = record.rounds.length === manifest.rounds.length && record.rounds.every((row) => row.gateOk === true && row.sweep?.ok === true);
    record.status = record.stoppedAt === null && allRoundsPassed && record.unexpectedOutsideRounds.length === 0
      && record.endpointClosed === true && record.finalSweep.ok && record.ledger.withinBudget && !finalAudit.summary.stop ? 'completed' : 'stopped';
    record.conclusionBound = manifest.scope;
    writeJson(join(layout.runDir, 'run-record.json'), record, 'wx');
  }
  return record;
}

export function approvalTemplate({ manifest, manifestSha256 }) {
  return {
    schemaVersion: APPROVAL_SCHEMA,
    approvedBy: '',
    approvedAt: '',
    approvalEvidence: '',
    cardVersion: manifest.cardVersion,
    manifestSha256,
    rounds: manifest.rounds.map((round) => round.id),
    budgets: manifest.budget,
    note: 'Fill approvedBy/approvedAt/approvalEvidence only after the Owner approved THIS card version and manifest sha256; save as approval.json.',
  };
}

function argValue(argv, name) {
  const index = argv.indexOf(`--${name}`);
  return index >= 0 && index + 1 < argv.length ? argv[index + 1] : null;
}

/** CLI entry. Returns the process exit code: 0 only for a READY verify or a completed execute. */
export async function main(argv = process.argv.slice(2)) {
  const repoRoot = resolve(argValue(argv, 'repo') ?? process.cwd());
  const packsRoot = resolve(argValue(argv, 'packs-root') ?? join(repoRoot, 'artifacts', 'pri-1152-isolated-host'));
  if (argv.includes('--prepare')) {
    const packId = argValue(argv, 'pack-id') ?? `pp-${new Date().toISOString().replace(/[-:]/g, '').replace(/\.\d{3}Z$/, 'Z')}`;
    const packRoot = join(packsRoot, packId);
    const appData = process.env.APPDATA;
    const hostSource = argValue(argv, 'host-source') ?? (appData ? join(appData, 'npm', 'node_modules', 'openclaw') : null);
    if (!hostSource) throw new Error('--host-source is required on this platform');
    const npmCacheDir = argValue(argv, 'npm-cache') ?? (process.env.LOCALAPPDATA ? join(process.env.LOCALAPPDATA, 'npm-cache') : null);
    const endpointPort = argValue(argv, 'endpoint-port') ? Number.parseInt(argValue(argv, 'endpoint-port'), 10) : await selectLoopbackPort();
    const source = sourceFacts(repoRoot);
    const { manifest, manifestSha256 } = await preparePack({
      repoRoot,
      packRoot,
      packId,
      hostSource,
      pluginSource: argValue(argv, 'plugin-source') ?? join(repoRoot, 'packages', 'openclaw-plugin'),
      expectedHostVersion: EXPECTED_HOST_VERSION,
      expectedHostCommit: EXPECTED_HOST_COMMIT,
      npmCacheDir,
      endpointPort,
      source,
    });
    writeJson(join(packRoot, 'approval.template.json'), approvalTemplate({ manifest, manifestSha256 }), 'wx');
    process.stdout.write(`${JSON.stringify({ packRoot, manifestSha256, cardVersion: CARD_VERSION, endpointPort, source }, null, 2)}\n`);
    return 0;
  }
  if (argv.includes('--verify')) {
    const packRoot = resolve(argValue(argv, 'pack') ?? '');
    const report = await preflightPack({ packRoot, full: argv.includes('--full'), selftest: argv.includes('--selftest') });
    const preflightDir = join(packRoot, 'preflight');
    const out = existsSync(preflightDir) ? join(preflightDir, preflightFileName('verify')) : null;
    if (out) writeJson(out, report, 'wx');
    process.stdout.write(`${JSON.stringify({ out, ready: report.ready, summary: report.summary, failing: report.failing.map((row) => `${row.id}:${row.status}`), failingDetails: report.failing.map(({ id, detail }) => ({ id, detail })) }, null, 2)}\n`);
    return report.ready ? 0 : 1;
  }
  if (argv.includes('--execute')) {
    const packRoot = resolve(argValue(argv, 'pack') ?? '');
    const approvalPath = argValue(argv, 'approval');
    if (!approvalPath) throw new Error('--approval <approval.json> is required');
    const record = await execute({ packRoot, approvalPath: resolve(approvalPath) });
    process.stdout.write(`${JSON.stringify(record, null, 2)}\n`);
    return record.status === 'completed' ? 0 : 1;
  }
  throw new Error('use --prepare, --verify or --execute');
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().then((code) => { process.exitCode = code; }, (error) => {
    process.stderr.write(`${String(error?.stack ?? error)}\n`);
    process.exitCode = 2;
  });
}
