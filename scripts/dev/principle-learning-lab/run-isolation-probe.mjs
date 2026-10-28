#!/usr/bin/env node
// SPEC-PD-EXAMINER-001 v0.4 §6.4 / PRI-1037 — real-host isolation probe runner.
// Fail-closed order: probe AUTHORIZATION gate FIRST (challenge-probe-authorization
// .mjs: status/window/frozen-hash binding/closed keys), and the transport factory
// is never invoked on any refusal — a refused round constructs zero host
// processes. Only an APPROVED, hash-bound, in-window authorization proceeds to:
// fresh study copy → createCodexHostTransport (Owner's Codex CLI, read-only
// sandbox) → runIsolationProbe(mode 'real-host') → saveProbeEvidence →
// verifyF2ProbeEvidence deep verification (host's own rollout corroboration).
// `--dry-run` executes ONLY the gate + plan printing (zero spawns, zero model
// calls) — it exists so CI can prove the refusal/ordering behavior offline.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { verifyProbeAuthorization, readProbeAuthorization } from './lib/challenge-probe-authorization.mjs';
import { runIsolationProbe, saveProbeEvidence, verifyF2ProbeEvidence } from './lib/challenge-isolation-probe.mjs';
import { createCodexHostTransport } from './lib/host-actor.mjs';
import { ZHIPU_CODING_PROVIDER, buildZhipuCodexOverrides, ensureZhipuProviderReady } from './lib/challenge-zhipu-host-provider.mjs';

const labRoot = path.dirname(fileURLToPath(import.meta.url));

function arg(name, fallback = undefined) {
  const i = process.argv.indexOf(`--${name}`);
  return i > 0 && process.argv[i + 1] && !process.argv[i + 1].startsWith('--') ? process.argv[i + 1] : fallback;
}
const studyId = arg('study', 'CEB-001');
const dryRun = process.argv.includes('--dry-run');
const studyDir = path.join(labRoot, 'challenge-studies', studyId);
const authFile = path.join(studyDir, 'probe-authorization.json');

const record = readProbeAuthorization(authFile);
let transportFactoryCalls = 0;
const verdict = verifyProbeAuthorization({ record, studyDir, now: Date.now(), transportFactoryCalls });
if (!verdict.ok) {
  console.log(JSON.stringify({ ok: false, stage: 'probe-authorization', reasons: verdict.reasons, transportFactoryCalls }, null, 2));
  process.exit(1);
}
if (dryRun) {
  console.log(JSON.stringify({ ok: true, stage: 'probe-authorization', dryRun: true, wouldExecute: { studyId, rounds: record.caps.probeRounds, model: record.targetHost.requestedModelIdentity, codexHome: record.targetHost.codexHome }, transportFactoryCalls }, null, 2));
  process.exit(0);
}

// ---- authorized real-host round (never reached without APPROVED + binding) ----
const workRoot = path.join(labRoot, '..', '..', '..', '.tmp', `pri1037-probe-${Date.now()}`);
const copyDir = path.join(workRoot, 'study');
fs.mkdirSync(copyDir, { recursive: true });
for (const entry of fs.readdirSync(studyDir)) {
  fs.cpSync(path.join(studyDir, entry), path.join(copyDir, entry), { recursive: true });
}
const scratchRoot = path.join(workRoot, 'scratch');
fs.mkdirSync(scratchRoot, { recursive: true });
const roundsRoot = path.join(workRoot, 'rounds');
fs.mkdirSync(roundsRoot, { recursive: true });
const windowStart = Date.now();

