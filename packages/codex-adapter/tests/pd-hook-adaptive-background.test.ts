/**
 * PRI-1196 — Codex desktop Adaptive Activation, BACKGROUND timing.
 *
 * The synchronous path is covered by `pd-hook-adaptive.test.ts`; this file pins
 * the asynchronous contract:
 *   - the first request leaves as Native without waiting for the decision;
 *   - only a qualified read-only tool boundary of the SAME turn may append;
 *   - a mutating/unknown/parallel-order/missed-window turn stays Native;
 *   - one result is delivered at most once across replays/concurrency.
 */
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import https from 'node:https';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import * as yaml from 'js-yaml';
import {
  SqliteActivationStateStore,
  SqliteConnection,
  getDefaultPdConfig,
  measureSharedDirectiveBlockChars,
  sharedDirectiveBaseChars,
} from '@principles/core/runtime';
import { escapeXml } from '@principles/core/prompt-builder';
import { fingerprintAdaptiveAppendRevision, readPromptActivationCandidates, runAdaptiveBackgroundSelection } from '@principles/host-runtime';
import { runHookExecutable } from './helpers/pd-hook-runner.js';
import {
  ADAPTIVE_APPEND_SCHEMA_VERSION,
  appendToolObservation,
  readToolObservations,
  claimAdaptiveAppendResult,
  evaluateAppendOrdering,
  markAdaptiveTurnStarted,
  writeAdaptiveAppendResultFor,
  type AdaptiveAppendHookIdentity,
  type AdaptiveAppendTargetRef,
  type ToolObservation,
} from '../src/ingestion/adaptive-append-state.js';
import { decodeCodexInput } from '../src/codec/index.js';

const TEXT = {
  SCOPE: '先确认任务边界与验收标准，再开始任何改动。',
  BIG: '避免为假设的未来需求预建抽象和额外服务。'.repeat(40),
  DELIVERY: 'PRI1196_TARGET 交付验收前以可观察证据自检：先列出验收基准与已有证据；缺证据时如实限定结论。',
  TESTS: '修复缺陷时先写能复现问题的回归测试，再改实现。',
} as const;
const ORDER = ['SCOPE', 'BIG', 'DELIVERY', 'TESTS'] as const;
const API_KEY_ENV = 'PD_TEST_BACKGROUND_KEY';
const DECISION_ENDPOINT = 'https://decisions.test/alpha/decisions';
const DECISION_MODEL = 'respan/span-01-lite:free';
const DECISION_PROVIDER = 'Respan';
const TARGET_SUBSTRING = 'PRI1196_TARGET';
const HOOK_ENTRY = fileURLToPath(new URL('../dist/pd-hook.js', import.meta.url));
// Test-only self-signed loopback certificate so the configured endpoint can be
// https (the config rejects plain http) without any external network.
const LOOPBACK_CERT = `-----BEGIN CERTIFICATE-----
MIIDGjCCAgKgAwIBAgIUCGbBdcus3q09MPghu2EEPsCcoHgwDQYJKoZIhvcNAQEL
BQAwFDESMBAGA1UEAwwJMTI3LjAuMC4xMB4XDTI2MTExNTEyNTMxOFoXDTM2MTEx
MjEyNTMxOFowFDESMBAGA1UEAwwJMTI3LjAuMC4xMIIBIjANBgkqhkiG9w0BAQEF
AAOCAQ8AMIIBCgKCAQEA2xMkwuo9dz3+RaYz12M2kGeS9uM2T7PP/6b/7qrIdYwZ
IecCQHVofipPa+452AQYpImwh6HnVxsVxOhebOuIVCNfBtg6GR0NU8+1GLKnTnF9
ZKOp4ru87dmF/3aTwV2gVuEs2PMXfZTTZ5oir1uAwsAVj0g+NArOfXe0sXgrVxrm
TOg0K7r3kM35oegzDXyLZattgt0/eYQEoa6Z28uKlDOEHdC3SZo7JNWyJf3zgkXy
aP9MCX0Ag0hu/8TVK+8AXCZ4L+akOBZT2Q11dOE5TAgD6dCTj1GxHr7rj7U4PXjJ
yJ2r7Ok0D34EB3zDJdlV2WlQ+OI3K/GHzYC9Nl0FzwIDAQABo2QwYjAdBgNVHQ4E
FgQUSF8+exOtr2SeNQrHw3P5GthHseEwHwYDVR0jBBgwFoAUSF8+exOtr2SeNQrH
w3P5GthHseEwDwYDVR0TAQH/BAUwAwEB/zAPBgNVHREECDAGhwR/AAABMA0GCSqG
SIb3DQEBCwUAA4IBAQB9VsRhmBqgfHpCFT8HswU/lk760/nsxIN7pUfIUhj2JD6j
9qNZldK6WAp1E7I5Rk6GmgmeOxKYwi4M+P/Px76fCk1pJJGqAuKGmuR7XuMeOg5x
WQBKNUiz0YoAwiogK29+W8XuQmetOGTOsR+ERJLLWatcl0XkE9mByR/Cc3fQmPBW
dE/1Y+o8foga5VQ26V3j9+RY5n/uxCuAVSFSjj4VyFA2XJdpo0ACEVUypAHrLzOc
SiGENl1KaWxok/mBpM+lDr21dsCSBUxPa1YZKnizMHqT1aILEtTuKc7wyrdV8aSZ
gpAek8NtoM8QQG5vCKUiaZzRGMvKsBljGW4P5hSd
-----END CERTIFICATE-----`;
const LOOPBACK_KEY = `-----BEGIN PRIVATE KEY-----
MIIEvQIBADANBgkqhkiG9w0BAQEFAASCBKcwggSjAgEAAoIBAQDbEyTC6j13Pf5F
pjPXYzaQZ5L24zZPs8//pv/uqsh1jBkh5wJAdWh+Kk9r7jnYBBikibCHoedXGxXE
6F5s64hUI18G2DoZHQ1Tz7UYsqdOcX1ko6niu7zt2YX/dpPBXaBW4SzY8xd9lNNn
miKvW4DCwBWPSD40Cs59d7SxeCtXGuZM6DQruveQzfmh6DMNfItlq22C3T95hASh
rpnby4qUM4Qd0LdJmjsk1bIl/fOCRfJo/0wJfQCDSG7/xNUr7wBcJngv5qQ4FlPZ
DXV04TlMCAPp0JOPUbEevuuPtTg9eMnInavs6TQPfgQHfMMl2VXZaVD44jcr8YfN
gL02XQXPAgMBAAECggEBAMlWi7eTXdAkKndKa2Stau1GM1wxr62KfUPg8GAhlz/o
9QQicgBZpyIksn9oHsM36In3fUT5+Eomu1gPkxCZWt6w71m0CZkhCSmYwEAlmPvP
88U1YSHfFqCmBK+nA953tK+EHRp6N4GT8MLLdssg1nKl5Gqdo4Vi1SmchXWBEpvm
ipuIkL9JNiK7BmMkaY7l+DXn5fI8Pjybhk+z9xSIcKfB62fcLNEkQHXYtxcih5Uh
vOpi3qHvIDM9rJCTYeL717MkGIgZesnKDuRr2I8U/QBXor4z0hlJD5TW0i2XBs8X
PtOg2js5H8aV1/b76HnYusU0NkC/IcDOqnLEEcD6+ZECgYEA8OQ0oUgi2NmXTzBs
wbETHNWHJtHtIM+DTAorMLu/+OT1zqohpiJIkFT8FDbRDutI2hq7YABvXHG1jGs+
u6dm7jYLLE3u48sC6w+eBJfeuN3JkU1jXFFT4txD0Q8lW+S7mpc5R9t7E8rTgLQH
UJkf+VO42XlZuheXm1etB783iHcCgYEA6NClaRv0EtCoz7nqrcPVDJGPk17M0JQB
F1fHYvxRtgYW3D7OwAkDmW+ulTew/2+nrSjIZk3+haFziSGo3GaqccbIHXkJR8ez
kPvzhxJLIn9etQbnHye9i8KHLbY5tJSOuphML554gVrZmqB80MaVI0EBJxDMYpMq
cC34GzI6m2kCgYAZLLA3XrONmAfRFc133IqTy9jo/K1cbXNaQgHLgQOJ/luV8n+7
vf95XfhOIIBun7YoXPzSBpmcvqFrgFW5BMCkCm/WfHqHwdKXQDWSY1C6XytOjRji
L/mlTsGjmoKb/OaCPGWXFd/h7KN34tiU2rvVsaMyzxTKdua4LEx/78Lc9wKBgA3w
kDbe6ZpGzBTD+P02gIckIAie4HyMoBQZuWJ/4RSZAL1nNVHiOEjzmuxsTTi+IrgH
fRhDCz5NEHHhhg7MRuBRGqJJIPkfR+0iaM5plf4WykDkjOocowi/OQDPrFzXmEQr
4kPnpSd5nRXZDiAiA8P8nGkOZG5yiVP2LKjUNRYhAoGAdbiswp7poHWnO7OKZ71O
zNY0e1UDGXJ2ydoIxIirr2Qle+OERmbt4MQWxP4mdB0YBYOYR4buvftON08v94bS
hDZDF9LfbEjhCIP7UvhMp6pA3MmFEynKhDf3nhdYJdjfqI661kHPXR8rZwSUnLKu
4mo/4gHbmWyBdPnCGW0LXb4=
-----END PRIVATE KEY-----`;
const TLS_PRELUDE = "process.env.NODE_TLS_REJECT_UNAUTHORIZED='0';";

