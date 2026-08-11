/**
 * OpenClawHostInstaller — implements HostInstaller for OpenClaw (ADR-0020 §2.3)
 *
 * Wraps the existing OpenClaw config write/cleanup logic that previously lived
 * as private functions in installer.ts and uninstaller.ts. Extracted into a
 * class so the CLI can route install/uninstall by --host (openclaw | codex).
 *
 * NO BEHAVIOR CHANGE: the logic is identical to the pre-refactor private
 * functions updateOpenClawConfig() / cleanupOpenClawConfig(). The existing
 * install() / uninstall() entry points delegate to this class.
 *
 * Runtime Contract Rules:
 * - rc-1-treat-as-unknown: openclaw.json parsed as unknown, validated.
 * - rc-2-no-as-bypass: uses Object.hasOwn + typeof guards, not `as`.
 * - rc-3-fail-loud-missing: malformed openclaw.json throws.
 * - rc-5-object-hasown-not-in: uses Object.hasOwn for untrusted keys.
 * - rc-9-no-silent-fallback: every result includes reason + nextAction.
 */
import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'fs';
import * as path from 'path';
import * as os from 'os';
import type {
  HostInstaller,
  HostInstallContext,
  HostInstallResult,
  HostUninstallContext,
  HostUninstallResult,
  HostDetectResult,
} from '@principles/core/host';
import { validateOpenClawConfig } from '../mvp-config.js';

// PRI-343: Keep in sync with @principles/core CONVERSATION_ACCESS_CONFIG_KEY
const CONVERSATION_ACCESS_CONFIG_KEY = 'allowConversationAccess';

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Type guard: extracts `.code` from a thrown error without `as NodeJS.ErrnoException`.
 * ESLint `no-undef` flags the `NodeJS` namespace; this helper avoids it.
 */
function getErrorCode(err: unknown): string | undefined {
  if (err !== null && typeof err === 'object' && Object.hasOwn(err, 'code')) {
    const { code } = err as { code?: unknown };
    return typeof code === 'string' ? code : undefined;
  }
  return undefined;
}

/**
 * PRI-343: Pure function — deep-merges allowConversationAccess: true into
 * the openclaw.json config without mutating the input.
 *
 * Ensures plugins.entries['principles-disciple'].hooks.allowConversationAccess
 * is set to true, creating intermediate objects if missing.
 * Preserves all other fields.
 */
function ensureConversationAccess(config: Record<string, unknown>): Record<string, unknown> {
  const result = { ...config };

  if (!isRecord(result.plugins)) return result;
  const plugins = { ...result.plugins };

  if (!isRecord(plugins.entries)) return result;
  const entries = { ...plugins.entries };

  const rawEntry = entries['principles-disciple'];
  const entry: Record<string, unknown> = isRecord(rawEntry)
    ? { ...rawEntry }
    : { enabled: true };

  const rawHooks = entry.hooks;
  const hooks = isRecord(rawHooks) ? { ...rawHooks } : {};

  hooks[CONVERSATION_ACCESS_CONFIG_KEY] = true;
  entry.hooks = hooks;
  entries['principles-disciple'] = entry;
  plugins.entries = entries;
  result.plugins = plugins;

  return result;
}

function getOpenClawDir(): string {
  return path.join(os.homedir(), '.openclaw');
}

function getPluginExtDir(): string {
  return path.join(getOpenClawDir(), 'extensions', 'principles-disciple');
}

/**
 * OpenClaw host installer — writes/merges ~/.openclaw/openclaw.json and
 * ~/.openclaw/plugins/installs.json. Does NOT install bundled components
 * (core/pd-cli/console) — that's the shared installer's job.
 */
export class OpenClawHostInstaller implements HostInstaller {
  readonly hostId = 'openclaw';