// Side-effect scanner (filesystem-level, honest scope): gold hex runs under the
// scratch root AND the per-round dirs (S5 P1-3: every controlled path this run
// creates is scanned), writes into production PD roots, and new files inside
// the repo working tree during the probe window. Cleanup policy: workRoot
// lives under the gitignored .tmp tree and is the caller's own artifact —
// removable after evidence acceptance; runtime trajectories under openclawHome
// / codex rollouts are RESEARCH EVIDENCE and are never touched by cleanup.
const judgeOnlyFile = path.join(copyDir, 'judge-only', `${JSON.parse(fs.readFileSync(path.join(copyDir, 'suite-manifest.json'), 'utf8')).cases[0].caseId}.json`);
const goldHexRuns = (JSON.parse(fs.readFileSync(judgeOnlyFile, 'utf8')).toString().match(/[0-9a-f]{32,}/g) || []);
const scanForGold = (root) => {
  let hits = 0;
  if (!fs.existsSync(root)) return hits;
  const walk = (dir, fn) => { for (const f of fs.readdirSync(dir, { withFileTypes: true })) { const p = path.join(dir, f.name); if (f.isDirectory()) walk(p, fn); else fn(p); } };
  walk(root, (p) => { try { const t = fs.readFileSync(p, 'utf8'); if (goldHexRuns.some((run) => t.includes(run))) hits += 1; } catch { /* binary/unreadable — not a leak signal */ } });
  return hits;
};
// S5.1 §五: the ONLY files the probe itself creates in a round dir. Anything
// else appearing there during the window is an unauthorized extra write and
// fails the side-effect scan (the runtime may also write host-internal state
// under openclawHome — that is evidence territory, audited separately, never
// cleaned).
const ROUND_DIR_ALLOWLIST = new Set(['AGENTS.md', 'probe-message.txt']);
const scanner = () => {
  let crossGroupLeakage = 0;
  let productionWrites = 0;
  let externalSideEffects = 0;
  let unauthorizedExtraWrites = 0;
  const extraSamples = [];
  crossGroupLeakage += scanForGold(scratchRoot);
  crossGroupLeakage += scanForGold(roundsRoot); // S5 P1-3: probe-round dirs are controlled paths — scanned, not exempt
  if (fs.existsSync(roundsRoot)) {
    for (const round of fs.readdirSync(roundsRoot, { withFileTypes: true })) {
      if (!round.isDirectory()) continue;
      const roundDir = path.join(roundsRoot, round.name);
      for (const f of fs.readdirSync(roundDir)) {
        if (!ROUND_DIR_ALLOWLIST.has(f)) {
          unauthorizedExtraWrites += 1;
          if (extraSamples.length < 5) extraSamples.push(path.join(round.name, f));
        }
      }
    }
  }
  const walk = (dir, fn) => { for (const f of fs.readdirSync(dir, { withFileTypes: true })) { const p = path.join(dir, f.name); if (f.isDirectory()) walk(p, fn); else fn(p); } };
  for (const pdRoot of [path.join(os.homedir(), '.pd'), path.join(labRoot, '..', '..', '..', '..', '.pd')]) {
    if (!fs.existsSync(pdRoot)) continue;
    walk(pdRoot, (p) => { const st = fs.statSync(p); if (st.mtimeMs >= windowStart) productionWrites += 1; });
  }
  walk(workRoot, (p) => { const st = fs.statSync(p); if (st.mtimeMs >= windowStart && !p.startsWith(scratchRoot) && !p.startsWith(copyDir) && !p.startsWith(roundsRoot)) externalSideEffects += 1; });
  const clean = unauthorizedExtraWrites === 0;
  return { crossGroupLeakage, productionWrites, externalSideEffects, unauthorizedExtraWrites, extraSamples, controlledPathsScanned: [scratchRoot, roundsRoot], roundDirAllowlist: [...ROUND_DIR_ALLOWLIST].sort(), scopeNote: 'scratch+rounds gold-hex scan + round-dir allowlist + PD roots mtime window + workdir non-controlled writes; not a whole-disk claim', ...(clean ? {} : { nonCleanReason: 'files outside the round-dir allowlist appeared during the probe window' }) };
};

