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
 * True when the URL is a plain-http loopback origin (the console server binds
 * 127.0.0.1). Anything else — https, remote host, file:, data: (opaque
 * origin) — is rejected.
 */
export function isLocalConsoleOrigin(rawUrl: string): boolean {
  let parsed: URL;
  try {
    parsed = new URL(rawUrl);
  } catch {
    return false;
  }
  if (parsed.protocol !== 'http:') return false;
  return parsed.hostname === '127.0.0.1' || parsed.hostname === 'localhost';
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
