/**
 * pd health --host codex command implementation.
 *
 * Reports Codex adapter/runtime versions, host.codex feature flag state,
 * hook trust status, and dual global/plugin hook registration detection.
 *
 * CLI gate compliance:
 * - cli-1: --json outputs exactly one parseable JSON object on stdout.
 * - cli-2: exit paths stop execution (return after process.exit).
 * - cli-5: failure paths do not mutate state (read-only throughout).
 * - cli-6: every degraded/refused result includes reason + nextAction.
 */
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { createRequire } from 'module';
import { resolveWorkspaceDir } from '../resolve-workspace.js';
import { loadPdConfigForPlugin, resolveNearestPdWorkspace } from '@principles/host-runtime';
import { computeFeatureFlagsFromConfig, isFeatureEnabled } from '@principles/core/runtime-v2';

const require = createRequire(import.meta.url);

interface CodexHealthOptions {
  workspace?: string;
  json?: boolean;
}

interface CodexHealthReport {
  generatedAt: string;
  host: 'codex';
  workspace: string;
  adapterVersion: string;
  runtimeVersion: string;
  featureFlag: {
    name: 'host.codex';
    enabled: boolean;
    source: 'user_config' | 'defaults' | 'malformed';
    reason?: string;
    nextAction?: string;
  };
  hooksTrust: {
    detectable: boolean;
    trusted?: boolean;
    reason?: string;
    nextAction?: string;
  };
  dualRegistration: {
    detected: boolean;
    globalHooksPath?: string;
    pluginHooksPath?: string;
    reason?: string;
    nextAction?: string;
  };
  warnings: string[];
}

function readPackageVersion(packageName: string): string {
  try {
    const pkgJsonPath = require.resolve(`${packageName}/package.json`);
    const pkg = JSON.parse(fs.readFileSync(pkgJsonPath, 'utf8')) as { version?: unknown };
    if (typeof pkg.version === 'string') return pkg.version;
    return 'unknown';
  } catch {
    return 'unknown';
  }
}

function detectCodexConfigDir(): string | undefined {
  const home = os.homedir();
  const codexDir = path.join(home, '.codex');
  if (fs.existsSync(codexDir)) return codexDir;
  return undefined;
}

function detectHooksTrust(codexConfigDir: string | undefined): CodexHealthReport['hooksTrust'] {
  if (!codexConfigDir) {
    return {
      detectable: false,
      reason: 'codex_config_dir_not_found',
      nextAction: 'Install Codex CLI (>= 0.147) and run `codex` once to create ~/.codex/, then re-run `pd health --host codex` to verify hook trust state.',
    };
  }
  // Codex stores hook trust in config.toml under [features] hooks = true|false.
  // We do a best-effort text scan rather than a full TOML parse to avoid a new
  // dependency. If the file is missing or the hook line is absent, we report
  // undetectable with a clear next action.
  const configTomlPath = path.join(codexConfigDir, 'config.toml');
  if (!fs.existsSync(configTomlPath)) {
    return {
      detectable: false,
      reason: 'config_toml_not_found',
      nextAction: `Open Codex and run /hooks to trust PD hooks, then re-run \`pd health --host codex\`. Expected config at ${configTomlPath}.`,
    };
  }
  try {
    const raw = fs.readFileSync(configTomlPath, 'utf8');
    const match = /hooks\s*=\s*(true|false)/i.exec(raw);
    if (!match || !match[1]) {
      return {
        detectable: false,
        reason: 'hooks_setting_not_found_in_config',
        nextAction: 'Open Codex and run /hooks to trust PD hooks. Codex config.toml exists but has no `hooks` setting under [features].',
      };
    }
    return { detectable: true, trusted: match[1].toLowerCase() === 'true' };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return {
      detectable: false,
      reason: `config_toml_read_failed: ${message.slice(0, 200)}`,
      nextAction: `Check read permissions on ${configTomlPath} and re-run \`pd health --host codex\`.`,
    };
  }
}

function detectDualRegistration(codexConfigDir: string | undefined): CodexHealthReport['dualRegistration'] {
  const globalHooksPath = codexConfigDir ? path.join(codexConfigDir, 'hooks.json') : undefined;
  // Plugin hooks are declared in a plugin manifest; we cannot reliably detect
  // them from outside Codex. We only flag the global-hooks path and let the
  // operator confirm plugin registration via /hooks in Codex.
  const globalHooksExists = globalHooksPath ? fs.existsSync(globalHooksPath) : false;
  if (globalHooksExists) {
    return {
      detected: true,
      globalHooksPath,
      reason: 'global_hooks_json_present',
      nextAction: 'Global ~/.codex/hooks.json is installed. If the PD Codex plugin is also installed via marketplace, this may cause double-registration. Choose ONE: keep global hooks.json (fallback path) OR uninstall it and use the plugin (recommended). To remove global PD entries, run `create-principles-disciple uninstall --host codex`.',
    };
  }
  return { detected: false };
}