const dirs: string[] = [];
const servers: http.Server[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) fs.rmSync(dir, {recursive: true, force: true});
  for (const server of servers.splice(0)) server.close();
});
beforeAll(() => {
  process.env[API_KEY_ENV] = 'test-key';
});
afterAll(() => {
  delete process.env[API_KEY_ENV];
});

interface FixtureOptions {
  readonly label: string;
  readonly adaptive: boolean;
  readonly timing?: 'sync' | 'background';
  readonly endpoint?: string;
  readonly responseModels?: readonly string[];
  readonly replaceableActivationIds?: readonly string[];
}

async function fixture(options: FixtureOptions): Promise<string> {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), `pd-bg-hook-${options.label}-`));
  dirs.push(root);
  fs.mkdirSync(path.join(root, '.pd'), {recursive: true});
  fs.mkdirSync(path.join(root, 'codex-home'), {recursive: true});
  const connection = new SqliteConnection(root);
  try {
    const db = connection.getDb();
    const insertArtifact = db.prepare(`
      INSERT INTO pi_artifacts (artifact_id, artifact_kind, source_task_id, source_principle_id, lineage_artifact_ids, validation_status, content_json, created_at, updated_at)
      VALUES (?, 'principle', ?, ?, '[]', 'validated', ?, ?, ?)
    `);
    const approve = db.prepare(`
      INSERT INTO approvals (approval_id, artifact_id, channel, risk_level, status, confidence, requested_at, decided_at, decided_by)
      VALUES (?, ?, 'prompt', 'low', 'approved', 1, ?, ?, 'owner-test')
    `);
    const store = new SqliteActivationStateStore(connection);
    let index = 0;
    for (const key of ORDER) {
      const at = new Date(Date.UTC(2026, 10, 10, 0, 0, 0) + index * 1000).toISOString();
      index += 1;
      const artifactId = `art-${key}`;
      insertArtifact.run(artifactId, `task-${artifactId}`, key, JSON.stringify({principleId: key, text: TEXT[key]}), at, at);
      await store.recordActivation({
        activationId: `act-${key}`,
        idempotencyKey: `${artifactId}::prompt`,
        artifactId,
        channel: 'prompt',
        action: 'prompt_activate',
        targetRef: `ledger://${key}`,
        activatedAt: at,
        deactivatedAt: null,
      });
      approve.run(`approval-${artifactId}`, artifactId, at, at);
    }
  } finally {
    connection.close();
  }
  const config = getDefaultPdConfig();
  config.features['host.codex'].enabled = true;
  if (options.adaptive) config.features['host.codex.adaptive_activation'].enabled = true;
  config.adaptiveActivation = {
    endpoint: options.endpoint ?? DECISION_ENDPOINT,
    model: DECISION_MODEL,
    apiKeyEnv: API_KEY_ENV,
    provider: DECISION_PROVIDER,
    ...(options.timing ? {timing: options.timing} : {}),
    ...(options.responseModels ? {responseModels: [...options.responseModels]} : {}),
    ...(options.replaceableActivationIds ? {replaceableActivationIds: [...options.replaceableActivationIds]} : {}),
  };
  fs.writeFileSync(path.join(root, '.pd', 'config.yaml'), yaml.dump(config), 'utf8');
  return root;
}

