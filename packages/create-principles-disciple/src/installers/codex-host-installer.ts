/**
 * CodexHostInstaller — implements HostInstaller for OpenAI Codex CLI (ADR-0020 §2.3, SPEC v4.1 §5.7)
 *
 * Writes/merges `~/.codex/hooks.json` pointing to the codex-adapter's pd-hook.js
 * entry. Codex spawns pd-hook.js as a subprocess for each hook event.
 *
 * Install layout (does NOT mix with OpenClaw's ~/.openclaw/ tree):
 *   ~/.pd/codex/
 *   ├── pd-hook-entry.cjs     # wrapper: sets env vars + imports codex-adapter
 *   └── .pd-hooks.marker      # sidecar marker for precise uninstall
 *
 * hooks.json entries (SPEC v4.1 §5.7):
 *   ~/.codex/hooks.json (merged — append, never overwrite)
 *
 * Runtime Contract Rules:
 * - rc-1-treat-as-unknown: hooks.json parsed as unknown, validated.
 * - rc-2-no-as-bypass: uses Object.hasOwn + typeof guards.
 * - rc-3-fail-loud-missing: malformed hooks.json throws.
 * - rc-5-object-hasown-not-in: uses Object.hasOwn for untrusted keys.
 * - rc-9-no-silent-fallback: every result includes reason + nextAction.
 *
 * EP-06 (Source of Truth): hooks.json is the canonical hook config — we
 * merge into it, never overwrite. The marker file is our own bookkeeping
 * for precise uninstall.
 */
import { existsSync, readFileSync, writeFileSync } from 'fs';
import { execSync } from 'child_process';
import * as path from 'path';
import * as os from 'os';
import { createRequire } from 'module';
import { pathToFileURL } from 'url';
import { isNpmDependencyResolutionEnabled } from '../installer.js';
import type {
  HostInstaller,
  HostInstallContext,
  HostInstallResult,
  HostUninstallContext,
  HostUninstallResult,
  HostDetectResult,
} from '@principles/core/host';

const requireFromModule = createRequire(import.meta.url);

// ─── Codex hook event names (SPEC v4.1 §5.7) ────────────────────────────────
const CODEX_EVENTS = ['PreToolUse', 'PostToolUse', 'UserPromptSubmit', 'SessionStart'] as const;

const PD_HOOK_MARKER = 'pd-hooks.marker';

