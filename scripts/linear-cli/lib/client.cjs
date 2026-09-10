'use strict';

/**
 * Linear GraphQL transport.
 *
 * Extracted verbatim in behaviour from the pre-PRI-722 single-file CLI:
 *   - token resolution order (env -> key file -> shell profile)
 *   - 3 attempts with exponential backoff (1s, 2s, 4s) honouring Retry-After
 *   - retriable: network error, timeout, 5xx, 429
 *   - 30s per-request AbortController timeout
 *
 * The only intentional change: `gql` now RETURNS a result object instead of
 * printing + mutating process state. Callers propagate `error` to the single
 * JSON output. This keeps failure handling explicit and makes the network
 * boundary injectable for tests.
 */

const fs = require('node:fs');

const DEFAULT_ENDPOINT = 'https://api.linear.app/graphql';
const DEFAULT_TIMEOUT_MS = 30000;
const DEFAULT_MAX_RETRIES = 3;

const KEY_FILE_CANDIDATES = [
  `${process.env.HOME || process.env.USERPROFILE || ''}/.linear_api_key`,
  `${process.env.USERPROFILE || process.env.HOME || ''}/.linear_api_key`,
  `${process.env.HOME || ''}/.config/linear/api_key`,
];

function readKeyFile() {
  for (const p of KEY_FILE_CANDIDATES) {
    if (!p) continue;
    try {
      const raw = fs.readFileSync(p, 'utf8').trim();
      if (raw) return raw;
    } catch {
      /* missing or unreadable — try next candidate */
    }
  }
  return undefined;
}

function readKeyFromProfile() {
  const profile = `${process.env.HOME || process.env.USERPROFILE || ''}/.bashrc`;
  try {
    const m = fs
      .readFileSync(profile, 'utf8')
      .match(/^\s*export\s+LINEAR_API_KEY\s*=\s*["']?([^"'\s]+)["']?\s*$/m);
    return m ? m[1].trim() : undefined;
  } catch {
    return undefined;
  }
}

function resolveToken() {
  return process.env.LINEAR_API_KEY || readKeyFile() || readKeyFromProfile();
}

function isRetriableStatus(status) {
  return status === 429 || status >= 500;
}

const MISSING_KEY_ERROR = {
  reason: 'missing_linear_api_key',
  nextAction:
    'No Linear API key found. Set LINEAR_API_KEY, or write the token to ~/.linear_api_key, or add an export line to ~/.bashrc.',
};

/**
 * Build a Linear client.
 *
 * @param {object} [options]
 * @param {string} [options.token]       defaults to resolveToken()
 * @param {Function} [options.fetchImpl] injectable for tests
 * @param {Function} [options.sleep]     injectable for tests
 */
function createClient(options = {}) {
  const {
    token = resolveToken(),
    endpoint = process.env.LINEAR_GRAPHQL_URL || DEFAULT_ENDPOINT,
    timeoutMs = Number(process.env.LINEAR_TIMEOUT_MS || DEFAULT_TIMEOUT_MS),
    maxRetries = DEFAULT_MAX_RETRIES,
    fetchImpl = globalThis.fetch,
    sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  } = options;

  async function once(query, variables) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    let res;
    try {
      res = await fetchImpl(endpoint, {
        method: 'POST',
        headers: { Authorization: token, 'Content-Type': 'application/json' },
        body: JSON.stringify({ query, variables }),
        signal: controller.signal,
      });
    } catch (err) {
      const aborted = err && (err.name === 'AbortError' || /aborted/i.test(String(err.message || '')));
      return {
        kind: 'retryable',
        reason: aborted ? 'request_timeout' : 'network_error',
        message: err instanceof Error ? err.message : String(err),
      };
    } finally {
      clearTimeout(timer);
    }

    // Read Retry-After before touching the body: some 429/5xx responses carry
    // an empty or non-JSON body, and the header still has to be honoured.
    const retryAfter = res.headers.get('retry-after');
    const retryAfterSec = retryAfter ? Number(retryAfter) : undefined;

    const text = await res.text();
    let payload;
    try {
      payload = JSON.parse(text);
    } catch {
      if (isRetriableStatus(res.status)) {
        return { kind: 'retryable', reason: `non_json_${res.status}`, retryAfterSec, bodyPreview: text.slice(0, 200) };
      }
      return {
        kind: 'error',
        error: {
          reason: 'linear_non_json_response',
          nextAction: 'Retry later or inspect Linear API status.',
          details: { status: res.status, bodyPreview: text.slice(0, 500) },
        },
      };
    }

    if (!res.ok || payload.errors) {
      if (isRetriableStatus(res.status)) {
        return {
          kind: 'retryable',
          reason: `status_${res.status}`,
          retryAfterSec,
          errors: payload.errors,
        };
      }
      return {
        kind: 'error',
        error: {
          reason: 'linear_graphql_error',
          nextAction:
            'Check the query, issue id, permissions, or token; retry if this is a transient Linear failure.',
          details: { status: res.status, errors: payload.errors },
        },
      };
    }
    return { kind: 'ok', data: payload.data };
  }

  /**
   * @returns {Promise<{ok:true, data:object}|{ok:false, error:{reason:string,nextAction:string,details?:object}}>}
   */
  async function gql(query, variables = {}) {
    if (!token) return { ok: false, error: MISSING_KEY_ERROR };
    for (let attempt = 1; attempt <= maxRetries; attempt += 1) {
      const result = await once(query, variables);
      if (result.kind === 'ok') return { ok: true, data: result.data };
      if (result.kind === 'error') return { ok: false, error: result.error };
      if (attempt >= maxRetries) {
        return {
          ok: false,
          error: {
            reason: 'linear_transient_failed',
            nextAction: `All ${maxRetries} attempts failed (last reason: ${result.reason}). Retry the command in a few seconds, or check Linear API status.`,
            details: {
              lastReason: result.reason,
              attempts: maxRetries,
              ...(result.errors ? { errors: result.errors } : {}),
            },
          },
        };
      }
      const backoff = Math.max(1000 * 2 ** (attempt - 1), (result.retryAfterSec || 0) * 1000);
      await sleep(backoff);
    }
    return { ok: false, error: MISSING_KEY_ERROR };
  }

  return { gql, endpoint };
}

module.exports = {
  createClient,
  resolveToken,
  isRetriableStatus,
  DEFAULT_ENDPOINT,
  DEFAULT_TIMEOUT_MS,
  DEFAULT_MAX_RETRIES,
};