export async function handleHealthCodex(opts: CodexHealthOptions = {}): Promise<void> {
  const generatedAt = new Date().toISOString();
  const workspaceDir = opts.workspace
    ? path.resolve(opts.workspace)
    : resolveWorkspaceDir();

  const warnings: string[] = [];

  // Resolve workspace via the shared host-runtime resolver so pd-cli reports
  // the same workspace the Codex hook would resolve.
  const resolution = resolveNearestPdWorkspace(workspaceDir);
  let resolvedWorkspace: string;
  let featureFlagSource: 'user_config' | 'defaults' | 'malformed';
  let hostCodexEnabled = false;

  if (!resolution.ok) {
    resolvedWorkspace = workspaceDir;
    featureFlagSource = 'defaults';
    warnings.push(`workspace_not_resolved: ${resolution.reason} — ${resolution.nextAction}`);
  } else {
    resolvedWorkspace = resolution.workspaceDir;
    const configLoad = loadPdConfigForPlugin(resolvedWorkspace);
    featureFlagSource = configLoad.source;
    const flags = computeFeatureFlagsFromConfig(configLoad.effective);
    hostCodexEnabled = isFeatureEnabled(flags, 'host.codex');
    if (!configLoad.ok) {
      for (const error of configLoad.errors) {
        warnings.push(`config_error: ${error.reason} — ${error.nextAction}`);
      }
    }
  }

  const adapterVersion = readPackageVersion('@principles/codex-adapter');
  const runtimeVersion = readPackageVersion('@principles/host-runtime');
  const codexConfigDir = detectCodexConfigDir();
  const hooksTrust = detectHooksTrust(codexConfigDir);
  const dualRegistration = detectDualRegistration(codexConfigDir);

  if (hooksTrust.reason) warnings.push(`hooks_trust: ${hooksTrust.reason}`);
  if (dualRegistration.reason) warnings.push(`dual_registration: ${dualRegistration.reason}`);

  const report: CodexHealthReport = {
    generatedAt,
    host: 'codex',
    workspace: resolvedWorkspace,
    adapterVersion,
    runtimeVersion,
    featureFlag: {
      name: 'host.codex',
      enabled: hostCodexEnabled,
      source: featureFlagSource,
      ...(hostCodexEnabled
        ? {}
        : {
            reason: 'host_codex_disabled',
            nextAction: `Enable the Codex host adapter by setting features.host.codex.enabled=true in ${resolvedWorkspace}/.pd/config.yaml, then re-run \`pd health --host codex\`.`,
          }),
    },
    hooksTrust,
    dualRegistration,
    warnings,
  };

  if (opts.json) {
    // cli-1: exactly one parseable JSON object on stdout.
    console.log(JSON.stringify(report, null, 2));
    // cli-2: exit-stops. Non-zero only when host.codex is disabled AND hooks
    // are not trusted — the operator must act before Codex activation works.
    if (!hostCodexEnabled && !hooksTrust.trusted) {
      process.exitCode = 1;
    }
    return;
  }

  // Text output — still includes explicit nextAction per cli-6.
  console.log(`generatedAt: ${report.generatedAt}`);
  console.log(`host: ${report.host}`);
  console.log(`workspace: ${report.workspace}`);
  console.log(`adapterVersion: ${report.adapterVersion}`);
  console.log(`runtimeVersion: ${report.runtimeVersion}`);
  console.log(`featureFlag.name: ${report.featureFlag.name}`);
  console.log(`featureFlag.enabled: ${report.featureFlag.enabled}`);
  console.log(`featureFlag.source: ${report.featureFlag.source}`);
  if (report.featureFlag.reason) {
    console.log(`featureFlag.reason: ${report.featureFlag.reason}`);
    console.log(`featureFlag.nextAction: ${report.featureFlag.nextAction ?? ''}`);
  }
  console.log(`hooksTrust.detectable: ${report.hooksTrust.detectable}`);
  if (report.hooksTrust.trusted !== undefined) {
    console.log(`hooksTrust.trusted: ${report.hooksTrust.trusted}`);
  }
  if (report.hooksTrust.reason) {
    console.log(`hooksTrust.reason: ${report.hooksTrust.reason}`);
    console.log(`hooksTrust.nextAction: ${report.hooksTrust.nextAction ?? ''}`);
  }
  console.log(`dualRegistration.detected: ${report.dualRegistration.detected}`);
  if (report.dualRegistration.globalHooksPath) {
    console.log(`dualRegistration.globalHooksPath: ${report.dualRegistration.globalHooksPath}`);
  }
  if (report.dualRegistration.reason) {
    console.log(`dualRegistration.reason: ${report.dualRegistration.reason}`);
    console.log(`dualRegistration.nextAction: ${report.dualRegistration.nextAction ?? ''}`);
  }
  if (report.warnings.length > 0) {
    console.log(`warnings:`);
    for (const w of report.warnings) console.log(`  - ${w}`);
  }
  console.log('');

  if (!hostCodexEnabled) {
    console.warn(`⚠️  host.codex feature flag is disabled. Enable it in ${resolvedWorkspace}/.pd/config.yaml under features.host.codex.enabled to activate Codex hooks.`);
  }
  if (!hooksTrust.trusted && !hooksTrust.detectable) {
    console.warn(`⚠️  Hook trust state could not be detected. ${hooksTrust.nextAction ?? ''}`);
    process.exitCode = 1;
  }
}
