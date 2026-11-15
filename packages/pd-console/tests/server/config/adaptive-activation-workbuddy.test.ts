/**
 * PRI-1127 — WorkBuddy product entry on the Console side.
 *
 * The SAME settings card and store now serve a second host. These tests pin
 * the boundaries that matter: a toggle writes ONLY the selected host's existing
 * switch; the shared service write lock is relative to that host; replacement
 * mode still refuses enable but allows disable; and the read model shows ONLY
 * this workspace + this host's injection fact, matched by the real same-turn
 * identity (WorkBuddy generation_id).
 */
import { afterEach, describe, expect, it } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as yaml from 'js-yaml';
import { getDefaultPdConfig, SqliteConnection } from '@principles/core/runtime';
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
});

function makeWorkspace(label: string): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), `pd-aa-wb-${label}-`));
  workspaces.push(root);
  fs.mkdirSync(path.join(root, '.pd'), { recursive: true });
  return root;
}

function writeConfig(root: string, mutate?: (config: ReturnType<typeof getDefaultPdConfig>) => void): void {
  const config = getDefaultPdConfig();
  config.features['host.workbuddy'].enabled = true;
  mutate?.(config);
  fs.writeFileSync(path.join(root, '.pd', 'config.yaml'), yaml.dump(config), 'utf8');
}

function bootstrapDb(root: string): void {
  const connection = new SqliteConnection(root);
  connection.getDb();
  connection.close();
}

function injectedEvent(input: {
  workspaceDir: string;
  hostKind: 'codex' | 'workbuddy';
  runId: string;
  resultCode: string;
  scored: boolean;
  appendedActivationId?: string;
  activationIds: string[];
  ts: string;
}): string {
  return JSON.stringify({
    ts: input.ts,
    type: 'runtime_v2_prompt_activations_injected',
    category: 'injected',
    sessionId: 's-1',
    data: {
      sessionId: 's-1',
      workspaceDir: input.workspaceDir,
      runId: input.runId,
      hostKind: input.hostKind,
      principleIds: input.activationIds.map((id) => id.replace('act-', '')),
      activationIds: input.activationIds,
      artifactIds: input.activationIds.map((id) => `art-${id}`),
      injectedCount: input.activationIds.length,
      skippedWarnings: [],
      injectedCharCount: 120,
      budget: 4000,
      adaptive: {
        resultCode: input.resultCode,
        scored: input.scored,
        ...(input.appendedActivationId === undefined ? {} : { appendedActivationId: input.appendedActivationId }),
      },
    },
  });
}

function writeEvents(root: string, lines: string[]): void {
  const logs = path.join(root, '.state', 'logs');
  fs.mkdirSync(logs, { recursive: true });
  fs.writeFileSync(path.join(logs, 'events_2026-11-15.jsonl'), lines.join('\n'), 'utf8');
}

function flagsOf(root: string): Record<string, boolean | undefined> {
  const loaded = loadPdConfig(root);
  if (!loaded.ok) throw new Error('config became invalid');
  const features = loaded.effective.config.features;
  return {
    codex: features['host.codex.adaptive_activation']?.enabled,
    openclaw: features['host.openclaw.adaptive_activation']?.enabled,
    workbuddy: features['host.workbuddy.adaptive_activation']?.enabled,
  };
}

