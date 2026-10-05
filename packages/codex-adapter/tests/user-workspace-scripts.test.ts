import { afterEach, describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { getDefaultPdConfig, SqliteActivationStateStore, SqliteConnection } from '@principles/core/runtime-v2';
import { processHookInvocation } from '../src/pd-hook.js';

const roots: string[] = [];
const locator = fileURLToPath(new URL('../../../plugins/principles-disciple/scripts/pd-locate.cjs', import.meta.url));

function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pd-user-scripts-'));
  roots.push(root);
  const home = path.join(root, 'codex-home');
  const project = path.join(root, 'project');
  fs.mkdirSync(path.join(project, '.pd'), { recursive: true });
  fs.writeFileSync(path.join(project, '.pd', 'config.yaml'), 'version: 1');
  return { home, project };
}

function resolve(home: string, project: string) {
  const result = spawnSync(process.execPath, ['-e',
    'const locator=require(process.argv[1]); console.log(JSON.stringify(locator.locateWorkspace(process.argv[2])));',
    locator, project], { encoding: 'utf8', env: { ...process.env, CODEX_HOME: home } });
  expect(result.status).toBe(0);
  return JSON.parse(result.stdout);
}

afterEach(() => {
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

describe('Codex owner controls follow the same user workspace as hooks', () => {
  it('keeps the existing project scope until a user workspace is initialized', () => {
    const { home, project } = fixture();
    expect(resolve(home, project)).toEqual({ ok: true, workspaceDir: project });
  });

  it('reviews and disables the user scope even when the project has its own config', () => {
    const { home, project } = fixture();
    const user = path.join(home, 'pd-workspace');
    fs.mkdirSync(path.join(user, '.pd'), { recursive: true });
    fs.writeFileSync(path.join(user, '.pd', 'config.yaml'), 'version: 1');
    expect(resolve(home, project)).toEqual({ ok: true, workspaceDir: user });
  });

  it('reports a corrupted user configuration instead of silently selecting project rules', () => {
    const { home, project } = fixture();
    fs.mkdirSync(path.join(home, 'pd-workspace', '.pd', 'config.yaml'), { recursive: true });
    expect(resolve(home, project)).toMatchObject({ ok: false, reason: 'user_workspace_config_invalid' });
  });
});

describe('user-level Codex principle injection', () => {
  it('injects the same activated user principle into two projects, including a project with its own config', async () => {
    const { home, project } = fixture();
    const user = path.join(home, 'pd-workspace');
    fs.mkdirSync(path.join(user, '.pd'), { recursive: true });
    fs.writeFileSync(path.join(user, '.pd', 'config.yaml'), JSON.stringify(getDefaultPdConfig()));
    const connection = new SqliteConnection(user);
    try {
      const now = new Date().toISOString();
      connection.getDb().prepare('INSERT INTO pi_artifacts (artifact_id, artifact_kind, source_task_id, source_principle_id, lineage_artifact_ids, validation_status, content_json, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)')
        .run('user-artifact', 'principle', 'user-task', 'P_USER_SCOPE', '[]', 'validated', JSON.stringify({ principleId: 'P_USER_SCOPE', text: 'USER_SCOPE_DIRECTIVE' }), now, now);
      await new SqliteActivationStateStore(connection).recordActivation({ activationId: 'user-activation', idempotencyKey: 'user-prompt', artifactId: 'user-artifact', channel: 'prompt', action: 'prompt_activate', targetRef: 'ledger://P_USER_SCOPE', activatedAt: now, deactivatedAt: null });
      connection.getDb().prepare('INSERT INTO pi_artifacts (artifact_id, artifact_kind, source_task_id, source_principle_id, source_rule_id, lineage_artifact_ids, validation_status, content_json, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)')
        .run('user-rule', 'rule', 'user-task', 'P_USER_SCOPE', 'R_USER_SCOPE', '[]', 'validated', JSON.stringify({ principleId: 'P_USER_SCOPE', ruleId: 'R_USER_SCOPE', implementationCode: `function evaluate(input) { return input.action.normalizedPath === 'protected.txt' ? { decision: 'block', matched: true, reason: 'project_path_protected' } : { decision: 'allow', matched: false, reason: 'safe' }; } var meta={name:'user',version:'1',ruleId:'R_USER_SCOPE',coversCondition:'all'};` }), now, now);
      await new SqliteActivationStateStore(connection).recordActivation({ activationId: 'user-rule-activation', idempotencyKey: 'user-rule', artifactId: 'user-rule', channel: 'code_tool_hook', action: 'code_tool_hook_live_activate', targetRef: 'impl://R_USER_SCOPE', activatedAt: now, deactivatedAt: null });
    } finally { connection.close(); }
    for (const cwd of [project, path.join(project, 'other-project')]) {
      const payload = { hook_event_name: 'UserPromptSubmit', session_id: 'user-scope-session', turn_id: 'user-scope-turn', transcript_path: null, cwd, model: 'gpt-6', permission_mode: 'default', prompt: 'help' };
      const result = await processHookInvocation(JSON.stringify(payload), { CODEX_HOME: home });
      expect(result.stdout).toEqual({ hookSpecificOutput: { hookEventName: 'UserPromptSubmit', additionalContext: expect.stringContaining('USER_SCOPE_DIRECTIVE') } });
      const denied = await processHookInvocation(JSON.stringify({ ...payload, hook_event_name: 'PreToolUse', tool_name: 'write_file', tool_input: { file_path: path.join(cwd, 'protected.txt'), content: 'x' }, tool_use_id: 'project-write' }), { CODEX_HOME: home });
      expect(denied.stdout).toEqual({ hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: 'project_path_protected' } });
      const allowed = await processHookInvocation(JSON.stringify({ ...payload, hook_event_name: 'PreToolUse', tool_name: 'write_file', tool_input: { file_path: 'safe.txt', content: 'x' }, tool_use_id: 'project-safe' }), { CODEX_HOME: home });
      expect(allowed.stdout).toEqual({ hookSpecificOutput: { hookEventName: 'PreToolUse' } });
    }
  });

  it('honors the user kill switch instead of falling back to an enabled project', async () => {
    const { home, project } = fixture();
    const user = path.join(home, 'pd-workspace');
    fs.mkdirSync(path.join(user, '.pd'), { recursive: true });
    const config = getDefaultPdConfig();
    // getDefaultPdConfig shallow-copies `features`, so the inner flag object is
    // shared module state: clone before mutating or later tests read enabled=false.
    const isolated = structuredClone(config);
    isolated.features['host.codex'].enabled = false;
    fs.writeFileSync(path.join(user, '.pd', 'config.yaml'), JSON.stringify(isolated));
    const result = await processHookInvocation(JSON.stringify({ hook_event_name: 'UserPromptSubmit', session_id: 's', turn_id: 't', transcript_path: null, cwd: project, model: 'gpt-6', permission_mode: 'default', prompt: 'help' }), { CODEX_HOME: home });
    expect(result.stdout).toEqual({});
    expect(result.stderr).toEqual([expect.stringContaining('host.codex_disabled')]);
    expect(fs.existsSync(path.join(user, '.pd', 'state.db'))).toBe(false);
  });

  // Cross-drive filesystems (Windows with C:\ tmp and D:\ cwd) cannot express
  // the fixture home as a relative path; POSIX CI and same-drive Windows run it.
  it.skipIf(path.isAbsolute(path.relative(process.cwd(), os.tmpdir())))('accepts a relative CODEX_HOME by resolving it the same way pd-locate does', async () => {
    const { home, project } = fixture();
    const user = path.join(home, 'pd-workspace');
    fs.mkdirSync(path.join(user, '.pd'), { recursive: true });
    fs.writeFileSync(path.join(user, '.pd', 'config.yaml'), JSON.stringify(getDefaultPdConfig()));
    const connection = new SqliteConnection(user);
    try {
      const now = new Date().toISOString();
      connection.getDb().prepare('INSERT INTO pi_artifacts (artifact_id, artifact_kind, source_task_id, source_principle_id, lineage_artifact_ids, validation_status, content_json, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)')
        .run('rel-artifact', 'principle', 'rel-task', 'P_REL_HOME', '[]', 'validated', JSON.stringify({ principleId: 'P_REL_HOME', text: 'USER_SCOPE_DIRECTIVE' }), now, now);
      await new SqliteActivationStateStore(connection).recordActivation({ activationId: 'rel-activation', idempotencyKey: 'rel-prompt', artifactId: 'rel-artifact', channel: 'prompt', action: 'prompt_activate', targetRef: 'ledger://P_REL_HOME', activatedAt: now, deactivatedAt: null });
    } finally { connection.close(); }
    const result = await processHookInvocation(JSON.stringify({ hook_event_name: 'UserPromptSubmit', session_id: 'rel-home-session', turn_id: 'rel-home-turn', transcript_path: null, cwd: project, model: 'gpt-6', permission_mode: 'default', prompt: 'help' }), { CODEX_HOME: path.relative(process.cwd(), home) });
    expect(result.stderr).toEqual([]);
    expect(result.stdout).toEqual({ hookSpecificOutput: { hookEventName: 'UserPromptSubmit', additionalContext: expect.stringContaining('USER_SCOPE_DIRECTIVE') } });
  });
});
