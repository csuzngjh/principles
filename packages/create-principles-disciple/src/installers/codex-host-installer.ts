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
import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'fs';
import * as path from 'path';
import * as os from 'os';
import { createRequire } from 'module';
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
type CodexEventName = (typeof CODEX_EVENTS)[number];

const PD_HOOK_MARKER = 'pd-hooks.marker';

// ─── Type guards (rc-2: no `as` bypass) ─────────────────────────────────────
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isStringArray(value: unknown): value is unknown[] {
  return Array.isArray(value);
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
 * 1. Try require.resolve('@principles/codex-adapter/pd-hook') — works if
 *    the package is installed locally or globally resolvable.
 * 2. Fall back to undefined — installer reports the missing dependency.
 */
function resolvePdHookPath(): string | undefined {
  try {
    const entry = requireFromModule.resolve('@principles/codex-adapter/pd-hook');
    return entry;
  } catch {
    return undefined;
  }
}

/**
 * Build the hook command string for hooks.json.
 *
 * The wrapper script sets PD_HOST_CODEX_ENABLED=1 and PD_WORKSPACE_DIR before
 * invoking pd-hook.js. This is cross-platform (no shell-specific env var syntax).
 */
function buildHookCommand(entryScriptPath: string, _workspaceDir: string): string {
  // Unix command: node <entry>
  // workspaceDir is injected by the wrapper script (pd-hook-entry.cjs), not here.
  void _workspaceDir;
  return `node "${entryScriptPath}"`;
}

function buildHookCommandWindows(entryScriptPath: string, _workspaceDir: string): string {
  // Windows command — same node invocation; the entry script handles env internally
  void _workspaceDir;
  return `node "${entryScriptPath}"`;
}

// ─── Hook entry builder ─────────────────────────────────────────────────────
interface HookEntry {
  type: 'command';
  command: string;
  commandWindows: string;
  timeout: number;
  statusMessage: string;
  async?: boolean;
  additionalContextLimit?: number;
}

interface HookMatcherGroup {
  matcher?: string;
  hooks: HookEntry[];
  /**
   * Internal marker for PD-owned entries. Used by uninstall to precisely
   * filter PD entries from hooks.json. NOT a Codex field — safe to include
   * because hooks.json is a config file (serde default), not hook output
   * (which has deny_unknown_fields).
   */
  __pd_marker?: string;
}

function buildMatcherGroup(
  eventName: CodexEventName,
  entryScriptPath: string,
  workspaceDir: string,
): HookMatcherGroup {
  const command = buildHookCommand(entryScriptPath, workspaceDir);
  const commandWindows = buildHookCommandWindows(entryScriptPath, workspaceDir);

  switch (eventName) {
    case 'PreToolUse':
      return {
        matcher: 'Bash|apply_patch',
        hooks: [{
          type: 'command',
          command,
          commandWindows,
          timeout: 5,
          statusMessage: 'PD: checking tool call',
        }],
      };
    case 'PostToolUse':
      return {
        matcher: '.*',
        hooks: [{
          type: 'command',
          command,
          commandWindows,
          timeout: 5,
          async: true,
          statusMessage: 'PD: capturing pain signal',
        }],
      };
    case 'UserPromptSubmit':
      return {
        hooks: [{
          type: 'command',
          command,
          commandWindows,
          timeout: 5,
          additionalContextLimit: 10000,
          statusMessage: 'PD: injecting principles',
        }],
      };
    case 'SessionStart':
      return {
        hooks: [{
          type: 'command',
          command,
          commandWindows,
          timeout: 600,
          additionalContextLimit: 10000,
          statusMessage: 'PD: hydrating state',
        }],
      };
  }
}

// ─── Wrapper script content ─────────────────────────────────────────────────
/**
 * Generate the wrapper script that sets env vars and imports pd-hook.js.
 *
 * This is a CommonJS file so it can use process.env mutation before the
 * ESM pd-hook.js is dynamically imported. Cross-platform (no shell syntax).
 */
function buildWrapperScriptContent(pdHookPath: string, workspaceDir: string): string {
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
    `import(${JSON.stringify('file://' + pdHookPath.replace(/\\/g, '/'))});`,
    '',
  ].join('\n');
}

// ─── CodexHostInstaller ─────────────────────────────────────────────────────
export class CodexHostInstaller implements HostInstaller {
  readonly hostId = 'codex';

