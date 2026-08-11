/**
 * HostInstaller — Multi-platform host install/uninstall abstraction (ADR-0020 §2.3)
 *
 * Pure types and type guards only. No I/O. Lives in @principles/core so that
 * any host-specific installer (Codex, OpenClaw, future Claude Code/OpenCode/Pi)
 * can depend on the interface without depending on each other or on the
 * concrete installer implementations (which live in
 * packages/create-principles-disciple — the I/O boundary).
 *
 * Product boundary (docs/product/PRODUCT_IDENTITY.md): PD owns owner-reviewed,
 * reversible behavior internalization. The HostInstaller only normalizes the
 * host-side wiring (config files, hook registration); it does not implement
 * task execution, memory, or autonomous value decisions.
 *
 * MVP scope (ADR-0014 / ADR-0020):
 * - `OpenClawHostInstaller` wraps the existing OpenClaw install logic in
 *   packages/create-principles-disciple (no behavior change).
 * - `CodexHostInstaller` writes/merges ~/.codex/hooks.json pointing to the
 *   codex-adapter's pd-hook.js entry. Default OFF via host.codex feature flag.
 *
 * Runtime Contract Rules (AGENTS.md):
 * - rc-1-treat-as-unknown: install contexts from CLI args are `unknown` until
 *   validated by the concrete installer.
 * - rc-3-fail-loud-missing: missing required context fields fail loud.
 * - rc-9-no-silent-fallback: every install/uninstall result includes a
 *   structured reason + nextAction, even on success (so the operator knows
 *   what to verify).
 */

// ─── Host install context ───────────────────────────────────────────────────
/**
 * Input to HostInstaller.install(). Host-agnostic fields that every host
 * installer needs. Host-specific options (e.g. Codex hook matchers, OpenClaw
 * gateway port) are passed via the concrete installer's constructor, not here.
 */
export interface HostInstallContext {
  /** Absolute path to the workspace PD is operating on. */
  readonly workspaceDir: string;
  /**
   * Absolute path to the bundled plugin/package directory (the installer's
   * PLUGIN_DIR — where plugin/, core/, pd-cli/, console/ subdirs live).
   */
  readonly pluginDir: string;
  /** Language code ('zh' | 'en') for operator-facing messages. */
  readonly language: string;
  /** Install mode: 'force' overwrites; 'smart' merges. */
  readonly mode: 'smart' | 'force';
  /**
   * Optional LLM runtime profile (provider/model/apiKeyEnv).
   * Host-agnostic — written to .pd/config.yaml, not host-specific config.
   */
  readonly runtimeProfile?: HostRuntimeProfileInput;
}

/**
 * Optional LLM runtime profile collected by the installer prompt flow.
 * Mirrors packages/create-principles-disciple RuntimeProfileInput — duplicated
 * here as a pure type so core does not depend on the installer package.
 */
export interface HostRuntimeProfileInput {
  readonly provider?: string;
  readonly model?: string;
  readonly apiKeyEnv?: string;
}

// ─── Host uninstall context ─────────────────────────────────────────────────
/**
 * Input to HostInstaller.uninstall(). workspaceDir is optional because the
 * uninstaller may be invoked when the workspace is no longer reachable.
 */
export interface HostUninstallContext {
  /** Absolute path to the workspace (optional — uninstall may run post-workspace). */
  readonly workspaceDir?: string;
  /** Language code for operator-facing messages. */
  readonly language: string;
  /** Skip confirmation prompt (for scripts / --force). */
  readonly force: boolean;
}

// ─── Install / uninstall results ────────────────────────────────────────────
/**
 * What a host installer did to the host's configuration.
 * - 'created'   — wrote a new config file.
 * - 'updated'   — merged into an existing config file.
 * - 'preserved' — existing valid config preserved (no write).
 * - 'skipped'   — no config action taken (e.g. feature flag off, host missing).
 */
export type HostConfigAction = 'created' | 'updated' | 'preserved' | 'skipped';

