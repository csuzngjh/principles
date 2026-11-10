// PRI-1163 controlled-host round-key run — the frozen run shape.
//
// GOAL: on the unmodified official OpenClaw 2026.11.1, with the PUBLISHED
// 3.1.3 plugin bundle (sha256 7301253d…6546d), prove that two consecutive
// genuine USER turns in ONE explicit session drive fair_rotation_v1 with an
// advancing selectionRoundOrdinal through the official normal-chat embedded
// entry (`openclaw agent --local --session-id <pinned>`).
//
// Differences from the PRI-1152 presence shape (deliberate):
//   - ONE shared state dir for both rounds + an explicit --session-id, so
//     round 2 resumes the SAME session and the persisted user_turns ordinal
//     advances (PRI-1152 used per-round state dirs = per-round sessions).
//   - signal_collector is ENABLED in the PD config: the pre-selection half of
//     the round-key provider (detectSync -> user_turns write) needs it.
//   - Six synthetic fixture principles (formal store entries, no approvals
//     row, authority derives to system_policy) so rotation has >1 candidate.
//   - The round-key judgments read runtime_v2_prompt_activations_injected
//     payloads (selectionPolicy/selectionRoundOrdinal/rotationStartIndex),
//     not presence events.
//
// Everything here is DATA for the frozen pack plus structural validators.
// Nothing here starts a host.

import { createHash, randomBytes } from 'node:crypto';
import { readFileSync, realpathSync } from 'node:fs';
import { resolve } from 'node:path';
import { getDefaultPdConfig } from '@principles/core/runtime';
import { endpointBaseUrl, MCP_SERVER_NAME, PLUGIN_ID } from './host-config.mjs';
import { PRESENCE_API_PATHS } from './presence-endpoint.mjs';

export const CARD_VERSION = 'pri1163-round-key-run-card-v1';
export const ROUNDKEY_MODEL_ID = 'isolated-roundkey-model';
export const ROUNDKEY_PROVIDER = 'pdroundkey-completions';
export const ROUNDKEY_API = 'openai-completions';
export const ROUNDKEY_ENDPOINT_PATH = PRESENCE_API_PATHS['openai-completions'];

/** ONE explicit session for both rounds (the whole point of this run). */
export const ROUNDKEY_SESSION_ID = '6e1f2a3b-4c5d-4e8f-9a0b-1c2d3e4f5a6b';

/** Owner-proposed caps (pending approval): host starts 2, provider HTTP 2, tools 0, paid 0. */
export const ROUNDKEY_RUN_BUDGET = Object.freeze({ hostTurns: 2, httpRequests: 2, toolCalls: 0, paidCalls: 0 });
export const ROUNDKEY_ROUND_BUDGETS = Object.freeze({
  R1: Object.freeze({ hostTurns: 1, httpRequests: 1, toolCalls: 0, paidCalls: 0 }),
  R2: Object.freeze({ hostTurns: 1, httpRequests: 1, toolCalls: 0, paidCalls: 0 }),
});

export const ROUNDKEY_ROUNDS = Object.freeze([
  Object.freeze({ id: 'R1' }),
  Object.freeze({ id: 'R2' }),
]);

/**
 * The two frozen user inputs (distinct texts; same session). The plugin must
 * classify them as user-interaction rounds (trigger user/api/undefined) —
 * the round gate reads the plugin's own `handleBeforePromptBuild called:
 * ... trigger=<x>` log line and FAILS the run if a non-interactive trigger
 * (heartbeat/cron/subagent) is observed for a user input round.
 */
export const ROUNDKEY_INPUTS = Object.freeze({
  R1: Object.freeze('PRI-1163 受控验收用户轮一：请确认本轮注入的原则集合与选择策略。'),
  R2: Object.freeze('PRI-1163 受控验收用户轮二：继续同一会话，请确认轮次序数已推进。'),
});

/** Host session settings: disable the embedded runner's transient retry budget. */
export const ROUNDKEY_AGENT_SETTINGS = Object.freeze({ retry: Object.freeze({ provider: Object.freeze({ maxRetries: 0 }) }) });