describe('updateAdaptiveActivationSettings — host-scoped WorkBuddy switch', () => {
  it('rejects enabling AA without host integration on both paths and allows turning AA off', async () => {
    const workspace = makeWorkspace('integration-disabled');
    writeConfig(workspace, (config) => {
      config.features['host.workbuddy'].enabled = false;
      config.features['host.workbuddy.adaptive_activation'].enabled = true;
    });
    const rejected = {ok: false, statusCode: 409, error: 'adaptive_workbuddy_host_disabled'};
    expect(updateAdaptiveActivationSettings(workspace, {host: 'workbuddy', enabled: true})).toMatchObject(rejected);
    expect(updateFeatureFlag(workspace, 'host.workbuddy.adaptive_activation', true)).toMatchObject(rejected);
    const before = await new AdaptiveActivationConsoleModel(workspace, 'workbuddy').getView();
    expect(before.host).toMatchObject({integrationEnabled: false, enabled: true});
    expect(updateAdaptiveActivationSettings(workspace, {host: 'workbuddy', enabled: false}).ok).toBe(true);
    expect(flagsOf(workspace).workbuddy).toBe(false);
  });

  it('enables ONLY host.workbuddy.adaptive_activation and saves the shared service once', () => {
    const workspace = makeWorkspace('enable');
    writeConfig(workspace);
    const saved = updateAdaptiveActivationSettings(workspace, {
      host: 'workbuddy', service: ADAPTIVE_ACTIVATION_SERVICE_PRESET.id, enabled: true,
    });
    expect(saved.ok).toBe(true);
    if (saved.ok) {
      expect(saved.host).toBe('workbuddy');
      expect(saved.enabled).toBe(true);
      expect(saved.serviceConfigured).toBe(true);
    }
    // No neighbour switch was touched.
    expect(flagsOf(workspace)).toMatchObject({ workbuddy: true, codex: false, openclaw: false });
    const loaded = loadPdConfig(workspace);
    expect(loaded.ok && loaded.effective.config.adaptiveActivation).toMatchObject({
      endpoint: ADAPTIVE_ACTIVATION_SERVICE_PRESET.endpoint,
      model: ADAPTIVE_ACTIVATION_SERVICE_PRESET.model,
      apiKeyEnv: ADAPTIVE_ACTIVATION_SERVICE_PRESET.apiKeyEnv,
    });
  });

  it('refuses to enable a replacement-mode config from the WorkBuddy entry, but still allows disable', () => {
    const workspace = makeWorkspace('replacement');
    writeConfig(workspace, (config) => {
      config.features['host.workbuddy.adaptive_activation'].enabled = true;
      config.adaptiveActivation = {
        endpoint: 'https://legacy.test/decisions', model: 'legacy', apiKeyEnv: 'LEGACY_KEY',
        replaceableActivationIds: ['act-old'],
      };
    });
    const enabled = updateAdaptiveActivationSettings(workspace, { host: 'workbuddy', enabled: true });
    expect(enabled.ok).toBe(false);
    if (!enabled.ok) expect(enabled.error).toBe('append_only_conflict');

    const disabled = updateAdaptiveActivationSettings(workspace, { host: 'workbuddy', enabled: false });
    expect(disabled.ok).toBe(true);
    expect(flagsOf(workspace).workbuddy).toBe(false);
    // The Owner's replacement configuration is preserved verbatim.
    const loaded = loadPdConfig(workspace);
    expect(loaded.ok && loaded.effective.config.adaptiveActivation).toEqual({
      endpoint: 'https://legacy.test/decisions', model: 'legacy', apiKeyEnv: 'LEGACY_KEY',
      replaceableActivationIds: ['act-old'],
    });
  });

  it('applies the shared-service lock RELATIVE to the selected host', () => {
    const workspace = makeWorkspace('shared-lock');
    writeConfig(workspace, (config) => {
      config.features['host.codex.adaptive_activation'].enabled = true;
    });
    // Codex owns the shared service config: the WorkBuddy entry cannot rewrite it.
    const refused = updateAdaptiveActivationSettings(workspace, {
      host: 'workbuddy', service: ADAPTIVE_ACTIVATION_SERVICE_PRESET.id,
    });
    expect(refused.ok).toBe(false);
    if (!refused.ok) expect(refused.error).toBe('shared_service_config_locked');

    // Its OWN enabled flag is not an "other host" and must not self-block.
    writeConfig(workspace, (config) => {
      config.features['host.workbuddy.adaptive_activation'].enabled = true;
    });
    const allowed = updateAdaptiveActivationSettings(workspace, {
      host: 'workbuddy', service: ADAPTIVE_ACTIVATION_SERVICE_PRESET.id,
    });
    expect(allowed.ok).toBe(true);
  });

  it('rejects an unknown host without touching the config, and defaults to codex when omitted', () => {
    const workspace = makeWorkspace('host-validation');
    writeConfig(workspace);
    const before = fs.readFileSync(path.join(workspace, '.pd', 'config.yaml'), 'utf8');
    const refused = updateAdaptiveActivationSettings(workspace, { host: 'some-other-host', enabled: false });
    expect(refused.ok).toBe(false);
    if (!refused.ok) {
      expect(refused.statusCode).toBe(400);
      expect(refused.error).toBe('unknown_host');
    }
    expect(fs.readFileSync(path.join(workspace, '.pd', 'config.yaml'), 'utf8')).toBe(before);

    const defaulted = updateAdaptiveActivationSettings(workspace, {
      service: ADAPTIVE_ACTIVATION_SERVICE_PRESET.id, enabled: true,
    });
    expect(defaulted.ok).toBe(true);
    if (defaulted.ok) expect(defaulted.host).toBe('codex');
    expect(flagsOf(workspace)).toMatchObject({ codex: true, workbuddy: false });
  });
});