export interface HostInstallResult {
  readonly success: boolean;
  /** Host identifier (matches HostInstaller.hostId), e.g. 'openclaw' | 'codex'. */
  readonly hostId: string;
  /** Path to the host-specific config file that was written/merged, if any. */
  readonly configPath?: string;
  /** What was done to the host config. */
  readonly configAction: HostConfigAction;
  /**
   * Structured reason (rc-9). Required on failure; optional on success but
   * recommended so the operator can verify what happened.
   */
  readonly reason?: string;
  /** Operator-facing next action (rc-9 / cli-6-output-next-action). */
  readonly nextAction: string;
}

export interface HostUninstallResult {
  readonly success: boolean;
  readonly hostId: string;
  /** Paths removed from the host's config/install (not workspace files). */
  readonly removedPaths: string[];
  /** Workspace/user paths preserved (never deleted by host uninstall). */
  readonly preservedPaths: string[];
  readonly reason?: string;
  readonly nextAction: string;
}

// ─── Detection ───────────────────────────────────────────────────────────────
export interface HostDetectResult {
  /** Whether PD is currently installed for this host. */
  readonly installed: boolean;
  /** Host-specific install/config paths that exist (for status reporting). */
  readonly paths: readonly HostDetectPath[];
}

export interface HostDetectPath {
  readonly exists: boolean;
  readonly path: string;
  readonly name: string;
  readonly type: 'dir' | 'file';
}

// ─── HostInstaller interface ────────────────────────────────────────────────
/**
 * Abstraction over a host platform's install/uninstall/detect lifecycle.
 *
 * - OpenClaw: writes ~/.openclaw/openclaw.json + installs plugin to
 *   ~/.openclaw/extensions/principles-disciple/.
 * - Codex CLI: writes/merges ~/.codex/hooks.json pointing to pd-hook.js.
 *
 * The installer owns:
 * 1. Host-side config file writes (openclaw.json / hooks.json).
 * 2. Host-side install path management (extensions dir / hooks dir).
 *
 * The installer does NOT own:
 * - Bundled component installation (core, pd-cli, console) — that's shared
 *   host-agnostic logic in installer.ts.
 * - Workspace template copying — host-agnostic.
 * - config.yaml generation — host-agnostic.
 *
 * Implementations MUST:
 * - Fail loud on missing required context (rc-3).
 * - Include reason + nextAction in every result (rc-9 / cli-6).
 * - Never silently treat a failed write as success (EP-03).
 * - Preserve user data on uninstall (workspace MD files, .principles/, .state/).
 */
export interface HostInstaller {
  /** Stable host identifier, e.g. 'openclaw', 'codex'. */
  readonly hostId: string;

  /**
   * Install PD's host-side wiring for this host.
   * Does NOT install bundled components — caller handles those.
   */
  install(ctx: HostInstallContext): Promise<HostInstallResult>;

  /**
   * Uninstall PD's host-side wiring for this host.
   * Preserves workspace user data (MD files, .principles/, .state/).
   */
  uninstall(ctx: HostUninstallContext): Promise<HostUninstallResult>;

  /**
   * Detect whether PD is currently installed for this host.
   * Used by `status` command and by install --host to skip/skip-not.
   */
  detect(): HostDetectResult;
}

// ─── Type guards (pure functions, no I/O) ────────────────────────────────────
export function isHostConfigAction(value: unknown): value is HostConfigAction {
  return (
    value === 'created' ||
    value === 'updated' ||
    value === 'preserved' ||
    value === 'skipped'
  );
}

export function isHostInstallResult(value: unknown): value is HostInstallResult {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const obj = value as Record<string, unknown>;
  return (
    typeof obj.success === 'boolean' &&
    typeof obj.hostId === 'string' &&
    isHostConfigAction(obj.configAction) &&
    typeof obj.nextAction === 'string'
  );
}

export function isHostUninstallResult(value: unknown): value is HostUninstallResult {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const obj = value as Record<string, unknown>;
  return (
    typeof obj.success === 'boolean' &&
    typeof obj.hostId === 'string' &&
    Array.isArray(obj.removedPaths) &&
    Array.isArray(obj.preservedPaths) &&
    typeof obj.nextAction === 'string'
  );
}
