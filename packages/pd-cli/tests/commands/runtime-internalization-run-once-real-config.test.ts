/**
 * PRI-719 review — real-config composition tests (NO core module mock).
 *
 * The run-once unit suites mock `@principles/core/runtime-v2`, which cannot
 * prove real default-config behavior. These tests drive the REAL resolver
 * chain (resolveRuntimeFromPdConfig → resolveRuntimeConfigForAgent →
 * resolveRuntimeAdapterFromConfig) against real workspaces built from
 * `getDefaultPdConfig()`:
 *
 *   Case 1  evaluator shipped disabled + explicit runtimeProfile → an
 *           explicit peer run-once resolves ITS profile (no
 *           "Agent 'evaluator' is disabled"), because peer execution scope
 *           is the internalization_full_chain flag — the same
 *           ignoreAgentEnabled semantics the auto-consumer uses.
 *   Case 2  rolloutReviewer shipped disabled — same resolution.
 *   Case 3  per-agent isolation: diagnostician→profile-A, evaluator→B;
 *           the run-once seam resolves profile-B.
 *   Case 4  the diagnostician bridge gate still HONORS enabled (no global
 *           bypass leaked from the peer option).
 *   B7      cross-entry equivalence: run-once path and auto-consumer path
 *           resolve IDENTICAL runtimeProfileId/provider/model for the same
 *           config (runtime binding must not drift across entry points).
 */
import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  computeEffectivePdConfig,
  getDefaultPdConfig,
  resolveRuntimeConfigForAgent,
  AGENT_NAME_FOR_TASK_KIND,
  type RuntimeConfigError,
} from '@principles/core/runtime-v2';
import { resolveRuntimeFromPdConfig } from '../../src/services/resolve-runtime-from-pd-config.js';
import { resolveRuntimeAdapterFromConfig } from '../../src/services/runtime-adapter-resolver.js';

const dirs: string[] = [];

function makeWorkspace(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pd-runonce-profile-'));
  dirs.push(root);
  fs.mkdirSync(path.join(root, '.pd'), { recursive: true });
  return root;
}

function writeProfileConfig(root: string, agents: Record<string, string>): void {
  const config = getDefaultPdConfig();
  (config.runtimeProfiles as Record<string, unknown>) = {
    ...(config.runtimeProfiles as Record<string, unknown>),
    'profile-diagnostician': {
      type: 'pi-ai', provider: 'prov-diag', model: 'diag-model', apiKeyEnv: 'DIAG_KEY',
      baseUrl: 'http://127.0.0.1:9001/v1',
    },
    'profile-evaluator': {
      type: 'pi-ai', provider: 'prov-evaluator', model: 'evaluator-model', apiKeyEnv: 'EVAL_KEY',
      baseUrl: 'http://127.0.0.1:9002/v1',
    },
    'profile-rollout': {
      type: 'pi-ai', provider: 'prov-rollout', model: 'rollout-model', apiKeyEnv: 'ROLLOUT_KEY',
      baseUrl: 'http://127.0.0.1:9003/v1',
    },
  };
  const agentBindings = config.internalAgents.agents as Record<string, { enabled: boolean; runtimeProfile?: string }>;
  // The shipped default config pins every agent's runtimeProfile — replace
  // the DECLARED profiles per the scenario; enabled flags stay at their
  // shipped values (evaluator/rolloutReviewer/philosopher = false).
  for (const [agent, profileId] of Object.entries(agents)) {
    agentBindings[agent] = { ...agentBindings[agent], runtimeProfile: profileId };
  }
  // JSON is valid YAML — same trick the sibling composition tests use.
  fs.writeFileSync(path.join(root, '.pd', 'config.yaml'), JSON.stringify(config));
}

function readAdapterConfig(adapter: unknown): { provider?: string; model?: string } {
  return (adapter as unknown as { config: { provider?: string; model?: string } }).config;
}

function isErr(result: unknown): RuntimeConfigError {
  return result as RuntimeConfigError;
}

