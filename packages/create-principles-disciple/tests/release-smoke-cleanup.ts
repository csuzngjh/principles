/**
 * Best-effort cleanup of the release-smoke temp root.
 *
 * After a ~270k-file extraction, antivirus/indexer handles transiently deny
 * recursive deletes on Windows (EPERM — same family as the ERR-090
 * 2026-08-25 publication-rename lesson). Cleanup runs strictly after every
 * correctness assertion has completed, so a leftover temp directory is
 * hygiene, not a release-asset correctness failure: retry generously and
 * degrade to a loud warning instead of failing the release gate. Real
 * failures (digest, containment, extraction, installer) are thrown before
 * cleanup ever runs and are never swallowed here.
 */
import * as fs from 'node:fs';

export type CleanupOptions = {
  log?: (message: string) => void;
  remove?: (path: string, options: fs.RmOptions) => void;
};

export function cleanupReleaseSmokeRoot(root: string, options: CleanupOptions = {}): { removed: boolean } {
  const remove = options.remove ?? ((path, removeOptions) => fs.rmSync(path, removeOptions));
  try {
    remove(root, { recursive: true, force: true, maxRetries: 30, retryDelay: 500 });
    return { removed: true };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    options.log?.(`[release-smoke] cleanup: temp dir left in place after retries (non-blocking): ${root} (${message})`);
    return { removed: false };
  }
}
