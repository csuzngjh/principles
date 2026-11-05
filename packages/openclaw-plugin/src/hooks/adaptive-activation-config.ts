import { resolve } from 'node:path';

export interface AdaptiveActivationConfig {
  artifactId: string;
  activationId: string;
  softTimeoutMs: number;
  expiresAtMs: number;
}

function own(value: unknown, key: string): unknown {
  if (!value || typeof value !== 'object') return undefined;
  return Object.getOwnPropertyDescriptor(value, key)?.value;
}

/** One explicit, workspace-scoped, expiring mapping; absent/invalid means ordinary Native. */
export function readAdaptiveActivationConfig(pluginConfig: unknown, workspaceDir: string, now: number): AdaptiveActivationConfig | null {
  const config = own(pluginConfig, 'adaptiveActivation');
  if (own(config, 'enabled') !== true) return null;
  const workspace = own(config, 'workspaceDir');
  const artifactId = own(config, 'artifactId');
  const activationId = own(config, 'activationId');
  const expiresAt = own(config, 'expiresAt');
  const softTimeoutMs = own(config, 'softTimeoutMs');
  if (typeof workspace !== 'string' || !workspace.trim() || typeof artifactId !== 'string' || !artifactId.trim()
    || typeof activationId !== 'string' || !activationId.trim() || typeof expiresAt !== 'string'
    || !Number.isFinite(Date.parse(expiresAt)) || Date.parse(expiresAt) <= now
    || typeof softTimeoutMs !== 'number' || !Number.isSafeInteger(softTimeoutMs) || softTimeoutMs < 1 || softTimeoutMs > 15000) return null;
  const canonical = (value: string) => process.platform === 'win32' ? resolve(value).toLowerCase() : resolve(value);
  if (canonical(workspace) !== canonical(workspaceDir)) return null;
  return { artifactId, activationId, softTimeoutMs, expiresAtMs: Date.parse(expiresAt) };
}
