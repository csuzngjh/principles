import { resolve } from 'node:path';

export interface AdaptiveActivationConfig {
  artifactId: string;
  activationId: string;
  softTimeoutMs: number;
  expiresAtMs: number;
}

/**
 * PRI-1140: alternative mapping identity resolved against the CURRENTLY
 * authorized prompt activations at request time (revision-resilient: an Owner
 * prompt-replacement deactivates the pinned activation, and the principle
 * mapping keeps working without a config edit). Exactly one of the two
 * variants is valid; the controlled-admission path keeps requiring the pinned
 * variant because its manifest contract binds exact artifact identity.
 */
export interface AdaptivePrincipleActivationConfig {
  principleId: string;
  softTimeoutMs: number;
  expiresAtMs: number;
}

export type AdaptiveActivationMapping = AdaptiveActivationConfig | AdaptivePrincipleActivationConfig;

export function isPrincipleIdentityMapping(mapping: AdaptiveActivationMapping): mapping is AdaptivePrincipleActivationConfig {
  return 'principleId' in mapping;
}

function own(value: unknown, key: string): unknown {
  if (!value || typeof value !== 'object') return undefined;
  return Object.getOwnPropertyDescriptor(value, key)?.value;
}

function readSharedTiming(config: unknown, now: number): { softTimeoutMs: number; expiresAtMs: number } | null {
  const expiresAt = own(config, 'expiresAt');
  const softTimeoutMs = own(config, 'softTimeoutMs');
  if (typeof expiresAt !== 'string' || !Number.isFinite(Date.parse(expiresAt)) || Date.parse(expiresAt) <= now
    || typeof softTimeoutMs !== 'number' || !Number.isSafeInteger(softTimeoutMs) || softTimeoutMs < 1 || softTimeoutMs > 15000) return null;
  return { softTimeoutMs, expiresAtMs: Date.parse(expiresAt) };
}

/**
 * One explicit, workspace-scoped, expiring mapping; absent/invalid means
 * ordinary Native. PRI-1140: the mapping identity is EITHER the pinned
 * `{artifactId, activationId}` (existing semantics, byte-identical validation)
 * OR `{principleId}` for current-authorized resolution — exactly one of the
 * two; an ambiguous shape (both present, or neither complete) is invalid and
 * fails closed rather than guessing an identity.
 */
export function readAdaptiveActivationConfig(pluginConfig: unknown, workspaceDir: string, now: number): AdaptiveActivationMapping | null {
  const config = own(pluginConfig, 'adaptiveActivation');
  if (own(config, 'enabled') !== true) return null;
  const workspace = own(config, 'workspaceDir');
  const artifactId = own(config, 'artifactId');
  const activationId = own(config, 'activationId');
  const principleId = own(config, 'principleId');
  if (typeof workspace !== 'string' || !workspace.trim()) return null;
  const timing = readSharedTiming(config, now);
  if (!timing) return null;
  const canonical = (value: string) => process.platform === 'win32' ? resolve(value).toLowerCase() : resolve(value);
  if (canonical(workspace) !== canonical(workspaceDir)) return null;

  const hasPinned = typeof artifactId === 'string' && artifactId.trim().length > 0
    && typeof activationId === 'string' && activationId.trim().length > 0;
  const hasPrinciple = typeof principleId === 'string' && principleId.trim().length > 0;
  // rc-3: a partially-specified identity must never degrade into a guess.
  const artifactOrActivationPresent = artifactId !== undefined || activationId !== undefined;
  if (hasPrinciple && artifactOrActivationPresent) return null;
  if (hasPrinciple) return { principleId, ...timing };
  if (hasPinned) return { artifactId: artifactId as string, activationId: activationId as string, ...timing };
  return null;
}
