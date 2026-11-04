import { hashOfCanonical } from './challenge-freeze.mjs';

export const ADAPTIVE_CONFIG_FIELDS = [
  'host', 'hostVersion', 'runtimeMode', 'pluginVersion',
  'effectiveHookSetFingerprint', 'evidenceCoverage',
];

/**
 * A value projection of supplied, observed configuration facts. This does not
 * discover the effective hooks or turn a caller's declaration into evidence.
 * Unknown fields and incomplete coverage remain explicit in the identity.
 */
export function adaptiveConfigIdentity(config) {
  if (config === null || typeof config !== 'object' || Array.isArray(config)) return null;
  const snapshot = {};
  for (const field of ADAPTIVE_CONFIG_FIELDS) {
    const descriptor = Object.getOwnPropertyDescriptor(config, field);
    if (!descriptor || !Object.hasOwn(descriptor, 'value')
      || typeof descriptor.value !== 'string' || descriptor.value.trim().length === 0) return null;
    snapshot[field] = descriptor.value;
  }
  if (!['openclaw', 'codex', 'workbuddy', 'unknown'].includes(snapshot.host)
    || !['complete', 'partial', 'unknown'].includes(snapshot.evidenceCoverage)) return null;
  // Extra fields do not silently disappear from configuration identity.
  if (Object.keys(config).some((field) => !ADAPTIVE_CONFIG_FIELDS.includes(field))) return null;
  const coverage = ADAPTIVE_CONFIG_FIELDS.some((field) => snapshot[field] === 'unknown')
    ? 'unknown' : snapshot.evidenceCoverage;
  return { snapshot, digest: hashOfCanonical(snapshot), coverage };
}