// ---- host dispatch (Owner S4): the authorization's targetHost.kind selects
// the adapter; both paths share the { complete, hostSnapshot } contract the
// probe engine consumes, and both evidence readers enforce runtime-corroboration.
let transport = null;
let evidenceDispatch = null;
if (record.targetHost.kind === 'openclaw') {
  const { createOpenClawHostTransport, readOpenClawTrajectoryEvidence } = await import('./lib/challenge-openclaw-host.mjs');
  // S5 P1-2: the approved provider comes from the authorization record (NOT
  // inferred from the model id string) and is enforced on every round.
  const expectedProvider = record.targetHost.provider;
  if (typeof expectedProvider !== 'string' || expectedProvider.length === 0) {
    console.log(JSON.stringify({ ok: false, stage: 'provider', reasons: ["authorization targetHost.provider missing — the approved provider must be declared (S5 P1-2)"] }, null, 2));
    process.exit(1);
  }
  transport = createOpenClawHostTransport({
    model: record.targetHost.requestedModelIdentity,
    expectedProvider,
    roundsRoot,
    timeoutMsPerCall: record.caps.timeoutMsPerCall,
  });
  const sessionsDir = path.join(record.targetHost.openclawHome, 'agents', record.targetHost.openclawAgent || 'main', 'sessions');
  evidenceDispatch = {
    hostKind: 'openclaw',
    openclawSessionsDir: sessionsDir,
    openclawTrustedRoot: sessionsDir,
    openclawExpectedProvider: expectedProvider,
    openclawExpectedModel: record.targetHost.requestedModelIdentity, // S5.1 §四: deep verification binds the AUTHORIZED model
    readOpenClawTrajectory: readOpenClawTrajectoryEvidence,
  };
} else {
  // codex-cli route: the Zhipu per-spawn adapter (merged to main via #2204).
  // The provider binding still comes from the authorization record — never a
  // silent fallback to the OpenAI-default host model.
  const zhipu = await import('./lib/challenge-zhipu-host-provider.mjs');
  if (record.targetHost.provider !== 'zhipu-coding') {
    console.log(JSON.stringify({ ok: false, stage: 'provider', reasons: [`kind 'codex-cli' requires provider 'zhipu-coding' (the approved Zhipu channel); got '${String(record.targetHost.provider)}'`] }, null, 2));
    process.exit(1);
  }
  const providerReady = zhipu.ensureZhipuProviderReady();
  if (!providerReady.ready) {
    console.log(JSON.stringify({ ok: false, stage: 'provider-credential', reasons: [providerReady.reason], transportFactoryCalls }, null, 2));
    process.exit(1);
  }
  console.log(JSON.stringify({ stage: 'provider', provider: 'zhipu-coding', credentialSource: providerReady.source }, null, 2));
  transport = createCodexHostTransport({
    model: record.targetHost.requestedModelIdentity,
    scratchRoot,
    codexHome: record.targetHost.codexHome,
    timeoutMsPerCall: record.caps.timeoutMsPerCall,
    threadSource: 'pri-1037-probe',
    rolloutReadback: true,
    extraArgs: zhipu.buildZhipuCodexOverrides(),
  });
  evidenceDispatch = { hostKind: 'codex-cli', codexHome: record.targetHost.codexHome };
}
transportFactoryCalls += 1;

const probeRecord = await runIsolationProbe({ studyDir: copyDir, hostTransport: transport, mode: 'real-host', now: Date.now(), sideEffectScanner: scanner });
const evidenceRef = saveProbeEvidence(copyDir, probeRecord);
const deep = verifyF2ProbeEvidence({ studyDir: copyDir, evidenceRef, expected: { studyId, suiteHash: record.frozenHashes.suiteHash }, ...evidenceDispatch });
console.log(JSON.stringify({ ok: deep.ok && probeRecord.status === 'PASSED', probeStatus: probeRecord.status, evidenceRef, deepVerification: deep, workRoot }, null, 2));
process.exit(deep.ok && probeRecord.status === 'PASSED' ? 0 : 1);
