import { isCorePrincipleId } from './core-principle-registry.js';

/**
 * Strip fabricated core principle IDs from an untrusted LLM output object.
 *
 * LLMs sometimes invent placeholder IDs like "pri-unknown", "pri-000", "pri-999"
 * when they don't know the correct value. This function removes those fabricated
 * values so downstream validation can detect the missing field and fail loud
 * (Runtime Contract Rule 3).
 *
 * Currently strips:
 * - `sourcePrincipleId`: single string field, deleted if not a valid core principle ID
 *
 * @param untrustedOutput - The LLM output object to mutate in-place
 */
export function stripFabricatedCorePrincipleIds(untrustedOutput: unknown): void {
  if (typeof untrustedOutput !== 'object' || untrustedOutput === null || Array.isArray(untrustedOutput)) {
    return;
  }

  // Strip fabricated sourcePrincipleId — LLM invents placeholders like pri-unknown, pri-000, pri-999
  if (Object.hasOwn(untrustedOutput, 'sourcePrincipleId')) {
    const val = Reflect.get(untrustedOutput, 'sourcePrincipleId');
    // Use registry membership check — format-only regex would accept T-99 etc.
    if (typeof val === 'string' && !isCorePrincipleId(val)) {
      Reflect.deleteProperty(untrustedOutput, 'sourcePrincipleId');
    }
  }
}