  async install(_ctx: HostInstallContext): Promise<HostInstallResult> {
    // OpenClaw install does not use workspaceDir from ctx — OpenClaw resolves
    // workspace from its own gateway config. The parameter is required by
    // the HostInstaller interface contract.
    void _ctx;
    const configDir = getOpenClawDir();
    const configPath = path.join(configDir, 'openclaw.json');

    // CodeQL TOCTOU fix: use try/catch read instead of existsSync+readFileSync.
    // The OpenClaw gateway creates openclaw.json on first run; if it doesn't
    // exist, PD's config is inert until the gateway starts. Not an error.
    let rawConfig: string;
    try {
      rawConfig = readFileSync(configPath, 'utf-8');
    } catch (err) {
      const code = getErrorCode(err);
      if (code === 'ENOENT') {
        return {
          success: true,
          hostId: this.hostId,
          configPath,
          configAction: 'skipped',
          reason: 'openclaw.json does not exist yet — PD plugin entries will be registered when OpenClaw gateway first starts.',
          nextAction: `Start OpenClaw gateway (openclaw gateway start), then verify: openclaw plugin list`,
        };
      }
      throw err;
    }

    try {
      const config: unknown = JSON.parse(rawConfig);

      const validation = validateOpenClawConfig(config);
      if (!validation.valid) {
        return {
          success: false,
          hostId: this.hostId,
          configPath,
          configAction: 'skipped',
          reason: `Malformed openclaw.json: ${validation.error}.`,
          nextAction: 'Fix ~/.openclaw/openclaw.json manually, then re-run: npx create-principles-disciple install --host openclaw',
        };
      }

      if (config === null || typeof config !== 'object' || Array.isArray(config)) {
        return {
          success: false,
          hostId: this.hostId,
          configPath,
          configAction: 'skipped',
          reason: 'openclaw.json parsed as non-object.',
          nextAction: 'Fix ~/.openclaw/openclaw.json manually, then re-run installer.',
        };
      }

      // rc-2: isRecord narrows config to Record<string, unknown> without `as` cast.
      const configObj = isRecord(config) ? { ...config } : {};

      // Ensure plugins.allow includes principles-disciple
      if (!configObj.plugins) configObj.plugins = {};
      if (!isRecord(configObj.plugins)) {
        return {
          success: false,
          hostId: this.hostId,
          configPath,
          configAction: 'skipped',
          reason: 'openclaw.json plugins field is malformed (not an object).',
          nextAction: 'Fix ~/.openclaw/openclaw.json plugins field manually, then re-run installer.',
        };
      }
      const plugins = { ...configObj.plugins };

      if (!plugins.allow) plugins.allow = [];
      if (!Array.isArray(plugins.allow)) {
        return {
          success: false,
          hostId: this.hostId,
          configPath,
          configAction: 'skipped',
          reason: 'openclaw.json plugins.allow is not an array.',
          nextAction: 'Fix ~/.openclaw/openclaw.json plugins.allow manually, then re-run installer.',
        };
      }
      const allow = (plugins.allow as unknown[]).filter((a): a is string => typeof a === 'string');
      if (!allow.includes('principles-disciple')) {
        allow.push('principles-disciple');
      }
      plugins.allow = allow;

      if (!plugins.entries) plugins.entries = {};
      if (!isRecord(plugins.entries)) {
        return {
          success: false,
          hostId: this.hostId,
          configPath,
          configAction: 'skipped',
          reason: 'openclaw.json plugins.entries is malformed.',
          nextAction: 'Fix ~/.openclaw/openclaw.json plugins.entries manually, then re-run installer.',
        };
      }
      const entries = { ...plugins.entries };
      const existingEntry = isRecord(entries['principles-disciple'])
        ? { ...entries['principles-disciple'] }
        : {};
      entries['principles-disciple'] = { ...existingEntry, enabled: true };
      plugins.entries = entries;
      configObj.plugins = plugins;

      // PRI-343: deep-merge allowConversationAccess: true
      const mergedConfigObj = ensureConversationAccess(configObj);
      writeFileSync(configPath, JSON.stringify(mergedConfigObj, null, 2));

      // Write install record to installs.json (the canonical store)
      this.writeInstallRecord(configDir);

      return {
        success: true,
        hostId: this.hostId,
        configPath,
        configAction: 'updated',
        nextAction: `Verify: openclaw plugin list (should show principles-disciple as enabled)`,
      };
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      return {
        success: false,
        hostId: this.hostId,
        configPath,
        configAction: 'skipped',
        reason: `Failed to update openclaw.json: ${reason}`,
        nextAction: 'Check file permissions on ~/.openclaw/openclaw.json and re-run installer.',
      };
    }
  }

  /**
   * Write install record to ~/.openclaw/plugins/installs.json.
   * Non-fatal on failure — OpenClaw manages this file and will self-heal.
   */
  // eslint-disable-next-line @typescript-eslint/class-methods-use-this
  private writeInstallRecord(configDir: string): void {
    const installsDir = path.join(configDir, 'plugins');
    const installsPath = path.join(installsDir, 'installs.json');
    try {
      // CodeQL TOCTOU fix: mkdirSync is idempotent (no pre-check needed);
      // readFileSync uses try/catch instead of existsSync+read.
      if (!existsSync(installsDir)) {
        mkdirSync(installsDir, { recursive: true });
      }
      // rc-3/rc-9: Only initialize a fresh record on ENOENT (file doesn't exist).
      // For any other read/parse failure (EACCES, EIO, malformed JSON), or when the
      // parsed value is not a record, RETURN without writing — overwriting would
      // destroy other plugins' installRecords. Non-fatal: OpenClaw self-heals.
      let installs: Record<string, unknown>;
      try {
        const raw = readFileSync(installsPath, 'utf-8');
        const parsed: unknown = JSON.parse(raw);
        if (!isRecord(parsed)) {
          // Parsed to a non-object (array/string/null) — preserve original file.
          return;
        }
        installs = parsed;
      } catch (err) {
        const code = getErrorCode(err);
        if (code === 'ENOENT') {
          // File doesn't exist — initialize fresh record (first install).
          installs = { version: 1, installRecords: {} };
        } else {
          // EACCES / EIO / malformed JSON — preserve original file, do not overwrite.
          return;
        }
      }
      // rc-2: isRecord narrows installRecords without `as` cast (ERR-001 recurrence).
      // Replaces the prior `typeof !== 'object'` check — isRecord also rejects arrays,
      // which the old check silently allowed through.
      const installRecords: Record<string, unknown> = isRecord(installs.installRecords)
        ? installs.installRecords
        : {};
      const extDir = getPluginExtDir();
      const pkgPath = path.join(extDir, 'package.json');
      let version: string | undefined = undefined;
      try {
        const pkg: unknown = JSON.parse(readFileSync(pkgPath, 'utf-8'));
        if (isRecord(pkg) && Object.hasOwn(pkg, 'version') && typeof pkg.version === 'string') {
          ({ version } = pkg);
        }
      } catch { /* ignore — ENOENT or malformed package.json */ }
      installRecords['principles-disciple'] = {
        source: 'path',
        installPath: extDir,
        ...(version ? { version } : {}),
        installedAt: new Date().toISOString(),
      };
      installs.installRecords = installRecords;
      writeFileSync(installsPath, JSON.stringify(installs, null, 2));
    } catch {
      // Non-fatal — installs.json is managed by OpenClaw and will self-heal
    }
  }