// ─── Type guards (rc-2: no `as` bypass) ─────────────────────────────────────
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isUnknownArray(value: unknown): value is unknown[] {
  return Array.isArray(value);
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

// ─── Path helpers ───────────────────────────────────────────────────────────
function getCodexDir(): string {
  return path.join(os.homedir(), '.codex');
}

function getCodexHooksJsonPath(): string {
  return path.join(getCodexDir(), 'hooks.json');
}

function getPdCodexDir(): string {
  return path.join(os.homedir(), '.pd', 'codex');
}

function getPdHookMarkerPath(): string {
  return path.join(getPdCodexDir(), PD_HOOK_MARKER);
}

/**
 * Resolve the path to the codex-adapter's pd-hook.js entry.
 *
 * Strategy:
 * 1. Try require.resolve('@principles/codex-adapter/pd-hook') from this
 *    package — works in a dev checkout (workspace sibling) or when the
 *    adapter sits in an ancestor node_modules.
 * 2. Fall back to the global npm root (`npm root -g`). A createRequire from
 *    THIS package cannot see global node_modules: when the installer runs via
 *    `npx create-principles-disciple`, the resolution root is the npx cache,
 *    which is not an ancestor of the global root. Without this probe, the
 *    documented flow "npm install -g @principles/codex-adapter, then re-run"
 *    dead-ends: install keeps failing even after the user follows the
 *    nextAction (PRI-523 review finding).
 * 3. Fall back to undefined — installer reports the missing dependency.
 */
function getGlobalNpmRoot(): string | undefined {
  // Registry dependency resolution is legitimate whenever the package is not
  // self-contained (the npm-distributed shape resolves from the registry
  // just like the PD_ALLOW_LEGACY_NPM_INSTALL recovery path).
  if (!isNpmDependencyResolutionEnabled()) return undefined;
  try {
    const root = execSync('npm root -g', { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
    return root.length > 0 ? root : undefined;
  } catch {
    return undefined;
  }
}

export function resolveAdapterPdHookFromDir(dir: string): string | undefined {
  try {
    // Probe filename inside the dir so resolution starts at that directory
    // and honors the package's exports map ("./pd-hook").
    return createRequire(path.join(dir, 'pd-adapter-probe.cjs')).resolve('@principles/codex-adapter/pd-hook');
  } catch {
    return undefined;
  }
}

export interface PdHookPathDeps {
  localResolve?: (specifier: string) => string | undefined;
  globalNpmRoot?: () => string | undefined;
  resolveFromDir?: (dir: string) => string | undefined;
}

export function resolvePdHookPath(deps: PdHookPathDeps = {}): string | undefined {
  const localResolve: (specifier: string) => string | undefined = deps.localResolve
    ?? ((specifier) => {
      try { return requireFromModule.resolve(specifier); } catch { return undefined; }
    });
  const globalNpmRoot = deps.globalNpmRoot ?? getGlobalNpmRoot;
  const resolveFromDir = deps.resolveFromDir ?? resolveAdapterPdHookFromDir;

  const local = localResolve('@principles/codex-adapter/pd-hook');
  if (local) return local;

  const globalRoot = globalNpmRoot();
  if (globalRoot) {
    const fromGlobal = resolveFromDir(globalRoot);
    if (fromGlobal) return fromGlobal;
  }
  return undefined;
}

/**
 * Hook entry / matcher-group shapes (rc-2 typing for detectLegacyCodexHookRegistration).
 * The builder that CREATED these groups was retired with the legacy installer
 * (SPEC rev 2 §17); the shapes remain because uninstall and the legacy
 * detector must still recognize what old installers wrote.
 */

// ─── Wrapper script content ─────────────────────────────────────────────────
/**
 * Generate the wrapper script that sets env vars and imports pd-hook.js.
 *
 * This is a CommonJS file so it can use process.env mutation before the
 * ESM pd-hook.js is dynamically imported. Cross-platform (no shell syntax).
 */
export function buildWrapperScriptContent(pdHookPath: string, workspaceDir: string): string {
  return [
    '#!/usr/bin/env node',
    '// Auto-generated by create-principles-disciple installer (CodexHostInstaller).',
    '// Sets PD env vars, then imports the codex-adapter pd-hook entry.',
    '// DO NOT edit manually — re-run the installer to regenerate.',
    '',
    'process.env.PD_HOST_CODEX_ENABLED = "1";',
    `process.env.PD_WORKSPACE_DIR = ${JSON.stringify(workspaceDir)};`,
    '',
    '// Import the codex-adapter pd-hook entry (ESM).',
    '// pd-hook.js reads stdin, processes the hook, writes stdout, exits.',
    // pathToFileURL — not manual `file://` concatenation: a POSIX absolute
    // path would produce file:////... and fail to import.
    `import(${JSON.stringify(pathToFileURL(pdHookPath).href)});`,
    '',
  ].join('\n');
}

// ─── Legacy registration detection (Slice D, SPEC rev 2 §17) ────────────────

export interface LegacyCodexRegistration {
  detected: boolean;
  /** true when a PD-owned PostToolUse group still carries the legacy `async: true` shape. */
  legacyAsyncPostToolUse: boolean;
  hooksJsonPath: string;
}

/**
 * Detect a PD-owned legacy global hook registration in ~/.codex/hooks.json:
 * any `__pd_marker: "pd-owned"` group (the marker only ever came from this
 * installer). `legacyAsyncPostToolUse` additionally identifies the retired
 * `async: true` PostToolUse shape, which the Marketplace plugin does not use
 * (its hooks.json omits the async flag) — the difference health/setup use to
 * offer the §17 migration.
 */
export function detectLegacyCodexHookRegistration(hooksJsonPathOverride?: string): LegacyCodexRegistration {
  const hooksJsonPath = hooksJsonPathOverride ?? getCodexHooksJsonPath();
  const result: LegacyCodexRegistration = { detected: false, legacyAsyncPostToolUse: false, hooksJsonPath };
  let raw: string;
  try {
    raw = readFileSync(hooksJsonPath, 'utf-8');
  } catch {
    return result;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return result;
  }
  if (!isRecord(parsed)) return result;
  for (const eventName of CODEX_EVENTS) {
    const groups = parsed[eventName];
    if (!isUnknownArray(groups)) continue;
    for (const group of groups) {
      if (!(isRecord(group) && Object.hasOwn(group, '__pd_marker') && group.__pd_marker === 'pd-owned')) continue;
      result.detected = true;
      const entries = group.hooks;
      if (isUnknownArray(entries)) {
        for (const entry of entries) {
          if (isRecord(entry) && eventName === 'PostToolUse' && Object.hasOwn(entry, 'async') && entry.async === true) {
            result.legacyAsyncPostToolUse = true;
          }
        }
      }
    }
  }
  return result;
}

// ─── CodexHostInstaller ─────────────────────────────────────────────────────
export class CodexHostInstaller implements HostInstaller {
  readonly hostId = 'codex';

  /**
   * RETIRED for new registrations (Codex Governance Closure Slice D; SPEC rev
   * 2 §17 — the Marketplace plugin is the only supported new install path;
   * this legacy global-hook installer is migration/uninstall-only).
   *
   * This method NEVER writes hook registrations anymore. It returns a
   * structured refusal that points at the supported path, and when a legacy
   * PD global registration is detected it offers the explicit migration
   * route (precise uninstall → Marketplace plugin → $pd-setup consent).
   */
  async install(_ctx: HostInstallContext): Promise<HostInstallResult> {
    const hooksJsonPath = getCodexHooksJsonPath();
    const legacy = detectLegacyCodexHookRegistration();
    if (legacy.detected) {
      return {
        success: false,
        hostId: this.hostId,
        configPath: hooksJsonPath,
        configAction: 'skipped',
        reason: 'A legacy PD global Codex hook registration was detected (async PostToolUse in ~/.codex/hooks.json). The legacy global installer is retired (SPEC rev 2 §17) and cannot update it.',
        nextAction: 'Migrate to the Marketplace plugin: 1) npx create-principles-disciple uninstall --host codex  (removes ONLY PD-owned entries; evidence is preserved); 2) codex plugin add principles-disciple@principles; 3) run the plugin setup ($pd-setup) — it presents the ingestion disclosure and records consent.',
      };
    }
    return {
      success: false,
      hostId: this.hostId,
      configPath: hooksJsonPath,
      configAction: 'skipped',
      reason: 'New Codex global hook registrations are retired (SPEC rev 2 §17). The Marketplace plugin is the only supported new install path for Codex.',
      nextAction: 'Install the plugin: codex plugin add principles-disciple@principles — then run its setup ($pd-setup), which verifies Node/runtime/workspace/trust and records the conversation-ingestion consent.',
    };
  }

  async uninstall(_ctx: HostUninstallContext): Promise<HostUninstallResult> {
    const hooksJsonPath = getCodexHooksJsonPath();
    const markerPath = getPdHookMarkerPath();
    const pdCodexDir = getPdCodexDir();
    const removedPaths: string[] = [];
    const preservedPaths: string[] = [];

    // 1. Remove PD-owned entries from hooks.json.
    //    CodeQL TOCTOU fix: try/catch read instead of existsSync+readFileSync.
    try {
      const raw = readFileSync(hooksJsonPath, 'utf-8');
      const parsed: unknown = JSON.parse(raw);
      if (isRecord(parsed)) {
        const config = { ...parsed };
        let modified = false;
        const PD_MARKER = 'pd-owned';

        for (const eventName of CODEX_EVENTS) {
          const groups = config[eventName];
          if (isUnknownArray(groups)) {
            const before = groups.length;
            // rc-2: use Object.hasOwn instead of `as` cast for marker check.
            const filtered: unknown[] = groups.filter((g) =>
              !(isRecord(g) && Object.hasOwn(g, '__pd_marker') && g.__pd_marker === PD_MARKER),
            );
            if (filtered.length === 0) {
              delete config[eventName];
            } else {
              config[eventName] = filtered;
            }
            if (filtered.length !== before) modified = true;
          }
        }

        if (modified) {
          writeFileSync(hooksJsonPath, JSON.stringify(config, null, 2), { encoding: 'utf-8' });
          removedPaths.push(hooksJsonPath);
        }
      }
    } catch (err) {
      const code = getErrorCode(err);
      if (code === 'ENOENT') {
        // hooks.json not found — nothing to clean, proceed to marker cleanup.
      } else {
        // Malformed hooks.json — can't safely merge. Leave it alone.
        preservedPaths.push(hooksJsonPath);
      }
    }

    // 2. Remove wrapper script + marker file
    const wrapperPath = path.join(pdCodexDir, 'pd-hook-entry.cjs');
    if (existsSync(wrapperPath)) {
      try {
        const fs = await import('fs');
        await fs.promises.rm(wrapperPath, { force: true });
        removedPaths.push(wrapperPath);
      } catch {
        preservedPaths.push(wrapperPath);
      }
    }
    if (existsSync(markerPath)) {
      try {
        const fs = await import('fs');
        await fs.promises.rm(markerPath, { force: true });
        removedPaths.push(markerPath);
      } catch {
        preservedPaths.push(markerPath);
      }
    }

    return {
      success: preservedPaths.length === 0,
      hostId: this.hostId,
      removedPaths,
      preservedPaths,
      reason: preservedPaths.length > 0
        ? `Some files could not be removed: ${preservedPaths.join(', ')}`
        : undefined,
      nextAction: preservedPaths.length > 0
        ? `Manually inspect: ${preservedPaths.join(', ')}`
        : 'Codex hooks uninstalled. Verify: open ~/.codex/hooks.json (should have no __pd_marker entries).',
    };
  }

  // eslint-disable-next-line @typescript-eslint/class-methods-use-this
  detect(): HostDetectResult {
    const markerPath = getPdHookMarkerPath();
    const hooksJsonPath = getCodexHooksJsonPath();
    const wrapperPath = path.join(getPdCodexDir(), 'pd-hook-entry.cjs');

    const paths = [
      {
        exists: existsSync(markerPath),
        path: markerPath,
        name: 'PD Codex install marker',
        type: 'file' as const,
      },
      {
        exists: existsSync(wrapperPath),
        path: wrapperPath,
        name: 'PD Codex hook entry script',
        type: 'file' as const,
      },
      {
        exists: existsSync(hooksJsonPath),
        path: hooksJsonPath,
        name: 'Codex hooks.json',
        type: 'file' as const,
      },
    ];

    // PD is "installed" for Codex if the marker exists OR hooks.json has PD entries
    let installed = existsSync(markerPath);
    if (!installed && existsSync(hooksJsonPath)) {
      try {
        const raw = readFileSync(hooksJsonPath, 'utf-8');
        const parsed: unknown = JSON.parse(raw);
        if (isRecord(parsed)) {
          for (const eventName of CODEX_EVENTS) {
            const groups = parsed[eventName];
            if (isUnknownArray(groups)) {
              const hasPd = groups.some((g) =>
                isRecord(g) && Object.hasOwn(g, '__pd_marker') && g.__pd_marker === 'pd-owned',
              );
              if (hasPd) {
                installed = true;
                break;
              }
            }
          }
        }
      } catch {
        // Malformed hooks.json — treat as not installed (will be cleaned on uninstall)
      }
    }

    return { installed, paths };
  }
}
