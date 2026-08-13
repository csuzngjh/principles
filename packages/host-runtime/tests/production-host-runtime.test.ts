import { afterEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import * as yaml from 'js-yaml';
import {
  getDefaultPdConfig,
  SqliteActivationStateStore,
  SqliteConnection,
} from '@principles/core/runtime-v2';
import {
  buildActivePrinciplePromptContext,
  createProductionHostRuntime,
  loadPdConfigForPlugin,
  resolveNearestPdWorkspace,
} from '../src/index.js';

const tempDirs: string[] = [];

function tempWorkspace(): string {
  const workspaceDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pd-host-production-'));
  tempDirs.push(workspaceDir);
  fs.mkdirSync(path.join(workspaceDir, '.pd'), { recursive: true });
  fs.writeFileSync(path.join(workspaceDir, '.pd', 'config.yaml'), yaml.dump(getDefaultPdConfig()), 'utf8');
  return workspaceDir;
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
  }
});

describe('shared production workspace and config', () => {
  it('resolves the nearest ancestor containing the exact .pd/config.yaml', () => {
    const outer = tempWorkspace();
    const inner = path.join(outer, 'nested', 'project');
    fs.mkdirSync(inner, { recursive: true });

    expect(resolveNearestPdWorkspace(inner)).toEqual({
      ok: true,
      workspaceDir: outer,
      configPath: path.join(outer, '.pd', 'config.yaml'),
      source: 'nearest',
    });
  });

  it('fails loud for relative cwd and missing config with a next action', () => {
    expect(resolveNearestPdWorkspace('relative/path')).toMatchObject({
      ok: false,
      reason: 'cwd_not_absolute',
      nextAction: expect.stringContaining('absolute'),
    });
    const missing = fs.mkdtempSync(path.join(os.tmpdir(), 'pd-host-missing-'));
    tempDirs.push(missing);
    expect(resolveNearestPdWorkspace(missing)).toMatchObject({
      ok: false,
      reason: 'config_not_found',
      nextAction: expect.stringContaining('.pd/config.yaml'),
    });
  });

  it('loads explicit rollout flags and reports malformed YAML without coercing to success', () => {
    const workspaceDir = tempWorkspace();
    const config = getDefaultPdConfig();
    config.features['host.codex'].enabled = false;
    config.features.abstraction_layer_v1.enabled = false;
    fs.writeFileSync(path.join(workspaceDir, '.pd', 'config.yaml'), yaml.dump(config), 'utf8');
    expect(loadPdConfigForPlugin(workspaceDir)).toMatchObject({
      ok: true,
      source: 'user_config',
      effective: { config: { features: {
        'host.codex': { enabled: false },
        abstraction_layer_v1: { enabled: false },
      } } },
    });

    fs.writeFileSync(path.join(workspaceDir, '.pd', 'config.yaml'), 'features: [unterminated', 'utf8');
    expect(loadPdConfigForPlugin(workspaceDir)).toMatchObject({
      ok: false,
      source: 'malformed',
      errors: [{ reason: expect.stringContaining('YAML parse error'), nextAction: expect.stringContaining('Fix YAML') }],
    });
  });
});

