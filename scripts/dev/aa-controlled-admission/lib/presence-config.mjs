// PRI-1152 Path A isolated-host run — the frozen run shape.
//
// Two rounds against the unmodified official host, one per OpenAI-compatible
// API, each one host start with exactly one provider request:
//   R1  openai-responses   POST /v1/responses
//   R2  openai-completions POST /v1/chat/completions
// The ledger counter `hostTurns` is the host-START counter for this run shape.
//
// Everything here is DATA for the frozen pack (host config, PD config, host
// session settings) plus structural validators. Nothing starts a host.

import { createHash, randomBytes } from 'node:crypto';
import { readFileSync, realpathSync } from 'node:fs';
import { resolve } from 'node:path';
import { getDefaultPdConfig } from '@principles/core/runtime';
import { endpointBaseUrl, MCP_SERVER_NAME, PLUGIN_ID } from './host-config.mjs';
import { PRESENCE_API_PATHS } from './presence-endpoint.mjs';

export const PRESENCE_MODEL_ID = 'isolated-presence-model';

export const PRESENCE_ROUNDS = Object.freeze([
  Object.freeze({ id: 'R1', api: 'openai-responses', provider: 'pdpresence-responses', path: PRESENCE_API_PATHS['openai-responses'] }),
  Object.freeze({ id: 'R2', api: 'openai-completions', provider: 'pdpresence-completions', path: PRESENCE_API_PATHS['openai-completions'] }),
]);

/** Owner-proposed caps (pending approval): host starts 2, provider HTTP 2, tools 0, paid 0. */
export const PRESENCE_RUN_BUDGET = Object.freeze({ hostTurns: 2, httpRequests: 2, toolCalls: 0, paidCalls: 0 });
export const PRESENCE_ROUND_BUDGETS = Object.freeze({
  R1: Object.freeze({ hostTurns: 1, httpRequests: 1, toolCalls: 0, paidCalls: 0 }),
  R2: Object.freeze({ hostTurns: 1, httpRequests: 1, toolCalls: 0, paidCalls: 0 }),
});

/**
 * Host session settings written to `<workspace>/.openclaw/settings.json`.
 * The embedded runner's failover controller retries transient provider errors
 * up to 8 times by default; `retry.provider.maxRetries=0` disables that budget
 * (verified at OpenClaw 4ffdd2047d1: settings-manager getProviderRetrySettings,
 * project settings survive the default `sanitize` policy, which strips only
 * shellPath/shellCommandPrefix). The endpoint still refuses anything extra.
 */
export const PRESENCE_AGENT_SETTINGS = Object.freeze({ retry: Object.freeze({ provider: Object.freeze({ maxRetries: 0 }) }) });

/**
 * `<workspace>/.pd/config.yaml`. The PD config schema requires every feature
 * entry's `category` plus runtimeProfiles/internalAgents, and a malformed file
 * silently falls back to defaults, so the file is the full default config
 * (JSON is valid YAML for the JSON_SCHEMA loader) with only the background
 * features that could make their own model calls or timers switched off. The
 * prompt route stays at its default (on); the default runtime profile has an
 * empty provider/model/apiKeyEnv, so PD itself has no model credentials.
 */
export const PRESENCE_PD_FEATURE_EXPECTATIONS = Object.freeze({
  prompt: true,
  signal_collector: false,
  internalization_auto_consumer: false,
  correction_observer: false,
  anonymous_product_telemetry: false,
});

export function buildPresencePdConfigText() {
  const config = getDefaultPdConfig();
  for (const [flag, enabled] of Object.entries(PRESENCE_PD_FEATURE_EXPECTATIONS)) {
    if (!config.features?.[flag]) throw new Error(`default PD config has no feature '${flag}'`);
    config.features[flag] = { ...config.features[flag], enabled };
  }
  return `${JSON.stringify(config, null, 2)}\n`;
}

/** A loopback-only placeholder generated per pack; never a source literal. */
export function generateFakeApiKey() {
  return `pdpresence-local-${randomBytes(16).toString('hex')}`;
}

/**
 * Shape of the generated placeholder. The key itself is never fingerprinted:
 * the frozen config file's sha256 already pins it, and validation only needs
 * to know that every provider carries the SAME generated placeholder (not an
 * inherited or hand-written credential).
 */
export const FAKE_API_KEY_PATTERN = /^pdpresence-local-[0-9a-f]{32}$/;

export function sha256Text(value) {
  return createHash('sha256').update(String(value), 'utf8').digest('hex');
}

export function roundModelRef(round) {
  return `${round.provider}/${PRESENCE_MODEL_ID}`;
}

/**
 * `hostLogPath` pins the host's own file log inside the pack: without it the
 * host writes a rolling log under a temp root it chooses itself. Level `info`
 * keeps the plugin's `Principles Disciple Plugin registered. (Path: ...)` line,
 * which the round gate reads as the runtime registration source.
 */