describe('AdaptiveActivationConsoleModel — WorkBuddy result isolation', () => {
  it('reads ONLY this workspace + this host, matched by the real same-turn generation_id', async () => {
    const wsA = makeWorkspace('read-a');
    const wsB = makeWorkspace('read-b');
    writeConfig(wsA, (config) => {
      config.features['host.workbuddy.adaptive_activation'].enabled = true;
      config.features['host.codex.adaptive_activation'].enabled = true;
      config.adaptiveActivation = { endpoint: 'https://d.test/x', model: 'm', apiKeyEnv: 'K' };
    });
    writeConfig(wsB);
    bootstrapDb(wsA);
    bootstrapDb(wsB);

    writeEvents(wsA, [
      injectedEvent({ workspaceDir: wsA, hostKind: 'codex', runId: 'codex-turn', resultCode: 'selected:selected', scored: true, appendedActivationId: 'act-CODEX', activationIds: ['act-NATIVE', 'act-CODEX'], ts: '2026-11-15T01:00:00.000Z' }),
      injectedEvent({ workspaceDir: wsA, hostKind: 'workbuddy', runId: 'wb-generation-01a1d4', resultCode: 'selected:selected', scored: true, appendedActivationId: 'act-WB', activationIds: ['act-NATIVE', 'act-WB'], ts: '2026-11-15T02:00:00.000Z' }),
      injectedEvent({ workspaceDir: wsB, hostKind: 'workbuddy', runId: 'other-workspace', resultCode: 'skipped:no_gap', scored: false, activationIds: ['act-NATIVE'], ts: '2026-11-15T03:00:00.000Z' }),
    ]);
    writeEvents(wsB, [
      injectedEvent({ workspaceDir: wsB, hostKind: 'workbuddy', runId: 'ws-b-turn', resultCode: 'skipped:no_gap', scored: false, activationIds: ['act-NATIVE'], ts: '2026-11-15T04:00:00.000Z' }),
    ]);

    const wb = await new AdaptiveActivationConsoleModel(wsA, 'workbuddy').getView();
    expect(wb.host).toMatchObject({ kind: 'workbuddy', flag: 'host.workbuddy.adaptive_activation', enabled: true, saved: true });
    expect(wb.evidence.status).toBe('observed');
    expect(wb.lastRecord?.runId).toBe('wb-generation-01a1d4');   // NEVER the Codex turn
    expect(wb.lastRecord?.appendedActivationId).toBe('act-WB');
    expect(wb.lastRound).toEqual({
      runId: 'wb-generation-01a1d4',
      appendedActivationId: 'act-WB',
      activationIds: ['act-NATIVE', 'act-WB'],
      independentRequestSent: true,
      matchedBy: ['workspace', 'host', 'turn'],
    });
    expect(JSON.stringify(wb.lastRecord)).not.toContain('other-workspace');

    // Same workspace, other host: the Codex card still sees ONLY its own turn.
    const codex = await new AdaptiveActivationConsoleModel(wsA, 'codex').getView();
    expect(codex.lastRecord?.runId).toBe('codex-turn');
    expect(codex.lastRecord?.appendedActivationId).toBe('act-CODEX');
    expect(codex.host.kind).toBe('codex');

    // Another workspace never leaks its result into this one.
    const other = await new AdaptiveActivationConsoleModel(wsB, 'workbuddy').getView();
    expect(other.lastRecord?.runId).toBe('ws-b-turn');
    expect(other.evidence.status).toBe('observed');
    expect(other.lastRound?.appendedActivationId).toBeNull();
  });

  it('reports other enabled hosts relative to the WorkBuddy selection', async () => {
    const workspace = makeWorkspace('other-hosts');
    writeConfig(workspace, (config) => {
      config.features['host.codex.adaptive_activation'].enabled = true;
      config.features['host.openclaw.adaptive_activation'].enabled = true;
    });
    bootstrapDb(workspace);
    const wb = await new AdaptiveActivationConsoleModel(workspace, 'workbuddy').getView();
    expect(wb.otherHostAaEnabled).toEqual(['openclaw', 'codex']);
    expect(wb.host.enabled).toBe(false);
    // Codex remains a REAL, separate fact — never overwritten by the selection.
    expect(wb.codex.enabled).toBe(true);
  });

  it('does not invent a WorkBuddy result when only Codex facts exist', async () => {
    const workspace = makeWorkspace('no-wb-fact');
    writeConfig(workspace);
    bootstrapDb(workspace);
    writeEvents(workspace, [
      injectedEvent({ workspaceDir: workspace, hostKind: 'codex', runId: 'codex-only', resultCode: 'skipped:no_gap', scored: false, activationIds: ['act-NATIVE'], ts: '2026-11-15T05:00:00.000Z' }),
    ]);
    const wb = await new AdaptiveActivationConsoleModel(workspace, 'workbuddy').getView();
    expect(wb.evidence.status).toBe('not_observed');
    expect(wb.lastRecord).toBeNull();
    expect(wb.lastRound).toBeNull();
  });
});
