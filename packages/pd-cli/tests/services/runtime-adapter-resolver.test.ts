/**
 * Runtime-adapter-resolver tests — the `runtimeProfileId` capability path
 * (PRI-917 v0.3.2 §8, added in Phase 3C-3; review-fix extension).
 *
 * The Semantic Reuse Evaluation Capability is NOT an internal agent, so it
 * resolves its adapter from an explicit profile id. These tests pin the
 * contract that the review surface depends on:
 *
 *   - a pi-ai profile resolves to a PiAiRuntimeAdapter (ADR-0029 makes pi-ai
 *     the only internal-agent runtime backend, so this is the green path);
 *   - a legacy `type: 'openclaw'` profile fails closed with needs_setup —
 *     including `source: 'default'`, which used to resolve to a delegated
 *     host CLI session (the behavior ADR-0029 retires);
 *   - an unknown profile id fails closed (profile_not_found).
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as yaml from 'js-yaml';
import { resolveRuntimeAdapterFromConfig } from '../../src/services/runtime-adapter-resolver.js';
import { PiAiRuntimeAdapter } from '@principles/core/runtime-v2';

let workspaceDir: string;

function writeConfig(config: Record<string, unknown>): void {
  fs.mkdirSync(path.join(workspaceDir, '.pd'), { recursive: true });
  fs.writeFileSync(path.join(workspaceDir, '.pd', 'config.yaml'), yaml.dump(config), 'utf8');
}

beforeEach(() => {
  workspaceDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pd-resolver-profile-'));
});

afterEach(() => {
  try { fs.rmSync(workspaceDir, { recursive: true, force: true }); } catch { /* best effort */ }
});

function baseConfig(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    version: 1,
    features: {
      prompt: { category: 'core', enabled: true },
      code_tool_hook: { category: 'core', enabled: true },
      defer_archive: { category: 'core', enabled: true },
    },
    runtimeProfiles: {
      'openclaw.default': { type: 'openclaw', source: 'default' },
    },
    internalAgents: { defaultRuntime: 'openclaw.default', agents: { diagnostician: { enabled: true } } },
    ...overrides,
  };
}

describe('resolveRuntimeAdapterFromConfig — runtimeProfileId (capability path)', () => {
  it('refuses a retired openclaw profile: fail-closed, never a delegated host session (ADR-0029)', () => {
    writeConfig(baseConfig());

    expect(() =>
      resolveRuntimeAdapterFromConfig({
        runtimeKind: 'config',
        workspaceDir,
        runtimeProfileId: 'openclaw.default',
      }),
    ).toThrowError(/retired \(ADR-0029\)/);
  });

  it('refuses a concrete legacy openclaw profile too — provider+model no longer make it ready', () => {
    writeConfig(baseConfig({
      runtimeProfiles: {
        'openclaw.default': { type: 'openclaw', source: 'default' },
        'openclaw.local': { type: 'openclaw', provider: 'test', model: 'test-model' },
      },
    }));

    expect(() =>
      resolveRuntimeAdapterFromConfig({
        runtimeKind: 'config',
        workspaceDir,
        runtimeProfileId: 'openclaw.local',
      }),
    ).toThrowError(/retired \(ADR-0029\)/);
  });

  it('names the retirement, not invalid-config, when a retired runtime kind meets a bad config', () => {
    // The workspace config resolves to needs_setup (legacy openclaw default);
    // naming the retired backend must still be reported as retired (cli-6).
    writeConfig(baseConfig());

    expect(() =>
      resolveRuntimeAdapterFromConfig({
        runtimeKind: 'openclaw-cli',
        workspaceDir,
        runtimeProfileId: 'openclaw.default',
      }),
    ).toThrowError(/retired \(ADR-0029\)/);
  });

  it('resolves a pi-ai capability profile (the only supported backend)', () => {
    writeConfig(baseConfig({
      runtimeProfiles: {
        'pd.anthropic': { type: 'pi-ai', provider: 'anthropic', model: 'claude-3-5-sonnet', apiKeyEnv: 'PD_RESOLVER_TEST_KEY' },
      },
    }));
    process.env.PD_RESOLVER_TEST_KEY = 'stub-sentinel-not-a-credential';
    try {
      const adapter = resolveRuntimeAdapterFromConfig({
        runtimeKind: 'config',
        workspaceDir,
        runtimeProfileId: 'pd.anthropic',
      });
      expect(adapter).toBeInstanceOf(PiAiRuntimeAdapter);
    } finally {
      delete process.env.PD_RESOLVER_TEST_KEY;
    }
  });

  it('fails closed on an unknown profile id', () => {
    writeConfig(baseConfig());

    expect(() =>
      resolveRuntimeAdapterFromConfig({
        runtimeKind: 'config',
        workspaceDir,
        runtimeProfileId: 'does.not.exist',
      }),
    ).toThrowError(/profile_not_found|does.not.exist/);
  });
});