export function buildPresenceHostConfig({ endpointPort, pluginRoot, fakeApiKey, hostLogPath }) {
  if (typeof fakeApiKey !== 'string' || fakeApiKey.length < 16) throw new Error('buildPresenceHostConfig: fakeApiKey is required');
  if (typeof hostLogPath !== 'string' || !hostLogPath.trim()) throw new Error('buildPresenceHostConfig: hostLogPath is required');
  const baseUrl = endpointBaseUrl(endpointPort);
  const providers = Object.fromEntries(PRESENCE_ROUNDS.map((round) => [round.provider, {
    baseUrl,
    apiKey: fakeApiKey,
    api: round.api,
    models: [{ id: PRESENCE_MODEL_ID, name: 'PD Presence Isolated Model' }],
  }]));
  return {
    plugins: {
      enabled: true,
      allow: [PLUGIN_ID],
      load: { paths: [pluginRoot] },
      entries: {
        [PLUGIN_ID]: {
          enabled: true,
          hooks: { allowPromptInjection: true, allowConversationAccess: true },
          config: { language: 'zh', auditLevel: 'low' },
        },
      },
    },
    // An empty allow list means "allow everything" in the host; deny-all is
    // the structural way to expose zero tools.
    tools: { deny: ['*'] },
    mcp: { servers: { [MCP_SERVER_NAME]: { enabled: false } } },
    models: { mode: 'merge', providers },
    agents: { defaults: { model: { primary: roundModelRef(PRESENCE_ROUNDS[0]) } } },
    logging: { level: 'info', file: hostLogPath },
  };
}

function samePath(left, right) {
  const norm = (path) => {
    let value = resolve(path);
    try { value = realpathSync(value); } catch { /* compare unresolved */ }
    return process.platform === 'win32' ? value.toLowerCase() : value;
  };
  return typeof left === 'string' && typeof right === 'string' && norm(left) === norm(right);
}

/** Structural validation of the frozen host config (never textual). */
export function validatePresenceHostConfig(config, expected) {
  const violations = [];
  const plugins = config?.plugins;
  const entry = plugins?.entries?.[PLUGIN_ID];
  if (plugins?.enabled !== true) violations.push('plugins.enabled is not true');
  if (!Array.isArray(plugins?.allow) || plugins.allow.length !== 1 || plugins.allow[0] !== PLUGIN_ID) violations.push(`plugins.allow is not exactly [${PLUGIN_ID}]`);
  const loadPaths = plugins?.load?.paths;
  if (!Array.isArray(loadPaths) || loadPaths.length !== 1 || !samePath(loadPaths[0], expected.pluginRoot)) {
    violations.push('plugins.load.paths is not exactly the frozen candidate root');
  }
  if (Object.keys(plugins?.entries ?? {}).length !== 1) violations.push('plugins.entries must configure only the candidate plugin');
  if (entry?.enabled !== true) violations.push('candidate plugin entry is not enabled');
  if (entry?.hooks?.allowConversationAccess !== true) violations.push('allowConversationAccess is not true (llm_input would be blocked)');
  if (entry?.hooks?.allowPromptInjection !== true) violations.push('allowPromptInjection is not true');
  if (entry?.config?.adaptiveActivation !== undefined) violations.push('adaptiveActivation must be absent: the presence run uses the ordinary shared prompt route');
  if (!Array.isArray(config?.tools?.deny) || config.tools.deny.length !== 1 || config.tools.deny[0] !== '*') violations.push('tools.deny is not exactly ["*"]');
  if (config?.tools?.allow !== undefined || config?.tools?.alsoAllow !== undefined) violations.push('tools.allow/alsoAllow must be absent');
  const servers = config?.mcp?.servers ?? {};
  if (servers[MCP_SERVER_NAME]?.enabled !== false) violations.push(`mcp.servers.${MCP_SERVER_NAME}.enabled is not false`);
  const otherEnabled = Object.entries(servers).filter(([name, value]) => name !== MCP_SERVER_NAME && value?.enabled !== false).map(([name]) => name);
  if (otherEnabled.length > 0) violations.push(`other MCP servers enabled: ${otherEnabled.join(', ')}`);
  const providers = config?.models?.providers ?? {};
  const providerIds = Object.keys(providers).sort();
  const expectedIds = PRESENCE_ROUNDS.map((round) => round.provider).sort();
  if (providerIds.length !== expectedIds.length || providerIds.some((id, index) => id !== expectedIds[index])) {
    violations.push(`models.providers must be exactly ${expectedIds.join(', ')}`);
  }
  for (const round of PRESENCE_ROUNDS) {
    const provider = providers[round.provider];
    if (provider?.baseUrl !== endpointBaseUrl(expected.endpointPort)) violations.push(`${round.provider}.baseUrl is not the frozen loopback endpoint`);
    if (provider?.api !== round.api) violations.push(`${round.provider}.api is not ${round.api}`);
    if (typeof provider?.apiKey !== 'string' || !FAKE_API_KEY_PATTERN.test(provider.apiKey)) violations.push(`${round.provider}.apiKey is not a generated loopback placeholder`);
    if (!Array.isArray(provider?.models) || provider.models.length !== 1 || provider.models[0]?.id !== PRESENCE_MODEL_ID) violations.push(`${round.provider}.models is not exactly [${PRESENCE_MODEL_ID}]`);
  }
  const keys = new Set(PRESENCE_ROUNDS.map((round) => providers[round.provider]?.apiKey));
  if (keys.size !== 1) violations.push('providers must share the one generated placeholder key');
  if (config?.agents?.defaults?.model?.primary !== roundModelRef(PRESENCE_ROUNDS[0])) violations.push('agents.defaults.model.primary does not route to the loopback provider');
  if (!samePath(config?.logging?.file, expected.hostLogPath)) violations.push('logging.file is not the frozen in-pack host log');
  if (config?.logging?.level !== 'info') violations.push('logging.level is not info (the registration line would not be written)');
  return violations;
}

export function readJsonFile(path) {
  return JSON.parse(readFileSync(path, 'utf8'));
}
