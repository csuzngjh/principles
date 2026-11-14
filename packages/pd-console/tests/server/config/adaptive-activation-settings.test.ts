/**
 * Adaptive Activation — Console settings entry (Codex desktop, append-only v1).
 *
 * These tests exercise the REAL store + model over throwaway workspaces:
 * workspace isolation, zero-network saves, the three honest empty states, the
 * blocking-warning rule, and the append-only refusal boundary.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as yaml from 'js-yaml';
import { SqliteActivationStateStore, SqliteConnection, getDefaultPdConfig } from '@principles/core/runtime';
import {
  loadPdConfig,
  updateAdaptiveActivationSettings,
  updateFeatureFlag,
  ADAPTIVE_ACTIVATION_SERVICE_PRESET,
} from '../../../src/server/config/pd-config-store.js';
import { AdaptiveActivationConsoleModel } from '../../../src/server/models/AdaptiveActivationConsoleModel.js';

const workspaces: string[] = [];
afterEach(() => {
  for (const dir of workspaces.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
  vi.restoreAllMocks();
});

function makeWorkspace(label: string): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), `pd-aa-console-${label}-`));
  workspaces.push(root);
  fs.mkdirSync(path.join(root, '.pd'), { recursive: true });
  return root;
}

function writeConfig(root: string, mutate?: (config: ReturnType<typeof getDefaultPdConfig>) => void): void {
  const config = getDefaultPdConfig();
  mutate?.(config);
  fs.writeFileSync(path.join(root, '.pd', 'config.yaml'), yaml.dump(config), 'utf8');
}

/** Bootstraps the runtime schema so the candidate read runs against a real DB. */
function bootstrapDb(root: string): void {
  const connection = new SqliteConnection(root);
  // The connection is lazy: touching the handle is what materializes the file.
  connection.getDb();
  connection.close();
}

async function insertPrinciple(root: string, key: string): Promise<void> {
  const connection = new SqliteConnection(root);
  try {
    const db = connection.getDb();
    const at = new Date(Date.UTC(2026, 10, 14, 0, 0, 0)).toISOString();
    db.prepare(`
      INSERT INTO pi_artifacts (artifact_id, artifact_kind, source_task_id, source_principle_id, lineage_artifact_ids, validation_status, content_json, created_at, updated_at)
      VALUES (?, 'principle', ?, ?, '[]', 'validated', ?, ?, ?)
    `).run(`art-${key}`, `task-${key}`, key, JSON.stringify({ principleId: key, text: `原则正文 ${key}` }), at, at);
    db.prepare(`
      INSERT INTO approvals (approval_id, artifact_id, channel, risk_level, status, confidence, requested_at, decided_at, decided_by)
      VALUES (?, ?, 'prompt', 'low', 'approved', 1, ?, ?, 'owner-test')
    `).run(`approval-${key}`, `art-${key}`, at, at);
    await new SqliteActivationStateStore(connection).recordActivation({
      activationId: `act-${key}`,
      idempotencyKey: `art-${key}::prompt`,
      artifactId: `art-${key}`,
      channel: 'prompt',
      action: 'prompt_activate',
      targetRef: `ledger://${key}`,
      activatedAt: at,
      deactivatedAt: null,
    });
  } finally {
    connection.close();
  }
}