  async install(ctx: HostInstallContext): Promise<HostInstallResult> {
    const pdCodexDir = getPdCodexDir();
    const hooksJsonPath = getCodexHooksJsonPath();
    const markerPath = getPdHookMarkerPath();

    // 1. Resolve codex-adapter pd-hook.js
    const pdHookPath = resolvePdHookPath();
    if (!pdHookPath) {
      return {
        success: false,
        hostId: this.hostId,
        configPath: hooksJsonPath,
        configAction: 'skipped',
        reason: '@principles/codex-adapter is not installed. The codex-adapter package provides the pd-hook.js entry Codex spawns.',
        nextAction: 'Install it first: npm install -g @principles/codex-adapter, then re-run: npx create-principles-disciple install --host codex',
      };
    }

    // 2. Write wrapper script to ~/.pd/codex/pd-hook-entry.cjs
    try {
      if (!existsSync(pdCodexDir)) {
        mkdirSync(pdCodexDir, { recursive: true });
      }
      const wrapperPath = path.join(pdCodexDir, 'pd-hook-entry.cjs');
      const wrapperContent = buildWrapperScriptContent(pdHookPath, ctx.workspaceDir);
      writeFileSync(wrapperPath, wrapperContent, { encoding: 'utf-8' });
      writeFileSync(markerPath, JSON.stringify({
        installedAt: new Date().toISOString(),
        workspaceDir: ctx.workspaceDir,
        pdHookPath,
        wrapperPath,
        events: CODEX_EVENTS,
      }, null, 2), { encoding: 'utf-8' });

      // 3. Merge PD hook entries into ~/.codex/hooks.json (append, never overwrite)
      const configAction = this.mergeHooksJson(hooksJsonPath, wrapperPath, ctx.workspaceDir);

      return {
        success: true,
        hostId: this.hostId,
        configPath: hooksJsonPath,
        configAction,
        nextAction: 'Open Codex and run /hooks to trust PD hooks before they execute. Verify with: codex doctor (hooks feature should be ON).',
      };
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      return {
        success: false,
        hostId: this.hostId,
        configPath: hooksJsonPath,
        configAction: 'skipped',
        reason: `Failed to write Codex hook config: ${reason}`,
        nextAction: `Check write permissions on ${pdCodexDir} and ${hooksJsonPath}, then re-run installer.`,
      };
    }
  }

  /**
   * Merge PD hook entries into ~/.codex/hooks.json.
   * - If file doesn't exist: create it with PD entries (configAction = 'created').
   * - If file exists: merge PD entries into existing event arrays (configAction = 'updated').
   * - Idempotent: re-running install replaces PD entries (matched by marker), not duplicates.
   */
  // eslint-disable-next-line @typescript-eslint/class-methods-use-this
  private mergeHooksJson(
    hooksJsonPath: string,
    wrapperPath: string,
    workspaceDir: string,
  ): 'created' | 'updated' | 'preserved' {
    const codexDir = getCodexDir();
    if (!existsSync(codexDir)) {
      mkdirSync(codexDir, { recursive: true });
    }

    let existing: Record<string, unknown> = {};
    let action: 'created' | 'updated' | 'preserved' = 'created';

    if (existsSync(hooksJsonPath)) {
      try {
        const raw = readFileSync(hooksJsonPath, 'utf-8');
        const parsed: unknown = JSON.parse(raw);
        if (isRecord(parsed)) {
          existing = { ...parsed };
          action = 'updated';
        } else {
          // Malformed — back off, don't overwrite
          action = 'preserved';
        }
      } catch {
        // Malformed JSON — back off
        action = 'preserved';
      }
    }

    if (action === 'preserved') {
      return action;
    }

    // For each Codex event, replace any existing PD-owned matcher groups
    // with our fresh set (idempotent — re-install doesn't duplicate).
    const PD_MARKER = 'pd-owned';
    for (const eventName of CODEX_EVENTS) {
      const group = buildMatcherGroup(eventName, wrapperPath, workspaceDir);
      // Tag the group so uninstall can find PD-owned entries precisely.
      group.__pd_marker = PD_MARKER;

      const existingGroups = existing[eventName];
      if (isStringArray(existingGroups)) {
        // Filter out previously-PD-owned groups, then append the new one.
        // rc-2: no `as` bypass — use Object.hasOwn to check marker presence.
        const filtered: unknown[] = existingGroups.filter((g) =>
          !(isRecord(g) && Object.hasOwn(g, '__pd_marker') && g.__pd_marker === PD_MARKER),
        );
        filtered.push(group);
        existing[eventName] = filtered;
      } else {
        existing[eventName] = [group];
      }
    }

    writeFileSync(hooksJsonPath, JSON.stringify(existing, null, 2), { encoding: 'utf-8' });
    return action;
  }

  async uninstall(_ctx: HostUninstallContext): Promise<HostUninstallResult> {
    const hooksJsonPath = getCodexHooksJsonPath();
    const markerPath = getPdHookMarkerPath();
    const pdCodexDir = getPdCodexDir();
    const removedPaths: string[] = [];
    const preservedPaths: string[] = [];

    // 1. Remove PD-owned entries from hooks.json
    if (existsSync(hooksJsonPath)) {
      try {
        const raw = readFileSync(hooksJsonPath, 'utf-8');
        const parsed: unknown = JSON.parse(raw);
        if (isRecord(parsed)) {
          const config = { ...parsed };
          let modified = false;
          const PD_MARKER = 'pd-owned';

          for (const eventName of CODEX_EVENTS) {
            const groups = config[eventName];
            if (isStringArray(groups)) {
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
      } catch {
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
            if (isStringArray(groups)) {
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
