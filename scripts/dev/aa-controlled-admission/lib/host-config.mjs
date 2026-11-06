// PRI-1118 controlled-admission experiment — the host's EFFECTIVE config.
//
// The endpoint the fake provider actually listens on is known only after the
// port is allocated, so the config is materialised from that port and frozen
// before P0. P0 and both arms load the SAME file; a changed file or a changed
// frozen artifact is a refusal, never a silent re-materialisation.
//
// Verification is structural (parsed JSON), not textual: "the output contains
// read" is not evidence that the tool surface is the declared allowlist.

import { createHash } from 'node:crypto';
import { readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { resolve } from 'node:path';

export const FAKE_PROVIDER_ID = 'aa-fake';
export const FAKE_MODEL_ID = 'local-fake-model';
export const PLUGIN_ID = 'principles-disciple';

export function endpointBaseUrl(port) {
  if (!Number.isInteger(port) || port <= 0 || port > 65535) throw new Error(`invalid endpoint port: ${port}`);
  return `http://127.0.0.1:${port}/v1`;
}

/**
 * Allocate a free loopback port, then release it. The run launcher binds that
 * exact port later; if it is taken by then the run fails closed instead of
 * searching for another port (which would silently change the frozen config).
 */
export async function selectLoopbackPort() {
  const server = createServer();
  try {
    await new Promise((resolvePromise, reject) => {
      server.once('error', reject);
      server.listen(0, '127.0.0.1', () => {
        server.off('error', reject);
        resolvePromise();
      });
    });
    const address = server.address();
    if (!address || typeof address !== 'object' || typeof address.port !== 'number') {
      throw new Error('port allocation returned no address');
    }
    return address.port;
  } finally {
    await new Promise((resolvePromise) => server.close(() => resolvePromise()));
  }
}

function normalizePath(path) {
  const resolved = resolve(path);
  return process.platform === 'win32' ? resolved.toLowerCase() : resolved;
}

function samePath(left, right) {
  try {
    return normalizePath(realpathSync(left)) === normalizePath(realpathSync(right));
  } catch {
    return false;
  }
}

function sameArray(left, right) {
  return Array.isArray(left) && Array.isArray(right)
    && left.length === right.length
    && left.every((value, index) => value === right[index]);
}

/**
 * Build the effective host config. `mapping` is the adaptive-activation mapping
 * the plugin reads; `toolName` is the SINGLE model-visible tool.
 */
export function buildHostConfig({ endpointPort, workspaceDir, pluginRoot, mapping, toolName }) {
  if (!toolName) throw new Error('buildHostConfig: toolName is required');
  return {
    plugins: {
      enabled: true,
      allow: [PLUGIN_ID],
      load: { paths: [pluginRoot] },
      entries: {
        [PLUGIN_ID]: {
          enabled: true,
          hooks: { allowPromptInjection: true, allowConversationAccess: true },
          config: {
            adaptiveActivation: {
              enabled: true,
              workspaceDir,
              artifactId: mapping.artifactId,
              activationId: mapping.activationId,
              expiresAt: mapping.expiresAt,
              softTimeoutMs: mapping.softTimeoutMs,
            },
            language: 'zh',
            auditLevel: 'low',
          },
        },
      },
    },
    // `minimal` does not register the fs tools at all, so `allow: ["read"]`
    // would resolve to an empty surface. `coding` registers group:fs while the
    // absolute allowlist still clamps the model-visible surface to exactly one
    // tool. Profile + allowlist are both asserted structurally below.
    tools: { profile: 'coding', allow: [toolName] },
    models: {
      mode: 'merge',
      providers: {
        [FAKE_PROVIDER_ID]: {
          baseUrl: endpointBaseUrl(endpointPort),
          apiKey: 'aa-fake-key',
          api: 'openai-completions',
          models: [{ id: FAKE_MODEL_ID, name: 'AA Fake Model' }],
        },
      },
    },
    agents: { defaults: { model: { primary: `${FAKE_PROVIDER_ID}/${FAKE_MODEL_ID}` } } },
  };
}

export function hostConfigSha256(path) {
  return createHash('sha256').update(readFileSync(path)).digest('hex');
}

export function writeHostConfig(path, config) {
  writeFileSync(path, `${JSON.stringify(config, null, 2)}\n`, 'utf8');
}

export function readHostConfig(path) {
  return JSON.parse(readFileSync(path, 'utf8'));
}

/** Structural check of the frozen config against the expected wiring. */
export function validateHostConfigWiring(config, expected) {
  const violations = [];
  const plugin = config?.plugins;
  const entry = plugin?.entries?.[PLUGIN_ID];
  const activation = entry?.config?.adaptiveActivation;

  if (plugin?.enabled !== true) violations.push('plugins.enabled is not true');
  if (!Array.isArray(plugin?.allow) || !sameArray(plugin.allow, [PLUGIN_ID])) violations.push(`plugins.allow is not exactly [${PLUGIN_ID}]`);
  const loadPaths = plugin?.load?.paths;
  if (!Array.isArray(loadPaths) || loadPaths.length !== 1) {
    violations.push('plugins.load.paths must contain exactly one plugin root');
  } else if (!samePath(loadPaths[0], expected.pluginRoot)) {
    violations.push('plugins.load.paths does not resolve to the frozen plugin root');
  }
  if (entry?.enabled !== true) violations.push('plugin entry is not enabled');
  if (entry?.hooks?.allowPromptInjection !== true) violations.push('allowPromptInjection is not true');
  if (entry?.hooks?.allowConversationAccess !== true) violations.push('allowConversationAccess is not true');

  if (activation?.enabled !== true) violations.push('adaptiveActivation.enabled is not true');
  if (typeof activation?.workspaceDir !== 'string' || !samePath(activation.workspaceDir, expected.workspaceDir)) {
    violations.push('adaptiveActivation.workspaceDir does not resolve to the frozen workspace');
  }
  if (activation?.artifactId !== expected.mapping.artifactId) violations.push('adaptiveActivation.artifactId differs from the frozen target');
  if (activation?.activationId !== expected.mapping.activationId) violations.push('adaptiveActivation.activationId differs from the frozen target');
  if (activation?.expiresAt !== expected.mapping.expiresAt) violations.push('adaptiveActivation.expiresAt differs from the frozen target');
  if (activation?.softTimeoutMs !== expected.mapping.softTimeoutMs) violations.push('adaptiveActivation.softTimeoutMs differs from the frozen target');

  if (!sameArray(config?.tools?.allow, [expected.toolName])) violations.push(`tools.allow is not exactly [${expected.toolName}]`);
  if (config?.tools?.profile !== 'coding') violations.push('tools.profile is not the frozen coding profile');
  if (config?.tools?.alsoAllow !== undefined) violations.push('tools.alsoAllow must be absent for a single-tool surface');
  if (config?.tools?.deny !== undefined) violations.push('tools.deny must be absent for a single-tool surface');

  const provider = config?.models?.providers?.[FAKE_PROVIDER_ID];
  if (provider?.baseUrl !== endpointBaseUrl(expected.endpointPort)) violations.push('provider baseUrl does not match the frozen endpoint port');
  if (provider?.api !== 'openai-completions') violations.push('provider api is not openai-completions');
  if (!Array.isArray(provider?.models) || provider.models[0]?.id !== FAKE_MODEL_ID) violations.push('provider model list does not contain the fake model');

  const primary = config?.agents?.defaults?.model?.primary;
  if (primary !== `${FAKE_PROVIDER_ID}/${FAKE_MODEL_ID}`) violations.push('agents.defaults.model.primary does not route to the fake provider');

  return violations;
}

/** Extract the host-relevant endpoint destination, e.g. for report evidence. */
export function endpointDestination(config) {
  const baseUrl = config?.models?.providers?.[FAKE_PROVIDER_ID]?.baseUrl;
  return typeof baseUrl === 'string' ? baseUrl : null;
}
