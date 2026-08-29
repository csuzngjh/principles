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
 *
 * `skip` covers the ephemeral-CI case: measured on windows-2025 + Node 22,
 * the recursive delete ground for 30+ minutes inside the job budget until
 * the job timeout killed it (run 33239467277) — on a throwaway runner that
 * deletion buys nothing, so the caller passes skip and the temp dir is left
 * for the runner to discard with the machine.
 */
import * as fs from 'node:fs';

export type CleanupOptions = {
  log?: (message: string) => void;
  remove?: (path: string, options: fs.RmOptions) => void;
  skip?: boolean;
};

export function cleanupReleaseSmokeRoot(root: string, options: CleanupOptions = {}): { removed: boolean; skipped: boolean } {
  if (options.skip) {
    options.log?.(`[release-smoke] cleanup: skipped (ephemeral runner; temp root left for runner disposal): ${root}`);
    return { removed: false, skipped: true };
  }
  const remove = options.remove ?? ((path, removeOptions) => fs.rmSync(path, removeOptions));
  try {
    remove(root, { recursive: true, force: true, maxRetries: 30, retryDelay: 500 });
    return { removed: true, skipped: false };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    options.log?.(`[release-smoke] cleanup: temp dir left in place after retries (non-blocking): ${root} (${message})`);
    return { removed: false, skipped: false };
  }
}
