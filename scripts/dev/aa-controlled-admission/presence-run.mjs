// PRI-1152 Path A isolated-host run — launcher.
//
//   --prepare   freeze a NEW execution pack (stages the official host copy, the
//               candidate plugin, the fixture, configs, inputs; writes
//               manifest.json, run-card.md and approval.template.json). Starts
//               no host and sends no request.
//   --verify    offline re-verification of a frozen pack; `--full` re-hashes the
//               staged host tree; `--selftest` runs the accounted loopback
//               protocol self-test against the staged official transports.
//   --execute   the approved run ONLY: requires an approval file bound to the
//               manifest sha256 and card version. Re-verifies everything, then
//               runs R1 and — only if R1 passed — R2, each as ONE host start with
//               ONE provider request, under the shared fail-closed ledger.
//
// Budget semantics: reaching a cap is not over budget; the NEXT attempt is
// refused before it is issued (host start: before spawn; provider HTTP: before
// the body is read). A failed host start is still charged. No retry, no
// fallback, no second execute of the same pack (the ledger file is never reset).

import { spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { connect } from 'node:net';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { BudgetExceededError, createExperimentLedger } from './lib/ledger.mjs';
import { selectLoopbackPort } from './lib/host-config.mjs';
import { startPresenceEndpoint, PRESENCE_ANSWER } from './lib/presence-endpoint.mjs';
import { PRESENCE_MODEL_ID, PRESENCE_ROUND_BUDGETS, PRESENCE_RUN_BUDGET } from './lib/presence-config.mjs';
import { PRESENCE_FIXTURE } from './lib/presence-fixture.mjs';
import { runProtocolSelftest } from './lib/protocol-selftest.mjs';
import {
  CARD_VERSION, PRESENCE_EVENT_TYPE, buildRoundEnv, comparePollution, packLayout, preparePack, roundArgv,
  sha256FileSync, snapshotTargets, verifyPack,
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

/** Bind the frozen port briefly and connect over raw TCP (no HTTP request). */
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

/** Processes whose command line references `fragment` (the pack root). */
export function findProcessesReferencing(fragment) {
  if (process.platform === 'win32') {
    const escaped = fragment.replaceAll("'", "''");
    // $PID excludes this PowerShell query itself (its own command line contains the fragment).
    const script = `Get-CimInstance Win32_Process | Where-Object { $_.ProcessId -ne $PID -and $_.CommandLine -and $_.CommandLine.Contains('${escaped}') } | Select-Object ProcessId,ParentProcessId,Name | ConvertTo-Json -Compress`;
    const result = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], { encoding: 'utf8', windowsHide: true, timeout: 30_000 });
    if (result.status !== 0) return { ok: false, reason: (result.stderr || '').slice(0, 300), processes: [] };
    const text = (result.stdout || '').trim();
    if (!text) return { ok: true, processes: [] };
    const parsed = JSON.parse(text);
    const rows = Array.isArray(parsed) ? parsed : [parsed];
    return { ok: true, processes: rows.map((row) => ({ pid: row.ProcessId, ppid: row.ParentProcessId, name: row.Name })).filter((row) => row.pid !== process.pid) };
  }
  const result = spawnSync('ps', ['-eo', 'pid=,ppid=,args='], { encoding: 'utf8', timeout: 30_000 });
  if (result.status !== 0) return { ok: false, reason: 'ps failed', processes: [] };
  const processes = [];
  for (const line of result.stdout.split('\n')) {
    const match = line.trim().match(/^(\d+)\s+(\d+)\s+(.*)$/);
    if (match && match[3].includes(fragment) && Number(match[1]) !== process.pid) processes.push({ pid: Number(match[1]), ppid: Number(match[2]), name: match[3].slice(0, 80) });
  }
  return { ok: true, processes };
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

function readPresenceEvents(workspaceDir) {
  const logsDir = join(workspaceDir, '.state', 'logs');
  const events = [];
  const files = [];
  if (!existsSync(logsDir)) return { logsDir, files, events };
  for (const name of readdirSync(logsDir).filter((file) => file.startsWith('events_') && file.endsWith('.jsonl')).sort()) {
    files.push(name);
    for (const line of readFileSync(join(logsDir, name), 'utf8').split('\n')) {
      if (!line.trim()) continue;
      try {
        const entry = JSON.parse(line);
        if (entry?.type === PRESENCE_EVENT_TYPE) events.push({ file: name, line, entry });
      } catch { /* a torn line is not an event */ }
    }
  }
  return { logsDir, files, events };
}

const FORBIDDEN_REASONS = new Set(['missing_expectations', 'expectations_expired', 'history_incomplete', 'ambiguous_binding', 'empty_snapshot',
  'snapshot_over_limit', 'observation_over_limit', 'unparseable_observation', 'check_failed', 'shared_field_absent', 'target_removed_by_fallback',
  'generation_failed', 'workspace_unresolved', 'missing_identity']);

/**
 * Gate one round from evidence only. The presence event carries no API field,
 * so the API path is proven by the endpoint record, never by the event.
 */
export function evaluatePresenceRound({ round, hostResult, endpointRecords, presenceEvents }) {
  const checks = [];
  const add = (id, ok, detail, evidence = {}) => checks.push({ id, ok, detail, evidence });

  add('host-exit', hostResult.exitCode === 0 && !hostResult.timedOut && !hostResult.spawnError,
    'the host process exited 0 within the outer timeout', { exitCode: hostResult.exitCode, timedOut: hostResult.timedOut, spawnError: hostResult.spawnError });
  let envelope = null;
  try { envelope = JSON.parse(hostResult.stdout.trim()); } catch { envelope = null; }
  add('host-envelope', envelope?.ok === true && envelope?.status === 'ok' && typeof envelope?.final === 'string' && envelope.final.includes(PRESENCE_ANSWER),
    'agent exec --json reports ok with the endpoint answer (an empty [DONE]-only reply cannot pass)', { ok: envelope?.ok ?? null, status: envelope?.status ?? null, provider: envelope?.provider ?? null, model: envelope?.model ?? null });

  const served = endpointRecords.filter((row) => row.decision === 'served');
  const refused = endpointRecords.filter((row) => row.decision === 'refused');
  add('endpoint-one-request', served.length === 1 && refused.length === 0,
    'exactly one provider request reached the endpoint in this round and nothing was refused', { served: served.length, refused: refused.map((row) => row.refusal?.kind) });
  const request = served[0] ?? null;
  add('endpoint-api-path', request?.path === round.endpointPath && request?.api === round.api,
    `the request used ${round.endpointPath} (${round.api})`, { path: request?.path ?? null, api: request?.api ?? null });
  add('endpoint-fake-key', request?.authMatchesFakeKey === true, 'the request carried the frozen generated fake key, not an inherited credential');
  add('endpoint-model', request?.model === PRESENCE_MODEL_ID, `the request named ${PRESENCE_MODEL_ID}`, { model: request?.model ?? null });

  const roundEvents = presenceEvents.filter((row) => row.entry?.data?.provider === round.provider && row.entry?.data?.model === PRESENCE_MODEL_ID);
  add('presence-event', roundEvents.length === 1, 'exactly one presence event for this round reached the isolated workspace log (also the candidate-loaded proof)', { count: roundEvents.length });
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

export function validateApproval({ approval, manifestSha256, manifest }) {
  const violations = [];
  if (approval?.schemaVersion !== APPROVAL_SCHEMA) violations.push('approval schemaVersion mismatch');
  if (typeof approval?.approvedBy !== 'string' || !approval.approvedBy.trim()) violations.push('approvedBy is required');
  if (typeof approval?.approvedAt !== 'string' || !Number.isFinite(Date.parse(approval.approvedAt))) violations.push('approvedAt must be an ISO timestamp');
  if (typeof approval?.approvalEvidence !== 'string' || !approval.approvalEvidence.trim()) violations.push('approvalEvidence (where the Owner approved this exact card) is required');
  if (approval?.manifestSha256 !== manifestSha256) violations.push('approval is not bound to this manifest sha256');
  if (approval?.cardVersion !== manifest.cardVersion) violations.push('approval is not bound to this card version');
  if (!Array.isArray(approval?.rounds) || approval.rounds.join(',') !== manifest.rounds.map((round) => round.id).join(',')) violations.push('approval must name exactly the frozen rounds');
  return violations;
}

/**
 * The approved run. Every refusal before the first host start leaves the
 * budget untouched (no ledger file is created). Evidence is never deleted.
 */
export async function execute({ packRoot, approvalPath, operatorEnv = process.env, realHome = homedir() }) {
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
  const verification = await verifyPack({ packRoot, full: true, operatorEnv, realHome });
  if (!verification.ready) {
    return { status: 'refused-before-any-start', reason: 'verification', violations: verification.checks.filter((row) => row.status !== 'PASS').map((row) => `${row.id}:${row.status}`), verification };
  }

  mkdirSync(join(layout.runDir, 'evidence'), { recursive: true });
  writeJson(join(layout.runDir, 'verification-before-run.json'), verification, 'wx');
  writeJson(join(layout.runDir, 'approval-used.json'), { ...approval, approvalFileSha256: sha256FileSync(approvalPath) }, 'wx');
  const pollutionBefore = snapshotTargets(manifest.pollution.targets);
  writeJson(join(layout.runDir, 'pollution-before.json'), pollutionBefore, 'wx');

  const ledger = createExperimentLedger({
    runId: manifest.packId,
    fixtureId: PRESENCE_FIXTURE.activationId,
    budget: PRESENCE_RUN_BUDGET,
    armBudgets: PRESENCE_ROUND_BUDGETS,
    persistPath: layout.budgetLedgerPath,
  });
  const fakeApiKey = JSON.parse(readFileSync(manifest.paths.configPath, 'utf8')).models.providers[manifest.rounds[0].provider].apiKey;
  const record = { schemaVersion: 'pd-presence-run-record/v1', packId: manifest.packId, manifestSha256, cardVersion: manifest.cardVersion, rounds: [], stoppedAt: null };
  let endpoint = null;
  try {
    endpoint = await startPresenceEndpoint({ ledger, port: manifest.endpoint.port, fakeApiKey });
    for (const round of manifest.rounds) {
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
        break;
      }
      endpoint.openRound({ arm: round.id, api: round.api });
      roundRecord.started = true;
      const hostResult = await runHostRound({ manifest, round, env: env.env });
      endpoint.closeRound();
      const sweep = sweepPackProcesses(packRoot);
      writeFileSync(join(layout.runDir, 'evidence', `${round.id}.host.stdout.txt`), hostResult.stdout, { encoding: 'utf8', flag: 'wx' });
      writeFileSync(join(layout.runDir, 'evidence', `${round.id}.host.stderr.txt`), hostResult.stderr, { encoding: 'utf8', flag: 'wx' });
      const endpointRecords = endpoint.roundObservations(round.id);
      writeJson(join(layout.runDir, 'evidence', `${round.id}.endpoint.json`), endpointRecords, 'wx');
      const presence = readPresenceEvents(manifest.paths.workspaceDir);
      writeJson(join(layout.runDir, 'evidence', `${round.id}.presence-events.json`), presence.events.map((row) => ({ file: row.file, entry: row.entry })), 'wx');
      const gate = evaluatePresenceRound({ round, hostResult, endpointRecords, presenceEvents: presence.events });
      writeJson(join(layout.runDir, 'evidence', `${round.id}.gate.json`), gate, 'wx');
      Object.assign(roundRecord, {
        argv: hostResult.argv, pid: hostResult.pid, exitCode: hostResult.exitCode, timedOut: hostResult.timedOut, killed: hostResult.killed,
        sweep, gateOk: gate.ok, failedChecks: gate.checks.filter((row) => !row.ok).map((row) => row.id),
      });
      if (!gate.ok || !sweep.ok) {
        record.stoppedAt = round.id;
        break;
      }
    }
  } catch (error) {
    record.error = String(error?.stack ?? error);
    record.stoppedAt ??= 'error';
  } finally {
    if (endpoint) await endpoint.close();
    record.unexpectedOutsideRounds = endpoint ? endpoint.observations().filter((row) => row.arm === null) : [];
    record.endpointClosed = await portRefusesConnections(manifest.endpoint.port);
    record.finalSweep = sweepPackProcesses(packRoot);
    record.ledger = ledger.snapshot();
    record.pollution = comparePollution(pollutionBefore, snapshotTargets(manifest.pollution.targets), manifest.pollution.markers);
    const allRoundsPassed = record.rounds.length === manifest.rounds.length && record.rounds.every((row) => row.gateOk === true && row.sweep?.ok === true);
    record.status = record.stoppedAt === null && allRoundsPassed && record.unexpectedOutsideRounds.length === 0
      && record.endpointClosed && record.finalSweep.ok && record.ledger.withinBudget ? 'completed' : 'stopped';
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

async function main() {
  const argv = process.argv.slice(2);
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
    return;
  }
  if (argv.includes('--verify')) {
    const packRoot = resolve(argValue(argv, 'pack') ?? '');
    const report = await verifyPack({ packRoot, full: argv.includes('--full') });
    report.portProbe = await probePort(JSON.parse(readFileSync(join(packRoot, 'manifest.json'), 'utf8')).endpoint.port);
    report.termination = process.platform === 'win32'
      ? { tool: 'taskkill', available: spawnSync('where.exe', ['taskkill'], { windowsHide: true }).status === 0 }
      : { tool: 'kill', available: true };
    report.processSweepAvailable = findProcessesReferencing(packRoot).ok;
    if (argv.includes('--selftest')) {
      const manifest = JSON.parse(readFileSync(join(packRoot, 'manifest.json'), 'utf8'));
      const fakeApiKey = JSON.parse(readFileSync(manifest.paths.configPath, 'utf8')).models.providers[manifest.rounds[0].provider].apiKey;
      const stamp = new Date().toISOString().replace(/[-:]/g, '').replace(/\.\d{3}Z$/, 'Z');
      report.protocolSelftest = await runProtocolSelftest({
        aiPackageDir: join(manifest.host.packageDir, 'node_modules', '@openclaw', 'ai'),
        ledgerPersistPath: join(packRoot, 'preflight', `selftest-ledger-${stamp}.json`),
        fakeApiKey,
      });
    }
    report.pollutionBaseline = snapshotTargets(JSON.parse(readFileSync(join(packRoot, 'manifest.json'), 'utf8')).pollution.targets)
      .map((row) => ({ id: row.id, class: row.class, exists: row.exists, sha256: row.sha256 ?? null, files: row.files?.length ?? undefined }));
    const out = join(packRoot, 'preflight', `verify-${new Date().toISOString().replace(/[-:]/g, '').replace(/\.\d{3}Z$/, 'Z')}.json`);
    writeJson(out, report, 'wx');
    process.stdout.write(`${JSON.stringify({ out, ready: report.ready, summary: report.summary, failing: report.checks.filter((row) => row.status !== 'PASS').map((row) => `${row.id}:${row.status}`), selftestPass: report.protocolSelftest?.pass ?? null, portProbe: report.portProbe }, null, 2)}\n`);
    process.exitCode = report.ready ? 0 : 1;
    return;
  }
  if (argv.includes('--execute')) {
    const packRoot = resolve(argValue(argv, 'pack') ?? '');
    const approvalPath = argValue(argv, 'approval');
    if (!approvalPath) throw new Error('--approval <approval.json> is required');
    const record = await execute({ packRoot, approvalPath: resolve(approvalPath) });
    process.stdout.write(`${JSON.stringify(record, null, 2)}\n`);
    process.exitCode = record.status === 'completed' ? 0 : 1;
    return;
  }
  throw new Error('use --prepare, --verify or --execute');
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    process.stderr.write(`${String(error?.stack ?? error)}\n`);
    process.exitCode = 2;
  });
}
