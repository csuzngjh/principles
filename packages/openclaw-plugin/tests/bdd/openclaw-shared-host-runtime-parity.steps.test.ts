import { afterEach, expect, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';
import * as yaml from 'js-yaml';
import {
  getDefaultPdConfig,
  SqliteActivationStateStore,
  SqliteConnection,
  appendPruningReview,
  clearPruningMaskCache,
} from '@principles/core/runtime-v2';
import plugin from '../../src/index.js';
import type { OpenClawPluginApi } from '../../src/openclaw-sdk.js';
import { WorkspaceContext } from '../../src/core/workspace-context.js';
import { EventLogService } from '../../src/core/event-log.js';
import { assembleHistoryFromRows } from '../../src/core/rule-context-assembler.js';
import type { EvolutionLoopEvent } from '../../src/core/evolution-types.js';
import { createStepRegistry, defineFeature } from '../../../principles-core/tests/bdd/support/vitest-bdd.js';
import { resolveFeaturePath } from '../../../principles-core/tests/bdd/support/repo-root.js';

// The OpenClaw host config file lives outside a workspace. Keep that host-owned
// boundary isolated while exercising the real plugin registration, dispatcher,
// handlers, SQLite stores, RuleHost, and trajectory persistence below.
vi.mock('../../src/core/config-health.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/core/config-health.js')>();
  return { ...actual, ensureConversationAccessInConfig: vi.fn(() => false) };
});

const PRINCIPLE_TEXT = 'When shared runtime correction, then follow the owner-approved shared runtime principle.';
const MASKED_TEXT = 'When masked shared overlap, then preserve it through Runtime V2.';
const BUDGET_TEXT = 'When budget omitted shared overlap, then preserve it through Runtime V2.';
const RULE_REASON = 'SHARED_RUNTIME_DENY_523';
const RULE_CODE = `
function evaluate(input) {
  var p = input.action.normalizedPath || '';
  if (p.indexOf('/etc/') === 0) return { decision: 'block', matched: true, reason: '${RULE_REASON}' };
  return { decision: 'allow', matched: false, reason: 'not matched' };
}
var meta = { name: 'shared-runtime-parity', version: '1', ruleId: 'R_SHARED_523', coversCondition: 'all' };
`;
const COMMENT_ONLY_RULE_CODE = `
function evaluate(input) {
  // Legacy note: input.session.recentThinking was retired.
  return { decision: 'allow', matched: false, reason: 'comment is not executable' };
}
var meta = { name: 'comment-only', version: '1', ruleId: 'R_COMMENT_ONLY', coversCondition: 'all' };
`;
const INCOMPATIBLE_RULE_CODE = `
function evaluate(input) {
  if (input.session && input.session.recentThinking === true) {
    return { decision: 'block', matched: true, reason: 'must never execute' };
  }
  return { decision: 'allow', matched: false };
}
var meta = { name: 'incompatible', version: '1', ruleId: 'R_INCOMPATIBLE', coversCondition: 'all' };
`;

type Hook = (...args: unknown[]) => unknown;
const registry = createStepRegistry();
let workspaceDir = '';
let connection: SqliteConnection | undefined;
let hooks = new Map<string, Hook>();
let result: unknown;
let logMessages: string[] = [];
const originalPdWorkspaceDir = process.env.PD_WORKSPACE_DIR;

function apiForWorkspace(): OpenClawPluginApi {
  const logger = { debug(...args: unknown[]) { logMessages.push(args.join(' ')); }, info(...args: unknown[]) { logMessages.push(args.join(' ')); }, warn(...args: unknown[]) { logMessages.push(args.join(' ')); }, error(...args: unknown[]) { logMessages.push(args.join(' ')); } };
  return {
    id: 'principles-disciple', rootDir: workspaceDir, pluginConfig: {},
    config: { plugins: { entries: { 'principles-disciple': { hooks: { allowConversationAccess: true } } } } }, logger,
    registerCommand() {}, registerService() {}, registerTool() {}, registerHttpRoute() {},
    on(event, handler) { hooks.set(event, handler as Hook); },
  };
}

