/**
 * OpenClaw effective config path resolution, mirrored from OpenClaw
 * 2026.11.5 (`src/config/paths.ts`, `state-dir.ts`, `home-dir.ts`).
 *
 * Host precedence: OPENCLAW_CONFIG_PATH > OPENCLAW_STATE_DIR >
 * profile/home-derived state dir. OPENCLAW_HOME is the host's HOME substitute
 * (not the `.openclaw` directory itself); a valid non-default OPENCLAW_PROFILE
 * selects `.openclaw-<profile>`. User-supplied paths support leading `~` and
 * host-style relative resolution. This module resolves paths only; config
 * content parsing belongs to the OpenClaw plugin layer.
 */
import os from 'node:os';
import path from 'node:path';

export type OpenClawConfigPathResolution =
  | { readonly ok: true; readonly path: string; readonly source: 'config_path' | 'state_dir' | 'profile' | 'openclaw_home' | 'default' }
  | { readonly ok: false; readonly reason: 'home_unavailable' };

const PROFILE_NAME_RE = /^[a-z0-9][a-z0-9_-]{0,63}$/i;

function normalizeProfileName(value: string | undefined): string | null {
  const trimmed = value?.trim();
  if (!trimmed || trimmed.toLowerCase() === 'default' || !PROFILE_NAME_RE.test(trimmed)) return null;
  return trimmed;
}

function expandUserPath(value: string, rawHomeDir: string | undefined, cwd: string): string {
  const trimmed = value.trim();
  if (!trimmed) return trimmed;
  let expanded = trimmed;
  if ((trimmed === '~' || trimmed.startsWith('~/') || trimmed.startsWith('~\\')) && rawHomeDir) {
    expanded = rawHomeDir + trimmed.slice(1);
  }
  // OpenClaw resolves non-absolute user paths through resolveUserPath; absent
  // its internal user-path base directory, that is process cwd semantics.
  return path.resolve(cwd, expanded);
}

function effectiveHomeDir(
  env: Readonly<Record<string, string | undefined>>,
  rawHomeDir: string | undefined,
  cwd: string,
): string | undefined {
  const openclawHome = env.OPENCLAW_HOME?.trim();
  if (openclawHome) return expandUserPath(openclawHome, rawHomeDir, cwd);
  // OpenClaw resolveRequiredHomeDir falls back to the process cwd when no
  // home source exists. Mirroring that behavior keeps PD aligned with the
  // config the host actually loads instead of inventing a different policy.
  return rawHomeDir ? path.resolve(cwd, rawHomeDir) : path.resolve(cwd);
}

export function resolveOpenClawConfigPath(
  env: Readonly<Record<string, string | undefined>> = process.env,
  homeDir: string = os.homedir(),
  cwd: string = process.cwd(),
): OpenClawConfigPathResolution {
  const rawHomeDir = homeDir.trim() || undefined;
  const explicitConfig = env.OPENCLAW_CONFIG_PATH?.trim();
  if (explicitConfig) {
    return { ok: true, path: expandUserPath(explicitConfig, rawHomeDir, cwd), source: 'config_path' };
  }

  const explicitStateDir = env.OPENCLAW_STATE_DIR?.trim();
  if (explicitStateDir) {
    return { ok: true, path: path.join(expandUserPath(explicitStateDir, rawHomeDir, cwd), 'openclaw.json'), source: 'state_dir' };
  }

  const effectiveHome = effectiveHomeDir(env, rawHomeDir, cwd);
  if (!effectiveHome) return { ok: false, reason: 'home_unavailable' };
  const profile = normalizeProfileName(env.OPENCLAW_PROFILE);
  if (profile) {
    return { ok: true, path: path.join(effectiveHome, `.openclaw-${profile}`, 'openclaw.json'), source: 'profile' };
  }
  return {
    ok: true,
    path: path.join(effectiveHome, '.openclaw', 'openclaw.json'),
    source: env.OPENCLAW_HOME?.trim() ? 'openclaw_home' : 'default',
  };
}
