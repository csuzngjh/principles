/**
 * OpenClaw effective config path resolution.
 *
 * Host contract priority: OPENCLAW_CONFIG_PATH (absolute file) >
 * OPENCLAW_STATE_DIR (absolute directory) > <home>/.openclaw/openclaw.json.
 * Invalid overrides fail closed instead of silently reading the default config.
 */
import os from 'node:os';
import path from 'node:path';

export type OpenClawConfigPathResolution =
  | { readonly ok: true; readonly path: string; readonly source: 'config_path' | 'state_dir' | 'default' }
  | { readonly ok: false; readonly reason: 'openclaw_config_path_not_absolute' | 'openclaw_state_dir_not_absolute' | 'home_unavailable' };

export function resolveOpenClawConfigPath(
  env: Readonly<Record<string, string | undefined>> = process.env,
  homeDir: string = os.homedir(),
): OpenClawConfigPathResolution {
  const explicitConfig = env.OPENCLAW_CONFIG_PATH?.trim();
  if (explicitConfig !== undefined && explicitConfig.length > 0) {
    if (!path.isAbsolute(explicitConfig)) return { ok: false, reason: 'openclaw_config_path_not_absolute' };
    return { ok: true, path: path.resolve(explicitConfig), source: 'config_path' };
  }
  const explicitStateDir = env.OPENCLAW_STATE_DIR?.trim();
  if (explicitStateDir !== undefined && explicitStateDir.length > 0) {
    if (!path.isAbsolute(explicitStateDir)) return { ok: false, reason: 'openclaw_state_dir_not_absolute' };
    return { ok: true, path: path.join(path.resolve(explicitStateDir), 'openclaw.json'), source: 'state_dir' };
  }
  if (!homeDir) return { ok: false, reason: 'home_unavailable' };
  return { ok: true, path: path.join(homeDir, '.openclaw', 'openclaw.json'), source: 'default' };
}
