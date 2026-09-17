import { afterEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import Database from 'better-sqlite3';
import { getDefaultPdConfig, SqliteActivationStateStore, SqliteConnection, summarizeRuleCodeShadowEvents } from '@principles/core/runtime-v2';
import { createStepRegistry, defineFeature } from '../../principles-core/tests/bdd/support/vitest-bdd.js';
import { resolveFeaturePath } from '../../principles-core/tests/bdd/support/repo-root.js';

const dirs: string[] = [];
function workspace(enabled = true): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pd-codex-production-')); dirs.push(root);
  fs.mkdirSync(path.join(root, '.pd'), { recursive: true });
  const config = getDefaultPdConfig(); config.features['host.codex'].enabled = enabled;
  fs.writeFileSync(path.join(root, '.pd', 'config.yaml'), JSON.stringify(config));
  return root;
}
function invoke(payload: unknown) {
  // fileURLToPath instead of import.meta.dirname: dirname needs Node >=20.11
  // while ADR-0020 declares Node >=20 for the host runtime.
  const hookEntry = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'dist', 'pd-hook.js');
  return spawnSync(process.execPath, [hookEntry], { input: JSON.stringify(payload), encoding: 'utf8' });
}
function base(root: string) { return { session_id: 'codex-session-523', turn_id: 'codex-turn-523', transcript_path: null, cwd: root, model: 'gpt-5.6', permission_mode: 'default' }; }
async function artifact(root: string, input: { id: string; kind: 'principle' | 'rule'; principleId: string; ruleId?: string; content: object; channel: 'prompt' | 'code_tool_hook'; action: 'prompt_activate' | 'code_tool_hook_live_activate' | 'code_tool_hook_shadow_activate'; target: string }) {
  const connection = new SqliteConnection(root);
  try {
    const now = new Date().toISOString();
    connection.getDb().prepare(`INSERT INTO pi_artifacts (artifact_id, artifact_kind, source_task_id, source_principle_id, source_rule_id, lineage_artifact_ids, validation_status, content_json, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(input.id, input.kind, `task-${input.id}`, input.principleId, input.ruleId ?? null, '[]', 'validated', JSON.stringify(input.content), now, now);
    await new SqliteActivationStateStore(connection).recordActivation({ activationId: `act-${input.id}`, idempotencyKey: `${input.id}::${input.channel}`, artifactId: input.id, channel: input.channel, action: input.action, targetRef: input.target, activatedAt: now, deactivatedAt: null });
  } finally { connection.close(); }
}
function trajectory(root: string): void {
  fs.mkdirSync(path.join(root, '.state'), { recursive: true });
  const db = new Database(path.join(root, '.state', 'trajectory.db'));
  db.exec(`
    CREATE TABLE sessions (session_id TEXT PRIMARY KEY, started_at TEXT NOT NULL, updated_at TEXT NOT NULL);
    CREATE TABLE tool_calls (id INTEGER PRIMARY KEY AUTOINCREMENT, session_id TEXT NOT NULL, tool_name TEXT NOT NULL, outcome TEXT NOT NULL, duration_ms INTEGER, exit_code INTEGER, error_type TEXT, error_message TEXT, gfi_before REAL, gfi_after REAL, params_json TEXT NOT NULL, result_preview TEXT, created_at TEXT NOT NULL);
    CREATE TABLE pain_events (id INTEGER PRIMARY KEY AUTOINCREMENT, session_id TEXT NOT NULL, source TEXT NOT NULL, score REAL NOT NULL, reason TEXT, severity TEXT, origin TEXT, confidence REAL, text TEXT, canonical_pain_id TEXT, runtime_task_id TEXT, host_kind TEXT, created_at TEXT NOT NULL);
    CREATE UNIQUE INDEX idx_pain_events_canonical_pain_id ON pain_events(canonical_pain_id) WHERE canonical_pain_id IS NOT NULL;
  `);
  db.close();
}
afterEach(() => { for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true }); });

describe('pd-hook executable shared MVP paths', () => {
  it('injects a real owner-approved prompt activation from SQLite', async () => {
    const root = workspace();
    await artifact(root, { id: 'art-prompt-523', kind: 'principle', principleId: 'P_CODEX_PROMPT_523', content: { principleId: 'P_CODEX_PROMPT_523', text: 'UNIQUE_CODEX_PROMPT_DIRECTIVE_523' }, channel: 'prompt', action: 'prompt_activate', target: 'ledger://P_CODEX_PROMPT_523' });
    const result = invoke({ ...base(root), hook_event_name: 'UserPromptSubmit', prompt: 'help' });
    expect(result.status).toBe(0); expect(result.stdout.trim().split(/\r?\n/)).toHaveLength(1);
    expect(JSON.parse(result.stdout)).toEqual({ hookSpecificOutput: { hookEventName: 'UserPromptSubmit', additionalContext: expect.stringContaining('UNIQUE_CODEX_PROMPT_DIRECTIVE_523') } });
  });

  it('denies a protected live RuleCode input and allows the safe control', async () => {
    const root = workspace();
    await artifact(root, { id: 'art-rule-523', kind: 'rule', principleId: 'P_CODEX_RULE_523', ruleId: 'R_CODEX_RULE_523', content: { principleId: 'P_CODEX_RULE_523', ruleId: 'R_CODEX_RULE_523', implementationCode: `function evaluate(input) { if (input.action.normalizedPath.indexOf('forbidden-523') >= 0) return { decision: 'block', matched: true, reason: 'CODEX_RULE_DENY_523' }; return { decision: 'allow', matched: false, reason: 'safe' }; } var meta={name:'codex',version:'1',ruleId:'R_CODEX_RULE_523',coversCondition:'all'};` }, channel: 'code_tool_hook', action: 'code_tool_hook_live_activate', target: 'impl://R_CODEX_RULE_523' });
    const denied = invoke({ ...base(root), hook_event_name: 'PreToolUse', tool_name: 'write_file', tool_input: { file_path: path.join(root, 'forbidden-523.txt'), content: 'x' }, tool_use_id: 'call-deny' });
    expect(JSON.parse(denied.stdout)).toEqual({ hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: 'CODEX_RULE_DENY_523' } });
    const allowed = invoke({ ...base(root), hook_event_name: 'PreToolUse', tool_name: 'write_file', tool_input: { file_path: path.join(root, 'safe.txt'), content: 'x' }, tool_use_id: 'call-safe' });
    expect(JSON.parse(allowed.stdout)).toEqual({ hookSpecificOutput: { hookEventName: 'PreToolUse' } });
  });

  it('persists exact PostToolUse evidence once in the selected Workspace', () => {
    const root = workspace(); trajectory(root);
    const payload = { ...base(root), hook_event_name: 'PostToolUse', tool_name: 'write_file', tool_input: { file_path: path.join(root, 'risky-523.txt'), content: 'x' }, tool_response: { exitCode: 1, error: 'EACCES' }, tool_use_id: 'call-post' };
    const result = invoke(payload);
    expect(result.status).toBe(0); expect(JSON.parse(result.stdout)).toEqual({ hookSpecificOutput: { hookEventName: 'PostToolUse' } });
    const db = new Database(path.join(root, '.state', 'trajectory.db'), { readonly: true });
    const rows = db.prepare('SELECT session_id, tool_name, outcome, exit_code FROM tool_calls').all(); db.close();
    expect(rows).toEqual([{ session_id: 'codex-session-523', tool_name: 'write_file', outcome: 'failure', exit_code: 1 }]);
  });

  it('creates no workspace state when host.codex is disabled (flag-off no-side-effect)', () => {
    // mvp-q-3 rollback path: flag-off must mean {} + exit 0 + a stderr skip
    // reason and NO DB bootstrap — an enabled PostToolUse would have created
    // .state/trajectory.db, so its absence proves no business side effects.
    const root = workspace(false);
    const result = invoke({ ...base(root), hook_event_name: 'PostToolUse', tool_name: 'write_file', tool_input: { file_path: path.join(root, 'blocked.txt'), content: 'x' }, tool_response: { exitCode: 1, error: 'EACCES' }, tool_use_id: 'call-flag-off' });
    expect(result.status).toBe(0);
    expect(JSON.parse(result.stdout)).toEqual({});
    expect(result.stderr.trim()).toEqual(expect.stringContaining('host.codex_disabled'));
    expect(fs.existsSync(path.join(root, '.state'))).toBe(false);
  });
});

describe('PRI-780 Codex runtime context capability declaration (v2 rules)', () => {
  const V2_DECL_RULE_CODE = `function evaluate(input) { if (input.action.normalizedPath.indexOf('ctxdecl-always-780') >= 0) return { decision: 'block', matched: true, reason: 'CODEX_V2_LOADED_780' }; return { decision: 'allow', matched: false, reason: 'not target' }; } var meta = { name: 'codex-v2-decl', version: '1', ruleId: 'R_CODEX_V2_DECL_780', coversCondition: 'all' };`;
  function workspaceWithRuleContext(v2Enabled: boolean): string {
    const root = workspace();
    const config = getDefaultPdConfig();
    config.features['host.codex'].enabled = true;
    config.features['rulecode_context_v2'].enabled = v2Enabled;
    fs.writeFileSync(path.join(root, '.pd', 'config.yaml'), JSON.stringify(config));
    return root;
  }
  async function v2Rule(root: string): Promise<void> {
    await artifact(root, { id: 'art-rule-780', kind: 'rule', principleId: 'P_CODEX_V2_780', ruleId: 'R_CODEX_V2_DECL_780', content: { principleId: 'P_CODEX_V2_780', ruleId: 'R_CODEX_V2_DECL_780', requiresContextVersion: 2, implementationCode: V2_DECL_RULE_CODE }, channel: 'code_tool_hook', action: 'code_tool_hook_live_activate', target: 'impl://R_CODEX_V2_DECL_780' });
  }

  it('PRI-780 (rev 2): a v2 rule stays SUSPENDED on Codex — never executed context-blind — with the structured unsupported warning', async () => {
    // Codex review round 2 P1: the unavailable→allow contract is prompt-level
    // discipline, not runtime-enforced; this rule blocks WITHOUT inspecting
    // context, so if it were loaded it would deny. The allow here proves the
    // suspension, and the stderr annotation makes the unsupported declaration
    // explicit (never a silent skip).
    const root = workspaceWithRuleContext(true);
    await v2Rule(root);
    const suspended = invoke({ ...base(root), hook_event_name: 'PreToolUse', tool_name: 'write_file', tool_input: { file_path: path.join(root, 'ctxdecl-always-780.txt'), content: 'x' }, tool_use_id: 'call-suspended' });
    expect(JSON.parse(suspended.stdout)).toEqual({ hookSpecificOutput: { hookEventName: 'PreToolUse' } });
    expect(suspended.stderr).toContain('rule_context_v2_unavailable');
    expect(suspended.stderr).toContain('codex_runtime_context_unsupported');
  });

  it('flag OFF (kill switch): the same v2 rule is suspended with the structured warning, not silently enforced', async () => {
    const root = workspaceWithRuleContext(false);
    await v2Rule(root);
    const suspended = invoke({ ...base(root), hook_event_name: 'PreToolUse', tool_name: 'write_file', tool_input: { file_path: path.join(root, 'ctxdecl-always-780.txt'), content: 'x' }, tool_use_id: 'call-suspended' });
    expect(JSON.parse(suspended.stdout)).toEqual({ hookSpecificOutput: { hookEventName: 'PreToolUse' } });
    expect(suspended.stderr).toContain('rule_context_v2_unavailable');
  });
});

describe('PRI-813 shared shadow evidence reconnection', () => {
  const SHADOW_RULE_CODE_813 = (ruleId: string, marker: string) => `function evaluate(input) { if (input.action.normalizedPath.indexOf('${marker}') >= 0) return { decision: 'block', matched: true, reason: 'CODEX_SHADOW_WOULD_BLOCK_813' }; return { decision: 'allow', matched: false, reason: 'safe' }; } var meta={name:'codex-shadow-813',version:'1',ruleId:'${ruleId}',coversCondition:'all'};`;

  function readRuleHostEvaluated(root: string): { ts: string; type: string; category: string; sessionId: string | undefined; data: Record<string, unknown> }[] {
    const logsDir = path.join(root, '.state', 'logs');
    if (!fs.existsSync(logsDir)) return [];
    const rows: { ts: string; type: string; category: string; sessionId: string | undefined; data: Record<string, unknown> }[] = [];
    for (const file of fs.readdirSync(logsDir).filter(name => name.startsWith('events_') && name.endsWith('.jsonl'))) {
      for (const line of fs.readFileSync(path.join(logsDir, file), 'utf8').split(/\r?\n/)) {
        if (line.trim().length === 0) continue;
        const parsed = JSON.parse(line) as { type?: string };
        if (parsed.type === 'rulehost_evaluated') rows.push(parsed as { ts: string; type: string; category: string; sessionId: string | undefined; data: Record<string, unknown> });
      }
    }
    return rows;
  }

  it('records canonical shadow rulehost_evaluated evidence with the exact activationId while the host action stays allowed', async () => {
    const root = workspace();
    await artifact(root, { id: 'art-shadow-813', kind: 'rule', principleId: 'P_CODEX_SHADOW_813', ruleId: 'R_CODEX_SHADOW_813', content: { principleId: 'P_CODEX_SHADOW_813', ruleId: 'R_CODEX_SHADOW_813', implementationCode: SHADOW_RULE_CODE_813('R_CODEX_SHADOW_813', 'shadow-blocked-813') }, channel: 'code_tool_hook', action: 'code_tool_hook_shadow_activate', target: 'impl://R_CODEX_SHADOW_813' });
    // The RuleCode returns block/matched for this path; shadow semantics mean
    // the evidence row MUST say block while the actual host outcome is allow.
    const result = invoke({ ...base(root), hook_event_name: 'PreToolUse', tool_name: 'write_file', tool_input: { file_path: path.join(root, 'shadow-blocked-813.txt'), content: 'x' }, tool_use_id: 'call-shadow-813' });
    expect(JSON.parse(result.stdout)).toEqual({ hookSpecificOutput: { hookEventName: 'PreToolUse' } });
    const rows = readRuleHostEvaluated(root);
    expect(rows.some(row => row.data['activationMode'] === 'shadow'
      && row.data['activationId'] === 'act-art-shadow-813'
      && row.data['ruleId'] === 'R_CODEX_SHADOW_813'
      && row.data['matched'] === true
      && row.data['decision'] === 'block'
      && row.data['toolName'] === 'write_file'
      && row.category === 'evaluated'
      && row.sessionId === 'codex-session-523')).toBe(true);
  });

  it('records the live evaluation row with its exact activationId on a live deny', async () => {
    const root = workspace();
    await artifact(root, { id: 'art-live-813', kind: 'rule', principleId: 'P_CODEX_LIVE_813', ruleId: 'R_CODEX_LIVE_813', content: { principleId: 'P_CODEX_LIVE_813', ruleId: 'R_CODEX_LIVE_813', implementationCode: SHADOW_RULE_CODE_813('R_CODEX_LIVE_813', 'live-blocked-813') }, channel: 'code_tool_hook', action: 'code_tool_hook_live_activate', target: 'impl://R_CODEX_LIVE_813' });
    const result = invoke({ ...base(root), hook_event_name: 'PreToolUse', tool_name: 'write_file', tool_input: { file_path: path.join(root, 'live-blocked-813.txt'), content: 'x' }, tool_use_id: 'call-live-813' });
    expect(JSON.parse(result.stdout)).toEqual({ hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: 'CODEX_SHADOW_WOULD_BLOCK_813' } });
    const rows = readRuleHostEvaluated(root);
    expect(rows.some(row => row.data['activationMode'] === 'live'
      && row.data['activationId'] === 'act-art-live-813'
      && row.data['matched'] === true
      && row.data['decision'] === 'block')).toBe(true);
  });

  it.each(['', '   '])('rejects shadow activationId %j with a diagnostic and preserves host allow', async (activationId) => {
    const root = workspace();
    const connection = new SqliteConnection(root);
    try {
      const now = new Date().toISOString();
      connection.getDb().prepare(`
        INSERT INTO pi_artifacts (artifact_id, artifact_kind, source_task_id, source_principle_id, source_rule_id, lineage_artifact_ids, validation_status, content_json, created_at, updated_at)
        VALUES ('art-blank-813', 'rule', 'task-blank-813', 'P_CODEX_BLANK_813', 'R_CODEX_BLANK_813', '[]', 'validated', ?, ?, ?)
      `).run(JSON.stringify({ principleId: 'P_CODEX_BLANK_813', ruleId: 'R_CODEX_BLANK_813', implementationCode: SHADOW_RULE_CODE_813('R_CODEX_BLANK_813', 'blank-id-813') }), now, now);
      await new SqliteActivationStateStore(connection).recordActivation({ activationId, idempotencyKey: 'blank::shadow', artifactId: 'art-blank-813', channel: 'code_tool_hook', action: 'code_tool_hook_shadow_activate', targetRef: 'impl://R_CODEX_BLANK_813', activatedAt: now, deactivatedAt: null });
    } finally { connection.close(); }

    const result = invoke({ ...base(root), hook_event_name: 'PreToolUse', tool_name: 'write_file', tool_input: { file_path: path.join(root, 'blank-id-813.txt'), content: 'x' }, tool_use_id: 'call-blank-813' });
    expect(JSON.parse(result.stdout)).toEqual({ hookSpecificOutput: { hookEventName: 'PreToolUse' } });
    expect(readRuleHostEvaluated(root).filter(row => row.data['activationMode'] === 'shadow')).toEqual([]);
    expect(result.stderr).toContain('rulehost_evaluation_entry_invalid');
  });

  it('keeps the computed deny when telemetry persistence fails (CR-1): fs failure degrades to a diagnostic, never drops the decision', async () => {
    const root = workspace();
    await artifact(root, { id: 'art-persist-813', kind: 'rule', principleId: 'P_CODEX_PERSIST_813', ruleId: 'R_CODEX_PERSIST_813', content: { principleId: 'P_CODEX_PERSIST_813', ruleId: 'R_CODEX_PERSIST_813', implementationCode: SHADOW_RULE_CODE_813('R_CODEX_PERSIST_813', 'persist-blocked-813') }, channel: 'code_tool_hook', action: 'code_tool_hook_live_activate', target: 'impl://R_CODEX_PERSIST_813' });
    // Real fs failure at the writer: the events file path is a DIRECTORY, so
    // appendFileSync throws. On the pre-CR-1 code this throw escaped
    // recordRuleHostEvaluations into processHookInvocation's fail-open catch,
    // which replaced the already-computed deny with `{}` on stdout and let
    // the tool call proceed. PreToolUse reaches this writer before anything
    // else touches .state/logs, so the failure is attributable exactly to the
    // evidence writer.
    const today = new Date().toISOString().slice(0, 10);
    fs.mkdirSync(path.join(root, '.state', 'logs', `events_${today}.jsonl`), { recursive: true });

    const result = invoke({ ...base(root), hook_event_name: 'PreToolUse', tool_name: 'write_file', tool_input: { file_path: path.join(root, 'persist-blocked-813.txt'), content: 'x' }, tool_use_id: 'call-persist-813' });
    expect(JSON.parse(result.stdout)).toEqual({ hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: 'CODEX_SHADOW_WOULD_BLOCK_813' } });
    expect(result.stderr).toContain('rulehost_evaluation_persist_failed');
  });

  it('keeps a v2 shadow rule suspended: zero shadow evidence, structured warning (Codex v2 boundary extends to shadow)', async () => {
    const root = workspace();
    await artifact(root, { id: 'art-v2shadow-813', kind: 'rule', principleId: 'P_CODEX_V2SHADOW_813', ruleId: 'R_CODEX_V2SHADOW_813', content: { principleId: 'P_CODEX_V2SHADOW_813', ruleId: 'R_CODEX_V2SHADOW_813', requiresContextVersion: 2, implementationCode: SHADOW_RULE_CODE_813('R_CODEX_V2SHADOW_813', 'v2shadow-813') }, channel: 'code_tool_hook', action: 'code_tool_hook_shadow_activate', target: 'impl://R_CODEX_V2SHADOW_813' });
    const result = invoke({ ...base(root), hook_event_name: 'PreToolUse', tool_name: 'write_file', tool_input: { file_path: path.join(root, 'v2shadow-813.txt'), content: 'x' }, tool_use_id: 'call-v2shadow-813' });
    expect(JSON.parse(result.stdout)).toEqual({ hookSpecificOutput: { hookEventName: 'PreToolUse' } });
    expect(result.stderr).toContain('rule_context_v2_unavailable');
    expect(result.stderr).toContain('codex_runtime_context_unsupported');
    expect(readRuleHostEvaluated(root).filter(row => row.data['activationMode'] === 'shadow')).toEqual([]);
  });

  it('isolates two shadow activations into two exact-identity evidence rows the shadow summary can aggregate separately', async () => {
    const root = workspace();
    await artifact(root, { id: 'art-shadow-a-813', kind: 'rule', principleId: 'P_CODEX_SHADOW_A_813', ruleId: 'R_CODEX_SHADOW_A_813', content: { principleId: 'P_CODEX_SHADOW_A_813', ruleId: 'R_CODEX_SHADOW_A_813', implementationCode: SHADOW_RULE_CODE_813('R_CODEX_SHADOW_A_813', 'shadow-iso-813') }, channel: 'code_tool_hook', action: 'code_tool_hook_shadow_activate', target: 'impl://R_CODEX_SHADOW_A_813' });
    await artifact(root, { id: 'art-shadow-b-813', kind: 'rule', principleId: 'P_CODEX_SHADOW_B_813', ruleId: 'R_CODEX_SHADOW_B_813', content: { principleId: 'P_CODEX_SHADOW_B_813', ruleId: 'R_CODEX_SHADOW_B_813', implementationCode: SHADOW_RULE_CODE_813('R_CODEX_SHADOW_B_813', 'shadow-iso-813') }, channel: 'code_tool_hook', action: 'code_tool_hook_shadow_activate', target: 'impl://R_CODEX_SHADOW_B_813' });
    const result = invoke({ ...base(root), hook_event_name: 'PreToolUse', tool_name: 'write_file', tool_input: { file_path: path.join(root, 'shadow-iso-813.txt'), content: 'x' }, tool_use_id: 'call-iso-813' });
    expect(JSON.parse(result.stdout)).toEqual({ hookSpecificOutput: { hookEventName: 'PreToolUse' } });
    const rows = readRuleHostEvaluated(root).filter(row => row.data['activationMode'] === 'shadow');
    expect(rows.map(row => row.data['activationId']).sort()).toEqual(['act-art-shadow-a-813', 'act-art-shadow-b-813']);
    // The existing promotion-evidence aggregator keys on the exact
    // activationId: evidence for A must not count B.
    expect(summarizeRuleCodeShadowEvents(rows, 'act-art-shadow-a-813')).toEqual(expect.objectContaining({ observed: 1, matched: 1, wouldBlock: 1 }));
    expect(summarizeRuleCodeShadowEvents(rows, 'act-art-shadow-b-813')).toEqual(expect.objectContaining({ observed: 1, matched: 1, wouldBlock: 1 }));
  });
});

const registry = createStepRegistry();
let bddRoot = '';
let bddResult: ReturnType<typeof invoke>;
registry.given('an isolated Codex Workspace with host.codex enabled and approved behavior', async () => {
  bddRoot = workspace(); trajectory(bddRoot);
  await artifact(bddRoot, { id: 'art-bdd-prompt', kind: 'principle', principleId: 'P_CODEX_BDD_523', content: { principleId: 'P_CODEX_BDD_523', text: 'CODEX_BDD_PROMPT_523' }, channel: 'prompt', action: 'prompt_activate', target: 'ledger://P_CODEX_BDD_523' });
  await artifact(bddRoot, { id: 'art-bdd-rule', kind: 'rule', principleId: 'P_CODEX_BDD_RULE', ruleId: 'R_CODEX_BDD_523', content: { principleId: 'P_CODEX_BDD_RULE', ruleId: 'R_CODEX_BDD_523', implementationCode: `function evaluate(input) { return input.action.normalizedPath.indexOf('blocked-bdd-523') >= 0 ? { decision:'block', matched:true, reason:'CODEX_BDD_DENY_523' } : { decision:'allow', matched:false, reason:'safe' }; } var meta={name:'bdd',version:'1',ruleId:'R_CODEX_BDD_523',coversCondition:'all'};` }, channel: 'code_tool_hook', action: 'code_tool_hook_live_activate', target: 'impl://R_CODEX_BDD_523' });
});
registry.when('Codex submits a prompt through the production hook executable', () => { bddResult = invoke({ ...base(bddRoot), hook_event_name: 'UserPromptSubmit', prompt: 'help' }); });
registry.then('the approved prompt directive is returned in the exact Codex schema', () => { expect(JSON.parse(bddResult.stdout)).toEqual({ hookSpecificOutput: { hookEventName: 'UserPromptSubmit', additionalContext: expect.stringContaining('CODEX_BDD_PROMPT_523') } }); });
registry.when('Codex invokes a protected tool through the production hook executable', () => { bddResult = invoke({ ...base(bddRoot), hook_event_name: 'PreToolUse', tool_name: 'write_file', tool_input: { file_path: path.join(bddRoot, 'blocked-bdd-523.txt') }, tool_use_id: 'bdd-deny' }); });
registry.then('the live owner-approved rule denies it with its exact reason', () => { expect(JSON.parse(bddResult.stdout)).toEqual({ hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: 'CODEX_BDD_DENY_523' } }); });
registry.when('Codex reports a failed tool through the production hook executable', () => { bddResult = invoke({ ...base(bddRoot), hook_event_name: 'PostToolUse', tool_name: 'write_file', tool_input: { file_path: path.join(bddRoot, 'failed.txt') }, tool_response: { exitCode: 1 }, tool_use_id: 'bdd-post' }); });
registry.then('one tool evidence row is persisted in that Codex Workspace', () => { const db = new Database(path.join(bddRoot, '.state', 'trajectory.db'), { readonly: true }); const count = db.prepare('SELECT COUNT(*) AS count FROM tool_calls WHERE session_id = ?').get('codex-session-523'); db.close(); expect(count).toEqual({ count: 1 }); });

defineFeature(fs.readFileSync(resolveFeaturePath('docs/specs/features/story-a/codex-shared-host-runtime.feature'), 'utf8'), registry);