describe('shared production active-principle prompt kernel', () => {
  it('dispatches through the production runtime and reads a real activation plus artifact', async () => {
    const workspaceDir = tempWorkspace();
    const connection = new SqliteConnection(workspaceDir);
    try {
      const now = new Date().toISOString();
      connection.getDb().prepare(`
        INSERT INTO pi_artifacts (artifact_id, artifact_kind, source_task_id, source_principle_id, source_rule_id, lineage_artifact_ids, validation_status, content_json, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run('art-shared-prompt', 'principle', 'task-shared-prompt', 'P_SHARED_PROMPT', null, '[]', 'validated', JSON.stringify({
        principleId: 'P_SHARED_PROMPT', text: 'UNIQUE_SHARED_PRODUCTION_PROMPT_TEXT',
      }), now, now);
      await new SqliteActivationStateStore(connection).recordActivation({
        activationId: 'act-shared-prompt', idempotencyKey: 'shared-prompt::prompt', artifactId: 'art-shared-prompt',
        channel: 'prompt', action: 'prompt_activate', targetRef: 'ledger://P_SHARED_PROMPT',
        activatedAt: now, deactivatedAt: null,
      });
    } finally {
      connection.close();
    }

    const runtime = createProductionHostRuntime({
      beforeToolCall: async (event) => ({ decision: 'allow', source: event.source }),
      afterToolCall: async (event) => ({ decision: 'observe', source: event.source }),
    });
    const result = await runtime.dispatch({
      kind: 'before_prompt_build', context: { workspaceDir, sessionId: 'session-shared-prompt' },
      rawPayload: {}, source: 'test:production-prompt',
    });

    expect(result).toMatchObject({
      decision: 'modify',
      source: 'test:production-prompt',
      additionalContext: expect.stringContaining('UNIQUE_SHARED_PRODUCTION_PROMPT_TEXT'),
    });
    await expect(buildActivePrinciplePromptContext({
      workspaceDir,
      excludePrincipleIds: new Set(['P_SHARED_PROMPT']),
    })).resolves.toMatchObject({ additionalContext: '', principleIds: [] });
  });

  it('omits invalid artifacts with an observable warning and bounds rendered output', async () => {
    const workspaceDir = tempWorkspace();
    const connection = new SqliteConnection(workspaceDir);
    try {
      const now = new Date().toISOString();
      connection.getDb().prepare(`
        INSERT INTO pi_artifacts (artifact_id, artifact_kind, source_task_id, source_principle_id, source_rule_id, lineage_artifact_ids, validation_status, content_json, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run('art-invalid-prompt', 'principle', 'task-invalid-prompt', 'P_INVALID_PROMPT', null, '[]', 'validated', '{bad-json', now, now);
      await new SqliteActivationStateStore(connection).recordActivation({
        activationId: 'act-invalid-prompt', idempotencyKey: 'invalid-prompt::prompt', artifactId: 'art-invalid-prompt',
        channel: 'prompt', action: 'prompt_activate', targetRef: 'ledger://P_INVALID_PROMPT',
        activatedAt: now, deactivatedAt: null,
      });
    } finally {
      connection.close();
    }

    const result = await buildActivePrinciplePromptContext({ workspaceDir });
    expect(result.additionalContext).toBe('');
    expect(result.principleIds).toEqual([]);
    expect(result.warnings.join('\n')).toContain('artifact_content_json_parse_error');
    expect(result.additionalContext.length).toBeLessThanOrEqual(result.budget);
  });

  it('excludes deactivated principles and keeps many short active directives within the production prompt cap', async () => {
    const workspaceDir = tempWorkspace();
    const connection = new SqliteConnection(workspaceDir);
    try {
      const now = new Date().toISOString();
      const artifactInsert = connection.getDb().prepare(`
        INSERT INTO pi_artifacts (artifact_id, artifact_kind, source_task_id, source_principle_id, source_rule_id, lineage_artifact_ids, validation_status, content_json, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `);
      const store = new SqliteActivationStateStore(connection);
      for (let index = 0; index < 100; index += 1) {
        const artifactId = `art-bounded-${index}`;
        const principleId = `P_BOUNDED_${index}`;
        artifactInsert.run(artifactId, 'principle', `task-bounded-${index}`, principleId, null, '[]', 'validated', JSON.stringify({ principleId, text: `short-${index}` }), now, now);
        await store.recordActivation({ activationId: `act-bounded-${index}`, idempotencyKey: `${artifactId}::prompt`, artifactId, channel: 'prompt', action: 'prompt_activate', targetRef: `ledger://${principleId}`, activatedAt: now, deactivatedAt: null });
      }
      expect(await store.deactivateActivation('act-bounded-0', now)).toBe(true);
    } finally {
      connection.close();
    }

    const result = await buildActivePrinciplePromptContext({ workspaceDir });
    expect(result.additionalContext).not.toContain('P_BOUNDED_0"');
    expect(result.additionalContext.length).toBeLessThanOrEqual(9_000);
  });
});
