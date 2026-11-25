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
import { chmodSync, closeSync, existsSync, lstatSync, openSync, renameSync, statSync, writeFileSync } from 'fs';
import { homedir } from 'os';
import { withLock } from '../utils/file-lock.js';
import { resolveOpenClawConfigPath } from '@principles/install-layout';
import { readOpenClawEffectiveConfig } from './openclaw-config-loader.js';

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

function getOpenClawConfigPath(): string | null {
  const resolved = resolveOpenClawConfigPath(process.env, homedir());
  return resolved.ok ? resolved.path : null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function readConfig(configPath: string): Record<string, unknown> | null {
  const result = readOpenClawEffectiveConfig(configPath);
  return result.ok ? result.config : null;
}

function readRawAndEffectiveConfig(configPath: string): { rawConfig: Record<string, unknown>; config: Record<string, unknown>; usesInclude: boolean; strictJson: boolean } | null {
  const result = readOpenClawEffectiveConfig(configPath);
  return result.ok ? { rawConfig: result.rawConfig, config: result.config, usesInclude: result.usesInclude, strictJson: result.strictJson } : null;
}

function ownershipPathIncludeManaged(cfg: Record<string, unknown>): boolean {
  // Only ancestors capable of supplying plugins.entries.<id>.hooks can make
  // the write target ambiguous. Includes in unrelated sibling branches (for
  // example plugins.allow) neither own nor can override the permission flag.
  let node: unknown = cfg;
  if (isRecord(node) && Object.hasOwn(node, '$include')) return true;
  for (const key of ['plugins', 'entries', PLUGIN_ID, 'hooks']) {
    if (!isRecord(node)) return false;
    node = node[key];
    if (!isRecord(node)) return false;
    if (Object.hasOwn(node, '$include')) return true;
  }
  return false;
}

function writeConfigAtomic(configPath: string, cfg: Record<string, unknown>): void {
  const tmpPath = configPath + '.tmp.' + Date.now();
  const originalMode = statSync(configPath).mode & 0o777;
  // Create the replacement with the original disclosure mode from the first
  // open. Waiting until after writeFileSync would leave a short window in
  // which a 0600 Owner config existed as a umask-created 0644 temporary file.
  const fd = openSync(tmpPath, 'wx', originalMode);
  try {
    writeFileSync(fd, JSON.stringify(cfg, null, 2), 'utf8');
  } finally {
    closeSync(fd);
  }
  // Preserve bits the process umask may have removed; the creation-time mode
  // above is the security-critical half that prevents temporary widening.
  chmodSync(tmpPath, originalMode);
  renameSync(tmpPath, configPath);
}

/**
 * Live read-side conversation access decision. A missing global config keeps
 * the documented missing-flag fallback semantics; an unreadable existing
 * config or explicit `allowConversationAccess=false` blocks reads.
 */
export function shouldBlockOpenClawConversationReads(pluginId: string = PLUGIN_ID): boolean {
  const configPath = getOpenClawConfigPath();
  // Fail closed whenever the EFFECTIVE host config cannot be identified,
  // read, or parsed. Missing/default-absent is not permission.
  if (configPath === null || !existsSync(configPath)) return true;
  const config = readConfig(configPath);
  if (config === null) return true;
  const entry = getPluginEntry(config, pluginId);
  if (isExplicitConversationAccessOptOut(entry)) return true;
  const access = checkConversationAccessConfig(entry);
  return !access.authorized;
}

export function ensureConversationAccessInConfig(): boolean {
  const configPath = getOpenClawConfigPath();
  if (configPath === null || !existsSync(configPath)) return false;

  return withLock(configPath, () => {
    // Atomic replacement would replace the symlink directory entry rather
    // than the linked host config, silently detaching future administrator
    // edits to the real target. This ownership is ambiguous, so fail closed
    // and leave manual repair to the Owner instead of following the link.
    if (lstatSync(configPath).isSymbolicLink()) return false;
    const loaded = readRawAndEffectiveConfig(configPath);
    if (!loaded) return false;
    // If the plugins ownership path (or the root object supplying it) crosses
    // `$include`, the write target is ambiguous: adding a main-config sibling
    // could override an Owner decision supplied by the include graph. Refuse
    // auto-repair in that case; unrelated include branches do not block the
    // historical absent-flag repair in the main config.
    const cfg = loaded.rawConfig;
    if (ownershipPathIncludeManaged(cfg)) return false;
    // JSON5 comments and formatting are Owner-managed configuration content.
    // JSON.stringify cannot preserve them, so a JSON5-only main config is
    // never auto-rewritten; the Owner receives the manual repair command
    // through the existing health guidance instead.
    if (!loaded.strictJson) return false;

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

    // An explicit value — true OR false — is an Owner decision recorded in the
    // host-owned config (false is the documented turn-off: `openclaw config
    // set plugins.entries.principles-disciple.hooks.allowConversationAccess
    // false`). The auto-fix below repairs only an ABSENT flag; rewriting an
    // explicit deny would silently reverse the Owner's decision on every
    // gateway start and defeat the flag as the surface's disable control.
    if (Object.hasOwn(hooks, CONVERSATION_ACCESS_CONFIG_KEY)) {
      return false;
    }

    hooks.allowConversationAccess = true;
    entries[PLUGIN_ID] = entry;
    writeConfigAtomic(configPath, cfg);
    return true;
  });
}

/**
 * True when the plugin entry carries an explicit
 * `hooks.allowConversationAccess === false`. Callers should honor the opt-out
 * (structured rc-9 log) instead of attempting the absent-flag auto-fix.
 */
export function isExplicitConversationAccessOptOut(pluginEntry: unknown): boolean {
  if (!pluginEntry || typeof pluginEntry !== 'object' || Array.isArray(pluginEntry)) return false;
  const hooks = (pluginEntry as Record<string, unknown>).hooks;
  if (!hooks || typeof hooks !== 'object' || Array.isArray(hooks)) return false;
  return (hooks as Record<string, unknown>)[CONVERSATION_ACCESS_CONFIG_KEY] === false;
}
