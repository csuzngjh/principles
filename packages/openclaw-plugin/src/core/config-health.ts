/**
 * Conversation Access Health Check (PRI-343 / PRI-346)
 *
 * Pure function for checking whether OpenClaw plugin config has
 * allowConversationAccess set to true. When missing, llm_output and
 * trajectory hooks are silently blocked by OpenClaw, causing evidence
 * to always be empty (PRI-338 root cause).
 *
 * Extracted from index.ts to avoid circular imports when trajectory-collector.ts
 * needs to check conversation access state (PRI-346).
 */
import { existsSync, readFileSync, writeFileSync, renameSync } from 'fs';
import { homedir } from 'os';
import * as path from 'path';
import { withLock } from '../utils/file-lock.js';

/**
 * PRI-348: Extract the full plugin entry (including hooks) from the global OpenClaw config.
 * Unlike api.pluginConfig (which is only the entry.config sub-object), this returns
 * the entire entry including hooks, config, enabled, etc.
 */
export function getPluginEntry(config: unknown, pluginId: string): unknown {
  if (!config || typeof config !== 'object' || Array.isArray(config)) return undefined;
  const plugins = (config as Record<string, unknown>).plugins;
  if (!plugins || typeof plugins !== 'object' || Array.isArray(plugins)) return undefined;
  const entries = (plugins as Record<string, unknown>).entries;
  if (!entries || typeof entries !== 'object' || Array.isArray(entries)) return undefined;
  return (entries as Record<string, unknown>)[pluginId];
}

/** Keep in sync with @principles/core CONVERSATION_ACCESS_CONFIG_KEY */
const CONVERSATION_ACCESS_CONFIG_KEY = 'allowConversationAccess' as const;

export interface ConversationAccessCheckResult {
  authorized: boolean;
  reason?: string;
  nextAction?: string;
}

const CONVERSATION_ACCESS_FIX_COMMAND =
  'openclaw config set plugins.entries.principles-disciple.hooks.allowConversationAccess true --strict-json';

/**
 * PRI-343: Pure function — checks if pluginConfig has hooks.allowConversationAccess === true.
 * Returns a structured result with reason and nextAction when not authorized (ERR-002).
 */
export function checkConversationAccessConfig(pluginConfig: unknown): ConversationAccessCheckResult {
  if (pluginConfig === null || pluginConfig === undefined || typeof pluginConfig !== 'object' || Array.isArray(pluginConfig)) {
    return {
      authorized: false,
      reason: 'pluginConfig is missing or invalid — conversation hooks cannot be registered',
      nextAction: CONVERSATION_ACCESS_FIX_COMMAND,
    };
  }

  const config = pluginConfig as Record<string, unknown>;

  if (typeof config.hooks !== 'object' || config.hooks === null || Array.isArray(config.hooks)) {
    return {
      authorized: false,
      reason: 'allowConversationAccess is not set to true',
      nextAction: CONVERSATION_ACCESS_FIX_COMMAND,
    };
  }

  const hooks = config.hooks as Record<string, unknown>;
  if (hooks[CONVERSATION_ACCESS_CONFIG_KEY] !== true) {
    return {
      authorized: false,
      reason: 'allowConversationAccess is not set to true',
      nextAction: CONVERSATION_ACCESS_FIX_COMMAND,
    };
  }

  return { authorized: true };
}

const PLUGIN_ID = 'principles-disciple';

function getOpenClawConfigPath(): string {
  return path.join(homedir(), '.openclaw', 'openclaw.json');
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function readConfig(configPath: string): Record<string, unknown> | null {
  if (!existsSync(configPath)) return null;
  try {
    const raw = readFileSync(configPath, 'utf8').replace(/^\uFEFF/, '');
    const parsed = JSON.parse(raw);
    return isRecord(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

function writeConfigAtomic(configPath: string, cfg: Record<string, unknown>): void {
  const tmpPath = configPath + '.tmp.' + Date.now();
  writeFileSync(tmpPath, JSON.stringify(cfg, null, 2), 'utf8');
  renameSync(tmpPath, configPath);
}

export function ensureConversationAccessInConfig(): boolean {
  const configPath = getOpenClawConfigPath();
  if (!existsSync(configPath)) return false;

  return withLock(configPath, () => {
    const cfg = readConfig(configPath);
    if (!cfg) return false;

    if (!isRecord(cfg.plugins)) {
      cfg.plugins = {};
    }
    const plugins = cfg.plugins as Record<string, unknown>;

    if (!isRecord(plugins.entries)) {
      plugins.entries = {};
    }
    const entries = plugins.entries as Record<string, unknown>;

    const rawEntry = entries[PLUGIN_ID];
    const entry = isRecord(rawEntry) ? rawEntry : { enabled: true };

    if (!isRecord(entry.hooks)) {
      entry.hooks = {};
    }
    const hooks = entry.hooks as Record<string, unknown>;

    if (hooks.allowConversationAccess === true) {
      return false;
    }

    hooks.allowConversationAccess = true;
    entries[PLUGIN_ID] = entry;
    writeConfigAtomic(configPath, cfg);
    return true;
  });
}
