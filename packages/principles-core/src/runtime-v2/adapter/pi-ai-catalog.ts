/**
 * PRI-621 PR2 review: single owner of "which providers are in the pi-ai
 * builtin catalog". Exported as a core capability so cross-package callers
 * (pd-cli baseUrl validation) query it instead of importing pi-ai directly
 * (EP-06: a package declares the runtime deps it imports; the CLI only
 * declares @principles/core).
 */
import { getProviders } from '@earendil-works/pi-ai/compat';

/**
 * Provider ids in the pi-ai builtin static catalog. 0.84 semantics: dynamic
 * providers registered at runtime are NOT part of this list.
 */
export function builtinPiAiProviderIds(): readonly string[] {
  return getProviders();
}

export function isBuiltinPiAiProvider(provider: string): boolean {
  return builtinPiAiProviderIds().includes(provider);
}
