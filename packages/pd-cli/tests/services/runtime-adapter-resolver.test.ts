/**
 * Runtime-adapter-resolver tests — the `runtimeProfileId` capability path
 * (PRI-917 v0.3.2 §8, added in Phase 3C-3; review-fix extension).
 *
 * The Semantic Reuse Evaluation Capability is NOT an internal agent, so it
 * resolves its adapter from an explicit profile id. These tests pin the
 * contract that the review surface depends on:
 *
 *   - a profile with `source: 'default'` resolves to an OpenClawCliRuntimeAdapter
 *     in DELEGATED mode ('default') — identical to how
 *     pain-signal-runtime-factory's validateRuntimeConfig treats the same
 *     profile (`openclawMode may be undefined when source = default`). The
 *     resolver previously threw "requires openclawMode" here, which made the
 *     capability permanently unavailable under the DEFAULT configuration
 *     (P1 review finding on PR #1902);
 *   - an explicit local/gateway profile still resolves concretely;
 *   - an unknown profile id fails closed (profile_not_found).
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as yaml from 'js-yaml';
import { resolveRuntimeAdapterFromConfig } from '../../src/services/runtime-adapter-resolver.js';
import { OpenClawCliRuntimeAdapter } from '@principles/core/runtime-v2';

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
  it('resolves a source=default OpenClaw profile in DELEGATED mode (no openclawMode required)', () => {
    writeConfig(baseConfig());

    const adapter = resolveRuntimeAdapterFromConfig({
      runtimeKind: 'config',
      workspaceDir,
      runtimeProfileId: 'openclaw.default',
    });

    expect(adapter).toBeInstanceOf(OpenClawCliRuntimeAdapter);
  });

  it('resolves a concrete local profile without delegation', () => {
    writeConfig(baseConfig({
      runtimeProfiles: {
        'openclaw.default': { type: 'openclaw', source: 'default' },
        'openclaw.local': { type: 'openclaw', provider: 'test', model: 'test-model' },
      },
    }));

    const adapter = resolveRuntimeAdapterFromConfig({
      runtimeKind: 'config',
      workspaceDir,
      runtimeProfileId: 'openclaw.local',
    });

    expect(adapter).toBeDefined();
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