async function measuredCosts(root: string): Promise<{base: number; blocks: Record<string, number>}> {
  const read = await readPromptActivationCandidates({workspaceDir: root, includeAuthority: true});
  const renderOptions = {escapeFn: escapeXml, selfReportInstruction: false};
  const blocks: Record<string, number> = {};
  for (const principle of read.principles) blocks[principle.principleId] = measureSharedDirectiveBlockChars(principle, renderOptions);
  return {base: sharedDirectiveBaseChars(renderOptions), blocks};
}

/** The configured window is tokens; the resolved char budget is tokens / 32. */
function setPromptBudget(root: string, budgetChars: number): void {
  const configPath = path.join(root, '.pd', 'config.yaml');
  const config = yaml.load(fs.readFileSync(configPath, 'utf8')) as Record<string, unknown>;
  config.promptBudget = {hosts: {codex: Math.max(1024, Math.round(budgetChars * 32))}};
  fs.writeFileSync(configPath, yaml.dump(config), 'utf8');
}

function appendedText(stdout: string): string | undefined {
  return (JSON.parse(stdout) as {hookSpecificOutput?: {additionalContext?: string}}).hookSpecificOutput?.additionalContext;
}

function expectNoAppend(stdout: string): void {
  expect(appendedText(stdout) ?? '').not.toContain('<directive ');
}

interface WireCandidate {
  readonly ref: string;
  readonly text: string;
}

function decisionAnswers(body: unknown, scores: (candidate: WireCandidate) => number): Record<string, {type: 'noul'; noul: number}> {
  const record = body as {questions?: Record<string, unknown>; state?: string};
  const state = JSON.parse(String(record.state)) as {candidates?: WireCandidate[]};
  const answers: Record<string, {type: 'noul'; noul: number}> = {};
  for (const id of Object.keys(record.questions ?? {})) answers[id] = {type: 'noul', noul: 0.02};
  for (const candidate of state.candidates ?? []) answers[`candidate_${candidate.ref}`] = {type: 'noul', noul: scores(candidate)};
  return answers;
}

function scoringFetch(scoreTarget: number, onRequest?: () => void): typeof fetch {
  return async (_resource, init) => {
    const body = JSON.parse(String(init?.body)) as unknown;
    onRequest?.();
    return new Response(JSON.stringify({
      model: DECISION_MODEL,
      provider: DECISION_PROVIDER,
      answers: decisionAnswers(body, (candidate) => (candidate.text.includes(TARGET_SUBSTRING) ? scoreTarget : 0.02)),
    }), {status: 200, headers: {'content-type': 'application/json'}});
  };
}

/**
 * Decision server that HOLDS the response until the test releases it. This
 * makes "the first request did not wait for the decision" a structural fact,
 * not a timing threshold: the hook must return while the request is pending.
 */