function writeConfig(): void {
  const config = getDefaultPdConfig();
  config.features.abstraction_layer_v1.enabled = true;
  config.features.evolution_worker.enabled = false;
  config.features.correction_observer.enabled = false;
  config.features.internalization_auto_consumer.enabled = false;
  fs.mkdirSync(path.join(workspaceDir, '.pd'), { recursive: true });
  fs.writeFileSync(path.join(workspaceDir, '.pd', 'config.yaml'), yaml.dump(config), 'utf8');
}

function insertArtifact(input: { id: string; kind: 'principle' | 'rule'; principleId: string; ruleId?: string; content: object }): void {
  const now = new Date().toISOString();
  connection!.getDb().prepare(`
    INSERT INTO pi_artifacts (artifact_id, artifact_kind, source_task_id, source_principle_id, source_rule_id, lineage_artifact_ids, validation_status, content_json, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(input.id, input.kind, 'task-shared-523', input.principleId, input.ruleId ?? null, '[]', 'validated', JSON.stringify(input.content), now, now);
}

async function activate(input: { id: string; channel: 'prompt' | 'code_tool_hook'; action: 'prompt_activate' | 'code_tool_hook_live_activate'; target: string }): Promise<void> {
  await new SqliteActivationStateStore(connection!).recordActivation({
    activationId: `act-${input.id}`, idempotencyKey: `${input.id}::${input.channel}`,
    artifactId: input.id, channel: input.channel, action: input.action,
    targetRef: input.target, activatedAt: new Date().toISOString(), deactivatedAt: null,
  });
}

afterEach(() => {
  try { connection?.close(); } catch { /* best effort */ }
  connection = undefined;
  WorkspaceContext.clearCache();
  EventLogService.disposeAll();
  clearPruningMaskCache();
  if (workspaceDir) {
    try { fs.rmSync(workspaceDir, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 }); } catch { /* Windows may retain native SQLite handles briefly */ }
  }
  workspaceDir = '';
  hooks = new Map();
  result = undefined;
  logMessages = [];
  if (originalPdWorkspaceDir === undefined) delete process.env.PD_WORKSPACE_DIR;
  else process.env.PD_WORKSPACE_DIR = originalPdWorkspaceDir;
});

registry.given('an isolated OpenClaw workspace with abstraction_layer_v1 enabled', () => {
  workspaceDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pd-host-runtime-bdd-'));
  process.env.PD_WORKSPACE_DIR = workspaceDir;
  writeConfig();
  fs.mkdirSync(path.join(workspaceDir, '.principles'), { recursive: true });
  fs.writeFileSync(path.join(workspaceDir, '.principles', 'PROFILE.json'), JSON.stringify({ risk_paths: ['/etc'] }), 'utf8');
  connection = new SqliteConnection(workspaceDir);
  connection.getDb();
  // Production startup owns workspace initialization; the after-tool kernel
  // must consume this canonical schema without silently bootstrapping it.
  void WorkspaceContext.fromHookContext({ workspaceDir }).trajectory;
});
registry.given('the OpenClaw plugin is registered through its production entry point', () => {
  plugin.register(apiForWorkspace());
});
registry.given('an approved prompt principle is active', async () => {
  const now = new Date().toISOString();
  const reducer = WorkspaceContext.fromHookContext({ workspaceDir }).evolutionReducer;
  const legacyEvents: EvolutionLoopEvent[] = [
    {
      ts: now,
      type: 'candidate_created',
      data: {
        painId: 'pain-shared-523', painType: 'tool_failure', principleId: 'P_SHARED_523',
        trigger: 'shared runtime correction', action: 'follow the owner-approved shared runtime principle',
        status: 'candidate', evaluability: 'manual_only',
      },
    },
    {
      ts: now,
      type: 'principle_promoted',
      data: { principleId: 'P_SHARED_523', from: 'candidate', to: 'probation', reason: 'bdd fixture', successCount: 0 },
    },
  ];
  for (const event of legacyEvents) reducer.emitSync(event);
  insertArtifact({ id: 'art-prompt-523', kind: 'principle', principleId: 'P_SHARED_523', content: { principleId: 'P_SHARED_523', text: PRINCIPLE_TEXT } });
  await activate({ id: 'art-prompt-523', channel: 'prompt', action: 'prompt_activate', target: 'ledger://P_SHARED_523' });
});
function seedLegacyProbation(input: { id: string; trigger: string; action: string; timestamp: string }): void {
  const reducer = WorkspaceContext.fromHookContext({ workspaceDir }).evolutionReducer;
  reducer.emitSync({
    ts: input.timestamp,
    type: 'candidate_created',
    data: { painId: `pain-${input.id}`, painType: 'tool_failure', principleId: input.id, trigger: input.trigger, action: input.action, status: 'candidate', evaluability: 'manual_only' },
  });
  reducer.emitSync({
    ts: input.timestamp,
    type: 'principle_promoted',
    data: { principleId: input.id, from: 'candidate', to: 'probation', reason: 'bdd fixture', successCount: 0 },
  });
}
registry.given('an overlapping prompt principle is masked from legacy injection', async () => {
  seedLegacyProbation({ id: 'P_MASKED_523', trigger: 'masked shared overlap', action: 'preserve it through Runtime V2', timestamp: new Date().toISOString() });
  appendPruningReview(workspaceDir, { principleId: 'P_MASKED_523', decision: 'archive-candidate', note: 'BDD selected-only dedup' });
  clearPruningMaskCache();
  insertArtifact({ id: 'art-masked-523', kind: 'principle', principleId: 'P_MASKED_523', content: { principleId: 'P_MASKED_523', text: MASKED_TEXT } });
  await activate({ id: 'art-masked-523', channel: 'prompt', action: 'prompt_activate', target: 'ledger://P_MASKED_523' });
});
registry.then('the Runtime V2 directive contains that masked overlap exactly once', () => {
  expectPromptDirectiveExactlyOnce('P_MASKED_523', MASKED_TEXT);
});
registry.given('an overlapping prompt principle is omitted by the legacy prompt budget', async () => {
  const base = Date.now();
  for (let index = 0; index < 4; index += 1) {
    seedLegacyProbation({ id: `P_FILLER_${index}`, trigger: `filler ${index}`, action: 'x'.repeat(950), timestamp: new Date(base + 10_000 - index).toISOString() });
  }
  seedLegacyProbation({ id: 'P_BUDGET_523', trigger: 'budget omitted shared overlap', action: 'preserve it through Runtime V2', timestamp: new Date(base).toISOString() });
  insertArtifact({ id: 'art-budget-523', kind: 'principle', principleId: 'P_BUDGET_523', content: { principleId: 'P_BUDGET_523', text: BUDGET_TEXT } });
  await activate({ id: 'art-budget-523', channel: 'prompt', action: 'prompt_activate', target: 'ledger://P_BUDGET_523' });
});
registry.then('the Runtime V2 directive contains that budget-omitted overlap exactly once', () => {
  expectPromptDirectiveExactlyOnce('P_BUDGET_523', BUDGET_TEXT);
});
function expectPromptDirectiveExactlyOnce(principleId: string, text: string): void {
  if (typeof result !== 'object' || result === null) throw new Error(`Expected prompt result; logs=${logMessages.join('\n')}`);
  const prepend = Object.getOwnPropertyDescriptor(result, 'prependSystemContext')?.value;
  const append = Object.getOwnPropertyDescriptor(result, 'appendSystemContext')?.value;
  if (typeof prepend !== 'string' || typeof append !== 'string') throw new Error('Expected prompt context strings');
  expect(`${prepend}\n${append}`.split(text)).toHaveLength(2);
  expect(prepend).toContain(`<directive id="${principleId}"`);
}
registry.when('OpenClaw builds the next prompt', async () => {
  result = await hooks.get('before_prompt_build')!({ prompt: 'help', messages: [] }, { workspaceDir, sessionId: 'session-prompt-523', agentId: 'main' });
});
registry.then('the returned system context contains that activated principle', () => {
  if (typeof result !== 'object' || result === null || !Object.hasOwn(result, 'prependSystemContext') || !Object.hasOwn(result, 'appendSystemContext')) {
    throw new Error(`Expected production prompt result; logs=${logMessages.join('\n')}`);
  }
  const prepend = Object.getOwnPropertyDescriptor(result, 'prependSystemContext')?.value;
  const append = Object.getOwnPropertyDescriptor(result, 'appendSystemContext')?.value;
  if (typeof prepend !== 'string' || typeof append !== 'string') throw new Error('Expected prompt context strings');
  expect(`${prepend}\n${append}`.split(PRINCIPLE_TEXT)).toHaveLength(2);
  expect(prepend).not.toContain(`<directive id="P_SHARED_523"`);

  EventLogService.disposeAll();
  const logsDir = path.join(workspaceDir, '.state', 'logs');
  const eventsFile = fs.readdirSync(logsDir).find((file) => file.startsWith('events_') && file.endsWith('.jsonl'));
  if (!eventsFile) throw new Error('Expected persisted event log');
  const entries = fs.readFileSync(path.join(logsDir, eventsFile), 'utf8').trim().split('\n').map((line) => JSON.parse(line) as unknown);
  const injection = entries.find((entry) => typeof entry === 'object' && entry !== null && Object.getOwnPropertyDescriptor(entry, 'type')?.value === 'runtime_v2_prompt_activations_injected');
  if (typeof injection !== 'object' || injection === null) throw new Error('Expected Runtime V2 injection metadata');
  const data = Object.getOwnPropertyDescriptor(injection, 'data')?.value;
  expect(data).toEqual(expect.objectContaining({
    injectedCount: 0,
    skipReason: 'all_deduped_against_legacy',
    nextAction: 'legacy evolution reducer already contains these principle IDs',
  }));
});
registry.given('an approved live RuleHost rule is active', async () => {
  insertArtifact({ id: 'art-rule-523', kind: 'rule', principleId: 'P_RULE_523', ruleId: 'R_SHARED_523', content: {
    principleId: 'P_RULE_523', ruleId: 'R_SHARED_523', implementationCode: RULE_CODE,
    goldenTrace: { traceId: 'trace-523', cases: [], createdAt: new Date().toISOString(), version: 1 },
    ruleHostGateDecision: 'accepted_shadow', affectedTools: ['write_file'], painReasonSummary: 'protect system paths',
  } });
  await activate({ id: 'art-rule-523', channel: 'code_tool_hook', action: 'code_tool_hook_live_activate', target: 'impl://R_SHARED_523' });
});
async function activateRuleFixture(input: { artifactId: string; principleId: string; ruleId: string; code: string }): Promise<void> {
  insertArtifact({ id: input.artifactId, kind: 'rule', principleId: input.principleId, ruleId: input.ruleId, content: {
    principleId: input.principleId, ruleId: input.ruleId, implementationCode: input.code,
    goldenTrace: { traceId: `trace-${input.ruleId}`, cases: [], createdAt: new Date().toISOString(), version: 1 },
    ruleHostGateDecision: 'accepted_shadow', affectedTools: ['write_file'], painReasonSummary: 'host-liveness BDD',
  } });
  await activate({ id: input.artifactId, channel: 'code_tool_hook', action: 'code_tool_hook_live_activate', target: `impl://${input.ruleId}` });
}
registry.given('an approved live RuleHost rule mentions recentThinking only in a comment', async () => {
  await activateRuleFixture({ artifactId: 'art-comment-only', principleId: 'P_COMMENT_ONLY', ruleId: 'R_COMMENT_ONLY', code: COMMENT_ONLY_RULE_CODE });
});
registry.given('an approved live RuleHost rule reads the retired recentThinking context', async () => {
  await activateRuleFixture({ artifactId: 'art-incompatible', principleId: 'P_INCOMPATIBLE', ruleId: 'R_INCOMPATIBLE', code: INCOMPATIBLE_RULE_CODE });
});
registry.when('OpenClaw checks a write to a protected system path', async () => {
  result = await hooks.get('before_tool_call')!({ toolName: 'write_file', params: { file_path: '/etc/passwd', content: 'bad' } }, { workspaceDir, sessionId: 'session-gate-523', agentId: 'main' });
});
registry.then('the tool call is denied with the rule reason', () => {
  expect(result, logMessages.join('\n')).toEqual(expect.objectContaining({ block: true, blockReason: expect.stringContaining(RULE_REASON) }));
});
registry.when('OpenClaw checks a write to a safe project path', async () => {
  result = await hooks.get('before_tool_call')!({ toolName: 'write_file', params: { file_path: path.join(workspaceDir, 'safe.txt'), content: 'safe' } }, { workspaceDir, sessionId: 'session-safe-gate-523', agentId: 'main' });
});
registry.then('the tool call is allowed by the evaluated live rule', () => {
  expect(result).toBeUndefined();
  expect(logMessages.join('\n')).not.toContain(RULE_REASON);
  expect(logMessages.join('\n')).not.toContain('activation_db_not_found');
  expect(logMessages.join('\n')).toContain('shared production gate evaluated; liveRules=1 decision=allow');
});
registry.then('the incompatible rule is skipped and the current tool call remains allowed', () => {
  expect(result).toBeUndefined();
  expect(logMessages.join('\n')).toContain('shared production gate evaluated; liveRules=0 decision=allow');
  expect(logMessages.join('\n')).not.toContain('must never execute');
});
registry.then('the Owner can see the activation ID and remediation', () => {
  const logs = logMessages.join('\n');
  expect(logs).toContain('activation=act-art-incompatible');
  expect(logs).toContain('nextAction=');
  expect(logs.toLowerCase()).toContain('deactivate');
});
registry.when('OpenClaw reports an owner pain signal after a tool call', async () => {
  await hooks.get('after_tool_call')!({ toolName: 'pain', params: { input: 'owner correction 523' }, result: {} }, { workspaceDir, sessionId: 'session-pain-523', agentId: 'main' });
});
registry.then('a pain evidence row is persisted in the workspace trajectory', () => {
  const db = new Database(path.join(workspaceDir, '.state', 'trajectory.db'), { readonly: true });
  const row = db.prepare('SELECT source, score, text FROM pain_events WHERE session_id = ?').get('session-pain-523');
  db.close();
  expect(row).toEqual(expect.objectContaining({ source: 'manual', score: 100, text: 'owner correction 523' }));
});
registry.when('OpenClaw reports a failed write to a risky path', async () => {
  result = await hooks.get('after_tool_call')!(
    { toolName: 'write_file', params: { file_path: '/etc/pd-shared-kernel', content: 'unsafe' }, result: { exitCode: 1 }, error: 'EACCES permission denied' },
    { workspaceDir, sessionId: 'session-auto-pain-523', agentId: 'agent-openclaw-523' },
  );
});
registry.then('one lineaged automatic pain and its tool evidence are persisted', () => {
  expect(fs.existsSync(path.join(workspaceDir, '.state', 'trajectory.db')), logMessages.join('\n')).toBe(true);
  const db = new Database(path.join(workspaceDir, '.state', 'trajectory.db'), { readonly: true });
  const tools = db.prepare('SELECT id, session_id, tool_name, outcome, exit_code, error_message, params_json FROM tool_calls WHERE session_id = ?').all('session-auto-pain-523');
  const pains = db.prepare('SELECT session_id, source, score, reason, origin, canonical_pain_id FROM pain_events WHERE session_id = ?').all('session-auto-pain-523');
  db.close();
  expect(tools).toHaveLength(1);
  expect(tools[0]).toEqual(expect.objectContaining({ session_id: 'session-auto-pain-523', tool_name: 'write_file', outcome: 'failure', exit_code: 1, error_message: 'EACCES permission denied' }));
  const paramsJson = String(Object.getOwnPropertyDescriptor(tools[0] as object, 'params_json')?.value);
  expect(JSON.parse(paramsJson)).toEqual({ content: 'unsafe', file_path: '<path:pd-shared-kernel>' });
  const replay = assembleHistoryFromRows([{ id: Number(Object.getOwnPropertyDescriptor(tools[0] as object, 'id')?.value), toolName: 'write_file', outcome: 'failure', paramsJson }], false, workspaceDir);
  expect(replay).toEqual(expect.objectContaining({ status: 'available', calls: [expect.objectContaining({ normalizedPath: '<path:pd-shared-kernel>' })] }));
  expect(pains, JSON.stringify(result)).toHaveLength(1);
  expect(pains[0]).toEqual(expect.objectContaining({ session_id: 'session-auto-pain-523', source: 'tool_failure', score: 70, origin: 'system_infer' }));
  expect(String(Object.getOwnPropertyDescriptor(pains[0] as object, 'reason')?.value)).toContain('write_file');
  expect(String(Object.getOwnPropertyDescriptor(pains[0] as object, 'canonical_pain_id')?.value)).toMatch(/^pain_host_/);
});

defineFeature(
  fs.readFileSync(resolveFeaturePath('docs/specs/features/story-a/openclaw-shared-host-runtime-parity.feature'), 'utf8'),
  registry,
);
