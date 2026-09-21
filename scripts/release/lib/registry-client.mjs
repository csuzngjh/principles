/**
 * Registry HTTP client for release governance (SPEC v1.2 §18 / Step K).
 *
 * Talks to the npm registry HTTP API directly instead of shelling out to the
 * npm CLI: the CLI's exit codes cannot distinguish "version absent" from
 * "registry unreachable" reliably, and spawning npm on Windows (npm.cmd)
 * requires shell workarounds. HTTP status codes map cleanly onto the SPEC's
 * contract:
 *
 *   2xx            → present (manifest returned)
 *   404            → ABSENT
 *   5xx / network  → REGISTRY_ERROR (retryable, NEVER interpreted as absent)
 *
 * No auth: every check here targets PUBLIC registry metadata. Publishing
 * still goes through `npm publish` with NODE_AUTH_TOKEN.
 */

const DEFAULT_REGISTRY = 'https://registry.npmjs.org';

// Strict npm package name grammar (scoped or unscoped). Callers pass names
// read from manifest FILES — validating at this trust boundary guarantees a
// poisoned manifest value can never steer the request path or host (SSRF /
// taint containment for CodeQL js/file-access-to-http).
const NPM_NAME_RE = /^(@[a-z0-9-~][a-z0-9-._~]*\/)?[a-z0-9-~][a-z0-9-._~]*$/i;

function assertValidNpmName(npmName) {
  if (typeof npmName !== 'string' || !NPM_NAME_RE.test(npmName) || npmName.length > 214) {
    throw new RegistryError(`invalid npm package name: ${JSON.stringify(npmName)}`);
  }
}

export class RegistryError extends Error {
  constructor(message, { status, cause } = {}) {
    super(message);
    this.name = 'RegistryError';
    this.status = status;
    this.cause = cause;
  }
}

function registryBase() {
  const override = process.env.PD_RELEASE_REGISTRY;
  if (override) return override.replace(/\/+$/, '');
  const npmRegistry = process.env.NPM_CONFIG_REGISTRY;
  if (npmRegistry && npmRegistry !== DEFAULT_REGISTRY) return npmRegistry.replace(/\/+$/, '');
  return DEFAULT_REGISTRY;
}

async function fetchJson(url, { timeoutMs = 15000, fetchImpl } = {}) {
  const doFetch = fetchImpl ?? globalThis.fetch;
  if (typeof doFetch !== 'function') throw new RegistryError('no fetch implementation available');
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  let res;
  try {
    res = await doFetch(url, {
      signal: controller.signal,
      // Plain application/json = the FULL packument. The abbreviated
      // install-v1 "corgi" doc strips gitHead, which the identity check
      // (SPEC §18.2) depends on.
      headers: { accept: 'application/json' },
    });
  } catch (err) {
    throw new RegistryError(`network failure fetching ${url}: ${err?.message ?? err}`, { cause: err });
  } finally {
    clearTimeout(timer);
  }
  if (!res.ok) {
    throw new RegistryError(`HTTP ${res.status} fetching ${url}`, { status: res.status });
  }
  try {
    return await res.json();
  } catch (err) {
    throw new RegistryError(`malformed JSON from ${url}: ${err?.message ?? err}`, { status: 200, cause: err });
  }
}

/**
 * Bounded retry for REGISTRY_ERROR-class failures only. 404 is a definitive
 * answer and must not be retried (SPEC §18.3). The delay is overridable for
 * tests via PD_RELEASE_RETRY_DELAY_MS.
 */
async function withRetries(fn, { attempts = 3, delayMs, onRetry } = {}) {
  const effectiveDelay =
    delayMs ?? (Number(process.env.PD_RELEASE_RETRY_DELAY_MS) > 0 ? Number(process.env.PD_RELEASE_RETRY_DELAY_MS) : 2000);
  let lastErr;
  for (let attempt = 1; attempt <= attempts; attempt++) {
    try {
      return await fn(attempt);
    } catch (err) {
      if (!(err instanceof RegistryError)) throw err;
      lastErr = err;
      if (err.status === 404) throw err; // definitive
      if (attempt < attempts) {
        onRetry?.(attempt, err);
        await new Promise((r) => setTimeout(r, effectiveDelay * attempt));
      }
    }
  }
  throw lastErr;
}

/**
 * Fetch the full packument (all versions, dist-tags) for a package.
 * Throws RegistryError on 5xx/network/malformed after bounded retries.
 * Returns null when the package itself is not on the registry (404).
 */
export async function fetchPackument(npmName, opts = {}) {
  assertValidNpmName(npmName);
  const url = `${registryBase()}/${npmName}`;
  try {
    return await withRetries(
      (attempt) => fetchJson(url, opts),
      { attempts: opts.attempts ?? 3, delayMs: opts.delayMs ?? 2000, onRetry: opts.onRetry },
    );
  } catch (err) {
    if (err instanceof RegistryError && err.status === 404) return null;
    throw err;
  }
}

/**
 * Fetch the manifest of one EXACT version. Throws RegistryError on
 * 5xx/network/malformed after bounded retries. Returns null on 404 (the
 * exact version does not exist).
 */
export async function fetchExactManifest(npmName, version, opts = {}) {
  assertValidNpmName(npmName);
  const url = `${registryBase()}/${npmName}/${version}`;
  try {
    return await withRetries(
      (attempt) => fetchJson(url, opts),
      { attempts: opts.attempts ?? 3, delayMs: opts.delayMs ?? 2000, onRetry: opts.onRetry },
    );
  } catch (err) {
    if (err instanceof RegistryError && err.status === 404) return null;
    throw err;
  }
}

/**
 * Identity comparison between a registry manifest and the release cohort's
 * expectation (SPEC §18.2): gitHead first (recorded when published from a
 * git checkout); dist.integrity is available for tarball-level comparison
 * by callers that can pack locally.
 */
export function classifyPresence(manifest, { expectGitHead } = {}) {
  if (!manifest) return 'ABSENT';
  const regHead = typeof manifest.gitHead === 'string' ? manifest.gitHead : null;
  if (!expectGitHead) {
    // No expectation supplied: presence is a fact, identity unverifiable.
    return regHead ? 'PRESENT_UNVERIFIED' : 'PRESENT_UNVERIFIED';
  }
  if (regHead === expectGitHead) return 'PRESENT_MATCH';
  if (!regHead) return 'PRESENT_UNVERIFIED';
  return 'PRESENT_CONFLICT';
}