/**
 * `<workspace>/.pd/config.yaml` feature expectations. Unlike the PRI-1152
 * presence shape, signal_collector is ON: the round-key provider's
 * pre-selection half (detectSync -> user_turns persistence) requires it.
 */
export const ROUNDKEY_PD_FEATURE_EXPECTATIONS = Object.freeze({
  prompt: true,
  signal_collector: true,
  internalization_auto_consumer: false,
  correction_observer: false,
  anonymous_product_telemetry: false,
});

export function buildRoundKeyPdConfigText() {
  const config = getDefaultPdConfig();
  for (const [flag, enabled] of Object.entries(ROUNDKEY_PD_FEATURE_EXPECTATIONS)) {
    if (!config.features?.[flag]) throw new Error(`default PD config has no feature '${flag}'`);
    config.features[flag] = { ...config.features[flag], enabled };
  }
  return `${JSON.stringify(config, null, 2)}\n`;
}

/** A loopback-only placeholder generated per pack; never a source literal. */
export function generateRoundKeyApiKey() {
  return `pdroundkey-local-${randomBytes(16).toString('hex')}`;
}
export const ROUNDKEY_API_KEY_PATTERN = /^pdroundkey-local-[0-9a-f]{32}$/;

export function roundKeyModelRef() {
  return `${ROUNDKEY_PROVIDER}/${ROUNDKEY_MODEL_ID}`;
}

/**
 * Six synthetic fixture principles, seeded through the formal stores
 * (seedControlledWorkspace; no approvals row; the shared prompt route derives
 * authority="system_policy"). Ascending activatedAt fixes a deterministic FIFO
 * base order so round-over-round rotation is observable. Each body is small
 * (budget 4000 fits all six, so every round selects all six from a rotating
 * start index — the SELECTION ORDER rotates even though the candidate set is
 * fully selected; the round gate therefore asserts on rotationStartIndex and
 * selectionRoundOrdinal, not on differing principle-id sets).
 */
export const ROUNDKEY_FIXTURES = Object.freeze([
  Object.freeze({ principleId: 'pri1163-roundkey-fixture-01', artifactId: 'art-pri1163-roundkey-fixture-01', activationId: 'act_prompt_pri1163-roundkey-fixture-01', text: 'PRI-1163 轮转夹具一：交付前核对预算与轮次序数（fixture-01）。' }),
  Object.freeze({ principleId: 'pri1163-roundkey-fixture-02', artifactId: 'art-pri1163-roundkey-fixture-02', activationId: 'act_prompt_pri1163-roundkey-fixture-02', text: 'PRI-1163 轮转夹具二：同一会话内序数必须逐轮推进（fixture-02）。' }),
  Object.freeze({ principleId: 'pri1163-roundkey-fixture-03', artifactId: 'art-pri1163-roundkey-fixture-03', activationId: 'act_prompt_pri1163-roundkey-fixture-03', text: 'PRI-1163 轮转夹具三：非用户轮不得推进序数（fixture-03）。' }),
  Object.freeze({ principleId: 'pri1163-roundkey-fixture-04', artifactId: 'art-pri1163-roundkey-fixture-04', activationId: 'act_prompt_pri1163-roundkey-fixture-04', text: 'PRI-1163 轮转夹具四：缺键回退 legacy FIFO（fixture-04）。' }),
  Object.freeze({ principleId: 'pri1163-roundkey-fixture-05', artifactId: 'art-pri1163-roundkey-fixture-05', activationId: 'act_prompt_pri1163-roundkey-fixture-05', text: 'PRI-1163 轮转夹具五：同轮重试字节稳定（fixture-05）。' }),
  Object.freeze({ principleId: 'pri1163-roundkey-fixture-06', artifactId: 'art-pri1163-roundkey-fixture-06', activationId: 'act_prompt_pri1163-roundkey-fixture-06', text: 'PRI-1163 轮转夹具六：发布产物行为与源码一致（fixture-06）。' }),
]);

/**
 * Host config: ONE loopback completions provider, candidate-only plugin load,
 * deny-all tools, MCP off, host log pinned in-pack (the round gate reads the
 * plugin's own registration + explicit-workspace lines from it at info level).
 */
