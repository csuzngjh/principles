/**
 * PD plugin backup location utilities.
 *
 * Backups must NEVER live inside any host plugin discovery tree. OpenClaw scans
 * every child directory of its extensions root, so a backup containing
 * package.json (openclaw.extensions) + dist/bundle.js would be discovered as a
 * second plugin. All host and runtime backups therefore live in the shared
 * <PD_HOME>/.pd/backups directory.
 *
 * The Console only ever USES this canonical root. Migrating legacy backups out
 * of the old <openclawHome>/pd-backups root and the extensions/ siblings is an
 * EXPLICIT installer operation (create-principles-disciple
 * migrateLegacyPdBackups) — the Console never relocates user files on startup
 * (PD迁移策略: 安装器显式迁移; Companion/Console 不隐式搬迁).
 */
import * as fs from 'fs';
import * as path from 'path';
import { errorMessage } from './response.js';
import { getPdHome } from './pd-home.js';

/**
 * Resolve the OpenClaw install home.
 *
 * PRI-872: delegated to the process-wide PD home resolution. In production it
 * keeps the historical priority (OPENCLAW_HOME env var > ~/.openclaw); in an
 * experiment instance it points at the experiment root, so backup placement
 * and installed-layout resolution can never read the production host.
 * Single authority for home resolution — `resolvePdBackupsRoot` and
 * `utils/installed-layout.ts` both derive from it.
 */
export function resolveOpenClawHome(): string {
  return getPdHome().openclawHome;
}

/** Host-neutral backup root — outside every host plugin discovery directory. */
export function resolvePdBackupsRoot(): string {
  return getPdHome().pdRuntimeBackupsDir;
}

/**
 * Extract a POSIX errno code from a thrown fs error (rc-2: type guard, no
 * blind `as` cast on the error object).
 */
function getErrorCode(err: unknown): string | undefined {
  if (err !== null && typeof err === 'object' && Object.hasOwn(err, 'code')) {
    const { code } = err as { code?: unknown };
    return typeof code === 'string' ? code : undefined;
  }
  return undefined;
}

/**
 * Reserve a unique backup destination under the backups root:
 * <root>/<targetName>-<ISO timestamp>, with a numeric suffix on collision.
 * Atomic reservation via plain (non-recursive) mkdirSync — EEXIST means the
 * name is taken, retry with the next suffix. The retry loop is bounded; never
 * poll existsSync in a loop (a stale/mocked always-true predicate makes it
 * unbounded).
 */
export function reservePdBackupDestination(targetName: string): string {
  const root = resolvePdBackupsRoot();
  fs.mkdirSync(root, { recursive: true });
  const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
  let lastError: unknown;
  for (let attempt = 0; attempt < 100; attempt++) {
    const suffix = attempt === 0 ? '' : `-${attempt}`;
    const candidate = path.join(root, `${targetName}-${timestamp}${suffix}`);
    try {
      fs.mkdirSync(candidate);
      return candidate;
    } catch (err) {
      if (getErrorCode(err) === 'EEXIST') {
        lastError = err;
        continue;
      }
      throw err;
    }
  }
  throw new Error(`Could not reserve a unique backup directory under ${root}: ${errorMessage(lastError)}`);
}