  async uninstall(_ctx: HostUninstallContext): Promise<HostUninstallResult> {
    const configDir = getOpenClawDir();
    const configPath = path.join(configDir, 'openclaw.json');
    const removedPaths: string[] = [];
    const preservedPaths: string[] = [];

    // CodeQL TOCTOU fix: try/catch read instead of existsSync+readFileSync.
    let raw: string;
    try {
      raw = readFileSync(configPath, 'utf-8');
    } catch (err) {
      const code = getErrorCode(err);
      if (code === 'ENOENT') {
        return {
          success: true,
          hostId: this.hostId,
          removedPaths,
          preservedPaths,
          nextAction: 'openclaw.json not found — nothing to clean.',
        };
      }
      throw err;
    }

    try {
      const config: unknown = JSON.parse(raw);

      if (config === null || typeof config !== 'object' || Array.isArray(config)) {
        return {
          success: false,
          hostId: this.hostId,
          removedPaths,
          preservedPaths,
          reason: 'openclaw.json is not an object',
          nextAction: 'Inspect ~/.openclaw/openclaw.json manually; PD entries may still be present.',
        };
      }

      // rc-2: isRecord narrows without `as` cast.
      const configObj = isRecord(config) ? config : {};
      let modified = false;

      if (isRecord(configObj.plugins)) {
        const {plugins} = configObj;

        // Remove from plugins.allow
        if (Array.isArray(plugins.allow)) {
          const before = plugins.allow.length;
          const filtered = (plugins.allow as unknown[]).filter(
            (a): a is string => typeof a === 'string' && a !== 'principles-disciple'
          );
          plugins.allow = filtered;
          if (filtered.length !== before) modified = true;
        }

        // Remove from plugins.entries
        if (isRecord(plugins.entries)) {
          const {entries} = plugins;
          if (Object.hasOwn(entries, 'principles-disciple')) {
            delete entries['principles-disciple'];
            modified = true;
          }
        }

        // Remove from plugins.installs (legacy field)
        if (isRecord(plugins.installs)) {
          const {installs} = plugins;
          if (Object.hasOwn(installs, 'principles-disciple')) {
            delete installs['principles-disciple'];
            modified = true;
          }
        }
      }

      if (modified) {
        writeFileSync(configPath, JSON.stringify(configObj, null, 2) + '\n');
        removedPaths.push(configPath);
        return {
          success: true,
          hostId: this.hostId,
          removedPaths,
          preservedPaths,
          nextAction: 'openclaw.json cleaned — principles-disciple entries removed.',
        };
      }

      return {
        success: true,
        hostId: this.hostId,
        removedPaths,
        preservedPaths,
        nextAction: 'openclaw.json had no principles-disciple entries — nothing to clean.',
      };
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      return {
        success: false,
        hostId: this.hostId,
        removedPaths,
        preservedPaths,
        reason,
        nextAction: 'Inspect ~/.openclaw/openclaw.json manually; PD entries may still be present.',
      };
    }
  }

  // eslint-disable-next-line @typescript-eslint/class-methods-use-this
  detect(): HostDetectResult {
    const configDir = getOpenClawDir();
    // detect() is non-interactive; use English labels (stable, no i18n dep).
    const paths = [
      {
        exists: existsSync(getPluginExtDir()),
        path: getPluginExtDir(),
        name: 'Plugin extension directory',
        type: 'dir' as const,
      },
      {
        exists: existsSync(path.join(configDir, 'principles-disciple.json')),
        path: path.join(configDir, 'principles-disciple.json'),
        name: 'OpenClaw config file',
        type: 'file' as const,
      },
    ];

    return {
      installed: paths.some((p) => p.exists),
      paths,
    };
  }
}