describe('PRI-719 review — explicit run-once resolves shipped-disabled peer agents on their own profile (real config)', () => {
  it('Case 1: evaluator enabled=false (default) + declared profile → run-once seam resolves profile-evaluator', () => {
    const ws = makeWorkspace();
    writeProfileConfig(ws, { evaluator: 'profile-evaluator' });
    process.env.EVAL_KEY = 'test-key';

    try {
      const resolved = resolveRuntimeFromPdConfig(ws, {
        agentName: 'evaluator',
        ignoreAgentEnabled: true,
      });
      expect(resolved.result).not.toHaveProperty('ok');
      if (resolved.result.ok === false) return;
      expect(resolved.result.runtimeKind).toBe('pi-ai');
      expect(resolved.result.provider).toBe('prov-evaluator');
      expect(resolved.result.model).toBe('evaluator-model');
      expect(resolved.result.runtimeProfileId).toBe('profile-evaluator');

      // The run-once ADAPTER seam resolves the same profile into the adapter.
      const adapter = resolveRuntimeAdapterFromConfig({
        runtimeKind: 'config',
        workspaceDir: ws,
        runnerKind: 'evaluator',
        agentName: 'evaluator',
        ignoreAgentEnabled: true,
      });
      // The real (unmocked) adapter has no `__type` marker — assert via kind().
      expect(adapter.kind()).toBe('pi-ai');
      expect(readAdapterConfig(adapter)).toMatchObject({
        provider: 'prov-evaluator', model: 'evaluator-model',
      });
    } finally {
      delete process.env.EVAL_KEY;
    }
  });

  it('Case 2: rolloutReviewer enabled=false (default) → run-once seam resolves profile-rollout', () => {
    const ws = makeWorkspace();
    writeProfileConfig(ws, { rolloutReviewer: 'profile-rollout' });
    process.env.ROLLOUT_KEY = 'test-key';

    try {
      // Through the canonical taskKind→agent map, as run-once does.
      const agentName = AGENT_NAME_FOR_TASK_KIND['rollout_reviewer'];
      expect(agentName).toBe('rolloutReviewer');
      const resolved = resolveRuntimeFromPdConfig(ws, { agentName, ignoreAgentEnabled: true });
      if (resolved.result.ok === false) throw new Error(resolved.result.message);
      expect(resolved.result.provider).toBe('prov-rollout');
      expect(resolved.result.runtimeProfileId).toBe('profile-rollout');
    } finally {
      delete process.env.ROLLOUT_KEY;
    }
  });

  it('Case 3: per-agent isolation — evaluator resolves ITS profile, not the diagnostician one', () => {
    const ws = makeWorkspace();
    writeProfileConfig(ws, { diagnostician: 'profile-diagnostician', evaluator: 'profile-evaluator' });
    process.env.DIAG_KEY = 'test-key';
    process.env.EVAL_KEY = 'test-key';

    try {
      const adapter = resolveRuntimeAdapterFromConfig({
        runtimeKind: 'config',
        workspaceDir: ws,
        runnerKind: 'evaluator',
        agentName: 'evaluator',
        ignoreAgentEnabled: true,
      });
      expect(readAdapterConfig(adapter)).toMatchObject({
        provider: 'prov-evaluator', model: 'evaluator-model',
      });
    } finally {
      delete process.env.DIAG_KEY;
      delete process.env.EVAL_KEY;
    }
  });

  it('negative control: without ignoreAgentEnabled the shipped-disabled evaluator still refuses', () => {
    const ws = makeWorkspace();
    writeProfileConfig(ws, { evaluator: 'profile-evaluator' });
    process.env.EVAL_KEY = 'test-key';

    try {
      // Pins that the option (not something else) lifts the gate: the same
      // call without it honors enabled and refuses.
      expect(() => resolveRuntimeAdapterFromConfig({
        runtimeKind: 'config',
        workspaceDir: ws,
        runnerKind: 'evaluator',
        agentName: 'evaluator',
      })).toThrow(/disabled/);
    } finally {
      delete process.env.EVAL_KEY;
    }
  });

  it('Case 4: diagnostician bridge gate still HONORS enabled (no global bypass)', () => {
    const ws = makeWorkspace();
    writeProfileConfig(ws, { diagnostician: 'profile-diagnostician' });
    process.env.DIAG_KEY = 'test-key';

    try {
      const config = JSON.parse(fs.readFileSync(path.join(ws, '.pd', 'config.yaml'), 'utf8'));
      config.internalAgents.agents.diagnostician.enabled = false;
      fs.writeFileSync(path.join(ws, '.pd', 'config.yaml'), JSON.stringify(config));

      // Canonical diagnostician resolution (the pain-signal bridge path)
      // keeps failing closed with readiness=disabled.
      const viaWrapper = resolveRuntimeFromPdConfig(ws);
      expect(viaWrapper.result).toHaveProperty('ok', false);
      expect(isErr(viaWrapper.result).reason).toBe('disabled');

      const viaCore = resolveRuntimeConfigForAgent(
        computeEffectivePdConfig(config),
        'diagnostician',
        { getEnvVar: (name) => process.env[name] },
      );
      expect(viaCore).toHaveProperty('ok', false);
      expect(isErr(viaCore).reason).toBe('disabled');
    } finally {
      delete process.env.DIAG_KEY;
    }
  });

  it('B7 cross-entry equivalence: run-once path and auto-consumer path resolve the SAME binding', () => {
    const ws = makeWorkspace();
    writeProfileConfig(ws, { diagnostician: 'profile-diagnostician', evaluator: 'profile-evaluator' });
    process.env.EVAL_KEY = 'test-key';

    try {
      // Auto-consumer path: per-kind resolution with peer scope semantics.
      const consumerResult = resolveRuntimeConfigForAgent(
        computeEffectivePdConfig(JSON.parse(fs.readFileSync(path.join(ws, '.pd', 'config.yaml'), 'utf8'))),
        'evaluator',
        { getEnvVar: (name) => process.env[name], ignoreAgentEnabled: true },
      );

      // Explicit run-once path: resolveRuntimeFromPdConfig with the same
      // agent + scope semantics (exactly what run-once's two resolution
      // points use).
      const runOnceResult = resolveRuntimeFromPdConfig(ws, {
        agentName: 'evaluator',
        ignoreAgentEnabled: true,
      }).result;

      expect(runOnceResult).toEqual(consumerResult);
      if (runOnceResult.ok === false || consumerResult.ok === false) return;
      expect(runOnceResult.runtimeProfileId).toBe('profile-evaluator');
      expect(runOnceResult.provider).toBe('prov-evaluator');
      expect(runOnceResult.model).toBe('evaluator-model');
    } finally {
      delete process.env.EVAL_KEY;
    }
  });
});