async function startGatedDecisionServer(): Promise<{
  endpoint: string;
  requests: () => number;
  pending: () => number;
  release: () => void;
}> {
  let count = 0;
  let release: (() => void) | null = null;
  const server = https.createServer({cert: LOOPBACK_CERT, key: LOOPBACK_KEY}, async (req, res) => {
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(chunk as Buffer);
    count += 1;
    const body = JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown;
    const payload = JSON.stringify({
      model: DECISION_MODEL,
      provider: DECISION_PROVIDER,
      answers: decisionAnswers(body, (candidate) => (candidate.text.includes(TARGET_SUBSTRING) ? 0.99 : 0.02)),
    });
    release = () => {
      res.writeHead(200, {'content-type': 'application/json'});
      res.end(payload);
    };
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
  servers.push(server);
  const address = server.address();
  if (address === null || typeof address === 'string') throw new Error('no ephemeral port');
  return {
    endpoint: `https://127.0.0.1:${address.port}/v1/decisions`,
    requests: () => count,
    pending: () => (release === null ? 0 : 1),
    release: () => {
      release?.();
      release = null;
    },
  };
}

async function startDecisionServer(delayMs: number): Promise<{endpoint: string; requests: () => number}> {
  let count = 0;
  const server = https.createServer({cert: LOOPBACK_CERT, key: LOOPBACK_KEY}, async (req, res) => {
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(chunk as Buffer);
    count += 1;
    const body = JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown;
    const payload = JSON.stringify({
      model: DECISION_MODEL,
      provider: DECISION_PROVIDER,
      answers: decisionAnswers(body, (candidate) => (candidate.text.includes(TARGET_SUBSTRING) ? 0.99 : 0.02)),
    });
    setTimeout(() => {
      res.writeHead(200, {'content-type': 'application/json'});
      res.end(payload);
    }, delayMs);
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
  servers.push(server);
  const address = server.address();
  if (address === null || typeof address === 'string') throw new Error('no ephemeral port');
  return {endpoint: `https://127.0.0.1:${address.port}/v1/decisions`, requests: () => count};
}

function hookIdentity(): AdaptiveAppendHookIdentity {
  return {entryPath: HOOK_ENTRY, mtimeMs: fs.statSync(HOOK_ENTRY).mtimeMs};
}

function userPrompt(root: string, sessionId = 's-bg', turnId = 't-bg'): string {
  return JSON.stringify({
    session_id: sessionId,
    turn_id: turnId,
    transcript_path: null,
    cwd: root,
    model: 'gpt-5.6',
    permission_mode: 'default',
    hook_event_name: 'UserPromptSubmit',
    prompt: '请验收这次改动。',
  });
}

function toolPayload(
  root: string,
  event: 'PreToolUse' | 'PostToolUse',
  toolName: string,
  toolInput: Record<string, unknown>,
  toolUseId: string,
  sessionId = 's-bg',
  turnId = 't-bg',
): string {
  return JSON.stringify({
    session_id: sessionId,
    turn_id: turnId,
    transcript_path: null,
    cwd: root,
    model: 'gpt-5.6',
    permission_mode: 'default',
    hook_event_name: event,
    tool_name: toolName,
    tool_input: toolInput,
    tool_use_id: toolUseId,
    tool_response: {output: 'ok'},
  });
}

function stopPayload(root: string, sessionId = 's-bg', turnId = 't-bg'): string {
  return JSON.stringify({
    session_id: sessionId,
    turn_id: turnId,
    transcript_path: null,
    cwd: root,
    model: 'gpt-5.6',
    permission_mode: 'default',
    hook_event_name: 'Stop',
    stop_hook_active: false,
  });
}

function stateFiles(root: string, marker: string): string[] {
  const dir = path.join(root, '.state');
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir).filter((name) => name.startsWith('pd_adaptive_append_') && name.includes(marker));
}

function readEvents(root: string): string {
  const logDir = path.join(root, '.state', 'logs');
  if (!fs.existsSync(logDir)) return '';
  return fs.readdirSync(logDir)
    .filter((name) => name.endsWith('.jsonl'))
    .map((name) => fs.readFileSync(path.join(logDir, name), 'utf8'))
    .join('\n');
}

async function waitFor(predicate: () => boolean, timeoutMs = 8000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate() && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 50));
}

async function seededResult(
  root: string,
  target: Omit<AdaptiveAppendTargetRef, 'revisionFingerprint'>,
  nativeChars: number,
  budgetChars: number,
  startedAt: number,
  identity: AdaptiveAppendHookIdentity = hookIdentity(),
): Promise<void> {
  const read = await readPromptActivationCandidates({workspaceDir: root, includeAuthority: true});
  const principle = read.principles.find((candidate) => candidate.activationId === target.activationId);
  const revisionFingerprint = principle && fingerprintAdaptiveAppendRevision(principle);
  if (!revisionFingerprint) throw new Error('Missing fixture revision fingerprint');
  writeAdaptiveAppendResultFor(root, {
    schemaVersion: ADAPTIVE_APPEND_SCHEMA_VERSION,
    createdAt: Date.now(),
    startedAt,
    sessionId: 's-bg',
    turnId: 't-bg',
    target: {...target, revisionFingerprint},
    directiveChars: 80,
    nativeActivationIds: ['act-SCOPE'],
    nativeChars,
    budgetChars,
    hookIdentity: identity,
  });
}

const TARGET = {principleId: 'DELIVERY', activationId: 'act-DELIVERY', artifactId: 'art-DELIVERY'};

describe('runAdaptiveBackgroundSelection (in-process, fake scoring transport)', () => {
  it('selects a principle that fits the budget Native did NOT use', async () => {
    const root = await fixture({label: 'bg-selected', adaptive: true, timing: 'background'});
    const {base, blocks} = await measuredCosts(root);
    const nativeChars = base + (blocks.SCOPE ?? 0);
    let sends = 0;
    const outcome = await runAdaptiveBackgroundSelection({
      workspaceDir: root,
      sessionId: 's-bg',
      turnId: 't-bg',
      promptContent: '请验收这次改动。',
      nativeActivationIds: ['act-SCOPE'],
      nativeChars,
      budgetChars: nativeChars + (blocks.DELIVERY ?? 0) + 20,
      deadlineAt: Date.now() + 20_000,
      env: {...process.env},
      fetchImpl: scoringFetch(0.99, () => { sends += 1; }),
    });
    expect(outcome.status).toBe('selected');
    if (outcome.status !== 'selected') return;
    expect(outcome.target).toMatchObject({...TARGET, revisionFingerprint: expect.stringMatching(/^[a-f0-9]{64}$/)});
    expect(outcome.directive).toContain(TARGET_SUBSTRING);
    expect(outcome.directive.startsWith('<directive ')).toBe(true);
    expect(sends).toBe(1);
  });

  it('never scores when the target was already in the Native set', async () => {
    const root = await fixture({label: 'bg-already-native', adaptive: true, timing: 'background'});
    let sends = 0;
    const outcome = await runAdaptiveBackgroundSelection({
      workspaceDir: root,
      sessionId: 's-bg',
      turnId: 't-bg',
      promptContent: '请验收这次改动。',
      nativeActivationIds: ['act-SCOPE', 'act-BIG', 'act-DELIVERY', 'act-TESTS'],
      nativeChars: 100,
      budgetChars: 5000,
      deadlineAt: Date.now() + 20_000,
      env: {...process.env},
      fetchImpl: scoringFetch(0.99, () => { sends += 1; }),
    });
    expect(outcome.status).toBe('skipped');
    expect(outcome.reason).toBe('no_appendable_gap');
    expect(sends).toBe(0);
  });

  it('never scores when Native consumed the whole budget', async () => {
    const root = await fixture({label: 'bg-no-gap', adaptive: true, timing: 'background'});
    let sends = 0;
    const outcome = await runAdaptiveBackgroundSelection({
      workspaceDir: root,
      sessionId: 's-bg',
      turnId: 't-bg',
      promptContent: '请验收这次改动。',
      nativeActivationIds: ['act-SCOPE'],
      nativeChars: 5000,
      budgetChars: 5000,
      deadlineAt: Date.now() + 20_000,
      env: {...process.env},
      fetchImpl: scoringFetch(0.99, () => { sends += 1; }),
    });
    expect(outcome.status).toBe('skipped');
    expect(sends).toBe(0);
  });

  it('drops the decision when the authorization changes while scoring', async () => {
    const root = await fixture({label: 'bg-revoked', adaptive: true, timing: 'background'});
    const {base, blocks} = await measuredCosts(root);
    const nativeChars = base + (blocks.SCOPE ?? 0);
    const outcome = await runAdaptiveBackgroundSelection({
      workspaceDir: root,
      sessionId: 's-bg',
      turnId: 't-bg',
      promptContent: '请验收这次改动。',
      nativeActivationIds: ['act-SCOPE'],
      nativeChars,
      budgetChars: nativeChars + (blocks.DELIVERY ?? 0) + 20,
      deadlineAt: Date.now() + 20_000,
      env: {...process.env},
      fetchImpl: scoringFetch(0.99, () => {
        const connection = new SqliteConnection(root);
        try {
          connection.getDb().prepare('UPDATE activations SET deactivated_at = ? WHERE activation_id = ?')
            .run(new Date().toISOString(), 'act-DELIVERY');
        } finally {
          connection.close();
        }
      }),
    });
    expect(outcome.status, JSON.stringify(outcome)).toBe('skipped');
    expect(outcome.reason).toBe('revalidation_failed');
  });
});

describe('append ordering gate', () => {
  const base = {toolName: 'Bash', canonicalKind: 'execute', readOnly: true, at: 1} as const;
  const obs = (phase: 'pre' | 'post', toolCallId: string, overrides: Partial<ToolObservation> = {}): ToolObservation => ({...base, phase, toolCallId, ...overrides});

  it('accepts one qualified read-only call that opened and closed in order', () => {
    expect(evaluateAppendOrdering([obs('pre', 'exec-1'), obs('post', 'exec-1')], 'exec-1')).toEqual({ok: true});
  });

  it('drops a lone post whose pre was never observed', () => {
    // P1-1: a post without its pre proves nothing about what ran before it.
    expect(evaluateAppendOrdering([obs('post', 'exec-1')], 'exec-1'))
      .toEqual({ok: false, reason: 'ordering_unprovable'});
  });

  it('rejects overflow and corrupt history even when the latest tool was read-only', async () => {
    const workspaceDir = await fixture({label: 'bg-order-history', adaptive: true, timing: 'background'});
    const key = {workspaceDir, sessionId: 's-bg', turnId: 't-bg'};
    function recordPair(toolCallId: string, canonicalKind: 'read' | 'write'): void {
      for (const phase of ['pre', 'post'] as const) {
        appendToolObservation({...key, observation: {
          phase, toolCallId, toolName: canonicalKind, canonicalKind, readOnly: canonicalKind === 'read', at: Date.now(),
        }});
      }
    }
    recordPair('first-write', 'write');
    for (let index = 0; index < 32; index++) recordPair(`read-${index}`, 'read');
    expect(evaluateAppendOrdering(readToolObservations(key), 'read-31')).toEqual({ok: false, reason: 'ordering_unprovable'});

    const [name] = stateFiles(workspaceDir, 'tools_');
    fs.writeFileSync(path.join(workspaceDir, '.state', name), '{"phase":"pre"\n', 'utf8');
    recordPair('last-read', 'read');
    expect(evaluateAppendOrdering(readToolObservations(key), 'last-read')).toEqual({ok: false, reason: 'ordering_unprovable'});
  });

  it('drops when a mutating call appears anywhere in the turn', () => {
    expect(evaluateAppendOrdering([
      obs('pre', 'patch-1', {toolName: 'apply_patch', canonicalKind: 'write', readOnly: false}),
      obs('post', 'patch-1', {toolName: 'apply_patch', canonicalKind: 'write', readOnly: false}),
      obs('pre', 'exec-1'),
      obs('post', 'exec-1'),
    ], 'exec-1')).toEqual({ok: false, reason: 'mutating_tool_observed'});
  });

  it('drops an execute command whose semantics are not proven safe', () => {
    expect(evaluateAppendOrdering([obs('pre', 'exec-1', {readOnly: false}), obs('post', 'exec-1', {readOnly: false})], 'exec-1'))
      .toEqual({ok: false, reason: 'unknown_tool_observed'});
  });

  it('drops when a parallel call is still open (order unprovable)', () => {
    expect(evaluateAppendOrdering([obs('pre', 'exec-1'), obs('pre', 'exec-2'), obs('post', 'exec-1')], 'exec-1'))
      .toEqual({ok: false, reason: 'parallel_order_unprovable'});
  });

  it('drops a replayed callback', () => {
    expect(evaluateAppendOrdering([obs('pre', 'exec-1'), obs('post', 'exec-1'), obs('post', 'exec-1')], 'exec-1'))
      .toEqual({ok: false, reason: 'duplicate_callback'});
  });
});

describe('ready result claim', () => {
  it('binds one result to one session+turn and claims it once', async () => {
    const root = await fixture({label: 'bg-claim', adaptive: true, timing: 'background'});
    await seededResult(root, TARGET, 100, 1000, Date.now());
    const first = claimAdaptiveAppendResult({workspaceDir: root, sessionId: 's-bg', turnId: 't-bg', now: Date.now()});
    expect(first.status).toBe('ready');
    const second = claimAdaptiveAppendResult({workspaceDir: root, sessionId: 's-bg', turnId: 't-bg', now: Date.now()});
    expect(second.status).toBe('absent');
    const otherTurn = claimAdaptiveAppendResult({workspaceDir: root, sessionId: 's-bg', turnId: 't-other', now: Date.now()});
    expect(otherTurn.status).toBe('absent');
    const otherSession = claimAdaptiveAppendResult({workspaceDir: root, sessionId: 's-other', turnId: 't-bg', now: Date.now()});
    expect(otherSession.status).toBe('absent');
  });

  it('expires after the turn window', async () => {
    const root = await fixture({label: 'bg-expired', adaptive: true, timing: 'background'});
    await seededResult(root, TARGET, 100, 1000, Date.now() - 60_000);
    const claimed = claimAdaptiveAppendResult({workspaceDir: root, sessionId: 's-bg', turnId: 't-bg', now: Date.now()});
    expect(claimed.status).toBe('expired');
  });
});

describe('pd-hook background timing (real subprocess)', () => {
  it('sends Native before the decision finishes, then appends exactly once after a read-only tool', async () => {
    const server = await startGatedDecisionServer();
    const root = await fixture({label: 'bg-chain', adaptive: true, timing: 'background', endpoint: server.endpoint});
    const {base, blocks} = await measuredCosts(root);
    // BIG blocks the Native pack after SCOPE; DELIVERY fits the unused room.
    setPromptBudget(root, base + (blocks.SCOPE ?? 0) + (blocks.DELIVERY ?? 0) + 10);
    const codexHome = path.join(root, 'codex-home');
    const prompt = await runHookExecutable(codexHome, userPrompt(root), {timeoutMs: 15_000, childPrelude: TLS_PRELUDE});
    expect(prompt.status).toBe(0);
    const nativeText = appendedText(prompt.stdout) ?? '';
    expect(nativeText, prompt.stderr).toContain(TEXT.SCOPE);
    expect(nativeText).not.toContain(TARGET_SUBSTRING);
    // The hook already returned; now wait for the background request to arrive
    // and confirm its response is still held.
    await waitFor(() => server.pending() === 1, 3000);
    expect(server.pending()).toBe(1);
    expect(stateFiles(root, 'result_')).toHaveLength(0);
    server.release();
    await waitFor(() => stateFiles(root, 'result_').length === 1, 12_000);
    expect(stateFiles(root, 'result_'), `jobs=${stateFiles(root, 'job_').join(',')} requests=${server.requests()} events=${readEvents(root).slice(-1200)}`).toHaveLength(1);
    expect(server.requests()).toBe(1);

    const pre = await runHookExecutable(codexHome, toolPayload(root, 'PreToolUse', 'Bash', {command: 'Get-ChildItem -Force'}, 'exec-bg-1'));
    expect(pre.status).toBe(0);
    const post = await runHookExecutable(codexHome, toolPayload(root, 'PostToolUse', 'Bash', {command: 'Get-ChildItem -Force'}, 'exec-bg-1'));
    expect(post.status).toBe(0);
    const postBody = JSON.parse(post.stdout) as {hookSpecificOutput?: {hookEventName?: string; additionalContext?: string}};
    expect(postBody.hookSpecificOutput?.hookEventName).toBe('PostToolUse');
    const appendText = postBody.hookSpecificOutput?.additionalContext ?? '';
    expect(appendText).toContain(TARGET_SUBSTRING);
    expect(appendText.split('<directive ').length - 1).toBe(1);

    // Replay: the result is consumed; no second append is possible.
    const replay = await runHookExecutable(codexHome, toolPayload(root, 'PostToolUse', 'Bash', {command: 'Get-ChildItem -Force'}, 'exec-bg-1'));
    expectNoAppend(replay.stdout);
    expect(server.requests()).toBe(1);

    const events = readEvents(root);
    expect(events).toContain('selected:background_ready');
    expect(events).toContain('selected:background_appended');

    const stop = await runHookExecutable(codexHome, stopPayload(root));
    expect(stop.status).toBe(0);
  }, 20_000);

  it('keeps Native when the first tool is mutating', async () => {
    const root = await fixture({label: 'bg-mutating', adaptive: true, timing: 'background'});
    const codexHome = path.join(root, 'codex-home');
    const {base, blocks} = await measuredCosts(root);
    await seededResult(root, TARGET, base + (blocks.SCOPE ?? 0), base + (blocks.SCOPE ?? 0) + (blocks.DELIVERY ?? 0) + 20, Date.now());
    appendToolObservation({
      workspaceDir: root,
      sessionId: 's-bg',
      turnId: 't-bg',
      observation: {phase: 'pre', toolCallId: 'patch-bg-1', toolName: 'apply_patch', canonicalKind: 'write', readOnly: false, at: Date.now()},
    });
    const post = await runHookExecutable(codexHome, toolPayload(root, 'PostToolUse', 'apply_patch', {patch: '*** Begin Patch'}, 'patch-bg-1'));
    expectNoAppend(post.stdout);
    expect(stateFiles(root, 'result_')).toHaveLength(0);
    expect(readEvents(root)).toContain('skipped:background_mutating_tool');
  });

  it('keeps Native when a parallel call makes the order unprovable', async () => {
    const root = await fixture({label: 'bg-parallel', adaptive: true, timing: 'background'});
    const codexHome = path.join(root, 'codex-home');
    const {base, blocks} = await measuredCosts(root);
    await seededResult(root, TARGET, base + (blocks.SCOPE ?? 0), base + (blocks.SCOPE ?? 0) + (blocks.DELIVERY ?? 0) + 20, Date.now());
    for (const id of ['exec-p1', 'exec-p2']) {
      appendToolObservation({
        workspaceDir: root,
        sessionId: 's-bg',
        turnId: 't-bg',
        observation: {phase: 'pre', toolCallId: id, toolName: 'Bash', canonicalKind: 'execute', readOnly: true, at: Date.now()},
      });
    }
    const post = await runHookExecutable(codexHome, toolPayload(root, 'PostToolUse', 'Bash', {command: 'Get-ChildItem -Force'}, 'exec-p1'));
    expectNoAppend(post.stdout);
    expect(readEvents(root)).toContain('skipped:background_parallel_order_unprovable');
  });

  it('drops a ready result on Stop and records one turn-ended fact', async () => {
    const root = await fixture({label: 'bg-stop', adaptive: true, timing: 'background'});
    const codexHome = path.join(root, 'codex-home');
    await seededResult(root, TARGET, 100, 1000, Date.now());
    const stop = await runHookExecutable(codexHome, stopPayload(root));
    expect(stop.status).toBe(0);
    expect(stateFiles(root, 'result_')).toHaveLength(0);
    expect(readEvents(root)).toContain('skipped:background_turn_ended');
  });

  it('does not start or consume anything when the switch is off', async () => {
    const server = await startDecisionServer(0);
    const root = await fixture({label: 'bg-off', adaptive: false, timing: 'background', endpoint: server.endpoint});
    const codexHome = path.join(root, 'codex-home');
    const prompt = await runHookExecutable(codexHome, userPrompt(root), {childPrelude: TLS_PRELUDE});
    expect(prompt.status).toBe(0);
    expect(stateFiles(root, 'job_')).toHaveLength(0);
    expect(server.requests()).toBe(0);
  });

  it('keeps Native when the authorization changed before consume', async () => {
    const root = await fixture({label: 'bg-revoked-consume', adaptive: true, timing: 'background'});
    const codexHome = path.join(root, 'codex-home');
    const {base, blocks} = await measuredCosts(root);
    await seededResult(root, TARGET, base + (blocks.SCOPE ?? 0), base + (blocks.SCOPE ?? 0) + (blocks.DELIVERY ?? 0) + 20, Date.now());
    const connection = new SqliteConnection(root);
    try {
      connection.getDb().prepare('UPDATE activations SET deactivated_at = ? WHERE activation_id = ?')
        .run(new Date().toISOString(), 'act-DELIVERY');
    } finally {
      connection.close();
    }
    appendToolObservation({
      workspaceDir: root,
      sessionId: 's-bg',
      turnId: 't-bg',
      observation: {phase: 'pre', toolCallId: 'exec-revoked', toolName: 'Bash', canonicalKind: 'execute', readOnly: true, at: Date.now()},
    });
    const post = await runHookExecutable(codexHome, toolPayload(root, 'PostToolUse', 'Bash', {command: 'Get-ChildItem -Force'}, 'exec-revoked'));
    expectNoAppend(post.stdout);
    const events = readEvents(root);
    expect(
      events.includes('skipped:background_target_unavailable') || events.includes('skipped:background_target_changed'),
      events.slice(-600),
    ).toBe(true);
  }, 15_000);

  it('keeps Native when the selected content changes with the same IDs', async () => {
    const root = await fixture({label: 'bg-edited-artifact', adaptive: true, timing: 'background'});
    await seededResult(root, TARGET, 100, 3000, Date.now());
    const connection = new SqliteConnection(root);
    try {
      connection.getDb().prepare('UPDATE pi_artifacts SET content_json = ? WHERE artifact_id = ?')
        .run(JSON.stringify({principleId: 'DELIVERY', text: 'A different directive in the same artifact.'}), TARGET.artifactId);
    } finally {
      connection.close();
    }
    appendToolObservation({
      workspaceDir: root, sessionId: 's-bg', turnId: 't-bg',
      observation: {phase: 'pre', toolCallId: 'read-edit', toolName: 'Bash', canonicalKind: 'execute', readOnly: true, at: Date.now()},
    });
    const post = await runHookExecutable(path.join(root, 'codex-home'),
      toolPayload(root, 'PostToolUse', 'Bash', {command: 'Get-ChildItem -Force'}, 'read-edit'));
    expectNoAppend(post.stdout);
    expect(readEvents(root)).toContain('skipped:background_target_changed');
  }, 15_000);

  it('keeps Native when the installed hook changed mid-turn', async () => {
    const root = await fixture({label: 'bg-version', adaptive: true, timing: 'background'});
    const codexHome = path.join(root, 'codex-home');
    await seededResult(root, TARGET, 100, 1000, Date.now(), {entryPath: hookIdentity().entryPath, mtimeMs: hookIdentity().mtimeMs - 1000});
    appendToolObservation({
      workspaceDir: root,
      sessionId: 's-bg',
      turnId: 't-bg',
      observation: {phase: 'pre', toolCallId: 'exec-version', toolName: 'Bash', canonicalKind: 'execute', readOnly: true, at: Date.now()},
    });
    const post = await runHookExecutable(codexHome, toolPayload(root, 'PostToolUse', 'Bash', {command: 'Get-ChildItem -Force'}, 'exec-version'));
    expectNoAppend(post.stdout);
    expect(readEvents(root)).toContain('skipped:background_version_changed');
  }, 15_000);

  it('keeps Native when the directive no longer fits the Native budget', async () => {
    const root = await fixture({label: 'bg-budget', adaptive: true, timing: 'background'});
    const codexHome = path.join(root, 'codex-home');
    await seededResult(root, TARGET, 1000, 1000, Date.now());
    appendToolObservation({
      workspaceDir: root,
      sessionId: 's-bg',
      turnId: 't-bg',
      observation: {phase: 'pre', toolCallId: 'exec-budget', toolName: 'Bash', canonicalKind: 'execute', readOnly: true, at: Date.now()},
    });
    const post = await runHookExecutable(codexHome, toolPayload(root, 'PostToolUse', 'Bash', {command: 'Get-ChildItem -Force'}, 'exec-budget'));
    expectNoAppend(post.stdout);
    expect(readEvents(root)).toContain('skipped:background_budget_exhausted');
  }, 15_000);

  it('keeps Native when a mutating tool ran during the scoring window (P1-1)', async () => {
    const root = await fixture({label: 'bg-window-mutating', adaptive: true, timing: 'background'});
    const codexHome = path.join(root, 'codex-home');
    const {base, blocks} = await measuredCosts(root);
    // The scoring window is exactly: the turn started (marker), the selector
    // has withdrawn the job, and the result does not exist yet.
    markAdaptiveTurnStarted({workspaceDir: root, sessionId: 's-bg', turnId: 't-bg'});
    expect(stateFiles(root, 'started_')).toHaveLength(1);
    expect(stateFiles(root, 'job_')).toHaveLength(0);
    expect(stateFiles(root, 'result_')).toHaveLength(0);
    const patchPre = await runHookExecutable(codexHome, toolPayload(root, 'PreToolUse', 'apply_patch', {patch: '*** Begin Patch'}, 'patch-window-1'));
    expect(patchPre.status).toBe(0);
    const patchPost = await runHookExecutable(codexHome, toolPayload(root, 'PostToolUse', 'apply_patch', {patch: '*** Begin Patch'}, 'patch-window-1'));
    expect(patchPost.status).toBe(0);
    expectNoAppend(patchPost.stdout);
    // The decision becomes ready only now.
    await seededResult(root, TARGET, base + (blocks.SCOPE ?? 0), base + (blocks.SCOPE ?? 0) + (blocks.DELIVERY ?? 0) + 20, Date.now());
    const readPre = await runHookExecutable(codexHome, toolPayload(root, 'PreToolUse', 'Bash', {command: 'Get-ChildItem -Force'}, 'exec-window-2'));
    expect(readPre.status).toBe(0);
    const readPost = await runHookExecutable(codexHome, toolPayload(root, 'PostToolUse', 'Bash', {command: 'Get-ChildItem -Force'}, 'exec-window-2'));
    expect(readPost.status).toBe(0);
    expectNoAppend(readPost.stdout);
    expect(readEvents(root)).toContain('skipped:background_mutating_tool');
  }, 30_000);

  it('Stop during scoring ends the turn without a late result or pending state (P1-2)', async () => {
    const server = await startGatedDecisionServer();
    const root = await fixture({label: 'bg-stop-scoring', adaptive: true, timing: 'background', endpoint: server.endpoint});
    const codexHome = path.join(root, 'codex-home');
    const {base, blocks} = await measuredCosts(root);
    setPromptBudget(root, base + (blocks.SCOPE ?? 0) + (blocks.DELIVERY ?? 0) + 10);
    const prompt = await runHookExecutable(codexHome, userPrompt(root), {timeoutMs: 20_000, childPrelude: TLS_PRELUDE});
    expect(prompt.status).toBe(0);
    await waitFor(() => server.pending() === 1, 5000);
    expect(stateFiles(root, 'started_')).toHaveLength(1);
    const stop = await runHookExecutable(codexHome, stopPayload(root));
    expect(stop.status).toBe(0);
    expect(stateFiles(root, 'started_')).toHaveLength(0);
    expect(stateFiles(root, 'job_')).toHaveLength(0);
    expect(stateFiles(root, 'result_')).toHaveLength(0);
    expect(stateFiles(root, 'ended_')).toHaveLength(1);
    // Release the held decision: the late selector must discard it.
    server.release();
    await new Promise((resolve) => setTimeout(resolve, 1500));
    expect(stateFiles(root, 'result_')).toHaveLength(0);
    const events = readEvents(root);
    expect(events).toContain('skipped:background_turn_ended');
    expect(events).not.toContain('selected:background_ready');
    expect(events).not.toContain('selected:background_appended');
  }, 30_000);

  it('starts at most one scoring request when the host replays UserPromptSubmit (P2-5)', async () => {
    const server = await startGatedDecisionServer();
    const root = await fixture({label: 'bg-duplicate-prompt', adaptive: true, timing: 'background', endpoint: server.endpoint});
    const codexHome = path.join(root, 'codex-home');
    const {base, blocks} = await measuredCosts(root);
    setPromptBudget(root, base + (blocks.SCOPE ?? 0) + (blocks.DELIVERY ?? 0) + 10);
    const first = await runHookExecutable(codexHome, userPrompt(root), {timeoutMs: 20_000, childPrelude: TLS_PRELUDE});
    expect(first.status).toBe(0);
    await waitFor(() => server.pending() === 1, 5000);
    const replay = await runHookExecutable(codexHome, userPrompt(root), {timeoutMs: 20_000, childPrelude: TLS_PRELUDE});
    expect(replay.status).toBe(0);
    expect(readEvents(root)).toContain('background:already_started');
    server.release();
    await waitFor(() => stateFiles(root, 'result_').length === 1, 12_000);
    expect(server.requests()).toBe(1);
    await runHookExecutable(codexHome, stopPayload(root));
  }, 30_000);

  it('reports an unreadable ready result instead of dropping it silently (P2-2)', async () => {
    const root = await fixture({label: 'bg-invalid-result', adaptive: true, timing: 'background'});
    const codexHome = path.join(root, 'codex-home');
    const key = (value: string): string => createHash('sha256').update(value, 'utf8').digest('hex').slice(0, 16);
    const corrupt = path.join(root, '.state', `pd_adaptive_append_result_${key('s-bg')}_${key('t-bg')}.json`);
    fs.mkdirSync(path.dirname(corrupt), {recursive: true});
    fs.writeFileSync(corrupt, '{not-json');
    appendToolObservation({
      workspaceDir: root,
      sessionId: 's-bg',
      turnId: 't-bg',
      observation: {phase: 'pre', toolCallId: 'exec-invalid', toolName: 'Bash', canonicalKind: 'execute', readOnly: true, at: Date.now()},
    });
    const post = await runHookExecutable(codexHome, toolPayload(root, 'PostToolUse', 'Bash', {command: 'Get-ChildItem -Force'}, 'exec-invalid'));
    expect(post.status).toBe(0);
    expectNoAppend(post.stdout);
    expect(readEvents(root)).toContain('skipped:background_result_unreadable');
  }, 15_000);

  it('sweeps stale turn state on SessionStart but keeps fresh state (P2-3)', async () => {
    const root = await fixture({label: 'bg-session-sweep', adaptive: true, timing: 'background'});
    const codexHome = path.join(root, 'codex-home');
    const dir = path.join(root, '.state');
    fs.mkdirSync(dir, {recursive: true});
    const stale = path.join(dir, 'pd_adaptive_append_tools_stale_0000.jsonl');
    const fresh = path.join(dir, 'pd_adaptive_append_started_fresh_0000.json');
    fs.writeFileSync(stale, '{"phase":"pre"}\n');
    fs.writeFileSync(fresh, '{"at":1}');
    const aged = new Date(Date.now() - 11 * 60_000);
    fs.utimesSync(stale, aged, aged);
    const sessionStart = JSON.stringify({
      session_id: 's-bg',
      transcript_path: null,
      cwd: root,
      model: 'gpt-5.6',
      permission_mode: 'default',
      hook_event_name: 'SessionStart',
      source: 'startup',
    });
    const started = await runHookExecutable(codexHome, sessionStart);
    expect(started.status).toBe(0);
    expect(fs.existsSync(stale)).toBe(false);
    expect(fs.existsSync(fresh)).toBe(true);
  }, 15_000);
});

describe('real captured Codex payloads carry turn lineage', () => {
  const root = fileURLToPath(new URL('./fixtures/g1-contract/hook-payloads/', import.meta.url));
  const versions = fs.readdirSync(root).filter((name) => fs.statSync(path.join(root, name)).isDirectory());

  it.each(versions)('%s: UserPromptSubmit/PreToolUse/PostToolUse all carry turn_id', (version) => {
    for (const file of ['02-user-prompt-submit.json', '03-pre-tool-use.json', '04-post-tool-use.json']) {
      const payload = JSON.parse(fs.readFileSync(path.join(root, version, file), 'utf8')) as unknown;
      const event = decodeCodexInput(payload);
      expect(event.context.turnId, `${version}/${file} turn_id`).toBeTruthy();
      if (file !== '02-user-prompt-submit.json') {
        expect(event.context.toolCallId, `${version}/${file} tool_use_id`).toBeTruthy();
        expect(event.context.toolName, `${version}/${file} tool_name`).toBeTruthy();
      }
    }
  });
});