describe('updateAdaptiveActivationSettings', () => {
  it('saves the fixed service preset into THIS workspace and makes zero scoring requests', async () => {
    const workspaceA = makeWorkspace('save-a');
    const workspaceB = makeWorkspace('save-b');
    writeConfig(workspaceA);
    writeConfig(workspaceB);
    const fetchSpy = vi.spyOn(globalThis, 'fetch');

    const saved = updateAdaptiveActivationSettings(workspaceA, {
      service: ADAPTIVE_ACTIVATION_SERVICE_PRESET.id,
    });
    expect(saved.ok).toBe(true);
    expect(fetchSpy).not.toHaveBeenCalled();

    const configA = loadPdConfig(workspaceA);
    const configB = loadPdConfig(workspaceB);
    expect(configA.ok && configA.effective.config.adaptiveActivation).toMatchObject({
      endpoint: ADAPTIVE_ACTIVATION_SERVICE_PRESET.endpoint,
      model: ADAPTIVE_ACTIVATION_SERVICE_PRESET.model,
      apiKeyEnv: ADAPTIVE_ACTIVATION_SERVICE_PRESET.apiKeyEnv,
      provider: ADAPTIVE_ACTIVATION_SERVICE_PRESET.provider,
    });
    // Another workspace's configuration is untouched.
    expect(configB.ok && configB.effective.config.adaptiveActivation).toBeUndefined();
  });

  it('enables the existing Codex flag only when a complete section exists', () => {
    const workspace = makeWorkspace('enable-guard');
    writeConfig(workspace);
    const refused = updateAdaptiveActivationSettings(workspace, { enabled: true });
    expect(refused.ok).toBe(false);
    if (!refused.ok) {
      expect(refused.error).toBe('adaptive_activation_not_configured');
      expect(refused.statusCode).toBe(400);
    }
    expect(loadPdConfig(workspace).ok && loadPdConfig(workspace).effective.config.features['host.codex.adaptive_activation']?.enabled).not.toBe(true);

    const saved = updateAdaptiveActivationSettings(workspace, { enabled: true, service: ADAPTIVE_ACTIVATION_SERVICE_PRESET.id });
    expect(saved.ok).toBe(true);
    if (saved.ok) {
      expect(saved.enabled).toBe(true);
      expect(saved.serviceConfigured).toBe(true);
    }
  });

  it('refuses to enable or rewrite the service when replacement mode is configured, but still allows disable', () => {
    const workspace = makeWorkspace('replacement');
    writeConfig(workspace, (config) => {
      config.features['host.codex.adaptive_activation'].enabled = true;
      config.adaptiveActivation = {
        endpoint: 'https://example.test/decisions',
        model: 'legacy-model',
        apiKeyEnv: 'LEGACY_KEY',
        replaceableActivationIds: ['act-old'],
      };
    });

    const enable = updateAdaptiveActivationSettings(workspace, { enabled: true });
    expect(enable.ok).toBe(false);
    if (!enable.ok) expect(enable.error).toBe('append_only_conflict');

    const rewrite = updateAdaptiveActivationSettings(workspace, { service: ADAPTIVE_ACTIVATION_SERVICE_PRESET.id });
    expect(rewrite.ok).toBe(false);
    if (!rewrite.ok) expect(rewrite.error).toBe('append_only_conflict');

    // The Owner's existing configuration is preserved verbatim.
    const before = loadPdConfig(workspace);
    expect(before.ok && before.effective.config.adaptiveActivation).toEqual({
      endpoint: 'https://example.test/decisions',
      model: 'legacy-model',
      apiKeyEnv: 'LEGACY_KEY',
      replaceableActivationIds: ['act-old'],
    });

    const disable = updateAdaptiveActivationSettings(workspace, { enabled: false });
    expect(disable.ok).toBe(true);
    if (disable.ok) expect(disable.enabled).toBe(false);
  });

  it('does not rewrite the shared service while another host has Adaptive enabled', () => {
    const workspace = makeWorkspace('shared');
    writeConfig(workspace, (config) => {
      config.features['host.openclaw.adaptive_activation'].enabled = true;
    });
    const result = updateAdaptiveActivationSettings(workspace, { service: ADAPTIVE_ACTIVATION_SERVICE_PRESET.id });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toBe('shared_service_config_locked');
  });
  it('never invents a config file for a workspace that has none', () => {
    const workspace = makeWorkspace('no-config');
    const result = updateAdaptiveActivationSettings(workspace, { service: ADAPTIVE_ACTIVATION_SERVICE_PRESET.id });
    // Same contract as the existing feature-flag write: an absent config is a
    // malformed-config conflict, not something this endpoint may fabricate.
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.statusCode).toBe(409);
    expect(fs.existsSync(path.join(workspace, '.pd', 'config.yaml'))).toBe(false);
  });

  it('rejects malformed payload shapes without touching the config', () => {
    const workspace = makeWorkspace('bad-payloads');
    writeConfig(workspace);
    const configPath = path.join(workspace, '.pd', 'config.yaml');
    const before = fs.readFileSync(configPath, 'utf8');

    const cases: Array<[unknown, string]> = [
      [null, 'bad_request'],
      [[], 'bad_request'],
      [{}, 'bad_request'],
      [{ service: 42 }, 'unknown_service'],
    ];
    for (const [payload, error] of cases) {
      const result = updateAdaptiveActivationSettings(workspace, payload);
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.error).toBe(error);
    }
    expect(fs.readFileSync(configPath, 'utf8')).toBe(before);
  });

  it('refuses to write into a config whose features section is not a map', () => {
    const workspace = makeWorkspace('features-not-map');
    fs.mkdirSync(path.join(workspace, '.pd'), { recursive: true });
    const configPath = path.join(workspace, '.pd', 'config.yaml');
    fs.writeFileSync(configPath, 'features: "oops"\n', 'utf8');
    const result = updateAdaptiveActivationSettings(workspace, { service: ADAPTIVE_ACTIVATION_SERVICE_PRESET.id });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.statusCode).toBe(409);
      expect(result.error).toBe('conflict');
    }
    // The malformed value is preserved, never silently reset (rc-9).
    expect(fs.readFileSync(configPath, 'utf8')).toContain('features: "oops"');
  });

  it('refuses to write into a config that fails validation', () => {
    const workspace = makeWorkspace('invalid-config');
    fs.mkdirSync(path.join(workspace, '.pd'), { recursive: true });
    fs.writeFileSync(
      path.join(workspace, '.pd', 'config.yaml'),
      'features:\n  host.codex.adaptive_activation:\n    enabled: "yes"\n',
      'utf8',
    );
    const result = updateAdaptiveActivationSettings(workspace, { service: ADAPTIVE_ACTIVATION_SERVICE_PRESET.id });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.statusCode).toBe(409);
  });

  it('blocks the generic feature-flag toggle from crossing into replacement mode', () => {
    const workspace = makeWorkspace('generic-boundary');
    writeConfig(workspace, (config) => {
      config.adaptiveActivation = {
        endpoint: 'https://legacy.example.test/decisions',
        model: 'legacy',
        apiKeyEnv: 'LEGACY_KEY',
        replaceableActivationIds: ['act-legacy'],
      };
    });
    const refused = updateFeatureFlag(workspace, 'host.codex.adaptive_activation', true);
    expect(refused.ok).toBe(false);
    if (!refused.ok) expect(refused.error).toBe('append_only_conflict');

    // Disabling is always allowed.
    expect(updateFeatureFlag(workspace, 'host.codex.adaptive_activation', false).ok).toBe(true);
    expect(updateFeatureFlag(workspace, 'host.workbuddy.adaptive_activation', false).ok).toBe(true);
  });
});

