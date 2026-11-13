/**
 * Bind guard for the console HTTP server.
 *
 * The console has no application-level credential: the operating-system
 * session is the trust boundary. That is only true while the listener is
 * reachable from the local machine alone, so a non-loopback `--host` is
 * refused unconditionally (it used to depend on the authentication mode).
 */

const LOOPBACK_HOSTS = new Set(['127.0.0.1', 'localhost', '::1']);

export function assertLoopbackBind(host: string): void {
  const normalized = String(host ?? '').toLowerCase().replace(/^\[(.+)\]$/, '$1');
  if (LOOPBACK_HOSTS.has(normalized)) return;
  console.error(
    '[pd-console] Refusing to bind non-loopback host "' + String(host) + '". ' +
    'The Console has no application-level authentication and relies on local OS access; use the default loopback host (127.0.0.1).',
  );
  process.exit(1);
}
