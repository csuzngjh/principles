/**
 * Release metadata source contract (PRI-709 P0-1).
 *
 * PRI-698 Phase 0 Audit finding F-4: `PD_RELEASE_METADATA_URL` had no supply
 * side anywhere in the repository — every consumer read the process env
 * directly, so a ReleaseManager install could only ever become ready inside
 * the single shell that exported the variable. There was no durable,
 * installer-owned answer to "where does signed release metadata come from?".
 *
 * This module is that answer. It is a READ-SIDE contract only: it resolves
 * the base URL of the signed release metadata repository and refuses to guess
 * one. It does not publish, sign, mirror or cache metadata (scope boundary —
 * the publishing pipeline is out of scope for PRI-709).
 *
 * Resolution order (highest precedence first):
 *
 *   1. `explicit`        — caller-supplied override. The Console passes the
 *                          operator's process-level env value here, so an
 *                          operator override always wins over install state.
 *   2. `env`             — `PD_RELEASE_METADATA_URL` read by this module.
 *   3. `install_config`  — `~/.pd/install.json` → `releaseMetadataUrl`,
 *                          written by the installer at install time. This is
 *                          the durable tier: it survives new shells, new
 *                          processes and Console restarts.
 *   4. `unconfigured`    — no source exists. `metadataBaseUrl` is `undefined`
 *                          and the caller's fallback semantics are UNCHANGED
 *                          (ADR-0024 §2.4 — refusal with a stable reason, never
 *                          a guessed endpoint).
 *
 * `invalid` short-circuits: a candidate source that exists but is not a usable
 * http(s) base URL is reported, never silently skipped in favour of a lower
 * tier. An operator who misconfigures the override must see the
 * misconfiguration, not a surprising fallback to install state.
 *
 * This module deliberately imports nothing from `install-layout.js`: callers
 * pass the already-read install config in. That keeps the layering one-way
 * (install-layout → this module) with no cycle.
 */

/** Operator override environment variable for the metadata repository base URL. */
export const RELEASE_METADATA_URL_ENV = 'PD_RELEASE_METADATA_URL';

export type ReleaseMetadataSourceKind =
  /** Caller-supplied override (Console passes the process-level env value). */
  | 'explicit'
  /** `PD_RELEASE_METADATA_URL` resolved by this module. */
  | 'env'
  /** Durable install-time source: `~/.pd/install.json` → `releaseMetadataUrl`. */
  | 'install_config'
  /** A candidate source exists but is not a usable http(s) base URL. */
  | 'invalid'
  /** No source configured; fallback semantics unchanged. */
  | 'unconfigured';

export interface ReleaseMetadataSource {
  readonly kind: ReleaseMetadataSourceKind;
  /** `undefined` for `invalid` and `unconfigured` — never a guessed URL. */
  readonly metadataBaseUrl: string | undefined;
  /** Stable machine-readable detail for `invalid`; null otherwise. */
  readonly detail: string | null;
}

export interface ResolveReleaseMetadataSourceOptions {
  /** Caller-supplied override; empty string is treated as absent. */
  readonly explicit?: string | undefined;
  /** Defaults to `process.env.PD_RELEASE_METADATA_URL`. */
  readonly env?: string | undefined;
  /** Already-read install config; null when install state is corrupt. */
  readonly installConfig?: { readonly releaseMetadataUrl?: string } | null;
}

/**
 * Strict validator for a metadata repository base URL.
 *
 * Returns the trimmed URL, or `null` when the value is not a non-empty
 * `http(s)` URL. Whitespace-only input is absent, not valid — the ReleaseManager
 * must never be handed a URL it would have to repair.
 */
export function normalizeReleaseMetadataUrl(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  const trimmed = raw.trim();
  if (trimmed.length === 0) return null;
  let parsed: URL;
  try {
    parsed = new URL(trimmed);
  } catch {
    return null;
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return null;
  return trimmed;
}

/** True when the value is a usable metadata repository base URL. */
export function isReleaseMetadataUrl(raw: unknown): raw is string {
  return normalizeReleaseMetadataUrl(raw) !== null;
}

/**
 * Resolve the release metadata source. Never throws: an unusable source is a
 * reported outcome (`invalid` / `unconfigured`), so readiness probing stays
 * side-effect free and observable.
 */
export function resolveReleaseMetadataSource(
  options: ResolveReleaseMetadataSourceOptions = {},
): ReleaseMetadataSource {
  const env = options.env !== undefined
    ? options.env
    : process.env[RELEASE_METADATA_URL_ENV];

  const candidates: readonly { readonly tier: 'explicit' | 'env' | 'install_config'; readonly raw: unknown }[] = [
    { tier: 'explicit', raw: options.explicit },
    { tier: 'env', raw: env },
    { tier: 'install_config', raw: options.installConfig?.releaseMetadataUrl },
  ];

  for (const candidate of candidates) {
    if (candidate.raw === undefined || candidate.raw === null) continue;
    if (typeof candidate.raw === 'string' && candidate.raw.trim().length === 0) continue;
    const normalized = normalizeReleaseMetadataUrl(candidate.raw);
    if (normalized === null) {
      // Refusal over silent degradation: do not fall through to a lower tier
      // and pretend the operator's intent was absent.
      return {
        kind: 'invalid',
        metadataBaseUrl: undefined,
        detail: `${candidate.tier}_url_invalid`,
      };
    }
    return { kind: candidate.tier, metadataBaseUrl: normalized, detail: null };
  }

  return { kind: 'unconfigured', metadataBaseUrl: undefined, detail: null };
}
