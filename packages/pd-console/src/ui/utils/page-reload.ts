/**
 * Reload the page. Its own module so the one navigation the update flow
 * triggers on its own can be replaced in tests.
 */
export function reloadPage(): void {
  // `globalThis` rather than `window`: this module is shared tooling, read
  // by linters that only know the Node globals.
  globalThis.location.reload();
}
