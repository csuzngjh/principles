/**
 * Bind-authorization guard for the console HTTP server.
 *
 * The `--no-auth` CLI flag has been loopback-restricted since its introduction
 * (parseArgs exits on `--no-auth` + non-loopback `--host`). But authentication
 * is equally disabled in the *token-less* mode — no `--token` and no
 * `PD_CONSOLE_TOKEN` — which historically performed no host check at all, so a
 * direct server launch (e.g. `node dist/server.js --host 0.0.0.0` with no
 * token) would bind a LAN-reachable interface with every `/api/*` route
 * callable by unauthenticated peers.
 *
 * The invariant this enforces: authentication disabled ⇒ loopback-only bind.
 * It keys on the effective authentication state (AuthConfig), not on which
 * flag produced that state, so both unauthenticated modes are covered.
 */

const LOOPBACK_HOSTS = new Set(['127.0.0.1', 'localhost', '::1']);

export function assertLoopbackBindForUnauthenticatedServer(isAuthEnabled: boolean, host: string): void {
  if (isAuthEnabled) return;
  const normalized = String(host ?? '').toLowerCase().replace(/^\[(.+)\]$/, '$1');
  if (LOOPBACK_HOSTS.has(normalized)) return;
  console.error(
    '[pd-console] Refusing to bind non-loopback host "' + String(host) + '" without authentication. ' +
    'Provide --token or PD_CONSOLE_TOKEN, or use the default loopback host (127.0.0.1).',
  );
  process.exit(1);
}
