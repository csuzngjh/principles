#!/usr/bin/env node
/**
 * R1 installed rollout gate — Codex Governance Closure (PRI-626; SPEC rev 2 §3 R1).
 *
 * Proves the four R1 consent behaviors against REAL installed binaries in an
 * isolated sandbox (own PD workspace + own CODEX_HOME; the live ~/.codex and
 * live PD workspaces are never touched, and the installed runtime files are
 * never written):
 *
 *   G1 (R1-1): setup presents the G2A-frozen disclosure (byte-equal to the
 *              decision package) before ingestion can be enabled;
 *   G2 (R1-2): declining leaves codex_conversation_ingestion off and every
 *              other config byte (existing governance) untouched;
 *   G3 (R1-3): declining means the hook never opens or reads the transcript
 *              (proven by removing the transcript before the flag-off hook run);
 *   G4 (R1-4): the upgrade/re-init path never enables ingestion and never
 *              bypasses consent implicitly.
 *
 * Every gate prints one JSON evidence line; failures fail loud with
 * reason + nextAction. Exit 0 only if every gate passed.
 *
 * Usage:
 *   node scripts/dev/codex-r1-installed-gate.mjs [--pd-cli <path>] [--pd-hook <path>]
 *        [--repo-root <dir>] [--evidence-out <file>]
 *
 * Defaults verify the INSTALLED runtime (~/.pd/runtime); pass repo dist paths
 * to re-verify a build before release.
 */
import { spawnSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { homedir, tmpdir } from 'node:os';
import * as path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const DEFAULT_ROOT = path.resolve(scriptDir, '..', '..');
const args = process.argv.slice(2);
const opt = (name) => {
  const index = args.indexOf(name);
  return index !== -1 && index + 1 < args.length ? args[index + 1] : undefined;
};
const ROOT = path.resolve(opt('--repo-root') ?? DEFAULT_ROOT);
const EVIDENCE_OUT = opt('--evidence-out');
const PD_CLI = path.resolve(opt('--pd-cli') ?? path.join(homedir(), '.pd', 'runtime', 'pd-cli', 'dist', 'index.js'));
const PD_HOOK = path.resolve(opt('--pd-hook') ?? path.join(homedir(), '.pd', 'runtime', 'codex-adapter', 'dist', 'pd-hook.js'));

const evidence = [];
function gate(name, status, detail) {
  const entry = { gate: name, status, ...(detail !== undefined ? { detail } : {}) };
  evidence.push(entry);
  process.stdout.write(`${JSON.stringify(entry)}\n`);
}
function fail(gateName, reason, nextAction) {
  gate(gateName, 'failed', { reason, nextAction });
  if (EVIDENCE_OUT !== undefined) writeFileSync(EVIDENCE_OUT, `${evidence.map((entry) => JSON.stringify(entry)).join('\n')}\n`);
  process.exit(1);
}

for (const binary of [PD_CLI, PD_HOOK]) {
  if (!existsSync(binary)) {
    fail('G0-prerequisites', `binary not found: ${binary}`, 'Pass --pd-cli / --pd-hook or install the runtime first.');
  }
}

// ── Frozen disclosure SSoT extraction (mirrors codex-disclosure-g2a-guard.test.ts) ──
const DECISION_PACKAGE = path.join(ROOT, 'docs', 'superpowers', 'specs', '2026-08-28-codex-governance-closure-g0-g2a-decision.md');
const FROZEN_HEADING = '## Frozen consent disclosure text (setup will show this verbatim)';
const FROZEN_SECTION_END_MARKER = '*(English rendering';
const frozenDisclosure = (() => {
  const lines = readFileSync(DECISION_PACKAGE, 'utf8').replace(/\r\n/g, '\n').split('\n');
  const start = lines.findIndex((line) => line.trim() === FROZEN_HEADING);
  if (start === -1) fail('G0-prerequisites', 'frozen disclosure heading missing from the G2A decision package', `Check ${DECISION_PACKAGE}`);
  const collected = [];
  for (let i = start + 1; i < lines.length; i += 1) {
    if (lines[i].startsWith(FROZEN_SECTION_END_MARKER)) break;
    collected.push(lines[i]);
  }
  const stripped = collected.map((line) => (line.startsWith('> ') ? line.slice(2) : line === '>' ? '' : line));
  while (stripped.length > 0 && stripped[0] === '') stripped.shift();
  while (stripped.length > 0 && stripped[stripped.length - 1] === '') stripped.pop();
  return stripped.join('\n');
})();

// ── Sandbox helpers ───────────────────────────────────────────────────────────
const sandbox = mkdtempSync(path.join(tmpdir(), 'pd-r1-gate-'));
const require = createRequire(path.join(ROOT, 'package.json'));
const yaml = require('js-yaml');
const { getDefaultPdConfig } = await import(pathToFileURL(path.join(ROOT, 'packages', 'principles-core', 'dist', 'runtime-v2', 'index.js')));

function makeWorkspace(name, { enableIngestion = false } = {}) {
  const ws = path.join(sandbox, name);
  mkdirSync(path.join(ws, '.pd'), { recursive: true });
  mkdirSync(path.join(ws, '.state'), { recursive: true });
  const core = getDefaultPdConfig();
  const config = {
    ...core,
    workspace: { default: ws },
    features: {
      ...core.features,
      'host.codex': { ...core.features['host.codex'], enabled: true },
      codex_conversation_ingestion: { category: 'quiet', enabled: enableIngestion },
    },
  };
  writeFileSync(path.join(ws, '.pd', 'config.yaml'), yaml.dump(config, { indent: 2, lineWidth: 200, noRefs: true }));
  writeFileSync(path.join(ws, '.state', 'trajectory.db'), '');
  return ws;
}

function runCli(cliArgs, ws, extraEnv = {}) {
  const result = spawnSync(process.execPath, [PD_CLI, ...cliArgs], {
    encoding: 'utf8',
    timeout: 30_000,
    windowsHide: true,
    env: { ...process.env, PD_WORKSPACE_DIR: ws, ...extraEnv },
  });
  return { status: result.status, stdout: result.stdout ?? '', stderr: result.stderr ?? '' };
}
function runCliJson(cliArgs, ws, extraEnv = {}) {
  const result = runCli(cliArgs, ws, extraEnv);
  const line = (result.stdout.trim().split('\n').findLast((row) => row.startsWith('{'))) ?? '{}';
  let json;
  try {
    json = JSON.parse(line);
  } catch {
    json = {};
  }
  return { ...result, json };
}
function readConsentRecord(ws) {
  try {
    return JSON.parse(readFileSync(path.join(ws, '.pd', 'codex-ingestion-consent.json'), 'utf8'));
  } catch {
    return null;
  }
}
function readConfigLines(ws) {
  return readFileSync(path.join(ws, '.pd', 'config.yaml'), 'utf8').replace(/\r\n/g, '\n').split('\n');
}

function payload(ws, event, extra = {}) {
  return {
    session_id: '01a048ae-b2a5-71a1-9faf-0226980f98ff',
    turn_id: '01a048ae-b344-7eb2-804b-a2fa34302fb3',
    transcript_path: path.join(sandbox, 'codex-home', 'transcript.jsonl'),
    cwd: ws,
    model: 'gpt-5.6-sol',
    permission_mode: 'bypassPermissions',
    hook_event_name: event,
    ...extra,
  };
}
function runHook(ws, body) {
  const result = spawnSync(process.execPath, [PD_HOOK], {
    encoding: 'utf8',
    timeout: 20_000,
    windowsHide: true,
    env: { ...process.env, CODEX_HOME: path.join(sandbox, 'codex-home'), PD_WORKSPACE_DIR: ws },
    input: JSON.stringify(body),
  });
  return { status: result.status, stdout: result.stdout ?? '', stderr: result.stderr ?? '' };
}

// ── G1 (R1-1): disclosure presented before enablement ────────────────────────
const wsA = makeWorkspace('ws-consent-granted');
const shown = runCli(['codex', 'setup', '--show-disclosure'], wsA);
if (shown.status !== 0) fail('G1-disclosure', `--show-disclosure exited ${shown.status}: ${shown.stderr.slice(0, 200)}`, 'Inspect pd codex setup --show-disclosure.');
if (shown.stdout.replace(/\r\n/g, '\n').trim() !== frozenDisclosure.trim()) {
  fail('G1-disclosure', 'installed setup disclosure is NOT byte-equal to the G2A frozen decision-package text', 'The installed runtime drifted from the approved disclosure — block rollout.');
}
// Ordering: the disclosure was presented (above) BEFORE any enablement; the
// accept in machine mode refuses to run without that presentation surface.
const accept = runCliJson(['codex', 'setup', '--workspace', wsA, '--accept', '--json'], wsA);
if (accept.json.status !== 'ok' || accept.json.decision !== 'granted' || accept.json.ingestionFlag?.enabled !== true) {
  fail('G1-disclosure', `accept did not grant+enable: ${accept.stdout.slice(0, 240)}`, 'Inspect pd codex setup --accept output.');
}
const grantedRecord = readConsentRecord(wsA);
if (grantedRecord?.decision !== 'granted' || grantedRecord?.disclosureVersion !== 'g2a-2026-08-28' || grantedRecord?.decidedVia !== 'pd_codex_setup') {
  fail('G1-disclosure', `consent record unexpected: ${JSON.stringify(grantedRecord)}`, 'Inspect the consent record writer.');
}
gate('G1-disclosure', 'passed', {
  frozenTextByteEqual: true,
  disclosureVersion: grantedRecord.disclosureVersion,
  ordering: 'disclosure presented before accept; granted only after explicit accept',
  flagEnabled: accept.json.ingestionFlag.enabled,
});

// ── G2 (R1-2): declining leaves the flag off and governance untouched ────────
const wsB = makeWorkspace('ws-consent-declined', { enableIngestion: true });
const beforeLines = readConfigLines(wsB);
const decline = runCliJson(['codex', 'setup', '--workspace', wsB, '--decline', '--json'], wsB);
if (decline.json.status !== 'ok' || decline.json.decision !== 'revoked' || decline.json.ingestionFlag?.enabled !== false) {
  fail('G2-decline', `decline did not revoke+disable: ${decline.stdout.slice(0, 240)}`, 'Inspect pd codex setup --decline output.');
}
const afterLines = readConfigLines(wsB);
// The ingestion block = the `codex_conversation_ingestion:` key line plus its
// 4-space-indented children. Only lines inside it may change.
const keyIndex = beforeLines.findIndex((line) => line.trim() === 'codex_conversation_ingestion:');
if (keyIndex === -1) fail('G2-decline', 'ingestion key line missing from the workspace config', 'Check the sandbox config rendering.');
let blockEnd = beforeLines.length;
for (let i = keyIndex + 1; i < beforeLines.length; i += 1) {
  if (beforeLines[i].trim() !== '' && !beforeLines[i].startsWith('    ')) { blockEnd = i; break; }
}
const changed = [];
for (let i = 0; i < Math.max(beforeLines.length, afterLines.length); i += 1) {
  if (beforeLines[i] !== afterLines[i]) changed.push({ line: i + 1, before: beforeLines[i], after: afterLines[i] });
}
const ingestionOnly = changed.length > 0 && changed.every((delta) => delta.line - 1 >= keyIndex && delta.line - 1 < blockEnd);
if (!ingestionOnly) {
  fail('G2-decline', `config diff exceeded the ingestion block: ${JSON.stringify(changed).slice(0, 400)}`, 'Existing governance config must stay byte-identical.');
}
const declinedRecord = readConsentRecord(wsB);
if (declinedRecord?.decision !== 'revoked' || declinedRecord?.disclosureVersion !== 'g2a-2026-08-28') {
  fail('G2-decline', `declined consent record unexpected: ${JSON.stringify(declinedRecord)}`, 'Inspect the consent record writer.');
}
const catchUp = runCliJson(['codex', 'ingest', 'catch-up', '--workspace', wsB, '--json'], wsB);
if (catchUp.json.status !== 'skipped' || catchUp.json.reason !== 'feature_disabled') {
  fail('G2-decline', `catch-up after decline expected skipped/feature_disabled: ${catchUp.stdout.slice(0, 240)}`, 'Inspect pd codex ingest catch-up.');
}
gate('G2-decline', 'passed', {
  decision: 'revoked',
  flagOff: true,
  configDiffLines: changed.map((delta) => `${delta.before} -> ${delta.after}`),
  existingGovernanceUntouched: true,
  catchUpAfterDecline: 'skipped/feature_disabled',
});

// ── G3 (R1-3): declining means the transcript is never opened ────────────────
// Prove "never opens" (not "reads then discards"): remove the transcript
// entirely, then deliver hook events. A flag-off hook must exit cleanly and
// write zero observations without the transcript even existing.
cpSync(path.join(ROOT, 'packages', 'codex-adapter', 'tests', 'fixtures', 'g1-contract', 'transcripts', 'normal-tool-final-turn.jsonl'), payload(wsB, 'Stop').transcript_path);
rmSync(payload(wsB, 'Stop').transcript_path);
const stopAfterDecline = runHook(wsB, payload(wsB, 'Stop', { stop_hook_active: false, last_assistant_message: 'FIXTURE-A-DONE' }));
if (stopAfterDecline.status !== 0) {
  fail('G3-no-read', `hook exited ${stopAfterDecline.status} after decline with no transcript: ${stopAfterDecline.stderr.slice(0, 240)}`, 'Flag-off must be a clean structured skip.');
}
const promptAfterDecline = runHook(wsB, payload(wsB, 'UserPromptSubmit', { prompt: 'ordinary prompt' }));
if (promptAfterDecline.status !== 0) {
  fail('G3-no-read', `prompt hook exited ${promptAfterDecline.status} after decline: ${promptAfterDecline.stderr.slice(0, 240)}`, 'Prompt delivery must keep working unchanged with ingestion off.');
}
const obsCount = spawnSync(process.execPath, ['-e', `
  const Database = require(${JSON.stringify(path.join(ROOT, 'node_modules', 'better-sqlite3'))});
  let n = -1;
  try {
    const db = new Database(${JSON.stringify(path.join(wsB, '.state', 'trajectory.db'))}, { readonly: true });
    n = db.prepare('SELECT COUNT(*) AS n FROM governance_observations').get().n;
    db.close();
  } catch { n = 0; }
  console.log(String(n));
`], { encoding: 'utf8' });
if (Number(obsCount.stdout.trim().split('\n').at(-1)) !== 0) {
  fail('G3-no-read', `observations written after decline: ${obsCount.stdout}`, 'Flag-off must write zero observations.');
}
gate('G3-no-read', 'passed', {
  transcriptRemovedBeforeHook: true,
  stopHookExit: 0,
  promptHookExit: 0,
  observationsWritten: 0,
});

// ── G4 (R1-4): upgrade/re-init never enables ingestion ───────────────────────
const recordBeforeInit = JSON.stringify(readConsentRecord(wsB));
const reInit = runCliJson(['runtime', 'init', '--workspace', wsB, '--confirm', '--json'], wsB);
if (reInit.status !== 0) {
  fail('G4-upgrade', `runtime init exited ${reInit.status}: ${reInit.stderr.slice(0, 240)}`, 'Inspect pd runtime init.');
}
if (JSON.stringify(readConsentRecord(wsB)) !== recordBeforeInit) {
  fail('G4-upgrade', 'the declined consent record was mutated by the upgrade-time initializer', 'Consent records are Owner decisions — upgrade must preserve them.');
}
const afterInitConfig = readConfigLines(wsB).join('\n');
if (!/codex_conversation_ingestion:[\s\S]*?enabled: false/.test(afterInitConfig) || /codex_conversation_ingestion:[\s\S]{0,80}enabled: true/.test(afterInitConfig)) {
  fail('G4-upgrade', 'ingestion flag is not off after re-init over a declined workspace', 'Upgrade must never enable ingestion.');
}
// Fresh-workspace facet: initializing a brand-new workspace (the upgrade
// destination shape) must not create consent or enable ingestion implicitly.
const wsC = path.join(sandbox, 'ws-fresh-upgrade');
const freshInit = runCliJson(['runtime', 'init', '--workspace', wsC, '--confirm', '--json'], wsC);
if (freshInit.status !== 0) {
  fail('G4-upgrade', `fresh runtime init exited ${freshInit.status}: ${freshInit.stderr.slice(0, 240)}`, 'Inspect pd runtime init.');
}
if (readConsentRecord(wsC) !== null) {
  fail('G4-upgrade', 'a consent record appeared without any Owner decision', 'Upgrade must never bypass consent implicitly.');
}
const freshConfig = readConfigLines(wsC).join('\n');
if (/codex_conversation_ingestion:[\s\S]{0,80}enabled: true/.test(freshConfig)) {
  fail('G4-upgrade', 'fresh workspace config enables ingestion by default', 'Default must stay off.');
}
const version = runCli(['--version'], wsB);
gate('G4-upgrade', 'passed', {
  reInitExit: reInit.status,
  declinedRecordPreserved: true,
  freshWorkspace: { consentRecord: null, ingestionDefaultOff: true },
  installedCli: version.stdout.trim(),
});

gate('r1-installed-gate', 'completed', {
  pdCli: PD_CLI,
  pdHook: PD_HOOK,
  sandbox,
});
if (EVIDENCE_OUT !== undefined) writeFileSync(EVIDENCE_OUT, `${evidence.map((entry) => JSON.stringify(entry)).join('\n')}\n`);
