import { afterEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import Database from 'better-sqlite3';
import { getDefaultPdConfig, SqliteActivationStateStore, SqliteConnection } from '@principles/core/runtime-v2';
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
async function artifact(root: string, input: { id: string; kind: 'principle' | 'rule'; principleId: string; ruleId?: string; content: object; channel: 'prompt' | 'code_tool_hook'; action: 'prompt_activate' | 'code_tool_hook_live_activate'; target: string }) {
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