export function buildRoundKeyHostConfig({ endpointPort, pluginRoot, fakeApiKey, hostLogPath }) {
  if (typeof fakeApiKey !== 'string' || fakeApiKey.length < 16) throw new Error('buildRoundKeyHostConfig: fakeApiKey is required');
  if (typeof hostLogPath !== 'string' || !hostLogPath.trim()) throw new Error('buildRoundKeyHostConfig: hostLogPath is required');
  const baseUrl = endpointBaseUrl(endpointPort);
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
    tools: { deny: ['*'] },
    mcp: { servers: { [MCP_SERVER_NAME]: { enabled: false } } },
    models: { mode: 'merge', providers: {
      [ROUNDKEY_PROVIDER]: {
        baseUrl,
        apiKey: fakeApiKey,
        api: ROUNDKEY_API,
        models: [{ id: ROUNDKEY_MODEL_ID, name: 'PD Round-Key Isolated Model' }],
      },
    } },
    agents: { defaults: { model: { primary: roundKeyModelRef() } } },
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
export function validateRoundKeyHostConfig(config, expected) {
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
  if (entry?.hooks?.allowConversationAccess !== true) violations.push('allowConversationAccess is not true (trajectory collection would be blocked)');
  if (entry?.hooks?.allowPromptInjection !== true) violations.push('allowPromptInjection is not true');
  if (entry?.config?.adaptiveActivation !== undefined) violations.push('adaptiveActivation must be absent: the round-key run uses the ordinary shared prompt route');
  if (!Array.isArray(config?.tools?.deny) || config.tools.deny.length !== 1 || config.tools.deny[0] !== '*') violations.push('tools.deny is not exactly ["*"]');
  if (config?.tools?.allow !== undefined || config?.tools?.alsoAllow !== undefined) violations.push('tools.allow/alsoAllow must be absent');
  const servers = config?.mcp?.servers ?? {};
  if (servers[MCP_SERVER_NAME]?.enabled !== false) violations.push(`mcp.servers.${MCP_SERVER_NAME}.enabled is not false`);
  const otherEnabled = Object.entries(servers).filter(([name, value]) => name !== MCP_SERVER_NAME && value?.enabled !== false).map(([name]) => name);
  if (otherEnabled.length > 0) violations.push(`other MCP servers enabled: ${otherEnabled.join(', ')}`);
  const providers = config?.models?.providers ?? {};
  const providerIds = Object.keys(providers).sort();
  if (providerIds.length !== 1 || providerIds[0] !== ROUNDKEY_PROVIDER) violations.push(`models.providers must be exactly [${ROUNDKEY_PROVIDER}]`);
  const provider = providers[ROUNDKEY_PROVIDER];
  if (provider?.baseUrl !== endpointBaseUrl(expected.endpointPort)) violations.push(`${ROUNDKEY_PROVIDER}.baseUrl is not the frozen loopback endpoint`);
  if (provider?.api !== ROUNDKEY_API) violations.push(`${ROUNDKEY_PROVIDER}.api is not ${ROUNDKEY_API}`);
  if (typeof provider?.apiKey !== 'string' || !ROUNDKEY_API_KEY_PATTERN.test(provider.apiKey)) violations.push(`${ROUNDKEY_PROVIDER}.apiKey is not a generated loopback placeholder`);
  if (!Array.isArray(provider?.models) || provider.models.length !== 1 || provider.models[0]?.id !== ROUNDKEY_MODEL_ID) violations.push(`${ROUNDKEY_PROVIDER}.models is not exactly [${ROUNDKEY_MODEL_ID}]`);
  if (config?.agents?.defaults?.model?.primary !== roundKeyModelRef()) violations.push('agents.defaults.model.primary does not route to the loopback provider');
  if (!samePath(config?.logging?.file, expected.hostLogPath)) violations.push('logging.file is not the frozen in-pack host log');
  if (config?.logging?.level !== 'info') violations.push('logging.level is not info (the registration/explicit-workspace lines would not be written)');
  return violations;
}

/** sha256 of a file (used by the driver for inputs and frozen files). */
export function sha256File(path) {
  return createHash('sha256').update(readFileSync(path)).digest('hex');
}
