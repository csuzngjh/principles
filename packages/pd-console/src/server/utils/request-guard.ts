/**
 * Request-origin guard for the credential-less console.
 *
 * The OS session is the trust boundary for *local* clients, but a browser page
 * served from another origin can still reach `127.0.0.1:<port>`:
 *
 * - cross-site `fetch`/form POSTs are "simple requests" and reach the server
 *   even though the response is unreadable (CSRF);
 * - DNS rebinding makes an attacker origin look same-origin, which also lets
 *   it read responses.
 *
 * The guard therefore enforces two independent facts and lets non-browser
 * clients through unchanged:
 *
 * - `Host` must be a loopback literal (defeats rebinding);
 * - when the browser tells us the provenance (`Origin` / `Sec-Fetch-Site`), it
 *   must be this console's own origin (defeats cross-site CSRF);
 * - no `Origin` and no `Sec-Fetch-Site` means a non-browser client and is
 *   allowed — that is how the CLI, installer probes and scripts keep working.
 *
 * State-changing requests with a body must also be JSON: that keeps the
 * "simple request" form/text submission path closed even if a future browser
 * omits the provenance headers.
 */
import type { IncomingMessage } from 'node:http';

const LOOPBACK_HOSTNAMES = new Set(['127.0.0.1', 'localhost', '::1']);
const MUTATING_METHODS = new Set(['POST', 'PUT', 'PATCH']);

export interface RequestGuardRejection {
  status: number;
  error: string;
  message: string;
  nextAction: string;
}

function stripBrackets(hostname: string): string {
  return hostname.replace(/^\[(.+)\]$/, '$1');
}

function loopbackHostOf(url: URL): string | null {
  const hostname = stripBrackets(url.hostname.toLowerCase());
  return LOOPBACK_HOSTNAMES.has(hostname) ? hostname : null;
}

function forbidden(reason: string): RequestGuardRejection {
  return {
    status: 403,
    error: reason,
    message: 'Cross-origin requests are not accepted by the local Console.',
    nextAction: 'Open the Console from its own address; browser extensions and remote pages cannot drive it.',
  };
}

/**
 * Returns `null` when the request may proceed, or a structured rejection.
 */
export function guardConsoleApiRequest(req: IncomingMessage): RequestGuardRejection | null {
  const hostHeader = typeof req.headers.host === 'string' ? req.headers.host : '';

  if (hostHeader.length > 0) {
    try {
      if (loopbackHostOf(new URL(`http://${hostHeader}`)) === null) {
        return {
          status: 403,
          error: 'forbidden_host',
          message: 'Requests must target the local Console address.',
          nextAction: 'Use the loopback address the Console printed at startup (127.0.0.1 or localhost).',
        };
      }
    } catch {
      return {
        status: 403,
        error: 'forbidden_host',
        message: 'Requests must target the local Console address.',
        nextAction: 'Use the loopback address the Console printed at startup (127.0.0.1 or localhost).',
      };
    }
  }

  const { origin } = req.headers;
  if (typeof origin === 'string' && origin.length > 0) {
    let parsed: URL;
    try {
      parsed = new URL(origin);
    } catch {
      return forbidden('forbidden_origin');
    }
    if (loopbackHostOf(parsed) === null) {
      return forbidden('forbidden_origin');
    }
    // Same-origin means the browser's page and this request share host:port.
    // `Origin: null` (file:, sandboxed frames) never reaches here as a match.
    if (hostHeader.length > 0 && parsed.host.toLowerCase() !== hostHeader.toLowerCase()) {
      return forbidden('forbidden_origin');
    }
  }

  const secFetchSite = req.headers['sec-fetch-site'];
  if (typeof secFetchSite === 'string' && secFetchSite.length > 0) {
    if (secFetchSite !== 'same-origin' && secFetchSite !== 'none') {
      return forbidden('forbidden_origin');
    }
  }

  const method = (req.method ?? 'GET').toUpperCase();
  if (MUTATING_METHODS.has(method)) {
    const contentLength = Number(req.headers['content-length'] ?? '0');
    const contentType = String(req.headers['content-type'] ?? '').toLowerCase();
    if (contentLength > 0 && !contentType.startsWith('application/json')) {
      return {
        status: 415,
        error: 'unsupported_media_type',
        message: 'Console write endpoints require an application/json request body.',
        nextAction: 'Send the request body as JSON with Content-Type: application/json.',
      };
    }
  }

  return null;
}
