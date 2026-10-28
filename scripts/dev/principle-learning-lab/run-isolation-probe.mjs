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
const windowStart = Date.now();

// Side-effect scanner (filesystem-level, honest scope): gold hex runs under the
// scratch root (cross-group leakage proxy), writes into production PD roots,
// and new files inside the repo working tree during the probe window.
const judgeOnlyFile = path.join(copyDir, 'judge-only', `${JSON.parse(fs.readFileSync(path.join(copyDir, 'suite-manifest.json'), 'utf8')).cases[0].caseId}.json`);
const goldHexRuns = (JSON.parse(fs.readFileSync(judgeOnlyFile, 'utf8')).toString().match(/[0-9a-f]{32,}/g) || []);
const scanner = () => {
  let crossGroupLeakage = 0;
  let productionWrites = 0;
  let externalSideEffects = 0;
  const walk = (dir, fn) => { for (const f of fs.readdirSync(dir, { withFileTypes: true })) { const p = path.join(dir, f.name); if (f.isDirectory()) walk(p, fn); else fn(p); } };
  walk(scratchRoot, (p) => { try { const t = fs.readFileSync(p, 'utf8'); if (goldHexRuns.some((run) => t.includes(run))) crossGroupLeakage += 1; } catch { /* binary/unreadable — not a leak signal */ } });
  for (const pdRoot of [path.join(os.homedir(), '.pd'), path.join(labRoot, '..', '..', '..', '..', '.pd')]) {
    if (!fs.existsSync(pdRoot)) continue;
    walk(pdRoot, (p) => { const st = fs.statSync(p); if (st.mtimeMs >= windowStart) productionWrites += 1; });
  }
  walk(workRoot, (p) => { const st = fs.statSync(p); if (st.mtimeMs >= windowStart && !p.startsWith(scratchRoot) && !p.startsWith(copyDir)) externalSideEffects += 1; });
  return { crossGroupLeakage, productionWrites, externalSideEffects, scopeNote: 'scratch-root hex scan + PD roots mtime window + workdir non-scratch writes; not a whole-disk claim' };
};

// ---- zhipu provider gate: fail-closed BEFORE transport construction ----
// (key resolved from the approved F1 source; value never printed. The codex
//  child inherits process.env and resolves env_key itself.)
if (record.targetHost.provider !== ZHIPU_CODING_PROVIDER.id) {
  console.log(JSON.stringify({ ok: false, stage: 'provider', reasons: [`targetHost.provider '${String(record.targetHost.provider)}' has no adapter — only '${ZHIPU_CODING_PROVIDER.id}' is approved`] }, null, 2));
  process.exit(1);
}
const providerReady = ensureZhipuProviderReady();
if (!providerReady.ready) {
  console.log(JSON.stringify({ ok: false, stage: 'provider-credential', reasons: [providerReady.reason], transportFactoryCalls }, null, 2));
  process.exit(1);
}
console.log(JSON.stringify({ stage: 'provider', provider: ZHIPU_CODING_PROVIDER.id, model: ZHIPU_CODING_PROVIDER.modelId, credentialSource: providerReady.source }, null, 2));

const transport = createCodexHostTransport({
  model: ZHIPU_CODING_PROVIDER.modelId,
  scratchRoot,
  codexHome: record.targetHost.codexHome,
  timeoutMsPerCall: record.caps.timeoutMsPerCall,
  threadSource: 'pri-1037-probe',
  rolloutReadback: true,
  extraArgs: buildZhipuCodexOverrides(),
});
transportFactoryCalls += 1;

const probeRecord = await runIsolationProbe({ studyDir: copyDir, hostTransport: transport, mode: 'real-host', now: Date.now(), sideEffectScanner: scanner });
const evidenceRef = saveProbeEvidence(copyDir, probeRecord);
const deep = verifyF2ProbeEvidence({ studyDir: copyDir, evidenceRef, expected: { studyId, suiteHash: record.frozenHashes.suiteHash }, codexHome: record.targetHost.codexHome });
console.log(JSON.stringify({ ok: deep.ok && probeRecord.status === 'PASSED', probeStatus: probeRecord.status, evidenceRef, deepVerification: deep, workRoot }, null, 2));
process.exit(deep.ok && probeRecord.status === 'PASSED' ? 0 : 1);
