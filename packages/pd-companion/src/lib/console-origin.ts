/**
 * Console-token IPC response shaping + origin guard.
 *
 * The read endpoint (`pd-companion:get-console-token`) hands the long-lived
 * Bearer token to the renderer, so the main process must only serve it to the
 * page it intends to serve: the local console server origin. Any other URL
 * loaded into the companion window (degraded `data:` pages have opaque
 * origins; a stray navigation to an external site) must fail closed to
 * "no credential" — the login form then falls back to manual entry.
 *
 * Pure logic only; main.ts stays thin glue around it.
 */

export interface ConsoleTokenStatus {
  available: boolean;
  token?: string;
}

/**
 * The exact origin (protocol://host:port) of a plain-http loopback URL, or
 * null when it is not one (https, remote host, file:, data: opaque origin,
 * unparsable). A string-compare key for exact-origin checks.
 */
export function consoleOriginOf(rawUrl: string): string | null {
  let parsed: URL;
  try {
    parsed = new URL(rawUrl);
  } catch {
    return null;
  }
  if (parsed.protocol !== 'http:') return null;
  if (parsed.hostname !== '127.0.0.1' && parsed.hostname !== 'localhost') return null;
  return parsed.origin;
}

/**
 * True when the sender URL belongs to the SAME origin the supervisor serves —
 * not merely any loopback service. A page loaded from a different loopback
 * port (a second dev server, a redirect) must not reach the credential even
 * though it still carries the preload bridge.
 */
export function isSameConsoleOrigin(senderUrl: string, activeUrl: string | undefined): boolean {
  if (activeUrl === undefined || activeUrl.length === 0) return false;
  const activeOrigin = consoleOriginOf(activeUrl);
  if (activeOrigin === null) return false;
  return consoleOriginOf(senderUrl) === activeOrigin;
}

/**
 * Shape the runtime token source (the env var the console server was spawned
 * with — restored from the encrypted store at startup) into the IPC result.
 * Empty/whitespace means no credential configured (server runs no-auth).
 */
export function buildConsoleTokenStatus(token: string | undefined): ConsoleTokenStatus {
  const trimmed = token?.trim();
  if (trimmed === undefined || trimmed.length === 0) return { available: false };
  return { available: true, token: trimmed };
}