describe('AdaptiveActivationConsoleModel', () => {
  it('reports a real zero-candidate workspace as "zero", never as an error', async () => {
    const workspace = makeWorkspace('zero');
    writeConfig(workspace);
    bootstrapDb(workspace);
    const view = await new AdaptiveActivationConsoleModel(workspace).getView();
    expect(view.candidates.emptyState).toBe('zero');
    expect(view.candidates.validCount).toBe(0);
    expect(view.candidates.blockingWarnings).toEqual([]);
    expect(view.evidence.status).toBe('not_observed');
    expect(view.evidence.reason).toBe('no_adaptive_fact');
    expect(view.lastRecord).toBeNull();
  });

  it('separates prompt-disabled from a missing runtime database', async () => {
    const disabled = makeWorkspace('prompt-off');
    writeConfig(disabled, (config) => {
      config.features.prompt.enabled = false;
    });
    bootstrapDb(disabled);
    expect((await new AdaptiveActivationConsoleModel(disabled).getView()).candidates.emptyState).toBe('prompt_disabled');

    const missingDb = makeWorkspace('no-db');
    writeConfig(missingDb);
    expect((await new AdaptiveActivationConsoleModel(missingDb).getView()).candidates.emptyState).toBe('db_missing');
  });

  it('keeps a blocking warning visible even when valid principles exist', async () => {
    const workspace = makeWorkspace('blocked');
    writeConfig(workspace);
    await insertPrinciple(workspace, 'GOOD');
    // A stale activation whose artifact is gone: one valid candidate PLUS a
    // warning — the runtime gate refuses selection in this exact situation.
    // Inserted directly: the store's own write path (correctly) refuses an
    // activation that references a missing artifact.
    const connection = new SqliteConnection(workspace);
    try {
      connection.getDb().prepare(`
        INSERT INTO activations
          (activation_id, idempotency_key, artifact_id, channel, action, target_ref, activated_at, promoted_at, deactivated_at)
        VALUES ('act-stale', 'missing::prompt', 'art-missing', 'prompt', 'prompt_activate', 'ledger://missing', ?, NULL, NULL)
      `).run(new Date(Date.UTC(2026, 10, 14, 0, 0, 1)).toISOString());
    } finally {
      connection.close();
    }
    const view = await new AdaptiveActivationConsoleModel(workspace).getView();
    expect(view.candidates.validCount).toBe(1);
    expect(view.candidates.blockingWarnings.length).toBeGreaterThan(0);
    expect(view.candidates.emptyState).toBe('ok');
  });

  it('reads the last Adaptive record from this workspace only, with host evidence separated', async () => {
    const workspace = makeWorkspace('last-record');
    const other = makeWorkspace('last-record-other');
    writeConfig(workspace);
    bootstrapDb(workspace);
    writeConfig(other);
    const logs = path.join(workspace, '.state', 'logs');
    fs.mkdirSync(logs, { recursive: true });
    const event = (workspaceDir: string, appended: string | undefined, ts: string) => JSON.stringify({
      ts,
      type: 'runtime_v2_prompt_activations_injected',
      category: 'injected',
      sessionId: 's-1',
      data: {
        sessionId: 's-1',
        workspaceDir,
        runId: 't-1',
        hostKind: 'codex',
        principleIds: ['GOOD'],
        activationIds: ['act-GOOD'],
        artifactIds: ['art-GOOD'],
        injectedCount: 1,
        skippedWarnings: [],
        injectedCharCount: 120,
        budget: 4000,
        adaptive: {
          resultCode: 'selected:selected',
          scored: true,
          ...(appended === undefined ? {} : { appendedActivationId: appended }),
        },
      },
    });
    fs.writeFileSync(
      path.join(logs, 'events_2026-11-14.jsonl'),
      [
        event(workspace, 'act-GOOD', '2026-11-14T01:00:00.000Z'),
        event(other, 'act-OTHER', '2026-11-14T02:00:00.000Z'),
      ].join('\n'),
      'utf8',
    );

    const view = await new AdaptiveActivationConsoleModel(workspace).getView();
    expect(view.evidence.status).toBe('observed');
    expect(view.evidence.reason).toBe('observed');
    expect(view.evidence.parseFailures).toBe(0);
    expect(view.evidence.logFilesRead).toBe(1);
    expect(view.lastRecord).toMatchObject({
      resultCode: 'selected:selected',
      scored: true,
      appendedActivationId: 'act-GOOD',
      runId: 't-1',
      sessionId: 's-1',
    });
    // "Saved" is still false — config and observation are different facts.
    expect(view.codex.saved).toBe(false);
  });

  // ── Evidence tri-state: UNKNOWN must never be reported as NOT_OBSERVED ─────

  it('reports UNKNOWN when the log path is unreadable, and leaks no path or error text', async () => {
    const workspace = makeWorkspace('evidence-unreadable');
    writeConfig(workspace);
    bootstrapDb(workspace);
    // `.state/logs` exists as a FILE, so readdir/read throws: the read failed.
    fs.mkdirSync(path.join(workspace, '.state'), { recursive: true });
    fs.writeFileSync(path.join(workspace, '.state', 'logs'), 'not a directory', 'utf8');

    const view = await new AdaptiveActivationConsoleModel(workspace).getView();
    expect(view.evidence.status).toBe('unknown');
    expect(view.evidence.reason).toBe('logs_unreadable');
    expect(view.lastRecord).toBeNull();
    // No absolute path / errno text may cross the wire.
    const serialized = JSON.stringify(view.evidence);
    expect(serialized).not.toContain(workspace);
    expect(serialized).not.toContain('ENOTDIR');
  });

  it('reports UNKNOWN when unreadable lines could have hidden the Adaptive fact', async () => {
    const workspace = makeWorkspace('evidence-malformed');
    writeConfig(workspace);
    bootstrapDb(workspace);
    const logs = path.join(workspace, '.state', 'logs');
    fs.mkdirSync(logs, { recursive: true });
    fs.writeFileSync(
      path.join(logs, 'events_2026-11-14.jsonl'),
      [
        'this is not json',
        JSON.stringify({
          ts: '2026-11-14T03:00:00.000Z',
          type: 'runtime_v2_prompt_activations_injected',
          sessionId: 's-1',
          data: { workspaceDir: workspace, sessionId: 's-1', adaptive: { resultCode: 42, scored: 'yes' } },
        }),
      ].join('\n'),
      'utf8',
    );

    const view = await new AdaptiveActivationConsoleModel(workspace).getView();
    expect(view.evidence.status).toBe('unknown');
    expect(view.evidence.reason).toBe('records_unreadable');
    expect(view.evidence.parseFailures).toBe(2);
    expect(view.lastRecord).toBeNull();
  });

  it('keeps OBSERVED when a valid record exists alongside unreadable lines, and flags incompleteness', async () => {
    const workspace = makeWorkspace('evidence-partial');
    writeConfig(workspace);
    bootstrapDb(workspace);
    const logs = path.join(workspace, '.state', 'logs');
    fs.mkdirSync(logs, { recursive: true });
    fs.writeFileSync(
      path.join(logs, 'events_2026-11-14.jsonl'),
      [
        'broken line',
        JSON.stringify({
          ts: '2026-11-14T04:00:00.000Z',
          type: 'runtime_v2_prompt_activations_injected',
          sessionId: 's-1',
          data: {
            sessionId: 's-1',
            workspaceDir: workspace,
            runId: 't-1',
            hostKind: 'codex',
            activationIds: ['act-GOOD'],
            adaptive: { resultCode: 'skipped:budget_too_small', scored: false },
          },
        }),
      ].join('\n'),
      'utf8',
    );

    const view = await new AdaptiveActivationConsoleModel(workspace).getView();
    expect(view.evidence.status).toBe('observed');
    expect(view.evidence.reason).toBe('observed_partial');
    expect(view.evidence.parseFailures).toBe(1);
    expect(view.lastRecord).toMatchObject({ resultCode: 'skipped:budget_too_small', scored: false });
  });

  it('reports other hosts that share the workspace service config', async () => {
    const workspace = makeWorkspace('other-hosts');
    writeConfig(workspace, (config) => {
      config.features['host.openclaw.adaptive_activation'].enabled = true;
      config.features['host.workbuddy.adaptive_activation'].enabled = true;
    });
    bootstrapDb(workspace);
    const view = await new AdaptiveActivationConsoleModel(workspace).getView();
    expect(view.otherHostAaEnabled).toEqual(['openclaw', 'workbuddy']);
  });

  it('reports read_failed for a zero-candidate read that still produced a warning', async () => {
    const workspace = makeWorkspace('zero-with-warning');
    writeConfig(workspace);
    await insertPrinciple(workspace, 'GOOD');
    const connection = new SqliteConnection(workspace);
    try {
      const db = connection.getDb();
      db.prepare("UPDATE activations SET deactivated_at = ? WHERE activation_id = 'act-GOOD'").run('2026-11-14T00:00:02.000Z');
      db.prepare(`
        INSERT INTO activations
          (activation_id, idempotency_key, artifact_id, channel, action, target_ref, activated_at, promoted_at, deactivated_at)
        VALUES ('act-stale', 'missing::prompt', 'art-missing', 'prompt', 'prompt_activate', 'ledger://missing', ?, NULL, NULL)
      `).run('2026-11-14T00:00:03.000Z');
    } finally {
      connection.close();
    }
    const view = await new AdaptiveActivationConsoleModel(workspace).getView();
    expect(view.candidates.validCount).toBe(0);
    expect(view.candidates.emptyState).toBe('read_failed');
  });
});
